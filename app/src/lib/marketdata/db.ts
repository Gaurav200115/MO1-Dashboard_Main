import { Pool, types } from "pg";

/**
 * Read-only connection to the market-data archive (PostgreSQL + TimescaleDB on the VPS, filled
 * by scripts/marketdata). MARKETDATA_DATABASE_URL points at a login that can only SELECT, so
 * nothing on the desk can change the archive.
 *
 * Unset means off: the History analysis pages say so and the rest of the desk is unaffected.
 */

// A trading date is a calendar date, not an instant: keep it as "YYYY-MM-DD" rather than letting
// pg turn it into a Date at local midnight, which shifts a day depending on the server's zone.
types.setTypeParser(1082, (v) => v);
// Counts and open interest arrive as bigint and numeric. They stay far below 2^53, so plain
// numbers are exact enough and much easier to chart than strings.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const globalRef = globalThis as unknown as { __marketdataPool?: Pool };

export function marketdataConfigured(): boolean {
  return Boolean(process.env.MARKETDATA_DATABASE_URL?.trim());
}

export function marketdataPool(): Pool {
  const url = process.env.MARKETDATA_DATABASE_URL?.trim();
  if (!url) throw new Error("MARKETDATA_DATABASE_URL is not set");
  if (!globalRef.__marketdataPool) {
    globalRef.__marketdataPool = new Pool({
      connectionString: url,
      max: 4,
      // A wrong query should fail in seconds, not hold one of the four connections.
      statement_timeout: 30_000,
      idleTimeoutMillis: 60_000,
    });
  }
  return globalRef.__marketdataPool;
}

export async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await marketdataPool().query(sql, params);
  return result.rows as T[];
}
