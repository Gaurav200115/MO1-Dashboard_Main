"""Writing a run and its trades to MongoDB.

A backtest trade is stored in **the same shape as a live trade**, plus `runId`
and `gate`. That is the whole reason results go to Mongo rather than PostgreSQL:
the Trade Analysis page already knows how to filter, bucket and chart a
`strategy_trades` document, so a backtest trade in the same shape gets the pivot
filter, the "how far it ran" panel, the trailing what-if and the equity curve
with no new screens.

The shape is `StrategyTrade` in app/src/lib/strategy/types.ts. Two details from
there that are easy to get wrong and silently break the page:

  - `Fill.at`, `LadderStep.at` and `Retracement.at` are **epoch milliseconds**,
    not dates. `openedAt` and `closedAt` are real dates.
  - `exit.reason` lives on the `sell` object, not beside it.
"""
import datetime as dt

from pymongo import MongoClient, ReturnDocument, UpdateOne

from .config import mongo_db_name, need
from .strategies import STRATEGIES

RUNS = "backtest_runs"
TRADES = "backtest_trades"
META = "backtest_meta"


def client():
    return MongoClient(need("MONGO_CONNECTION_STRING"), serverSelectionTimeoutMS=20000)


def database(mongo):
    return mongo[mongo_db_name()]


def _ms(at):
    """Epoch milliseconds, the unit every `at` in a stored trade uses."""
    if at is None:
        return None
    if isinstance(at, dt.datetime):
        return int(at.timestamp() * 1000)
    return int(at)


def _tradingsymbol(symbol, expiry, strike, option_type):
    """A readable contract name.

    Synthesised rather than looked up: the live desk takes it from the Kite
    instrument dump, which the archive does not carry. It is a label on the
    row, and nothing keys off it.
    """
    return f"{symbol}{expiry:%y%b}".upper() + f"{strike:g}{option_type}"


def _level_doc(level):
    skew = level.skew()
    return {"pivot": level.pivot, "kind": level.kind, "value": level.pivot_value,
            "strike": level.strike,
            "skew": None if skew == float("inf") else skew,
            "gapPct": level.gap_pct}


def trade_document(position, run_id):
    """One closed position as a `strategy_trades`-shaped document."""
    strategy = STRATEGIES[position.strategy_id]
    # From the contract rather than the setup: every rule buys its option, so a
    # call is a long and a put a short - and the NIFTY opening-range leg trades
    # either, depending on which edge broke.
    side = "LONG" if position.option_type == "CE" else "SHORT"
    context = position.context

    return {
        "_id": f"{run_id}:{position.symbol}:{_ms(position.entry_at)}:{position.setup}",
        "runId": run_id,
        "gate": position.gate,

        "strategyId": position.strategy_id,
        "strategyVersion": position.strategy_version,
        "strategyName": strategy["name"],
        "setup": position.setup,
        "setupLabel": strategy["setupLabels"][position.setup],

        "tradingDate": position.trading_date,
        "symbol": position.symbol,
        "side": side,
        "instrument": {
            "tradingsymbol": _tradingsymbol(position.symbol, position.expiry,
                                            position.strike, position.option_type),
            "strike": position.strike,
            "type": position.option_type,
            "expiry": position.expiry.isoformat(),
            "lotSize": position.qty // strategy["risk"]["lots"],
        },
        "qty": position.qty,

        "buy": {"price": position.entry, "at": _ms(position.entry_at)},
        "sell": ({"price": position.exit_price, "at": _ms(position.exit_at),
                  "reason": position.exit_reason}
                 if position.exit_price is not None else None),
        "profit": position.profit,

        "stop": position.stop,
        "target": position.target,
        "step": position.step,
        "riskPerUnit": position.risk_per_unit,
        "riskCapped": position.risk_capped,

        "mtm": None,
        "status": "closed" if position.exit_price is not None else "open",
        "ladder": [{"at": _ms(s["at"]), "step": s["step"], "stop": s["stop"],
                    "target": s["target"], "locked": s["locked"]}
                   for s in position.ladder],
        "trigger": {
            "setup": position.setup,
            "level": {"pivot": context["pivot"], "kind": context["levelKind"],
                      "value": context["pivotValue"], "strike": context["levelStrike"],
                      "skew": context["skew"], "gapPct": context["gapPct"]},
            "basis": None,
            "crossedAt": None,
            "ema": context["emaAtEntry"],
            "retracement": (None if not context.get("retracement") else {
                "extreme": context["retracement"]["extreme"],
                "emaGapPct": context["retracement"]["emaGapPct"],
                "at": _ms(context["retracement"]["at"]),
                "turnPct": context["retracement"]["turnPct"]}),
            "spot": context["spotAtEntry"],
        },

        "paper": True,
        "openedAt": position.entry_at,
        "closedAt": position.exit_at,
    }


def find_run(db, run_id):
    return db[RUNS].find_one({"_id": run_id})


def queue_run(db, run_id, payload, setup_ids, start, end, requested_by=None):
    """Records a run as queued, unless it is already there.

    `$setOnInsert` so re-queuing an existing fingerprint is a no-op: that is
    what makes "this backtest has already been run" the default answer instead
    of a silent recompute.
    """
    db[RUNS].update_one(
        {"_id": run_id},
        {"$setOnInsert": {
            "_id": run_id,
            "setups": sorted(setup_ids),
            "strategyIds": [s["id"] for s in payload["strategies"]],
            "strategies": payload["strategies"],
            "from": str(start), "to": str(end),
            "fillRule": payload["fillRule"],
            "gateFloors": payload["floors"],
            "dataRevision": payload["dataRevision"],
            "conditions": payload["conditions"],
            "status": "queued",
            "progress": {"done": 0, "total": None, "day": None},
            "requestedBy": requested_by,
            "queuedAt": dt.datetime.now(dt.timezone.utc),
            "startedAt": None, "finishedAt": None, "error": None,
        }},
        upsert=True)
    return find_run(db, run_id)


def claim_run(db, run_id, force=False):
    """Claims one named run. None when it is not claimable.

    `claim_next` takes whatever is at the head of the queue, which is right for
    the worker and wrong for a foreground run - that one must take *its own*
    row or it would replay one range while marking another as running.
    """
    status = {"$in": ["queued", "done", "failed"]} if force else "queued"
    return db[RUNS].find_one_and_update(
        {"_id": run_id, "status": status},
        {"$set": {"status": "running",
                  "startedAt": dt.datetime.now(dt.timezone.utc),
                  "error": None}},
        return_document=ReturnDocument.AFTER)


def claim_next(db):
    """Takes one queued run and marks it running. None when there is nothing to do."""
    return db[RUNS].find_one_and_update(
        {"status": "queued"},
        {"$set": {"status": "running",
                  "startedAt": dt.datetime.now(dt.timezone.utc),
                  "error": None}},
        sort=[("queuedAt", 1)])


def record_conditions(db, run_id, payload):
    """Writes onto the run everything that decided its result but was not part of
    the id: the gate floors, the rule versions and how much of the archive existed.

    The id is only what was asked for, because the dashboard has to be able to
    compute it. These are what make a stale or differently-configured result
    visible instead of silently reused.
    """
    db[RUNS].update_one({"_id": run_id}, {"$set": {
        "gateFloors": payload["floors"],
        "dataRevision": payload["dataRevision"],
        "conditions": payload["conditions"],
        "fillRule": payload["fillRule"],
        "setupDetail": payload["setups"],
        "strategies": payload["strategies"],
    }})


def set_progress(db, run_id, done, total, day):
    db[RUNS].update_one({"_id": run_id},
                        {"$set": {"progress": {"done": done, "total": total,
                                               "day": str(day)}}})


def save_results(db, run_id, positions, report):
    """Writes the trades and finishes the run.

    Trades first, then the run is marked done: a reader that sees `done` can
    rely on every trade being there. Written with a deterministic `_id` and an
    upsert so a re-run of the same fingerprint replaces its own rows rather
    than doubling them.
    """
    if positions:
        db[TRADES].bulk_write(
            [UpdateOne({"_id": doc["_id"]}, {"$set": doc}, upsert=True)
             for doc in (trade_document(p, run_id) for p in positions)],
            ordered=False)

    db[RUNS].update_one({"_id": run_id}, {"$set": {
        "status": "done",
        "finishedAt": dt.datetime.now(dt.timezone.utc),
        "sessions": report["sessions"],
        "summary": report["summary"],
        "summaryExApprox": report["summaryExApprox"],
        "gateCounts": report["gateCounts"],
        "bySetup": report["bySetup"],
        "setups": report["setups"],
        "rejected": report["rejected"],
        "skipped": report["skipped"],
        "signals": report["signals"],
        "incompleteStockDays": report["incompleteStockDays"],
        "trades": report["summary"]["trades"],
        "error": None,
    }})


def fail_run(db, run_id, message):
    db[RUNS].update_one({"_id": run_id}, {"$set": {
        "status": "failed",
        "finishedAt": dt.datetime.now(dt.timezone.utc),
        "error": str(message)[:2000],
    }})


def ensure_indexes(db):
    db[TRADES].create_index("runId")
    db[TRADES].create_index([("runId", 1), ("tradingDate", 1)])
    db[RUNS].create_index([("status", 1), ("queuedAt", 1)])


def save_coverage(db, coverage):
    """Publishes what the archive holds, so the screen can show it.

    One document, overwritten. It is a snapshot of someone else's database, not
    a record worth keeping history of.
    """
    db[META].update_one(
        {"_id": "coverage"},
        {"$set": {"_id": "coverage", "coverage": coverage,
                  "updatedAt": dt.datetime.now(dt.timezone.utc)}},
        upsert=True)


def read_coverage(db):
    return db[META].find_one({"_id": "coverage"})
