import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isConfigured, mongoMessage } from "@/lib/mongo";
import { shadowsBetween } from "@/lib/strategy/shadowAtr";
import { tradesBetween } from "@/lib/strategy/store";
import { istDate } from "@/lib/strategy/ist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ATR600 paper forward test (lib/strategy/shadowAtr.ts), read-only.
 *
 *   GET /api/paper-shadow?from=YYYY-MM-DD&to=YYYY-MM-DD   default: the last 30 days
 *
 * Each shadow comes with its paper trade's own result, so the page can put the
 * desk's exit and the ATR600 exit side by side, trade by trade.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const today = istDate();
  const fromParam = request.nextUrl.searchParams.get("from") ?? "";
  const toParam = request.nextUrl.searchParams.get("to") ?? "";
  const to = DATE.test(toParam) ? toParam : today;
  const from = DATE.test(fromParam) ? fromParam : istDate(Date.now() - 30 * 86_400_000);

  try {
    const [shadows, trades] = await Promise.all([shadowsBetween(from, to), tradesBetween(from, to)]);
    const byId = new Map(trades.map((t) => [t._id, t]));
    const rows = shadows.map((shadow) => {
      const paper = byId.get(shadow.tradeId);
      return {
        shadow,
        paper: paper
          ? { profit: paper.profit, status: paper.status, reason: paper.sell?.reason ?? null,
              exitPrice: paper.sell?.price ?? null, exitAt: paper.sell?.at ?? null }
          : null,
      };
    });
    return NextResponse.json({ configured: isConfigured(), from, to, rows }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { configured: isConfigured(), error: mongoMessage(err) },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}
