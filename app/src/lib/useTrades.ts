"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineSnapshot, StrategyDefinition, StrategyTrade, TradeDaySummary } from "./strategy/types";
import { istDate } from "./strategy/ist";

export interface TradesResult {
  trades: StrategyTrade[];
  days: TradeDaySummary[];
  strategies: StrategyDefinition[];
  engines: EngineSnapshot[];
  date: string;
  loading: boolean;
  error: string | null;
  configured: boolean;
  select: (date: string) => void;
  refresh: () => void;
}

/**
 * Polled rather than streamed.
 *
 * The quote stream already has its own SSE connection and a 500ms coalescer, and
 * a second one for a blotter that changes a handful of times a session would be
 * a lot of plumbing for very little. The poll is fast while a position is open —
 * a trailing stop moving is the one thing worth seeing promptly — and slows to a
 * crawl once nothing is live.
 */
const POLL_LIVE_MS = 5_000;
const POLL_IDLE_MS = 60_000;

export function useTrades(enabled: boolean): TradesResult {
  const [trades, setTrades] = useState<StrategyTrade[]>([]);
  const [days, setDays] = useState<TradeDaySummary[]>([]);
  const [strategies, setStrategies] = useState<StrategyDefinition[]>([]);
  const [engines, setEngines] = useState<EngineSnapshot[]>([]);
  const [date, setDate] = useState<string>(() => istDate());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  // The catalogue is static for the life of the build; fetching it once is enough.
  useEffect(() => {
    if (!enabled || strategies.length > 0) return;
    let cancelled = false;
    fetch("/api/strategies")
      .then((response) => response.json() as Promise<{ strategies?: StrategyDefinition[] }>)
      .then((payload) => {
        if (!cancelled) setStrategies(payload.strategies ?? []);
      })
      .catch(() => {
        // The blotter is still readable without the rule text beside it.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, strategies.length]);

  const load = useCallback(async (): Promise<boolean> => {
    const [tradesResponse, daysResponse, engineResponse] = await Promise.all([
      fetch(`/api/trades?date=${encodeURIComponent(date)}`),
      fetch("/api/trades?days=1"),
      fetch("/api/strategy"),
    ]);

    const tradesPayload = (await tradesResponse.json()) as {
      trades?: StrategyTrade[];
      configured?: boolean;
      error?: string;
    };
    const daysPayload = (await daysResponse.json()) as { days?: TradeDaySummary[] };
    const enginePayload = (await engineResponse.json()) as { engines?: EngineSnapshot[] };

    if (!alive.current) return false;

    setConfigured(tradesPayload.configured !== false);
    if (tradesPayload.error) throw new Error(tradesPayload.error);

    const list = tradesPayload.trades ?? [];
    setTrades(list);
    setDays(daysPayload.days ?? []);
    setEngines(enginePayload.engines ?? []);
    setError(null);

    return list.some((trade) => trade.status === "open");
  }, [date]);

  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    setLoading(true);

    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      load()
        .then((anyOpen) => {
          if (!alive.current) return;
          timer = setTimeout(tick, anyOpen ? POLL_LIVE_MS : POLL_IDLE_MS);
        })
        .catch((err: unknown) => {
          if (!alive.current) return;
          setError(err instanceof Error ? err.message : "Could not load trades");
          timer = setTimeout(tick, POLL_IDLE_MS);
        })
        .finally(() => {
          if (alive.current) setLoading(false);
        });
    };

    tick();

    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, load, nonce]);

  const select = useCallback((next: string) => setDate(next), []);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    trades,
    days,
    strategies,
    engines,
    date,
    loading,
    error,
    configured,
    select,
    refresh,
  };
}
