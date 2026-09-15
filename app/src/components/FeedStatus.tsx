"use client";

import type { FeedSnapshot } from "@/lib/useQuotes";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** NSE continuous session, 09:15–15:30 IST, Monday to Friday. */
function marketOpen(now = Date.now()): boolean {
  const ist = new Date(now + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

function clockIST(ts: number): string {
  return new Date(ts + IST_OFFSET_MS).toISOString().slice(11, 19);
}

export default function FeedStatus({ feed }: { feed: FeedSnapshot }) {
  const needsLogin = feed.status === "no-session" || feed.status === "unconfigured";

  if (needsLogin) {
    return (
      <a
        href="/api/kite/login"
        className="flex items-center gap-1.5 rounded-[3px] border border-alert bg-alertsoft px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-alert"
        title={feed.detail ?? undefined}
      >
        <span className="h-[6px] w-[6px] rounded-full bg-alert" aria-hidden />
        {feed.status === "unconfigured" ? "No credentials" : "Connect Kite"}
      </a>
    );
  }

  const open = marketOpen();
  const live = feed.status === "live";

  const tone = live
    ? open
      ? "border-pos text-pos"
      : "border-linestrong text-muted"
    : feed.status === "error"
      ? "border-neg text-neg"
      : "border-linestrong text-muted";

  const label = !live
    ? feed.status === "reconnecting"
      ? "Reconnecting"
      : feed.status === "error"
        ? "Feed error"
        : "Connecting"
    : open
      ? "Live"
      : "Market closed";

  return (
    <span
      className={`flex items-center gap-1.5 rounded-[3px] border px-2 py-1 text-[10px] uppercase tracking-[0.09em] ${tone}`}
      title={feed.detail ?? undefined}
    >
      <span
        className={`h-[6px] w-[6px] rounded-full ${
          live && open
            ? "bg-pos animate-report-pulse"
            : feed.status === "error"
              ? "bg-neg"
              : "bg-muted"
        }`}
        aria-hidden
      />
      <span className="font-semibold">{label}</span>
      {feed.subscribed > 0 ? (
        <span className="font-mono normal-case tracking-normal opacity-70">
          {feed.subscribed}
          {feed.unresolved.length > 0 ? (
            <span
              className="text-alert"
              title={`No NSE equity match: ${feed.unresolved.join(", ")}`}
            >
              {" "}
              −{feed.unresolved.length}
            </span>
          ) : null}
        </span>
      ) : null}
      {feed.lastTickAt ? (
        <span className="font-mono normal-case tracking-normal opacity-50">
          {clockIST(feed.lastTickAt)}
        </span>
      ) : null}
    </span>
  );
}
