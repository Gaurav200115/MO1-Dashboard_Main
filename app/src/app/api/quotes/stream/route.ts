import type { NextRequest } from "next/server";
import { getFeed } from "@/lib/kite/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events rather than a second WebSocket: the flow is one-way, the
 * browser reconnects on its own, and it rides the existing HTTP server without
 * an upgrade handshake.
 *
 * Events emitted:
 *   snapshot — every quote held, sent once on connect so the table fills at once
 *   quotes   — a coalesced batch of only the symbols that changed
 *   state    — feed status transitions (connecting, live, reconnecting, error)
 */
export async function GET(request: NextRequest) {
  const feed = getFeed();
  await feed.ensureStarted();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send("snapshot", { state: feed.state(), quotes: feed.snapshot() });

      const unsubscribe = feed.subscribe((event) => {
        if (event.type === "quotes") send("quotes", event.quotes);
        else send("state", event.state);
      });

      // Comment frames keep intermediaries from timing the connection out.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": hb\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed by the client going away
        }
      };

      request.signal.addEventListener("abort", shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
