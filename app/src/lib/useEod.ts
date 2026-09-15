"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EodReport } from "./eod/types";

export interface EodResult {
  report: EodReport | null;
  loading: boolean;
  error: string | null;
}

interface ReportMeta {
  basedOn: string;
  generatedAt: number;
  verifiedAt: number | null;
}

/** Slow on purpose — the report changes at most twice a day. */
const POLL_MS = 120_000;

function stamp(meta: ReportMeta | null): string {
  return meta ? `${meta.basedOn}:${meta.generatedAt}:${meta.verifiedAt ?? 0}` : "none";
}

/**
 * Loaded client-side rather than on the server so the desk page stays
 * statically prerendered — the report is runtime state that changes every
 * evening, and reading it during render would bake one evening's levels into
 * the build.
 *
 * Re-checked on a slow poll and on refocus, because the overnight verification
 * replaces the levels in place. A tab left open across that boundary would
 * otherwise keep showing pivots computed from a provisional close — not merely
 * stale, but wrong by around the width of the confluence band.
 */
export function useEod(): EodResult {
  const [report, setReport] = useState<EodReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<string>("none");
  const alive = useRef(true);

  const loadFull = useCallback(async () => {
    const response = await fetch("/api/eod");
    if (!response.ok) throw new Error(`Report unavailable (${response.status})`);
    const payload = (await response.json()) as { report: EodReport | null };
    if (!alive.current) return;
    setReport(payload.report);
    current.current = stamp(
      payload.report
        ? {
            basedOn: payload.report.basedOn,
            generatedAt: payload.report.generatedAt,
            verifiedAt: payload.report.verifiedAt,
          }
        : null
    );
  }, []);

  useEffect(() => {
    alive.current = true;

    loadFull()
      .catch((err: unknown) => {
        if (alive.current) setError(err instanceof Error ? err.message : "Report unavailable");
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });

    const check = async () => {
      try {
        const response = await fetch("/api/eod?meta=1");
        if (!response.ok) return;
        const { meta } = (await response.json()) as { meta: ReportMeta | null };
        if (alive.current && stamp(meta) !== current.current) await loadFull();
      } catch {
        // a missed poll is harmless; the next one picks it up
      }
    };

    const timer = setInterval(check, POLL_MS);
    window.addEventListener("focus", check);

    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [loadFull]);

  return { report, loading, error };
}
