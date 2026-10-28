"""Settings for the market-data backfill.

PROFILE "test" - the last 15 trading days, 5 stocks. Run this first and read the report.
PROFILE "year" - the last ~12 months (250 trading days), all NIFTY 200 stocks: NSE files and
                 spot for all 200; options for the top OPTION_STOCKS each month (see below).

On the VPS, pick the profile in /opt/marketdata/.env (MARKETDATA_PROFILE=year) - no code change.
Re-running is always safe: anything already in the database is skipped.
"""

PROFILE = "test"

PROFILES = {
    "test": {"trading_days": 15, "stocks": ["RELIANCE", "HDFCBANK", "INFY", "TCS", "SBIN"]},
    "year": {"trading_days": 250, "stocks": "NIFTY200"},
}

END_DATE = None             # None = yesterday (IST); or "YYYY-MM-DD"

# ---------------- when it may run ----------------
# The download only runs between these IST times (after market hours, overnight). A systemd timer
# starts it at 16:00; at 06:00 it stops cleanly and carries on the next evening.
RUN_WINDOW = ("16:00", "06:00")

# ---------------- options (Dhan rolling-option data) ----------------
EXPIRY_FLAG = "MONTH"       # stock options are monthly
EXPIRY_CODE = 1             # 1 = nearest expiry
STRIKE_BAND = 3             # ATM-3..ATM+3 = 7 strikes, calls and puts = 14 series a stock
                            # (Dhan's maximum for stock options)
OPTION_TYPES = ["CALL", "PUT"]
INTERVAL = "1"              # minutes
WINDOW_DAYS = 2             # calendar days per option call. Dhan refuses 1-minute option requests
                            # over 2 calendar days (DH-905, since 27 Oct 2026); a refused or
                            # timed-out multi-day call is split automatically

# ---------------- which stocks get options: the most liquid, re-chosen every month ----------------
# For each month, every F&O stock is ranked on the RANK_DAYS trading days just before that month
# starts - about the previous month - from the NSE F&O bhavcopy (no look-ahead):
#   score  = median daily option turnover (rupees, NSE's figure) of the nearest monthly expiry,
#            counting only the 7 strikes nearest the price (ATM-3..ATM+3)
#   floor  = median open interest on those same strikes, calls + puts, in lots, at least MIN_ATM_OI_LOTS
# The top OPTION_STOCKS by score that clear the floor get that month's options downloaded.
# The ranking is stored in the table liquidity_rank. Spot and the NSE files stay for all 200.
OPTION_STOCKS = 100
MIN_ATM_OI_LOTS = 500
RANK_DAYS = 20              # the extra bhavcopy days before the range are downloaded for the first month

# ---------------- failed pieces ----------------
MAX_ATTEMPTS = 6            # tries per failed piece (about 3 nights: one in the run + one retry pass);
                            # after that it shows as "gave up" on the dashboard and is not retried

# ---------------- pace ----------------
WORKERS = 10                # Dhan calls in parallel (fastest in the NIFTY test: 1.53 s per series-day)
MAX_CALLS_PER_SECOND = 4    # Dhan allows 5 a second for data APIs
DAILY_CALL_LIMIT = 95_000   # Dhan allows 100,000 a day; the run waits for the next day before that
PAUSE_AFTER_CALL = 1.2      # seconds each worker waits after a call

# ---------------- what to download, in this order ----------------
# Always run first, whatever this list says: the stock list (NIFTY 200 + Dhan IDs, F&O flag, lot
# size, strike step) and the NSE F&O bhavcopy (every contract's end of day; it also decides the
# trading days).
INDEX_SPOT = ["NIFTY"]      # index spot, 1-minute (NIFTY options are not downloaded)
DATASETS = [
    "cm_bhavcopy",          # NSE stock end of day (official open/high/low/close)
    "corporate_actions",    # NSE corporate actions with price-adjust factors
    "fo_ban",               # NSE F&O ban list
    "spot_1min",            # Dhan 1-minute spot
    # "futures_1min",       # Dhan 1-minute, live futures only - dropped (futures end of day is in the
                            # F&O bhavcopy, which is always downloaded)
    "options_1min",         # Dhan 1-minute options, ATM band, calls and puts
]
