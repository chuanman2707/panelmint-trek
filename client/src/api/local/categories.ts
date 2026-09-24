/**
 * `categoriesApi` — the local implementation. The category palette is FROZEN
 * in the client-only build: seeded from `SEED_CATEGORIES` at bootstrap
 * (db/bootstrap.ts), and the server's admin-gated create/update/delete have no
 * local counterpart — there is no admin, and the seeded rows are also what
 * every `placeWire` join resolves `category_*` from.
 *
 * Server parity notes (server/src/nest/categories/):
 *  - `list` is the server's `SELECT * FROM categories ORDER BY name ASC`,
 *    envelope `{ categories }`.
 *  - Mutations answered 403 through the AdminGuard for non-admin users; the
 *    local build has no roles at all, so the frozen-palette refusal is a
 *    permanent 403 rather than a role check. The message names the build,
 *    which is what a caller debugging a disabled button needs to hear.
 */
import type { Category } from '../../types';
import { db } from '../../db/panelmintDb';
import { apiError, detachedList, numId } from './helpers';

const FROZEN = 'Categories are a fixed palette in this build';

// A rejected promise, not a synchronous throw — axios calls reject, and a
// caller that forgot await would see an unhandled rejection either way, but
// `expect(api.mutate()).rejects` only works on the promise path.
const frozenPalette = (): Promise<never> => Promise.reject(apiError(403, FROZEN));

export const categoriesApi = {
  /** `{ categories }`, `ORDER BY name ASC` — codepoint-ordered like SQLite BINARY. */
  list: async (): Promise<{ categories: Category[] }> => {
    const rows = await db.categories.toArray();
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { categories: detachedList(rows) };
  },

  /** Single row by id; the server's service exposed getById for its guards. */
  get: async (id: number | string): Promise<{ category: Category }> => {
    const nid = numId(id);
    // A NaN id is the NULL-bound lookup the server ran — 'Category not found',
    // not the DataError IndexedDB would throw on a NaN key.
    const row = Number.isFinite(nid) ? await db.categories.get(nid) : undefined;
    if (!row) throw apiError(404, 'Category not found');
    return { category: structuredClone(row) };
  },

  create: frozenPalette as (data: unknown) => Promise<never>,
  update: (_id: number | string, _data?: unknown): Promise<never> => frozenPalette(),
  delete: (_id: number | string): Promise<never> => frozenPalette(),
};
