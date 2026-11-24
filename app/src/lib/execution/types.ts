import type { ExitReason } from "@/lib/strategy/types";

/**
 * Real orders at Zerodha, following the paper engine.
 *
 * Paper always runs and stays the research record. When live orders are on,
 * each paper entry is also sent to Kite as a real order, and the paper trade's
 * stop, trail and exit are mirrored onto that real position. One signal, two
 * executions: the gap between them is the cost of the real market.
 */

/** What became of the entry order. Terminal states never change again. */
export type EntryStatus =
  | "sending"
  /** No reply - it may or may not be at Zerodha. Looked up by tag before anything else. */
  | "unknown"
  | "filled"
  /** Zerodha or NSE refused it - insufficient funds, IP not whitelisted, price band... */
  | "rejected"
  /** IOC found nobody at our price. */
  | "cancelled"
  /** The lookup by tag found nothing: it never reached Zerodha. */
  | "not-placed";

export type StopStatus =
  | "placing"
  /** Resting at the exchange, waiting for its trigger. */
  | "open"
  /** Filled: the position is out through its stop. */
  | "complete"
  /** Could not be placed - the position is exited instead. */
  | "failed"
  /** Modified into a sell at the bid to exit the position. */
  | "exiting";

export type LiveState =
  /** Entry order in flight. */
  | "entering"
  /** Filled and holding, protected by the exchange stop. */
  | "open"
  /** An exit has been asked for and is being worked. */
  | "closing"
  | "closed"
  /** The entry never filled - nothing was bought. */
  | "not-entered";

export interface LiveOrderRef {
  tag: string;
  orderId: string | null;
}

export interface LivePosition {
  /** The paper trade this mirrors - one paper trade has at most one live position. */
  tradeId: string;
  tradingDate: string;
  strategyId: string;
  setup: string;
  symbol: string;
  tradingsymbol: string;
  /** Units, lots x lot size. */
  qty: number;
  /** Premium per unit the paper trade risks - the desk's 550 over the lot. */
  riskPerUnit: number;
  /** The contract's price step; every price sent is rounded to it. Absent on positions from before 19 Nov. */
  tick?: number;
  state: LiveState;

  entry: LiveOrderRef & {
    /** The ask the paper entry was priced at. */
    ask: number;
    /** The limit sent: the ask plus 1% of the premium (at least two ticks). */
    price: number;
    status: EntryStatus;
    reason: string | null;
    filledQty: number;
    fillPrice: number | null;
    /** When the quote that priced it was read. */
    quoteAt: number;
    /** When the desk took the signal. */
    sentAt: number;
    /** When the order left for Kite, and when Kite answered with an order id. */
    placedAt: number | null;
    ackAt: number | null;
    doneAt: number | null;
    /**
     * An earlier IOC for this entry that was cancelled for want of a seller,
     * before the one chase. Only on entries from 19-24 Nov 2026: the chase was
     * removed when the first order took the whole 0.3R. Kept so old journals read.
     */
    tries?: {
      tag: string;
      orderId: string | null;
      ask: number;
      price: number;
      status: "cancelled";
      reason: string;
      quoteAt: number;
      sentAt: number;
      doneAt: number;
    }[];
  };

  stop:
    | (LiveOrderRef & {
        trigger: number;
        /** The worst price the stop accepts once triggered. */
        limit: number;
        status: StopStatus;
        reason: string | null;
        placedAt: number;
        /** Each modification, for the record - Kite caps how many an order may have. */
        modifications: number;
      })
    | null;

  exit:
    | (LiveOrderRef & {
        reason: ExitReason | "kill" | "stop-failed" | "gap-past-limit";
        requestedAt: number;
        /** The limit last sent. */
        price: number | null;
        fillPrice: number | null;
        attempts: number;
        doneAt: number | null;
      })
    | null;

  /** Realised P&L once closed, from the actual fill prices. */
  profit: number | null;
  updatedAt: number;
}

/** One order as the desk needs it from Kite's order book. */
export interface BrokerOrder {
  orderId: string;
  tag: string | null;
  status: string;
  statusMessage: string | null;
  filledQty: number;
  averagePrice: number;
  orderType: string;
  triggerPrice: number;
  price: number;
}

export interface BrokerPosition {
  tradingsymbol: string;
  exchange: string;
  product: string;
  /** Net quantity: positive long, zero flat. */
  quantity: number;
}

/**
 * Everything the desk asks of a broker. Kite in production; a stand-in in tests,
 * so the logic around real orders can be exercised without sending one.
 */
export interface Broker {
  /** Resolves with the order id. Rejects with a BrokerError. */
  placeOrder(order: {
    tradingsymbol: string;
    transactionType: "BUY" | "SELL";
    quantity: number;
    orderType: "LIMIT" | "SL";
    price: number;
    triggerPrice?: number;
    validity: "IOC" | "DAY";
    tag: string;
  }): Promise<string>;
  modifyOrder(
    orderId: string,
    change: { orderType?: "LIMIT" | "SL"; price?: number; triggerPrice?: number }
  ): Promise<void>;
  orderHistory(orderId: string): Promise<BrokerOrder[]>;
  orders(): Promise<BrokerOrder[]>;
  positions(): Promise<BrokerPosition[]>;
}

/**
 * Why a call failed, and - the one thing that matters for orders - whether the
 * order might have been placed anyway. `answered` is true when Kite replied
 * with an error: the request was refused and nothing was placed. False means no
 * reply arrived, so the order may be at Zerodha and must be looked up by tag.
 */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly answered: boolean
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export type AlertLevel = "critical" | "warning" | "info";
