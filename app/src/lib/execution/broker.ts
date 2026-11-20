import { KiteConnect } from "kiteconnect";
import { requireConfig } from "@/lib/kite/config";
import { orderGate } from "@/lib/kite/gate";
import { readSession } from "@/lib/kite/session";
import { BrokerError, type Broker, type BrokerOrder, type BrokerPosition } from "./types";

/**
 * Kite's order API, and nothing else of Kite's.
 *
 * Every real order the desk sends goes through here, through one rate gate.
 * Orders are only accepted from the static IP registered on the Kite developer
 * profile; that is checked by Kite, not here - a refusal comes back as an
 * answered error like any other and is reported as one.
 *
 * Product NRML, for now: Zerodha refuses fresh MIS buys of stock options in
 * expiry week (physical delivery). Unlike MIS there is NO Zerodha square-off
 * near the close - the desk's own 15:15 exit is the only one, so a position it
 * fails to close stays open overnight (and near expiry, an ITM one can go to
 * physical delivery). Entry and stop both use this, so they always match.
 * Variety "regular" throughout.
 */

const VARIETY = "regular" as const;
const EXCHANGE = "NFO" as const;
const PRODUCT = "NRML" as const;

type Kite = InstanceType<typeof KiteConnect>;

async function client(): Promise<Kite> {
  const session = await readSession();
  if (!session) throw new BrokerError("No Kite session - log in on the desk first", "NoSession", true);
  const { apiKey } = requireConfig();
  const kc = new KiteConnect({ api_key: apiKey });
  kc.setAccessToken(session.accessToken);
  return kc;
}

/**
 * Kite rejects a failed call with `{ error_type, message }`. When the server
 * answered, error_type names why (InputException, OrderException,
 * TokenException, PermissionException...) and the request was refused - nothing
 * was placed. NetworkException means no answer, or no readable one, and an
 * order may have reached Zerodha anyway.
 */
function toBrokerError(err: unknown): BrokerError {
  if (err instanceof BrokerError) return err;
  const e = (err ?? {}) as { error_type?: string; message?: string };
  const kind = e.error_type ?? "Unknown";
  const answered = Boolean(e.error_type) && kind !== "NetworkException";
  return new BrokerError(e.message || String(err), kind, answered);
}

async function call<T>(work: (kc: Kite) => Promise<T>): Promise<T> {
  const kc = await client();
  try {
    return await orderGate.run(() => work(kc));
  } catch (err) {
    throw toBrokerError(err);
  }
}

type KiteOrder = Awaited<ReturnType<Kite["getOrders"]>>[number];

function toOrder(o: KiteOrder): BrokerOrder {
  return {
    orderId: String(o.order_id),
    tag: o.tag ?? null,
    status: String(o.status ?? ""),
    statusMessage: o.status_message ?? null,
    filledQty: Number(o.filled_quantity ?? 0),
    averagePrice: Number(o.average_price ?? 0),
    orderType: String(o.order_type ?? ""),
    triggerPrice: Number(o.trigger_price ?? 0),
    price: Number(o.price ?? 0),
  };
}

export const kiteBroker: Broker = {
  async placeOrder(order) {
    const reply = await call((kc) =>
      kc.placeOrder(VARIETY, {
        exchange: EXCHANGE,
        tradingsymbol: order.tradingsymbol,
        transaction_type: order.transactionType,
        quantity: order.quantity,
        product: PRODUCT,
        order_type: order.orderType,
        validity: order.validity,
        price: order.price,
        ...(order.triggerPrice != null ? { trigger_price: order.triggerPrice } : {}),
        tag: order.tag,
      })
    );
    const id = (reply as { order_id?: string }).order_id;
    if (!id) throw new BrokerError("Kite returned no order id", "NoOrderId", false);
    return String(id);
  },

  async modifyOrder(orderId, change) {
    await call((kc) =>
      kc.modifyOrder(VARIETY, orderId, {
        ...(change.orderType ? { order_type: change.orderType } : {}),
        ...(change.price != null ? { price: change.price } : {}),
        ...(change.triggerPrice != null ? { trigger_price: change.triggerPrice } : {}),
      })
    );
  },

  async orderHistory(orderId) {
    const rows = await call((kc) => kc.getOrderHistory(orderId));
    return rows.map((row) => toOrder(row as unknown as KiteOrder));
  },

  async orders() {
    const rows = await call((kc) => kc.getOrders());
    return rows.map(toOrder);
  },

  async positions(): Promise<BrokerPosition[]> {
    const reply = await call((kc) => kc.getPositions());
    return reply.net.map((p) => ({
      tradingsymbol: p.tradingsymbol,
      exchange: p.exchange,
      product: p.product,
      quantity: Number(p.quantity ?? 0),
    }));
  },
};
