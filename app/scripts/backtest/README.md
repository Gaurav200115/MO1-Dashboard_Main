# Strategy backtest

Replays the desk's rules over the market-data archive on the VPS, and writes the trades to
MongoDB in the same shape as live trades — so the existing Trade Analysis page reads a backtest
with no new screens.

Built to `DATA/BACKTEST-PLAN.md`. Where this code departs from that document, the reason is in
the module that departs; the two known ones are listed under **Departures from the plan** below.

## Running it

From this folder - on the VPS that is the repo's `app/scripts/backtest` (the worker's
`WorkingDirectory`), with `/opt/backtest/venv/bin/python` as the interpreter; `/opt/backtest` holds
only the venv, `.env` and logs, not the code:

```
python run.py check                         the strategy mirror, and both databases
python run.py coverage                      what the archive actually holds
python run.py levels  --day 2026-10-15      the overnight levels for one session
python run.py session --day 2026-10-15      replay one session and print the trades
python run.py now   --from A --to B         replay a range here and now
python run.py queue --from A --to B         hand it to the worker instead
python run.py recharge                      re-price every stored run's charges at today's rates
```

`check`, `coverage`, `levels` and `session` write nothing. `now`, `queue` and `recharge` write to Mongo.

**Charges.** Backtest results are estimated at **Kotak Neo**'s charges since 2026-11-25: no
brokerage and no GST, only STT, exchange charges, SEBI fee and stamp duty (`charges.py`, the same
numbers as `BACKTEST_CHARGE_RATES` in `app/src/lib/strategy/charges.ts`). The live desk stays on
Zerodha's. A run stores its charges when it finishes, so runs made before a rate change keep the
old figures in the runs list until `run.py recharge` re-prices them from their stored trades; the
Trade Analysis page always prices a run at today's rates.

Start with `coverage`. The option minute data is the binding constraint — spot and the NSE files
cover all ~200 stocks, options only the ~100 most liquid, chosen per month — and it decides which
date ranges are worth asking for at all.

## How a session is replayed

The shape mirrors the live desk's day.

1. **Levels.** Fibonacci pivots from the previous session's high, low and official close
   (`cm_bhavcopy`), confirmed by that session's per-strike call/put open interest
   (`fo_bhavcopy`, nearest expiry, ATM±8, 1.8× skew, within 0.8%). The major resistance and
   support are the least-gap levels clearing 4× and 5×.
2. **The EMA.** Seeded each morning from the last 84 settled 5-minute bars of previous sessions,
   then advanced by the day's own bars — `bars.ts` does exactly this.
3. **The session.** One minute at a time. Open positions are managed *before* new signals are
   considered, because the three-position cap is shared across every running strategy and a
   signal at 11:04 can only be taken if something has closed by 11:04.
4. **The fill.** `strike_offset = 0` at the entry minute gives the at-the-money strike. From then
   on the position is followed by `strike_paise` and the offset is never read again.
5. **The exit.** The stop on the minute's low, the ladder on its high, the stop first. Plus
   `out-of-band` — see below.

## The two things most likely to produce a wrong answer

**`strike_offset` is a label, not a contract.** Dhan recomputes what "ATM" means every minute, so
the strike behind the `ATM` series changes as the stock moves. Reading a held position with
`WHERE strike_offset = 0` returns a series that jumps between contracts every time spot crosses a
strike boundary. Nothing about the result looks broken — every number is plausible and all of them
are wrong. `fills.py` locks onto the strike at entry for this reason.

**A contract that leaves the band closes the trade.** Only ATM±3 was downloaded each minute, so a
position that runs far enough simply stops being in the data. That silence is told apart from "did
not trade this minute" by reading the band out of the data itself — the lowest and highest strike
actually present for that symbol, expiry and minute. Inside it, carry the last price and hold.
Outside it, close at the last known price with the exit reason `out-of-band`. Those are real closed
trades, but they are closed by the edge of the archive rather than by the rule, so a run with many
of them needs reading with that in mind.

## The book gate, and what it can and cannot reproduce

The live gate exists because of a measured failure: 9 of the first 36 trades died inside ten
seconds and between them accounted for the entire net loss, every one filled far above where the
contract was trading. A backtest without it reproduces the desk *before* the gate existed.

Of its six checks, two reproduce exactly — the contract traded at all (`option_1min.volume`) and
the strike carries at least 3% of its chain's heaviest open interest (`fo_bhavcopy.open_interest`).
The other four are spread tests, and the archive stores no quotes at all. They are stood in for by
liquidity, and every trade is marked:

| Mark | Meaning |
|---|---|
| `clear` | comfortably above the liquidity floors |
| `approx` | passes, but near them — the live gate might have refused it |
| `rejected` | below them, or failing one of the two exact checks — not traded |

Each run reports its headline **with** and **without** the `approx` trades. If those two numbers
are far apart, the result rests on the approximation rather than on the rule.

**The floors in `settings.py` are provisional** (`GATE_CALIBRATED = False`). Step 0 of the build
order calibrates them against the 155 trades the live desk actually took — those all passed the
real gate, so a floor rejecting many of them is too strict. Until that has happened, any number
this produces should be read as provisional too.

## Departures from the plan

Both are to avoid look-ahead, and both make results *worse*, not better:

- **The gate reads the previous session's F&O bhavcopy**, not the session being traded. The live
  gate takes open interest from the overnight scan, which is the previous session — and a day's own
  end-of-day figures are not knowable at 10am. Reading them would let the replay dodge contracts
  that turned out to be thin that day, which the live desk could not do.
- **A run names a set of strategies, not one.** The three-position cap is desk-wide. Replaying the
  long rule alone and giving it all three slots reports a rule that had more room than it had.
  Both rules together is the default, and is what the desk ran.

One correction to the plan's §6.6: the levels scan takes the nearest expiry **strictly after** the
session (`lib/eod/chain.ts` — a scan running the evening of expiry day would otherwise read a chain
that has already settled). The contract a trade *buys* is the nearest expiry **on or after** the
trading day, so the one expiring that day still counts. Those are two different questions, and
`db.levels_expiry` and `db.entry_expiry` answer them separately.

## The strategy mirror

`backtest/strategies.py` mirrors `app/src/lib/strategy/registry.ts`. It is a mirror, not a second
source of truth: `check_against_registry()` re-parses the TypeScript and reports any drift, the
worker refuses to start on drift, and `run.py check` prints it. A backtest of a rule the desk is
not running is worse than no backtest, because it looks like evidence.

## Backtest-only rule: the NIFTY opening range (`--setups ORB`)

`backtest/orb.py`, defined as `NIFTY_ORB_15M` in `strategies.py`. **Not live**: it has no
counterpart in registry.ts, the drift check never looks at it, and the desk never trades it.

- The range is NIFTY's 09:15–09:29 high and low. From 09:30 the first 1-minute **close** above
  the high buys the ATM call, below the low the ATM put. **One trade a day** — the first break.
- Stop 15 **premium** points under the fill. At +15 it moves to +5, and each further +5 lifts it
  another 5 (+20 → +10, +25 → +15 …). Anything open at 13:00 is closed at 13:00.
- Priced on NIFTY weekly options (nearest expiry, ATM±5), which the downloader stores as its own
  dataset `index_options_1min`. Lot size per contract from the F&O bhavcopy (NIFTY's changed).
- Always a run of its own. It is a different instrument on its own book, so mixing it with the
  stock legs would let their shared three-position cap decide between them.

```
python run.py session --day 2026-10-15 --setups ORB
python run.py now --from 2026-01-01 --to 2026-10-31 --setups ORB
```

## Backtest-only rule: ADR-scaled retrace (`--setups A-ADR B-ADR C-ADR`)

`backtest/adr.py`, defined as `BREAKOUT_RETRACE_21EMA_ADR` / `BREAKDOWN_RETRACE_21EMA_ADR` in
`strategies.py`, tagged **ADR, SL 1:2→1**. **Went live unchanged on 2026-11-15 as long v9 /
short v5**, so `A B C` now replay this same rule; the ADR legs stay as the frozen record of what
was backtested, and `tests/test_adr.py` fails if the two ever differ. One consequence: the mirror
can no longer replay the v8 / v4 percent rule — a comparison against it needs a run made before
the change (every run records the versions it replayed).

- The live rules arm when price comes within **0.4%** of the 21 EMA and enter on a **0.2%** turn
  off the pullback's extreme. Here both are measured in the stock's own **14-session average
  daily range** instead: zone **0.15 ADR**, turn **0.075 ADR**. The minimum pullback and the
  closed-bar kill line ride on the same two numbers, exactly as they do live.
- ADR% = mean of (high − low) / close over the 14 sessions ending the day before, from
  `cm_bhavcopy`; in rupees it is that percent of the previous close. Fixed before 09:15, so no
  look-ahead. A stock with under 14 sessions has no ADR: its A and C legs cannot arm, counted
  under `skipped`.
- Calibrated so the median stock behaves as live: the median 14-session ADR across the desk's 186
  stocks (Mongo `daily_levels`, 7 Sep – 13 Nov 2026) is **2.716%**, so 0.4% = 0.147 ADR and 0.2%
  = 0.074 ADR, rounded to 0.15 / 0.075.
- Everything else is the live long v8 / short v4 as of 2026-11-13 — levels, skews, 13:00
  cutoff, book gate, ₹550 risk, and the SL trail (at 1:2 the SL moves to +1R, then one step
  behind). **B-ADR is setup B unchanged** — it has no retracement % — and is in the run so the
  three legs share the three-position cap as they do live.
- An alternative to A, B and C, not an addition: a run holds one or the other, never both.

```
python run.py session --day 2026-10-15 --setups A-ADR B-ADR C-ADR
python run.py now --from 2026-01-01 --to 2026-10-31 --setups A B C
python run.py now --from 2026-01-01 --to 2026-10-31 --setups A-ADR B-ADR C-ADR
```

Compare the last two: same dates, same cap, only the entry ruler differs. Each ADR trade stores
the band it used under `trigger.adr` (`pct`, `rupees`, `zone`, `turn`).

## Backtest-only rule: stop at the pullback (`--setups A-PB B-PB C-PB`)

`backtest/pullback_stop.py`, defined as `BREAKOUT_RETRACE_21EMA_PB` / `BREAKDOWN_RETRACE_21EMA_PB`
in `strategies.py`, tagged **ADR, SL pullback 550-800**. As Gaurav specified it on 2026-11-15; it
goes live only if it shows a lower drawdown than A/B/C on the same dates.

- **Entry: the live ADR rule (long v9 / short v5), unchanged.** Only where A and C stop moves.
- **Why:** the desk's fixed ₹550 premium stop measured as a 0.19% move in the stock at the
  median — about the size of the 0.075 ADR turn the entry waits for — and sat *above* the
  pullback's own low in 80 of 108 live A/C trades. It stopped trades inside the wiggle they had
  just come out of.
- **Stop:** the stock back at the pullback's low (A) or the rally's high (C) — the lowest 1-minute
  *low* / highest *high* from the minute the pullback reached the EMA zone to the entry minute.
  A 1-minute stock bar touching it ends the trade, **filled at the option's low for that minute**
  (the moment inside the minute is unknown, so the worst price is taken). A crossing on a minute
  the option did not print exits on its next print.
- **R** = distance from entry spot to that extreme × an assumed ATM delta of **0.5** × lot qty.
  Under **₹550** it is raised to ₹550 and the stop moved out to match; over **₹800** the trade is
  not taken and the setup is spent for the day (counted as `stop risk over Rs 800`).
- **Ladder:** the desk's 1:2 → +1R, one step behind, in **that trade's own R**. The stock stop
  guards only the opening rung; after the first move the trade is managed on premium.
- **Backstop:** a premium stop at **1.5R** under the fill, standing in for the exchange SL live
  would rest. Its exits are named `backstop`, not `stop`.
- **B-PB is setup B unchanged** on the fixed ₹550 — it fires on a level cross and has no pullback
  low — and is in the run so the three legs share the cap as they do live.
- Its own book: never in a run with A/B/C or the ADR legs.

```
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A B C
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A-PB B-PB C-PB
```

Same dates, same entry, same cap: only the stop differs. Each A/C trade stores its stop under
`trigger.pullbackStop` (`rupees`, `rawRupees`, `floored`, `extreme`, `level`, `backstop`).

## Backtest-only rule: ADR with a daily loss limit (`--setups A-DL B-DL C-DL`)

Defined as `BREAKOUT_RETRACE_21EMA_DL` / `BREAKDOWN_RETRACE_21EMA_DL` in `strategies.py`, tagged
**ADR, SL 550, day stop 1700**. As Gaurav specified it on 2026-11-15, after the pullback stop
backtested badly: keep the ₹550 stop, add a day stop.

- **The live ADR rule (long v9 / short v5) exactly** — ADR retrace for A and C, B unchanged,
  ₹550 stop, 1:2 → +1R ladder, one step behind.
- **One addition:** once the day's **net P&L on closed trades** is down **₹1,700**, no new trade
  that day. Wins offset losses; open trades do not count, and are left to run on under their own
  stop and ladder. The limit covers all three legs together, like the three-position cap.
- A stop fills at its own price in this replay, so a loss is normally exactly ₹550: three full
  losses are ₹1,650 and ₹1,700 usually trips on the fourth (or the third, when gaps through the
  stop added ₹50+). He chose ₹1,700 over ₹1,650 knowing that.
- Refused signals are counted as `daily loss limit Rs 1700`; the days it was reached as
  `days the Rs 1700 daily loss limit was reached` (both in the run's `refused` / `skipped`).

```
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A B C
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A-DL B-DL C-DL
```

Same dates, same rule: only the day stop differs.

## Backtest-only rule: ADR with a skew threshold per pivot (`--setups A-SK B-SK C-SK`)

Defined as `BREAKOUT_RETRACE_21EMA_SK` / `BREAKDOWN_RETRACE_21EMA_SK` in `strategies.py`, tagged
**ADR, skew 5x R1/R3/S1/S3**, with `levels.pick_major_per_pivot`. As Gaurav specified it on
2026-11-15. **Went live unchanged the same day as long v10 / short v6**; v11 / v7 (19 Nov) added only
the step-cost gate - skip a contract where one price step across the lot costs over 20% of
the risk, the step read from the contract's own prices (`gate.contract_tick`). The -SK legs
stay as the record; `tests/test_pivot_skew.py` fails if live differs from them by anything
else.

- **The live ADR rule (long v9 / short v5)** except how each stock's major level is picked.
  Live: closest-gap confirmed level with skew ≥ 4x (resistance) / ≥ 5x (support).
- Here each pivot has its own bar: **R1, R3, S1, S3 need 5x or more; R2, S2, P qualify at any
  skew** (a confirmed level is already ≥ 1.8x by construction). Closest gap still wins among
  those that qualify — so an R1 at 4.5x is out and the next qualifying level takes its place,
  and an R2 or P at 2x can now be the major. Exactly 5.00x passes, as "above 4x" does live.
- **Setup B's cross candidates are unchanged** — any confirmed level at any skew. The support B
  holds above is the major support, so that follows the new pick.
- The params carry `pivotMinSkew` and drop `resistanceSkew` / `supportSkew`, so the stored record
  never shows a bar this rule does not apply.

```
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A-SK B-SK C-SK
```

Compare with the ADR run on the same dates: only the major-level pick differs. Each trade stores
the level it traded under `trigger.level` (`pivot`, `skew`), so the result can be split by pivot.

## Every trade replayed under two exits (`what_if.py`)

From 2026-11-25 each backtest trade is also replayed - same contract, fill, stop and ladder
unit, same option minutes - under the **live exit** (`liveRule`: -1R until 1:2, then +1R and one
step behind) and the **1.5R break-even** (`breakevenAt15`: the same plus the stop to cost once up
1.5R), and both results are stored on the trade as `whatIf`. The shadows hold no slot, budget or
day count. The analysis page's trailing what-if shows, for a backtest run: **Current live** and
**SL to 0 at 1.5R** from this replay (exact), then the exit study and the previous rule (modelled
off the ladder). Runs made before this have no replay: re-run them to fill those two rows.

## Backtest-only rule: the -SK legs with an ATR stop (`--setups A-ATR B-ATR C-ATR`, `A-ATR600 B-ATR600 C-ATR600`)

Defined as `BREAKOUT_RETRACE_21EMA_ATR` / `BREAKDOWN_RETRACE_21EMA_ATR` (book `atr-stop`) and
`..._ATR600` (book `atr-stop-600`) in `strategies.py`; the arithmetic is in `atr_stop.py`. As
Gaurav specified it on 2026-11-25.

- **Entries are A-SK / B-SK / C-SK v2 exactly.** Only the stop and the ladder change.
- **SL = the stock's ATR(14) on 5-minute bars / 3, applied straight to the option premium in
  points** - premium 133, ATR 14.40 → SL 128.20. Not converted through a delta. R = that × the
  lot; no ₹550, no floor, no ceiling. A trade's `riskPerUnit` is this stop.
- The ATR is the chart's: true range with the previous bar's close, Wilder-smoothed, seeded with
  the mean of the first 14. Bars run on across sessions - the same three earlier sessions seed it
  as seed the 21 EMA, so the first bar of the day carries the overnight gap. Only closed bars
  count (an entry at 10:02 reads the ATR as of the 09:55 bar). A stock with no ATR yet is turned
  away, counted as `no 5-min ATR yet`.
- **-ATR**: ladder in the trade's own R - cost at +1.5R, +1R locked at +2R, then one rung behind.
- **-ATR600**: the same ladder in fixed ₹600 steps whatever the stop - cost at +₹900, +₹600
  locked at +₹1,200, then every +₹600 (`Position.ladder_unit`). The dashboard's "peak R" counts
  these ₹600 rungs; its actual R (profit / riskPerUnit × qty) is in the ATR stop.
- Each trade stores `trigger.atrStop`: the ATR, the stop in points and rupees, and the ladder unit.
- The spread-of-risk check does not exist in the backtest (no quotes in the archive), and the -SK
  params carry no step-cost gate, so nothing else reads R before entry.

```
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A-ATR B-ATR C-ATR
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A-ATR600 B-ATR600 C-ATR600
```

Compare both with an A-SK B-SK C-SK run on the same dates: the trades taken are the same, only
the exits differ. `tests/test_atr_stop.py`.

## Backtest-only rule: A, B and C on NIFTY (`--setups A-NIFTY B-NIFTY C-NIFTY`)

Defined as `NIFTY_BREAKOUT_RETRACE_21EMA` / `NIFTY_BREAKDOWN_RETRACE_21EMA` in `strategies.py`,
tagged **NIFTY weekly, R 650, 1 per setup/day**, book `nifty-abc`. As Gaurav specified it on
2026-11-21; v2 on 2026-11-23.
On the dashboard: Backtest → Instrument **NIFTY**.

- **The live long v11 / short v7, on one instrument:** NIFTY's weekly options (the nearest
  expiry archived for the day - so the expiring contract on expiry day, 0 DTE).
- **The overnight scan on the index.** Pivots from NIFTY's previous session: high and low from
  its 1-minute bars (`db.index_daily`), close = NSE's official close (`underlying_paise` on the
  OPTIDX rows of the F&O bhavcopy; the last 1-minute close before 2024-07-08). Confirmed by
  the OPTIDX weekly chain's open interest, nearest expiry strictly after the session - the same
  1.8x / ATM±8 / 0.8% band / per-pivot 5x as the stocks. ADR from NIFTY's own 14 sessions.
  Lot size from the bhavcopy (`index_lot_size`). 21 EMA on 5-minute bars, seeded the same way.
- **R = ₹650** a trade at 1 lot (10 points on a 65 lot): 1:2 target ₹1,300, ladder in ₹650 steps.
- **One trade of each setup a day (v2).** A, B and C each trade at most once a day, and only
  when their own setup forms. A leg that fires is spent for the day whether the signal was
  taken or refused (book full, gate), as live. There is no cap across legs, so A firing does
  not use up B - up to three trades a day, **max 3 open**. Entries until 13:00, flat 15:15.
  (v1 re-armed a leg straight after each signal - `rearmAfterSignal` - for any number a day;
  the switch is still in the engine, unused.)
- **The gate** runs its exact checks on the index options (OPTIDX: entry-minute volume, strike
  OI ≥ 3% of the chain's heaviest) and its per-contract proxies; the two monthly stock-liquidity
  proxies do not exist for an index and are skipped (`skipStockLiquidity`).

```
python run.py now --from 2025-11-10 --to 2026-10-30 --setups A-NIFTY B-NIFTY C-NIFTY
```

Trade analysis can split the result by setup, by trade number of the day (1st, 2nd … uncapped)
and by days to expiry (expiry day, 1 … 6, 7+).

## Backtest-only rules: fewer trades on a ₹35k budget (`-CAP`, `-35K`)

As Gaurav specified it on 2026-11-23, to cut the trade count and the drawdown. Both are the
live long v11 / short v7 rule unchanged, plus:

- **`A-CAP B-CAP C-CAP`** (`BREAKOUT_RETRACE_21EMA_CAP` / `BREAKDOWN_RETRACE_21EMA_CAP`, book
  `cap-35k`): at most **3 entries a day across A, B and C together** (first come, first taken;
  `maxTradesPerDayBook`), and **no new entry from 10:30** (`entryCutoffIst`). Trades already
  open run on to their own exit.
- **`B-35K`** (`BREAKOUT_RETRACE_21EMA_B35K`, book `b-35k`): setup B alone, the normal day
  (entries till 13:00, 15 a day).
- **Break-even at 1.5R (v2, 2026-11-23)** - on `-CAP`, `-35K` and `-SK` (v2, changed in place):
  once the premium touches entry + 1.5R, the stop moves to the entry price, cost to cost
  (`breakevenAtR`, `position.move_to_cost`); exit reason `breakeven`. Then 1:2 -> +1R as before.
  Backtest only - the live desk does not do it.
- **Both: a ₹35,000 budget** (`capitalRupees`). A signal whose premium (price × qty) plus the
  premium already in open trades would go over ₹35,000 is skipped - open trades are never closed
  to make room - and does not count toward the day's 3. Max 3 open as always.

```
python run.py now --from 2025-10-23 --to 2026-11-12 --setups A-CAP B-CAP C-CAP
python run.py now --from 2025-10-23 --to 2026-11-12 --setups B-35K
```

## Tests

No database and no network — the pure parts of the engine, plus one whole session replayed against
a stand-in archive:

```
python tests/test_core.py        the rule: ladder, EMA, levels, all three setups
python tests/test_fills.py       stops, the flatten, and the edge of the archive
python tests/test_session.py     one session end to end, the gate, run identity
python tests/test_strategies.py  every leg: A, B and C apart and together, and the shared cap
python tests/test_orb.py         the NIFTY opening range: the break, the points trail, 13:00
python tests/test_adr.py         the ADR variant: the band, live vs ADR on one path, A/B/C-ADR
python tests/test_pullback.py    the pullback stop: R, floor, cap, stock stop, backstop, A/B/C-PB
python tests/test_daily_loss.py  the ₹1,700 day stop: net of closed trades, open trades run on
python tests/test_pivot_skew.py  5x for R1/R3/S1/S3, any for R2/S2/P: the pick, plans, sessions
python tests/test_step_cost.py   v11 / v7: skip when one price step across the lot is over 0.2R
python tests/test_nifty_abc.py   A/B/C-NIFTY: the scan on the index, 1 per setup/day, R 650, 0 DTE, OPTIDX gate
python tests/test_budget_cap.py  -CAP / -35K: 3 a day across setups, 10:30 cut-off, the Rs 35k budget
```

500 checks, plus, for the live desk, `node scripts/test-live-desk.mjs` (76), `node scripts/test-levels-ts.mjs` (20) and `node scripts/test-feed.mjs` (26 - the Kite feed and the 09:00 reminder). `test_strategies.py` is the one that keeps the pair honest: each rule can be
correct on its own and the two still wrong together. Give the long rule three slots and the
short rule three more and the replay runs six positions where the desk runs three, on twice
the risk, with every figure downstream of it inflated.

A silent error here does not crash — it produces a plausible P&L that is wrong, which is the worst
failure a backtest has. That is what these are for.

## Install on the VPS

```
cd <the MO1 repo on the VPS>
sudo bash app/scripts/backtest/deploy/install.sh
```

Creates `/opt/backtest` with a venv and logs, copies `DATABASE_URL` across from the downloader's
own `.env` where it can, and installs `backtest-worker.service`. The worker is a separate service
from the downloader on purpose: a three-month backtest must not delay the nightly download, and a
download failure must not stop a backtest.

```
sudo journalctl -u backtest-worker -f
```
