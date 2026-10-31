import { NextResponse, type NextRequest } from "next/server";
import { marketdataConfigured } from "@/lib/marketdata/db";
import {
  chainDay,
  monthDetail,
  oiMonth,
  optionBars,
  optionContracts,
  overview,
  spotBars,
  TooManyBars,
} from "@/lib/marketdata/queries";
import type { Timeframe } from "@/lib/marketdata/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The market-data archive, read-only, for the History analysis pages.
 *
 *   GET /api/explorer?view=overview                                   months, VIX range
 *   GET /api/explorer?view=month&month=2026-09                         that month's top 100
 *   GET /api/explorer?view=bars&symbol=SBIN&from=..&to=..&tf=5         spot / NIFTY / INDIA VIX
 *   GET /api/explorer?view=contracts&symbol=SBIN&from=..&to=..         option contracts with minute data
 *   GET /api/explorer?view=option&symbol=..&expiry=..&strike=..&type=CE&from=..&to=..&tf=..
 *   GET /api/explorer?view=chain&symbol=SBIN&date=2026-09-15[&expiry=..]   end-of-day chain
 *   GET /api/explorer?view=oi&symbol=SBIN&month=2026-09                OI day by day
 *
 * Answers { available: true, data } or { available: false, reason } — the same handled
 * not-available shape /api/marketdata uses, so an unconfigured desk reads as a message.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const SYMBOL = /^[A-Z0-9&\- ]{1,30}$/;
const TIMEFRAMES: Timeframe[] = ["1", "5", "15", "60", "D"];

class BadRequest extends Error {}

function need(params: URLSearchParams, key: string, pattern: RegExp): string {
  const value = params.get(key)?.trim() ?? "";
  if (!pattern.test(value)) throw new BadRequest(`Missing or malformed "${key}"`);
  return value;
}

function timeframe(params: URLSearchParams): Timeframe {
  const tf = (params.get("tf") ?? "1") as Timeframe;
  if (!TIMEFRAMES.includes(tf)) throw new BadRequest(`"tf" must be one of ${TIMEFRAMES.join(", ")}`);
  return tf;
}

async function answer(params: URLSearchParams): Promise<unknown> {
  switch (params.get("view")) {
    case "overview":
      return overview();
    case "month":
      return monthDetail(need(params, "month", MONTH));
    case "bars":
      return spotBars(need(params, "symbol", SYMBOL), need(params, "from", DAY), need(params, "to", DAY), timeframe(params));
    case "contracts":
      return optionContracts(need(params, "symbol", SYMBOL), need(params, "from", DAY), need(params, "to", DAY));
    case "option": {
      const strike = Number(params.get("strike"));
      const type = params.get("type");
      if (!Number.isFinite(strike) || strike <= 0) throw new BadRequest('Missing or malformed "strike"');
      if (type !== "CE" && type !== "PE") throw new BadRequest('"type" must be CE or PE');
      return optionBars(
        need(params, "symbol", SYMBOL),
        need(params, "expiry", DAY),
        strike,
        type,
        need(params, "from", DAY),
        need(params, "to", DAY),
        timeframe(params)
      );
    }
    case "chain":
      return chainDay(
        need(params, "symbol", SYMBOL),
        need(params, "date", DAY),
        params.get("expiry") && DAY.test(params.get("expiry")!) ? params.get("expiry") : null
      );
    case "oi":
      return oiMonth(need(params, "symbol", SYMBOL), need(params, "month", MONTH));
    default:
      throw new BadRequest('"view" must be overview, month, bars, contracts, option, chain or oi');
  }
}

export async function GET(request: NextRequest) {
  const headers = { "cache-control": "no-store" };
  if (!marketdataConfigured()) {
    return NextResponse.json(
      {
        available: false,
        reason:
          "The market-data archive is not connected: set MARKETDATA_DATABASE_URL (a read-only login) in .env.local.",
      },
      { headers }
    );
  }
  try {
    return NextResponse.json({ available: true, data: await answer(request.nextUrl.searchParams) }, { headers });
  } catch (err) {
    if (err instanceof BadRequest) {
      return NextResponse.json({ available: false, reason: err.message }, { status: 400, headers });
    }
    if (err instanceof TooManyBars) {
      return NextResponse.json({ available: false, reason: err.message }, { headers });
    }
    console.error("[explorer]", err);
    return NextResponse.json(
      { available: false, reason: `Could not read the archive: ${(err as Error).message}` },
      { headers }
    );
  }
}
