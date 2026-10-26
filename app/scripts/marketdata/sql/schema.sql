-- Market-data archive schema. Safe to run again: everything is "if not exists".
-- Prices are whole paise (integer) - exact, and they compress well. The *_rs views show rupees.
-- Minute bars keep 09:15-15:29 IST only. Times are timestamptz (stored UTC, shown in IST by the views).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------- reference
CREATE TABLE IF NOT EXISTS stocks (
    symbol        text PRIMARY KEY,
    company_name  text,
    industry      text,
    isin          text,
    security_id   integer,            -- Dhan/NSE equity ID, also the underlying ID for its options
    has_fno       boolean,
    lot_size      integer,            -- current F&O lot size
    strike_step   numeric(12, 2),     -- gap between strikes nearest the money
    in_nifty200   boolean,
    as_of         date
);

CREATE TABLE IF NOT EXISTS trading_calendar (
    d            date PRIMARY KEY,
    trading_day  boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key    text PRIMARY KEY,
    value  text NOT NULL
);

-- ---------------------------------------------------------------- NSE end of day
CREATE TABLE IF NOT EXISTS fo_bhavcopy (
    trade_date        date    NOT NULL,
    instrument        text    NOT NULL,   -- FUTIDX FUTSTK OPTIDX OPTSTK
    symbol            text    NOT NULL,
    expiry_date       date    NOT NULL,
    strike_paise      integer NOT NULL,   -- 0 for futures
    option_type       text    NOT NULL,   -- CE / PE, '' for futures
    open_paise        integer,
    high_paise        integer,
    low_paise         integer,
    close_paise       integer,
    settle_paise      integer,
    contracts         bigint,             -- number of contracts traded (not shares)
    turnover_rs       numeric(20, 2),     -- NSE's turnover figure for the day, rupees
    open_interest     bigint,             -- shares
    change_in_oi      bigint,
    underlying_paise  integer,            -- from 2024-07-08 only
    lot_size          integer,            -- from 2024-07-08 only
    security_id       bigint,             -- NSE contract ID = Dhan security ID; from 2024-07-08 only
    PRIMARY KEY (symbol, instrument, expiry_date, strike_paise, option_type, trade_date)
);
SELECT create_hypertable('fo_bhavcopy', by_range('trade_date', INTERVAL '1 month'), if_not_exists => TRUE);
ALTER TABLE fo_bhavcopy ADD COLUMN IF NOT EXISTS turnover_rs numeric(20, 2);   -- for databases made before it

CREATE TABLE IF NOT EXISTS cm_bhavcopy (
    trade_date     date NOT NULL,
    symbol         text NOT NULL,
    series         text NOT NULL,
    isin           text,
    open_paise     integer,
    high_paise     integer,
    low_paise      integer,
    close_paise    integer,             -- NSE's official close (after the closing auction), unadjusted
    last_paise     integer,
    prev_close_paise integer,           -- NSE adjusts this on an ex-date
    volume         bigint,              -- shares
    turnover       numeric(20, 2),      -- rupees
    trades         bigint,
    PRIMARY KEY (symbol, series, trade_date)
);
SELECT create_hypertable('cm_bhavcopy', by_range('trade_date', INTERVAL '3 months'), if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS corporate_actions (
    symbol           text NOT NULL,
    ex_date          date NOT NULL,
    purpose_key      text NOT NULL,     -- purpose, upper-cased, single-spaced (for de-duplication)
    series           text,
    company          text,
    record_date      date,
    purpose_raw      text NOT NULL,     -- NSE's text, verbatim
    action_type      text NOT NULL,     -- SPLIT BONUS DIVIDEND RIGHTS MERGER DEMERGER FV_CHANGE MEETING OTHER
    ratio_from       numeric,
    ratio_to         numeric,
    dividend_amount  numeric,
    prev_close       numeric,
    adjust_factor    numeric,           -- multiply prices BEFORE ex_date by this
    first_seen       date,
    PRIMARY KEY (symbol, ex_date, purpose_key)
);

CREATE TABLE IF NOT EXISTS fo_ban (
    trade_date  date NOT NULL,
    symbol      text NOT NULL,
    PRIMARY KEY (trade_date, symbol)
);

-- ---------------------------------------------------------------- Dhan minute bars
CREATE TABLE IF NOT EXISTS spot_1min (
    ts           timestamptz NOT NULL,   -- start of the minute
    symbol       text        NOT NULL,
    open_paise   integer, high_paise integer, low_paise integer, close_paise integer,
    volume       bigint,                 -- shares (0 for an index)
    PRIMARY KEY (symbol, ts)
);
SELECT create_hypertable('spot_1min', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS futures_1min (
    ts           timestamptz NOT NULL,
    symbol       text        NOT NULL,
    expiry_date  date        NOT NULL,
    open_paise   integer, high_paise integer, low_paise integer, close_paise integer,
    volume       bigint,
    PRIMARY KEY (symbol, expiry_date, ts)
);
SELECT create_hypertable('futures_1min', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS option_1min (
    ts             timestamptz NOT NULL,
    symbol         text        NOT NULL,
    expiry_date    date        NOT NULL,
    strike_paise   integer     NOT NULL,   -- the real strike that minute
    option_type    char(2)     NOT NULL,   -- CE / PE
    strike_offset  smallint    NOT NULL,   -- distance from ATM that minute (ATM moves; group by strike, not this)
    open_paise integer, high_paise integer, low_paise integer, close_paise integer,
    volume         bigint,                 -- shares
    spot_paise     integer,                -- the underlying that minute
    PRIMARY KEY (symbol, expiry_date, strike_paise, option_type, ts)
);
SELECT create_hypertable('option_1min', by_range('ts', INTERVAL '7 days'), if_not_exists => TRUE);

-- ---------------------------------------------------------------- bookkeeping
CREATE TABLE IF NOT EXISTS download_log (
    id         bigserial PRIMARY KEY,
    logged_at  timestamptz NOT NULL DEFAULT now(),
    run_id     text,
    dataset    text,
    what       text,
    win        text,
    status     integer,
    rows       integer,
    seconds    real,
    workers    integer,
    note       text
);
CREATE INDEX IF NOT EXISTS download_log_logged_at ON download_log (logged_at);

-- A piece of work that is finished - written in the same transaction as its data.
CREATE TABLE IF NOT EXISTS done (
    dataset      text NOT NULL,
    symbol       text NOT NULL,
    series       text NOT NULL,
    d            date NOT NULL,
    rows         integer,
    finished_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset, symbol, series, d)
);

-- A piece Dhan or NSE failed on. Retried at the end of the run and on every following night until
-- it succeeds (then it is removed) or `attempts` reaches settings.MAX_ATTEMPTS ("gave up").
CREATE TABLE IF NOT EXISTS gaps (
    dataset    text NOT NULL,
    symbol     text NOT NULL,
    series     text NOT NULL,
    d          date NOT NULL,
    reason     text,
    logged_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset, symbol, series, d)
);
ALTER TABLE gaps ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;

-- Which stocks get options each month: ranked on the 20 trading days before the month (no look-ahead).
CREATE TABLE IF NOT EXISTS liquidity_rank (
    month            date    NOT NULL,     -- first day of the month the ranking is used for
    symbol           text    NOT NULL,
    ranked_from      date,                 -- the trading days the ranking was computed on
    ranked_to        date,
    days             integer,
    turnover_median  numeric(20, 2),       -- rupees a day, nearest monthly expiry, ATM-3..ATM+3
    atm_oi_lots      numeric(14, 1),       -- median open interest on those strikes, calls + puts, lots
    rank             integer,              -- 1 = most liquid, among stocks that clear the OI floor
    selected         boolean NOT NULL,
    note             text,
    PRIMARY KEY (month, symbol)
);

-- The latest progress snapshot (the same JSON as progress/progress.json, read by the dashboard).
CREATE TABLE IF NOT EXISTS progress (
    id          smallint PRIMARY KEY DEFAULT 1,
    updated_at  timestamptz NOT NULL,
    data        jsonb NOT NULL
);

-- ---------------------------------------------------------------- compression (TimescaleDB)
DO $$
BEGIN
    IF NOT (SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'option_1min') THEN
        ALTER TABLE option_1min SET (timescaledb.compress,
            timescaledb.compress_segmentby = 'symbol',
            timescaledb.compress_orderby = 'expiry_date, option_type, strike_paise, ts');
    END IF;
    IF NOT (SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'spot_1min') THEN
        ALTER TABLE spot_1min SET (timescaledb.compress,
            timescaledb.compress_segmentby = 'symbol', timescaledb.compress_orderby = 'ts');
    END IF;
    IF NOT (SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'futures_1min') THEN
        ALTER TABLE futures_1min SET (timescaledb.compress,
            timescaledb.compress_segmentby = 'symbol', timescaledb.compress_orderby = 'expiry_date, ts');
    END IF;
    IF NOT (SELECT compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_name = 'fo_bhavcopy') THEN
        ALTER TABLE fo_bhavcopy SET (timescaledb.compress,
            timescaledb.compress_segmentby = 'symbol',
            timescaledb.compress_orderby = 'instrument, expiry_date, option_type, strike_paise, trade_date');
    END IF;
END $$;

-- ---------------------------------------------------------------- rupee views
CREATE OR REPLACE VIEW option_1min_rs AS
SELECT ts AT TIME ZONE 'Asia/Kolkata' AS ist, ts, symbol, expiry_date, strike_paise / 100.0 AS strike,
       option_type, strike_offset, open_paise / 100.0 AS open, high_paise / 100.0 AS high,
       low_paise / 100.0 AS low, close_paise / 100.0 AS close, volume, spot_paise / 100.0 AS spot
FROM option_1min;

CREATE OR REPLACE VIEW spot_1min_rs AS
SELECT ts AT TIME ZONE 'Asia/Kolkata' AS ist, ts, symbol, open_paise / 100.0 AS open, high_paise / 100.0 AS high,
       low_paise / 100.0 AS low, close_paise / 100.0 AS close, volume
FROM spot_1min;

CREATE OR REPLACE VIEW futures_1min_rs AS
SELECT ts AT TIME ZONE 'Asia/Kolkata' AS ist, ts, symbol, expiry_date, open_paise / 100.0 AS open,
       high_paise / 100.0 AS high, low_paise / 100.0 AS low, close_paise / 100.0 AS close, volume
FROM futures_1min;

CREATE OR REPLACE VIEW fo_bhavcopy_rs AS
SELECT trade_date, instrument, symbol, expiry_date, strike_paise / 100.0 AS strike, option_type,
       open_paise / 100.0 AS open, high_paise / 100.0 AS high, low_paise / 100.0 AS low,
       close_paise / 100.0 AS close, settle_paise / 100.0 AS settle, contracts, open_interest,
       change_in_oi, underlying_paise / 100.0 AS underlying, lot_size, security_id
FROM fo_bhavcopy;

CREATE OR REPLACE VIEW cm_bhavcopy_rs AS
SELECT trade_date, symbol, series, isin, open_paise / 100.0 AS open, high_paise / 100.0 AS high,
       low_paise / 100.0 AS low, close_paise / 100.0 AS close, last_paise / 100.0 AS last,
       prev_close_paise / 100.0 AS prev_close, volume, turnover, trades
FROM cm_bhavcopy;
