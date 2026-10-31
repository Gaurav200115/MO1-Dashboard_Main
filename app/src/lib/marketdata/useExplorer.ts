"use client";

import { useEffect, useState } from "react";
import type { Reply } from "./types";

/**
 * One /api/explorer read. `query` null means "nothing to ask yet". A newer query cancels the
 * older one, so flicking through months never paints a stale answer over a fresh one.
 */
export function useExplorer<T>(query: string | null): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ query: string | null; data: T | null; error: string | null }>({
    query: null,
    data: null,
    error: null,
  });

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    fetch(`/api/explorer?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as Reply<T>;
        setState(
          body.available
            ? { query, data: body.data, error: null }
            : { query, data: null, error: body.reason }
        );
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setState({ query, data: null, error: err.message });
      });
    return () => controller.abort();
  }, [query]);

  const current = state.query === query;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: Boolean(query) && !current,
  };
}

export function q(params: Record<string, string | number | null | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") out.set(k, String(v));
  return out.toString();
}
