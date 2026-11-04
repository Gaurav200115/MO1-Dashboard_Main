"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteSource, TradeNote } from "./strategy/notes";

export interface TagCount {
  tag: string;
  count: number;
  starter: boolean;
}

export interface NoteTarget {
  id: string;
  source: NoteSource;
  runId?: string | null;
  tradingDate?: string | null;
  symbol?: string | null;
}

export interface TradeNotes {
  notes: Record<string, TradeNote>;
  tags: TagCount[];
  loading: boolean;
  error: string | null;
  configured: boolean;
  /** Writes one trade's tags and comment. Clearing both removes the note. */
  save: (target: NoteTarget, tags: string[], comment: string | null) => Promise<void>;
  refresh: () => void;
}

/**
 * Trade tags and comments, loaded once for a view and written one trade at a
 * time.
 *
 * Not polled. These change only when *you* change them, so there is nothing to
 * watch for — and a poll would fight the optimistic update below, making a tag
 * you just added flicker off and back as a stale response landed.
 *
 * Writes are applied locally first and reconciled from the reply. A tag is a
 * judgement you are in the middle of making; waiting on a round trip to see it
 * appear makes tagging a row at a time feel broken.
 */
export function useTradeNotes(enabled: boolean, runId?: string | null): TradeNotes {
  const [notes, setNotes] = useState<Record<string, TradeNote>>({});
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);

    const url = runId ? `/api/trade-notes?run=${encodeURIComponent(runId)}` : "/api/trade-notes";
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!alive.current) return;
        setNotes(body.notes ?? {});
        setTags(body.tags ?? []);
        setConfigured(body.configured !== false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive.current) setError(err instanceof Error ? err.message : "Could not load tags");
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
  }, [enabled, runId, nonce]);

  const save = useCallback(
    async (target: NoteTarget, nextTags: string[], comment: string | null) => {
      const previous = notes[target.id];

      // Optimistic: show it immediately, put it back if the write fails.
      setNotes((current) => {
        const next = { ...current };
        if (nextTags.length === 0 && !comment) delete next[target.id];
        else
          next[target.id] = {
            _id: target.id,
            tags: nextTags,
            comment: comment ?? null,
            source: target.source,
            runId: target.runId ?? null,
            tradingDate: target.tradingDate ?? null,
            symbol: target.symbol ?? null,
            updatedAt: new Date(),
          };
        return next;
      });

      try {
        const response = await fetch("/api/trade-notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...target, tags: nextTags, comment }),
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);

        if (!alive.current) return;
        setNotes((current) => {
          const next = { ...current };
          if (body.note) next[target.id] = body.note;
          else delete next[target.id];
          return next;
        });
        if (body.tags) setTags(body.tags);
        setError(null);
      } catch (err) {
        if (!alive.current) return;
        setNotes((current) => {
          const next = { ...current };
          if (previous) next[target.id] = previous;
          else delete next[target.id];
          return next;
        });
        setError(err instanceof Error ? err.message : "Could not save the tag");
      }
    },
    [notes]
  );

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { notes, tags, loading, error, configured, save, refresh };
}
