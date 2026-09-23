// Surrogate-id allocation for the `panelmint` database.
//
// Every table this is called on has a plain `id` primary key (see
// db/panelmintDb.ts). The junction tables keyed by a natural compound
// (packingBagMembers, tripMembers) take no surrogate id, and the `number` key
// type on the signature refuses them at compile time.
import type { Table } from 'dexie'

/**
 * Ids handed out this session, per table name.
 *
 * A pure max-id read cannot be the allocator: two calls with no insert in
 * between would hand out the same id. Remembering the last issued id makes the
 * allocator strictly monotonic within the session — including over rows that
 * were deleted (max-id would otherwise reissue a freed trailing id). Rows that
 * arrive without going through nextId — an import, a seed — are still covered
 * because every allocation floors at max(stored id) + 1.
 *
 * Cross-tab safety is the caller's transaction: call nextId inside the `rw`
 * transaction performing the insert and IndexedDB serialises the writers. The
 * map itself never rolls back, so an aborted transaction can leave a gap in
 * the id sequence — gaps are harmless, ids carry no ordering meaning beyond
 * uniqueness.
 */
const allocated = new Map<string, number>()

/**
 * The next free id for `table`: greater than both the largest stored id and
 * every id already issued this session. Starts at 1 on an empty table.
 */
export async function nextId<T extends { id?: number }>(
  table: Table<T, number>,
): Promise<number> {
  const last = await table.orderBy('id').last()
  return reserveIds(table.name, last?.id ?? 0, 1)[0]
}

/**
 * Reserve `count` ids for `name` synchronously, sharing the same monotonic
 * session map as `nextId`. `name` is a table name for table-backed rows; the
 * Dexie seam also uses it for embedded collections that have no table of their
 * own (`'days.assignments'`, `'reservations.endpoints'`, …) so those ids stay
 * unique across the whole parent table.
 *
 * `maxStoredId` is the highest id currently persisted (or already loaded in
 * the caller's snapshot) — the caller's transaction is what makes the result
 * collision-safe, exactly like `nextId`.
 */
export function reserveIds(name: string, maxStoredId: number, count = 1): number[] {
  const start = Math.max(maxStoredId, allocated.get(name) ?? 0)
  allocated.set(name, start + count)
  return Array.from({ length: count }, (_, i) => start + i + 1)
}
