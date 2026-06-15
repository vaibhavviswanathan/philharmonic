/**
 * Drizzle client wrapped around the D1 binding. Build per request — Drizzle's
 * D1 driver is cheap to construct and there's no shared global state to leak.
 */

import { eq } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export type DB = DrizzleD1Database<typeof schema>;

export function getDb(d1: D1Database): DB {
  return drizzle(d1, { schema });
}

/**
 * Look up a project's slug — taskDto needs it for identifier derivation
 * (SPEC §6.2). Falls back to '' for a dangling projectId rather than failing
 * the caller's broadcast/response.
 */
export async function projectSlug(db: DB, projectId: string): Promise<string> {
  const row = await db
    .select({ slug: schema.projects.slug })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  return row?.slug ?? '';
}

export { schema };
