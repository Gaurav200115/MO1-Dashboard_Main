"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gapPct } from "./eod/confluence";
import type { PivotLabel } from "./eod/pivots";
import type { EodReport } from "./eod/types";
import { isArmed, watchLevels } from "./eod/watch";
import type { Quote } from "./types";

export interface Alert {
  id: string;
  symbol: string;
  name: string;
  kind: "support" | "resistance";
  pivot: PivotLabel;
  level: number;
  /** Price at the moment the level armed, kept so the log is not rewritten by later ticks. */
  ltp: number;
  gapPct: number;
  at: number;
}

export interface AlertsResult {
  alerts: Alert[];
  /** Levels currently inside the band, for live marking in Today's Special. */
  armed: Set<string>;
  unread: number;
  markRead: () => void;
}

const MAX_ALERTS = 100;

/**
 * Fires once per level per browser session. Price hovering inside the band would
 * otherwise re-trigger twice a second for as long as it stayed there, so the
 * dedupe set is the whole reason this is a hook and not a derived value.
 */
export function useAlerts(report: EodReport | null, quotes: Record<string, Quote>): AlertsResult {
  const levels = useMemo(() => watchLevels(report), [report]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [readCount, setReadCount] = useState(0);
  const fired = useRef(new Set<string>());

  // A fresh report is a fresh day: the old day's levels must be able to fire again.
  useEffect(() => {
    fired.current = new Set();
    setAlerts([]);
    setReadCount(0);
  }, [report?.basedOn]);

  const armed = useMemo(() => {
    const inside = new Set<string>();
    for (const level of levels) {
      const quote = quotes[level.symbol];
      if (quote && isArmed(quote.ltp, level.value)) inside.add(level.id);
    }
    return inside;
  }, [levels, quotes]);

  useEffect(() => {
    const fresh: Alert[] = [];

    for (const level of levels) {
      if (!armed.has(level.id) || fired.current.has(level.id)) continue;
      const quote = quotes[level.symbol];
      if (!quote) continue;

      fired.current.add(level.id);
      fresh.push({
        id: level.id,
        symbol: level.symbol,
        name: level.name,
        kind: level.kind,
        pivot: level.pivot,
        level: level.value,
        ltp: quote.ltp,
        gapPct: gapPct(quote.ltp, level.value),
        at: Date.now(),
      });
    }

    if (fresh.length > 0) {
      setAlerts((current) => [...fresh, ...current].slice(0, MAX_ALERTS));
    }
  }, [armed, levels, quotes]);

  const markRead = useCallback(() => setReadCount(alerts.length), [alerts.length]);

  return { alerts, armed, unread: Math.max(0, alerts.length - readCount), markRead };
}
