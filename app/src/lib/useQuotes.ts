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
 * Subscribes to the coalesced quote stream.
 *
 * A dropped stream reopens on its own and the server replays a fresh snapshot,
 * so there is no retry logic here. A *rejected* one does not, which is the case
 * this hook has to handle itself: EventSource treats any non-200 as fatal —
 * the spec says fail the connection rather than reestablish it — so the auth
 * gate answering 401 closes the feed permanently, with no further attempts.
 * Left alone that shows up as a desk stuck on "reconnecting" with prices
 * quietly frozen at whatever they were when the session lapsed.
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
      // Still CONNECTING means the browser is retrying by itself — reflect that
      // without clearing prices, which is what the old comment described.
      if (source.readyState !== EventSource.CLOSED) {
        setFeed((current) =>
          current.status === "live" ? { ...current, status: "reconnecting" } : current
        );
        return;
      }

      /*
       * CLOSED is terminal. The overwhelmingly likely cause is the gate in
       * middleware.ts answering 401 on an expired session, so ask a cheap
       * endpoint which it was: a 401 sends you to sign in again, anything else
       * is a real server fault and says so rather than bouncing you to a login
       * page that would not have helped.
       */
      setFeed((current) => ({ ...current, status: "error", detail: "Feed disconnected" }));

      // /api/kite/session is the cheapest thing behind the gate — one file read
      // and an in-memory struct. /api/quotes would start the feed as a side
      // effect, which is not something a diagnostic probe should do.
      void fetch("/api/kite/session")
        .then((response) => {
          if (response.status === 401) {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/login?next=${next}`;
            return;
          }
          setFeed((current) => ({
            ...current,
            status: "error",
            detail: "Feed closed by the server. Reload to reconnect.",
          }));
        })
        .catch(() => {
          setFeed((current) => ({
            ...current,
            status: "error",
            detail: "Feed unreachable. Reload to reconnect.",
          }));
        });
    };

    return () => source.close();
  }, []);

  return { quotes, feed };
}
