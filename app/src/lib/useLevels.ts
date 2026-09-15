"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionSummary, StoredDay } from "./eod/store";

export interface LevelsResult {
  sessions: SessionSummary[];
  session: string | null;
  days: StoredDay[];
  loading: boolean;
  error: string | null;
  configured: boolean;
  select: (session: string) => void;
}

/**
 * The archive is read on demand rather than with the desk — it is analysis, not
 * something every page load should pay for.
 */
export function useLevels(enabled: boolean): LevelsResult {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [days, setDays] = useState<StoredDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loadedList, setLoadedList] = useState(false);

  useEffect(() => {
    if (!enabled || loadedList) return;
    setLoadedList(true);
    setLoading(true);

    fetch("/api/levels")
      .then(async (response) => {
        const payload = (await response.json()) as {
          sessions?: SessionSummary[];
          configured?: boolean;
          error?: string;
        };
        if (!response.ok) {
          setConfigured(payload.configured !== false);
          throw new Error(payload.error ?? `Archive unavailable (${response.status})`);
        }
        const list = payload.sessions ?? [];
        setSessions(list);
        // Newest first from the server, so the first entry is the latest session.
        if (list.length > 0) setSession(list[0].session);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Archive unavailable");
      })
      .finally(() => setLoading(false));
  }, [enabled, loadedList]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);

    fetch(`/api/levels?session=${encodeURIComponent(session)}`)
      .then(async (response) => {
        const payload = (await response.json()) as { days?: StoredDay[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Could not load that session");
        if (!cancelled) {
          setDays(payload.days ?? []);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load that session");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  const select = useCallback((next: string) => setSession(next), []);

  return { sessions, session, days, loading, error, configured, select };
}
