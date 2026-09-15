/**
 * Rate-limit gates for the Kite REST endpoints. Kite publishes a separate limit
 * per family — quote is 1 req/sec, historical candles 3 req/sec — so each gets
 * its own gate rather than one shared budget that would throttle the faster one
 * down to the slower.
 *
 * Two priority tiers, because the nightly EOD scan queues 184 historical calls
 * back to back. On a single FIFO queue an interactive chart request arriving
 * mid-scan would sit behind all of them for a minute. Foreground drains first;
 * background only moves when nothing interactive is waiting.
 *
 * Only the *starts* are spaced — the limit is on request rate, not concurrency,
 * so a slow response never delays the next slot.
 */

type Task = () => void;

class Gate {
  private foreground: Task[] = [];
  private background: Task[] = [];
  private last = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly minGapMs: number) {}

  run<T>(work: () => Promise<T>, opts?: { background?: boolean }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        work().then(resolve, reject);
      };
      if (opts?.background) this.background.push(task);
      else this.foreground.push(task);
      this.pump();
    });
  }

  /** Queue depth, so a caller can report progress without reaching inside. */
  pending(): number {
    return this.foreground.length + this.background.length;
  }

  private pump(): void {
    if (this.timer) return;
    if (this.foreground.length === 0 && this.background.length === 0) return;

    const wait = Math.max(0, this.last + this.minGapMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const task = this.foreground.shift() ?? this.background.shift();
      if (task) {
        this.last = Date.now();
        task();
      }
      this.pump();
    }, wait);
  }
}

/**
 * Pinned to globalThis so Next's dev hot reload keeps one gate per limit. Two
 * module instances would each think they owned the whole budget and together
 * double the request rate.
 */
const globalRef = globalThis as typeof globalThis & {
  __kiteGates?: { history: Gate; quote: Gate };
};

globalRef.__kiteGates ??= {
  // 350ms and 1100ms rather than 333/1000 — a little headroom absorbs clock
  // jitter, and tripping the limit costs far more than the milliseconds do.
  history: new Gate(350),
  quote: new Gate(1100),
};

export const historyGate = globalRef.__kiteGates.history;
export const quoteGate = globalRef.__kiteGates.quote;
