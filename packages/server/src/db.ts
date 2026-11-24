import pg from "pg";
import { env } from "./env.js";

// bigint (seq) and timestamptz come back as strings so JSON round-trips cleanly.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

export type QueryClient = Pick<pg.PoolClient, "query">;

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: QueryClient = pool,
): Promise<T[]> {
  const res = await client.query<T>(text, params as never[]);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: QueryClient,
): Promise<T> {
  const rows = await q<T>(text, params, client);
  const row = rows[0];
  if (!row) throw new Error("expected exactly one row, got none");
  return row;
}

export async function maybeOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client?: QueryClient,
): Promise<T | null> {
  const rows = await q<T>(text, params, client);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
