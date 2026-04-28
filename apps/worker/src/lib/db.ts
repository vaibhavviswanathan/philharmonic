/**
 * Drizzle client wrapped around the D1 binding. Build per request — Drizzle's
 * D1 driver is cheap to construct and there's no shared global state to leak.
 */

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

export type DB = DrizzleD1Database<typeof schema>;

export function getDb(d1: D1Database): DB {
  return drizzle(d1, { schema });
}

export { schema };
