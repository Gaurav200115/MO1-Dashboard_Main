import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { mongoMessage } from "@/lib/mongo";
import { runKey } from "@/lib/backtest/key";
import {
  deleteRun,
  ensureIndexes,
  getRun,
  isConfigured,
  listRuns,
  queueRun,
  readCoverage,
  runTrades,
} from "@/lib/backtest/store";
import { isKnownSetup, listSetups, mixError, strategiesFor } from "@/lib/backtest/setups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Backtest runs.
 *
 *   GET    /api/backtest                 every stored run, newest first
 *   GET    /api/backtest?run=<id>        one run with its trades
 *   POST   /api/backtest                 ask for a run: { strategies, from, to }
 *   DELETE /api/backtest?run=<id>        throw a run and its trades away
 *
 * Nothing here replays anything. A POST writes a `queued` row and returns; the
 * worker on the VPS is the only process with the archive in reach, and it picks
 * the row up within its poll interval. A twenty-minute replay has no business
 * inside a web request, and the 70 GB of minute data it reads has no business
 * being reachable from here.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("run")?.trim();

  try {
    if (id) {
      const run = await getRun(id);
      if (!run) {
        return NextResponse.json({ error: "no such run" }, { status: 404 });
      }
      return ok({ run, trades: run.status === "done" ? await runTrades(id) : [] });
    }

    const [runs, coverage] = await Promise.all([listRuns(), readCoverage()]);
    return ok({ runs, coverage, setups: listSetups() });
  } catch (err) {
    return NextResponse.json(
      { configured: isConfigured(), error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isConfigured()) {
    return NextResponse.json(
      { configured: false, error: "MONGO_CONNECTION_STRING is not set" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  let body: { setups?: unknown; from?: unknown; to?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.setups) ? body.setups.map(String) : [];
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";

  if (ids.length === 0) {
    return NextResponse.json({ error: "pick at least one setup" }, { status: 400 });
  }
  for (const id of ids) {
    if (!isKnownSetup(id)) {
      return NextResponse.json({ error: `unknown setup ${id}` }, { status: 400 });
    }
  }
  const mixed = mixError(ids);
  if (mixed) {
    return NextResponse.json({ error: mixed }, { status: 400 });
  }
  if (!DATE.test(from) || !DATE.test(to)) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "the start date is after the end date" }, { status: 400 });
  }

  try {
    await ensureIndexes();
    const id = runKey(ids, from, to);
    const setups = [...new Set(ids)].sort();
    const strategyIds = strategiesFor(setups);
    const catalogue = listSetups();
    const { run, created } = await queueRun(id, {
      setups,
      strategyIds,
      strategies: strategyIds.map((sid) => ({
        id: sid,
        version: catalogue.find((s) => s.strategy === sid)!.version,
      })),
      from,
      to,
      // Recorded by the worker, which is the only side that knows them. Placed
      // here so the shape of a queued row matches a finished one.
      fillRule: "entry-minute-close",
      gateFloors: {},
      dataRevision: "",
      requestedBy: null,
    });

    return ok({ run, created, queued: created || run.status === "queued" });
  } catch (err) {
    return NextResponse.json(
      { configured: true, error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("run")?.trim();
  if (!id) {
    return NextResponse.json({ error: "run is required" }, { status: 400 });
  }
  try {
    await deleteRun(id);
    return ok({ deleted: id });
  } catch (err) {
    return NextResponse.json(
      { configured: isConfigured(), error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

function ok(body: Record<string, unknown>) {
  return NextResponse.json(
    { configured: isConfigured(), ...body },
    { headers: { "cache-control": "no-store" } }
  );
}
