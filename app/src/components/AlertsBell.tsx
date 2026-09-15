"use client";

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { fmtPrice, grouped } from "@/lib/format";
import type { Alert } from "@/lib/useAlerts";
import type { FeedSnapshot } from "@/lib/useQuotes";

/**
 * In-app only, by choice — no browser notification, so nothing fires when the
 * tab is closed and the list lives for as long as the tab does.
 */
export default function AlertsBell({
  alerts,
  unread,
  markRead,
  feed,
  onOpen,
}: {
  alerts: Alert[];
  unread: number;
  markRead: () => void;
  feed: FeedSnapshot;
  onOpen: (symbol: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  function toggle() {
    setOpen((was) => {
      if (!was) markRead();
      return !was;
    });
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={`Alerts${unread > 0 ? `, ${unread} new` : ""}`}
        aria-expanded={open}
        className="relative flex h-[26px] w-[26px] items-center justify-center rounded-md border border-line bg-sunken"
      >
        <Bell size={13} className={unread > 0 ? "text-alert" : "text-muted"} aria-hidden />
        {unread > 0 ? (
          <span className="tnum absolute -right-1 -top-1 min-w-[15px] rounded-full bg-alert px-1 text-[9px] font-bold leading-[15px] text-ground">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-[32px] z-40 w-[330px] overflow-hidden rounded-md border border-line bg-surface shadow-lg">
          <div className="flex items-baseline gap-2 border-b border-line px-3 py-2">
            <h3 className="font-display text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
              Level alerts
            </h3>
            <span className="ml-auto text-[10px] text-faint">
              {feed.status === "live" ? "Live tape" : `Feed ${feed.status}`}
            </span>
          </div>

          {alerts.length === 0 ? (
            <p className="px-3 py-4 text-[11.5px] leading-relaxed text-muted">
              Nothing yet. An alert fires once when price closes to within 0.3–0.8% of a confirmed
              level — the same band that confirmed it against the option chain.
            </p>
          ) : (
            <ul className="max-h-[340px] overflow-y-auto">
              {alerts.map((alert) => (
                <li key={`${alert.id}-${alert.at}`} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(alert.symbol);
                      setOpen(false);
                    }}
                    className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-surface2"
                  >
                    <span
                      className={`font-mono text-[10px] font-bold ${
                        alert.kind === "support" ? "text-pos" : "text-neg"
                      }`}
                    >
                      {alert.kind === "support" ? "S" : "R"}
                    </span>
                    <span className="font-mono text-[11.5px] font-semibold">{alert.symbol}</span>
                    <span className="text-[10px] text-muted">{alert.pivot}</span>
                    <span className="tnum ml-auto font-mono text-[11px]">
                      {fmtPrice(alert.level)}
                    </span>
                  </button>
                  <p className="px-3 pb-2 text-[10px] text-faint">
                    approached at {fmtPrice(alert.ltp)} · {grouped(alert.gapPct, 2)}% away ·{" "}
                    {new Date(alert.at).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
