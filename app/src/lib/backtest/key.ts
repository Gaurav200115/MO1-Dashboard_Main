import { createHash } from "node:crypto";

/**
 * A backtest run's id, from the three things the person actually chose: which
 * legs to replay, and over what dates.
 *
 * The other half of `run_key` in app/scripts/backtest/backtest/runner.py, and
 * it has to agree with it exactly — the dashboard queues runs under this id and
 * the worker reads them back under the same one. If the two ever disagree,
 * nothing errors: "you have already run this" simply stops working, and every
 * repeat quietly replays from scratch. `tests/test_session.py` pins the Python
 * side to this same sha1 so the pair cannot drift unnoticed.
 *
 * Deliberately not a hash of everything that decides the result. The dashboard
 * has no reach into the PostgreSQL archive, so it cannot know how much data
 * exists — and a key including that could only ever be computed on the VPS,
 * which would mean the screen could not answer "already run" until the worker
 * had picked the job up. What the key leaves out is recorded on the run instead
 * (`dataRevision`, `gateFloors`, the rule versions) and shown beside it.
 */
export function runKey(setupIds: string[], from: string, to: string): string {
  const base = [[...setupIds].sort().join(","), from, to].join("|");
  return createHash("sha1").update(base, "utf8").digest("hex").slice(0, 16);
}
