/**
 * `packingApi` — the Dexie port of the hosted PackingController +
 * PackingService pair (server/src/nest/packing/). Kept surface of the axios
 * object this replaces:
 *
 *   GET                      → { items }
 *   POST                     → { item }
 *   PUT :id                  → { item }
 *   DELETE :id               → { success: true }
 *   PUT reorder              → { success: true }
 *   POST :id/clone           → { item }
 *   GET category-assignees   → { assignees }   (grouped record)
 *   PUT category-assignees/* → { assignees }   (flat array for the category)
 *   GET bags                 → { bags, unassigned_weight_grams }
 *   POST bags                → { bag }
 *   PUT bags/:id             → { bag }
 *   DELETE bags/:id          → { success: true }
 *   PUT bags/:id/members     → { members }
 *
 * What did NOT come over, because it only existed to serve the hosted app's
 * multi-member collaboration and its server-owned template library:
 * setSharing/addContributor/removeContributor (the #858 sharing actions — the
 * visibility FIELDS stay: a local item can still be personal or shared with
 * trip guests) and listTemplates/applyTemplate/saveAsTemplate.
 *
 * Server parity notes:
 *  - Every route was trip-scoped (TripAccessGuard → 404 'Trip not found');
 *    `requireTrip` reproduces it.
 *  - Item reads on mutation paths ran the VISIBLE_TO_ACTOR fragment: a row
 *    the viewer may not see is indistinguishable from a missing one —
 *    404 'Item not found' (getItemInTrip).
 *  - A non-null bag_id in a create/update body had to name a bag ON this
 *    trip — the FK only guaranteed the row existed somewhere. The controller
 *    answered 400 { error: 'Bag not found' } (the 404 belongs to the path
 *    routes).
 *  - Updates followed the bodyKeys presence protocol: weight_grams/bag_id/
 *    quantity/is_private/user_id/weight_limit_grams only move when the key is
 *    present (explicit null clears); name/category COALESCE falsy-keeps. The
 *    zod output preserves which keys arrived, so `in body` is the sentinel.
 *  - quantity clamps into [1, 999] via `Number(q) || 1`.
 *  - Privacy fields (#858): `visibility` beats the `is_private` fallback
 *    ('common' → 0, anything else → 1); create stamps owner_id = the acting
 *    (self) user, and privatizing an unowned legacy row claims it for the
 *    actor. `visibility === 'shared'` embeds the roster-filtered recipients
 *    (owner excluded) the way packing_item_recipients did.
 *  - checked arrives boolean or 0/1 on the wire, stores 0/1.
 *  - The bag-totals broadcast (`packing:bag-totals`, #2191) had no client
 *    listener — listBags computes fresh totals over EVERY row (privacy-blind
 *    on purpose), so the side channel simply does not exist here.
 *  - Templates are gone entirely: no packing_templates table exists locally.
 *    Neither is the bulk text/CSV import — without templates to seed it the
 *    flow was a second way to type the same rows, so `bulkImport` stayed
 *    server-side too.
 */
import {
  packingBagMembersRequestSchema,
  packingCategoryAssigneesRequestSchema,
  packingCreateBagRequestSchema,
  packingCreateItemRequestSchema,
  packingReorderRequestSchema,
  packingUpdateBagRequestSchema,
  packingUpdateItemRequestSchema,
  type PackingVisibility,
} from '@trek/shared';
import type { PackingBag, PackingItem } from '../../types';
import { DexieStore, SELF_ID, withStore } from './dexieStore';
import { badRequest, detached, notFound, nowIso, numId, parseBody } from './helpers';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** `visibilityToPrivate` — the three-tier mapping onto the stored flag. */
function visibilityToPrivate(visibility: PackingVisibility | undefined, isPrivateFallback: boolean | undefined): number {
  if (visibility) return visibility === 'common' ? 0 : 1;
  return isPrivateFallback ? 1 : 0;
}

/** `bagInTrip` — the referenced-bag rule the FK could not enforce. */
function bagInTrip(store: DexieStore, tripId: number, bagId: number | string): boolean {
  return store.packingBagRaw(numId(bagId))?.trip_id === tripId;
}

/**
 * `getItemInTrip` — the item scoped to its trip AND to what the actor may
 * see. A missing actor denied too, rather than falling through unfiltered.
 */
function requireVisibleItem(store: DexieStore, tripId: number, id: number | string): PackingItem {
  const item = store.packingItemRaw(numId(id));
  if (!item || item.trip_id !== tripId || !store.packingItemVisibleTo(item, SELF_ID)) {
    throw notFound('Item');
  }
  return item;
}

/** `bagForCloner` (#207) — the copy keeps its bag only when that bag is the
 *  cloner's to pack: one they own, one nobody owns, or one they belong to. */
function bagForCloner(store: DexieStore, tripId: number, bagId: number | null | undefined, userId: number): number | null {
  if (bagId == null) return null;
  const bid = numId(bagId);
  const bag = store.packingBagRaw(bid);
  if (!bag || bag.trip_id !== tripId) return null;
  if (bag.user_id === userId) return bid;
  const members = store.packingBagMembersOf(bid);
  if (bag.user_id == null && members.length === 0) return bid;
  return members.some((m) => m.user_id === userId) ? bid : null;
}

/** `MAX(sort_order) + 1` over the trip's rows (all of them — visibility never
 *  scoped the append). */
function nextSortOrder(items: { sort_order?: number }[]): number {
  let max = -1;
  for (const i of items) max = Math.max(max, i.sort_order ?? 0);
  return max + 1;
}

/** `Math.max(1, Math.min(999, Number(q) || 1))`. */
function clampQuantity(q: number | undefined): number {
  return Math.max(1, Math.min(999, Number(q) || 1));
}

/** The INSERT + recipients half of createItem — shared by `create` and
 *  `clone` (which pre-resolves its fields). */
function insertItem(
  store: DexieStore,
  tripId: number,
  fields: {
    name: string;
    category: string | null;
    checked: number;
    sortOrder: number;
    quantity: number;
    weight_grams: number | null;
    bag_id: number | null;
    is_private: number;
    owner_id: number | null;
    recipient_ids?: number[];
    record_recipients?: boolean;
  },
): PackingItem {
  const item: PackingItem = {
    id: store.allocId('packingItems'),
    trip_id: tripId,
    name: fields.name,
    checked: fields.checked,
    category: fields.category,
    sort_order: fields.sortOrder,
    quantity: fields.quantity,
    weight_grams: fields.weight_grams,
    bag_id: fields.bag_id,
    is_private: fields.is_private,
    owner_id: fields.owner_id,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  // "Shared with specific people" — the roster-scoped recipient junction,
  // stored embedded (recipients) since there is no junction table locally.
  if (fields.record_recipients && fields.recipient_ids) {
    const roster = store.rosterUserIds(tripId);
    item.recipients = [...new Set(fields.recipient_ids)]
      .filter((uid) => uid !== fields.owner_id && roster.has(uid))
      .map((uid) => ({ user_id: uid, username: store.user(uid)?.name ?? `Guest ${uid}` }));
  }
  store.put('packingItems', item);
  return store.packingItemWire(item);
}

export const packingApi = {
  list: (tripId: number | string): Promise<{ items: PackingItem[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return { items: store.listPackingItemsWire(tid, SELF_ID) };
    }),

  create: (
    tripId: number | string,
    data: unknown,
  ): Promise<{ item: PackingItem }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(packingCreateItemRequestSchema, data);
      if (body.bag_id != null && !bagInTrip(store, tid, body.bag_id)) {
        throw badRequest('Bag not found');
      }
      const isPrivate = visibilityToPrivate(body.visibility, body.is_private);
      const item = insertItem(store, tid, {
        name: body.name,
        category: body.category || 'Other',
        checked: body.checked ? 1 : 0,
        sortOrder: nextSortOrder(store.packingItemsOfTrip(tid)),
        quantity: clampQuantity(body.quantity),
        weight_grams: body.weight_grams ?? null,
        bag_id: body.bag_id ?? null,
        is_private: isPrivate,
        owner_id: SELF_ID,
        recipient_ids: body.recipient_ids,
        record_recipients: body.visibility === 'shared',
      });
      return { item };
    }),

  update: (
    tripId: number | string,
    id: number,
    data: unknown,
  ): Promise<{ item: PackingItem }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(packingUpdateItemRequestSchema, data);
      const item = requireVisibleItem(store, tid, id);
      if ('bag_id' in body && body.bag_id != null && !bagInTrip(store, tid, body.bag_id)) {
        throw badRequest('Bag not found');
      }
      // Privatizing an unowned (legacy) item stamps the actor as its owner so
      // the visibility filter still has someone to match (#858).
      const claimOwner = 'is_private' in body && !!body.is_private && item.owner_id == null;
      if (body.name) item.name = body.name;
      // The server's checked guard was value-based (`data.checked !==
      // undefined`), not bodyKeys — an explicit undefined keeps the column.
      if (body.checked !== undefined) item.checked = body.checked ? 1 : 0;
      if (body.category) item.category = body.category;
      if ('weight_grams' in body) item.weight_grams = body.weight_grams ?? null;
      if ('bag_id' in body) item.bag_id = body.bag_id ?? null;
      if ('quantity' in body) item.quantity = clampQuantity(body.quantity);
      if ('is_private' in body) item.is_private = body.is_private ? 1 : 0;
      if (claimOwner) item.owner_id = SELF_ID;
      item.updated_at = nowIso();
      store.put('packingItems', item);
      return { item: store.packingItemWire(item) };
    }),

  delete: (tripId: number | string, id: number): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const item = requireVisibleItem(store, tid, id);
      store.delete('packingItems', item.id);
      return { success: true as const };
    }),

  reorder: (tripId: number | string, orderedIds: number[]): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const { orderedIds: ids } = parseBody(packingReorderRequestSchema, { orderedIds });
      // `UPDATE … SET sort_order = ? WHERE id = ? AND trip_id = ?` per listed
      // id — a foreign or dead id is a silent no-op that still consumes its
      // slot, exactly like the prepared statement.
      ids.forEach((itemId, index) => {
        const item = store.packingItemRaw(itemId);
        if (item && item.trip_id === tid) {
          item.sort_order = index;
          store.put('packingItems', item);
        }
      });
      return { success: true as const };
    }),

  clone: (tripId: number | string, id: number): Promise<{ item: PackingItem }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const item = requireVisibleItem(store, tid, id);
      return {
        item: insertItem(store, tid, {
          name: item.name,
          category: item.category || 'Other',
          checked: 0,
          sortOrder: nextSortOrder(store.packingItemsOfTrip(tid)),
          quantity: clampQuantity(item.quantity),
          weight_grams: item.weight_grams ?? null,
          bag_id: bagForCloner(store, tid, item.bag_id, SELF_ID),
          is_private: visibilityToPrivate('personal', undefined),
          owner_id: SELF_ID,
        }),
      };
    }),

  getCategoryAssignees: (
    tripId: number | string,
  ): Promise<{ assignees: Record<string, { user_id: number; username: string; avatar: null }[]> }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return { assignees: store.categoryAssigneesWire('packingCategoryAssignees', tid) };
    }),

  setCategoryAssignees: (
    tripId: number | string,
    categoryName: string,
    userIds: number[],
  ): Promise<{ assignees: { user_id: number; username: string; avatar: null }[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const { user_ids } = parseBody(packingCategoryAssigneesRequestSchema, { user_ids: userIds });
      // Only people on this trip may be assigned — off-roster ids drop
      // silently, never error.
      const roster = store.rosterUserIds(tid);
      const ids = user_ids.filter((uid) => roster.has(uid));
      return { assignees: store.setCategoryAssigneeRows('packingCategoryAssignees', tid, categoryName, ids) };
    }),

  setBagMembers: (
    tripId: number | string,
    bagId: number,
    userIds: number[],
  ): Promise<{ members: { user_id: number; username: string; avatar: null }[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const { user_ids } = parseBody(packingBagMembersRequestSchema, { user_ids: userIds });
      const bag = store.packingBagRaw(numId(bagId));
      if (!bag || bag.trip_id !== tid) throw notFound('Bag');
      const roster = store.rosterUserIds(tid);
      const ids = user_ids.filter((uid) => roster.has(uid));
      store.setBagMemberRows(bag.id, ids);
      return { members: store.bagMembersWire(bag.id) };
    }),

  listBags: (tripId: number | string): Promise<{ bags: PackingBag[]; unassigned_weight_grams: number }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return store.listBagsWire(tid);
    }),

  createBag: (
    tripId: number | string,
    data: unknown,
  ): Promise<{ bag: PackingBag }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(packingCreateBagRequestSchema, data);
      // The schema requires a non-empty name; whitespace-only still 400s.
      if (!body.name.trim()) throw badRequest('Name is required');
      const bag: PackingBag = {
        id: store.allocId('packingBags'),
        trip_id: tid,
        name: body.name.trim(),
        color: body.color || '#6366f1',
        weight_limit_grams: body.weight_limit_grams ?? null,
        sort_order: nextSortOrder(store.packingBagsOfTrip(tid)),
        created_at: nowIso(),
      };
      store.put('packingBags', bag);
      // `SELECT *` — the bare row: no members/total_weight_grams (listBags'
      // decoration is the list projection only).
      return { bag: detached(bag) };
    }),

  updateBag: (
    tripId: number | string,
    bagId: number,
    data: unknown,
  ): Promise<{ bag: PackingBag }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(packingUpdateBagRequestSchema, data);
      const bag = store.packingBagRaw(numId(bagId));
      if (!bag || bag.trip_id !== tid) throw notFound('Bag');
      // A bag may only be assigned to a real trip member; an off-roster id
      // becomes unassigned.
      const assignUser =
        body.user_id != null && store.rosterUserIds(tid).has(body.user_id) ? body.user_id : null;
      if (body.name?.trim()) bag.name = body.name.trim();
      if (body.color) bag.color = body.color;
      if ('weight_limit_grams' in body) bag.weight_limit_grams = body.weight_limit_grams ?? null;
      if ('user_id' in body) bag.user_id = assignUser;
      store.put('packingBags', bag);
      // `SELECT b.*, COALESCE(u.display_name, u.username) as assigned_username`.
      const assigned = bag.user_id != null ? store.user(bag.user_id) : undefined;
      return { bag: detached({ ...bag, assigned_username: assigned?.name ?? null }) as PackingBag };
    }),

  deleteBag: (tripId: number | string, bagId: number): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const bag = store.packingBagRaw(numId(bagId));
      if (!bag || bag.trip_id !== tid) throw notFound('Bag');
      store.deleteBagCascade(bag.id);
      return { success: true as const };
    }),
};
