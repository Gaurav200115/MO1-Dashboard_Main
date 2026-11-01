# Strategy backtest

Replays the desk's rules over the market-data archive on the VPS, and writes the trades to
MongoDB in the same shape as live trades — so the existing Trade Analysis page reads a backtest
with no new screens.

Built to `DATA/BACKTEST-PLAN.md`. Where this code departs from that document, the reason is in
the module that departs; the two known ones are listed under **Departures from the plan** below.

## Running it

From this folder (`/opt/backtest` on the VPS, where `venv/bin/python` is the interpreter):

```
python run.py check                         the strategy mirror, and both databases
python run.py coverage                      what the archive actually holds
python run.py levels  --day 2026-10-15      the overnight levels for one session
python run.py session --day 2026-10-15      replay one session and print the trades
python run.py now   --from A --to B         replay a range here and now
python run.py queue --from A --to B         hand it to the worker instead
```

`check`, `coverage`, `levels` and `session` write nothing. `now` and `queue` write to Mongo.

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

## Tests

No database and no network — the pure parts of the engine, plus one whole session replayed against
a stand-in archive:

```
python tests/test_core.py        the rule: ladder, EMA, levels, all three setups
python tests/test_fills.py       stops, the flatten, and the edge of the archive
python tests/test_session.py     one session end to end, the gate, run identity
python tests/test_strategies.py  every leg: A, B and C apart and together, and the shared cap
```

185 checks. `test_strategies.py` is the one that keeps the pair honest: each rule can be
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
