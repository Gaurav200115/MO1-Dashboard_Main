"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RotationView } from "./sector/rotation";
import type { ChainAnchor, SeriesMeta } from "./sector/types";

export interface SectorsMeta extends SeriesMeta {
  sessions: number;
}

export interface SectorsResult {
  anchor: ChainAnchor | null;
  rotation: RotationView | null;
  meta: SectorsMeta | null;
  loading: boolean;
  error: string | null;
  /** No chain on disk yet — the backfill has never run. */
  missing: boolean;
}

/**
 * The chain extends once a day, so this polls at the same slow cadence as the
 * EOD report and refreshes on focus. A tab left open overnight would otherwise
 * keep chaining today live move onto the session before last, which is the one
 * way this index can go wrong quietly.
 */
const POLL_MS = 120_000;

export function useSectors(): SectorsResult {
  const [anchor, setAnchor] = useState<ChainAnchor | null>(null);
  const [rotation, setRotation] = useState<RotationView | null>(null);
  const [meta, setMeta] = useState<SectorsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const response = await fetch("/api/sectors");
    if (!response.ok) throw new Error(`Sector history unavailable (${response.status})`);
    const payload = (await response.json()) as {
      anchor?: ChainAnchor | null;
      rotation?: RotationView | null;
      meta?: SectorsMeta | null;
      reason?: string;
    };
    if (!alive.current) return;

    setMissing(payload.reason === "no-history");
    setAnchor(payload.anchor ?? null);
    setRotation(payload.rotation ?? null);
    setMeta(payload.meta ?? null);
  }, []);

  useEffect(() => {
    alive.current = true;

    const refresh = () =>
      load()
        .then(() => {
          if (alive.current) setError(null);
        })
        .catch((err: unknown) => {
          if (alive.current) {
            setError(err instanceof Error ? err.message : "Sector history unavailable");
          }
        })
        .finally(() => {
          if (alive.current) setLoading(false);
        });

    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);

    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  return { anchor, rotation, meta, loading, error, missing };
}
