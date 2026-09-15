"use client";

import { useEffect, useState } from "react";
import type { Quote } from "./types";

export type ConnectionStatus =
  | "unconfigured"
  | "no-session"
  | "connecting"
  | "live"
  | "reconnecting"
  | "stopped"
  | "error";

export interface FeedSnapshot {
  status: ConnectionStatus;
  detail: string | null;
  subscribed: number;
  unresolved: string[];
  lastTickAt: number | null;
}

export interface QuotesResult {
  quotes: Record<string, Quote>;
  feed: FeedSnapshot;
}

const INITIAL: FeedSnapshot = {
  status: "connecting",
  detail: null,
  subscribed: 0,
  unresolved: [],
  lastTickAt: null,
};

/**
 * Subscribes to the coalesced quote stream. EventSource handles reconnection
 * itself, so there is no retry logic here — a dropped stream reopens and the
 * server replays a fresh snapshot.
 */
export function useQuotes(): QuotesResult {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [feed, setFeed] = useState<FeedSnapshot>(INITIAL);

  useEffect(() => {
    const source = new EventSource("/api/quotes/stream");

    // The server already coalesced this batch, so one setState per batch is the
    // whole cost — never one per symbol.
    const merge = (incoming: Quote[]) => {
      if (incoming.length === 0) return;
      setQuotes((current) => {
        const next = { ...current };
        for (const quote of incoming) next[quote.symbol] = quote;
        return next;
      });
    };

    source.addEventListener("snapshot", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        state: FeedSnapshot;
        quotes: Quote[];
      };
      setFeed(payload.state);
      const seeded: Record<string, Quote> = {};
      for (const quote of payload.quotes) seeded[quote.symbol] = quote;
      setQuotes(seeded);
    });

    source.addEventListener("quotes", (event) => {
      merge(JSON.parse((event as MessageEvent<string>).data) as Quote[]);
    });

    source.addEventListener("state", (event) => {
      setFeed(JSON.parse((event as MessageEvent<string>).data) as FeedSnapshot);
    });

    source.onerror = () => {
      // EventSource is already retrying; reflect it without clearing prices.
      setFeed((current) =>
        current.status === "live" ? { ...current, status: "reconnecting" } : current
      );
    };

    return () => source.close();
  }, []);

  return { quotes, feed };
}
