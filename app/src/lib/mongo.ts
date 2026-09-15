import { MongoClient, type Db } from "mongodb";

/**
 * One connection pool for the whole process.
 *
 * Extracted out of the level archive once the strategy blotter needed the same
 * database. Two modules each running their own `new MongoClient(...)` would open
 * two pools against one cluster and, worse, would each have their own opinion
 * about what to do when the cluster is unreachable.
 *
 * Everything that reads through here has to tolerate `null`: this desk's source
 * of truth is the reports on disk and the Kite feed, and Mongo being down should
 * cost the archive, never the session.
 */

const DEFAULT_DB = "nifty200desk";

function uri(): string | null {
  return process.env.MONGO_CONNECTION_STRING?.trim() || null;
}

export function isConfigured(): boolean {
  return uri() !== null;
}

/**
 * Pinned to globalThis so Next's dev hot reload reuses one pool instead of
 * leaking a new set of sockets on every file save.
 */
const globalRef = globalThis as typeof globalThis & {
  __mongoClient?: Promise<MongoClient> | null;
};

export async function getDb(): Promise<Db | null> {
  const connection = uri();
  if (!connection) return null;

  globalRef.__mongoClient ??= new MongoClient(connection, {
    serverSelectionTimeoutMS: 8000,
  })
    .connect()
    .catch((err: unknown) => {
      // Clear the memo so a later call can retry rather than reusing a
      // permanently rejected promise.
      globalRef.__mongoClient = null;
      throw err;
    });

  return (await globalRef.__mongoClient).db(process.env.MONGO_DB?.trim() || DEFAULT_DB);
}

/** First line of a driver error — the rest is a topology dump nobody reads. */
export function mongoMessage(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

export type MongoStatus =
  | { state: "unconfigured" }
  | { state: "live"; db: string; ms: number }
  | { state: "down"; error: string; ms: number };

/**
 * Round-trips a `ping` so boot can say whether the cluster is actually there.
 *
 * `getDb()` alone proves nothing: it hands back a `Db` handle from a memoised
 * promise, and the driver only does server selection when a command needs a
 * socket. Without the ping a wrong host or a rotated password stays quiet until
 * the first archive read, which is usually hours later and looks like a bug in
 * the route rather than in the environment.
 *
 * Never reports the host or anything else lifted out of the connection string —
 * that value carries credentials and must not reach a log. The database name is
 * enough to catch the mistake this is here for, which is pointing at the wrong
 * cluster or at nothing at all.
 */
export async function checkConnection(): Promise<MongoStatus> {
  if (!isConfigured()) return { state: "unconfigured" };

  const started = Date.now();
  try {
    const database = await getDb();
    if (!database) return { state: "unconfigured" };
    await database.command({ ping: 1 });
    return { state: "live", db: database.databaseName, ms: Date.now() - started };
  } catch (err: unknown) {
    return { state: "down", error: mongoMessage(err), ms: Date.now() - started };
  }
}

/** The one-line form for the boot log. */
export function describeStatus(status: MongoStatus): string {
  switch (status.state) {
    case "unconfigured":
      return "[db] MONGO_CONNECTION_STRING is not set — archive and blotter are off, the live desk is unaffected.";
    case "live":
      return `[db] Mongo live — ${status.db} (ping ${status.ms}ms)`;
    case "down":
      return `[db] Mongo unreachable after ${status.ms}ms — ${status.error}`;
  }
}
