import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { fetchHistory, NoSessionError, RANGES, type Range } from "@/lib/kite/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("symbol")?.trim().toUpperCase();
  const range = request.nextUrl.searchParams.get("range") as Range | null;

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }
  if (!range || !RANGES.includes(range)) {
    return NextResponse.json(
      { error: `range must be one of ${RANGES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await fetchHistory(symbol, range);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof NoSessionError) {
      return NextResponse.json({ error: err.message, needsLogin: true }, { status: 401 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load candles" },
      { status: 502 }
    );
  }
}
