/**
 * Parity tests for the local `packingApi` — the adapter that replaced
 * `apiClient.*('/trips/:id/packing*', …)` over the real Dexie `panelmint`
 * database (fake-indexeddb). Pins the server's envelopes ({items}/{item}/
 * {success:true}/{bag}/{members}/{assignees}), the VISIBLE_TO_ACTOR list
 * filter, the presence-sentinel update protocol, the quantity clamp, the
 * trip-scoped 'Item not found'/'Bag not found'/'Trip not found' errors, the
 * roster filter on assignees and bag members, bag weight totals (incl. the
 * privacy-blind unassigned pile) and the delete-bag cascade. No HTTP — a
 * stubbed fetch proves nothing leaves the page.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { packingApi } from '../../../src/api/local/packing';
import { db } from '../../../src/db/panelmintDb';
import type { LocalTripMember } from '../../../src/db/panelmintDb';
import { buildTrip, buildPackingItem } from '../../helpers/factories';
import type { LocalUser, PackingBag } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

/** TripAccessGuard-satisfying trip owned by self. */
const seedTrip = (over = {}) => db.trips.put(buildTrip({ id: 1, user_id: 1, ...over }));

/** A roster member: membership row + the localUsers row the joins read. */
async function seedMember(id: number, name: string) {
  await db.localUsers.put({ id, name, is_self: 0 });
  await db.tripMembers.put({
    tripId: 1, id, username: name, role: 'member',
    added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: false,
  } as LocalTripMember);
}

const bag = (over: Partial<PackingBag> = {}): PackingBag => ({
  id: 10, trip_id: 1, name: 'Bag', color: '#6366f1',
  weight_limit_grams: null, sort_order: 0, created_at: '2025-01-01T00:00:00.000Z',
  ...over,
});

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('packingApi — no HTTP', () => {
  it('performs zero fetch traffic across the whole surface', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await seedTrip();
    const { item } = await packingApi.create(1, { name: 'Tent' });
    await packingApi.list(1);
    await packingApi.update(1, item.id, { checked: true });
    await packingApi.reorder(1, [item.id]);
    await packingApi.clone(1, item.id);
    await packingApi.getCategoryAssignees(1);
    await packingApi.setCategoryAssignees(1, 'Gear', []);
    const { bag: b } = await packingApi.createBag(1, { name: 'Duffel' });
    await packingApi.listBags(1);
    await packingApi.setBagMembers(1, b.id, [1]);
    await packingApi.updateBag(1, b.id, { name: 'Hold' });
    await packingApi.deleteBag(1, b.id);
    await packingApi.delete(1, item.id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('packingApi.list', () => {
  it('returns {items} ordered by sort_order, created_at with owner enrichment', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.packingItems.bulkPut([
      buildPackingItem({ id: 2, trip_id: 1, sort_order: 1, name: 'B', owner_id: 2 }),
      buildPackingItem({ id: 1, trip_id: 1, sort_order: 0, name: 'A' }),
    ]);

    const { items } = await packingApi.list(1);
    expect(items.map((i) => i.name)).toEqual(['A', 'B']);
    // The enrichItems JOIN: owner_username resolves against the user table.
    expect(items[1].owner_username).toBe('Alice');
  });

  it('hides private items the viewer does not own and is not a recipient of', async () => {
    await seedTrip();
    await db.packingItems.bulkPut([
      buildPackingItem({ id: 1, trip_id: 1, name: 'Shared', is_private: 0 }),
      buildPackingItem({ id: 2, trip_id: 1, name: 'Mine', is_private: 1, owner_id: 1 }),
      buildPackingItem({ id: 3, trip_id: 1, name: 'Hidden', is_private: 1, owner_id: 2 }),
      buildPackingItem({
        id: 4, trip_id: 1, name: 'SharedToMe', is_private: 1, owner_id: 2,
        recipients: [{ user_id: 1, username: 'Me' }],
      }),
    ]);

    const { items } = await packingApi.list(1);
    expect(items.map((i) => i.name)).toEqual(['Shared', 'Mine', 'SharedToMe']);
  });

  it('accepts a string trip id and 404s an unreachable trip', async () => {
    await seedTrip();
    await expect(packingApi.list('1')).resolves.toEqual({ items: [] });

    const err = await fail(packingApi.list(999));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('packingApi.create', () => {
  it('writes the column defaults and stamps the acting user as owner', async () => {
    await seedTrip();
    const { item } = await packingApi.create(1, { name: 'Tent' });
    expect(item).toMatchObject({
      trip_id: 1, name: 'Tent', category: 'Other', checked: 0,
      quantity: 1, weight_grams: null, bag_id: null,
      is_private: 0, owner_id: 1,
    });
    expect(item.created_at).toBeTruthy();
    expect(await db.packingItems.get(item.id)).toMatchObject({ name: 'Tent' });
  });

  it('appends at MAX(sort_order)+1 over every row of the trip', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({ id: 5, trip_id: 1, sort_order: 4 }));
    const { item } = await packingApi.create(1, { name: 'Mat' });
    expect(item.sort_order).toBe(5);
  });

  it('clamps quantity into [1, 999]', async () => {
    await seedTrip();
    expect((await packingApi.create(1, { name: 'a', quantity: 0 })).item.quantity).toBe(1);
    expect((await packingApi.create(1, { name: 'b', quantity: 2000 })).item.quantity).toBe(999);
  });

  it('maps visibility over the is_private fallback and embeds roster recipients', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    const personal = await packingApi.create(1, { name: 'Diary', visibility: 'personal' });
    expect(personal.item.is_private).toBe(1);

    // 'shared' embeds recipients minus the owner and minus off-roster ids.
    const shared = await packingApi.create(1, {
      name: 'Stove', visibility: 'shared', recipient_ids: [2, 99, 1],
    });
    expect(shared.item.is_private).toBe(1);
    expect(shared.item.recipients).toEqual([{ user_id: 2, username: 'Alice' }]);

    const common = await packingApi.create(1, { name: 'Tent', is_private: true, visibility: 'common' });
    expect(common.item.is_private).toBe(0);
  });

  it('400s a bag_id that is not a bag of this trip', async () => {
    await seedTrip();
    await db.trips.put(buildTrip({ id: 2, user_id: 1 }));
    await db.packingBags.put(bag({ id: 7, trip_id: 2 }));

    const err = await fail(packingApi.create(1, { name: 'X', bag_id: 7 }));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('Bag not found');

    const missing = await fail(packingApi.create(1, { name: 'X', bag_id: 404 }));
    expect(missing.response.data.error).toBe('Bag not found');
  });

  it('400s a missing name through the zod parse', async () => {
    await seedTrip();
    const err = await fail(packingApi.create(1, {}));
    expect(err.response.status).toBe(400);
  });
});

describe('packingApi.update', () => {
  it('follows the presence protocol: absent keys keep, present null clears', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({
      id: 3, trip_id: 1, name: 'Boots', category: 'Gear',
      weight_grams: 900, bag_id: 4, quantity: 2, checked: 1,
    }));
    await db.packingBags.put(bag({ id: 4 }));

    const { item } = await packingApi.update(1, 3, { weight_grams: null, bag_id: null });
    expect(item).toMatchObject({ name: 'Boots', category: 'Gear', weight_grams: null, bag_id: null, quantity: 2, checked: 1 });
  });

  it('stores checked as 0/1 for boolean input and clamps quantity', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({ id: 3, trip_id: 1, checked: 0, quantity: 2 }));
    const { item } = await packingApi.update(1, 3, { checked: true, quantity: -5 });
    expect(item.checked).toBe(1);
    expect(item.quantity).toBe(1);
  });

  it('claims an unowned row for the actor when it is privatized', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({ id: 3, trip_id: 1, owner_id: null, is_private: 0 }));
    const { item } = await packingApi.update(1, 3, { is_private: true });
    expect(item.is_private).toBe(1);
    expect(item.owner_id).toBe(1);
  });

  it('404s a missing row, a foreign-trip row and a row the viewer cannot see', async () => {
    await seedTrip();
    await db.packingItems.bulkPut([
      buildPackingItem({ id: 8, trip_id: 2, name: 'Foreign' }),
      buildPackingItem({ id: 9, trip_id: 1, name: 'Secret', is_private: 1, owner_id: 2 }),
    ]);
    for (const id of [8, 9, 77]) {
      const err = await fail(packingApi.update(1, id, { name: 'x' }));
      expect(err.response.status).toBe(404);
      expect(err.response.data.error).toBe('Item not found');
    }
  });

  it('400s a bag_id pointing at a bag of another trip', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({ id: 3, trip_id: 1 }));
    await db.trips.put(buildTrip({ id: 2, user_id: 1 }));
    await db.packingBags.put(bag({ id: 6, trip_id: 2 }));

    const err = await fail(packingApi.update(1, 3, { bag_id: 6 }));
    expect(err.response.data.error).toBe('Bag not found');
  });
});

describe('packingApi.delete', () => {
  it('removes the row and answers {success:true}', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({ id: 3, trip_id: 1 }));
    await expect(packingApi.delete(1, 3)).resolves.toEqual({ success: true });
    expect(await db.packingItems.get(3)).toBeUndefined();
  });

  it('404s an invisible row instead of leaking it', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({ id: 3, trip_id: 1, is_private: 1, owner_id: 2 }));
    const err = await fail(packingApi.delete(1, 3));
    expect(err.response.status).toBe(404);
    expect(await db.packingItems.get(3)).toBeTruthy();
  });
});

describe('packingApi.reorder', () => {
  it('writes sort_order per listed id and silently skips foreign ids', async () => {
    await seedTrip();
    await db.trips.put(buildTrip({ id: 2, user_id: 1 }));
    await db.packingItems.bulkPut([
      buildPackingItem({ id: 1, trip_id: 1, sort_order: 0 }),
      buildPackingItem({ id: 2, trip_id: 1, sort_order: 1 }),
      buildPackingItem({ id: 3, trip_id: 2, sort_order: 7 }),
    ]);

    await expect(packingApi.reorder(1, [2, 999, 1, 3])).resolves.toEqual({ success: true });
    expect((await db.packingItems.get(2))!.sort_order).toBe(0);
    // 999 is dead: index 1 lands nowhere; 1 takes slot 2.
    expect((await db.packingItems.get(1))!.sort_order).toBe(2);
    // The other trip's row is untouched even though its id was listed.
    expect((await db.packingItems.get(3))!.sort_order).toBe(7);
  });
});

describe('packingApi.clone', () => {
  it('copies the row as an unchecked personal item owned by the actor', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({
      id: 3, trip_id: 1, name: 'Stove', category: 'Kitchen',
      checked: 1, quantity: 2, weight_grams: 300, is_private: 0, owner_id: 2,
    }));
    const { item } = await packingApi.clone(1, 3);
    expect(item).toMatchObject({
      name: 'Stove', category: 'Kitchen', checked: 0,
      quantity: 2, weight_grams: 300, is_private: 1, owner_id: 1,
    });
    expect(item.id).not.toBe(3);
    expect(await db.packingItems.get(item.id)).toMatchObject({ name: 'Stove' });
  });

  it('keeps the bag when it is unclaimed, drops a foreign-owned bag', async () => {
    await seedTrip();
    await db.packingBags.bulkPut([
      bag({ id: 4, user_id: null }),
      bag({ id: 5, user_id: 2 }),
    ]);
    await db.packingItems.bulkPut([
      buildPackingItem({ id: 1, trip_id: 1, name: 'A', bag_id: 4 }),
      buildPackingItem({ id: 2, trip_id: 1, name: 'B', bag_id: 5 }),
      // A member's bag: self belongs, so the bag carries over.
      buildPackingItem({ id: 3, trip_id: 1, name: 'C', bag_id: 6 }),
    ]);
    await db.packingBags.put(bag({ id: 6, user_id: 2 }));
    await db.packingBagMembers.put({ bag_id: 6, user_id: 1 });

    expect((await packingApi.clone(1, 1)).item.bag_id).toBe(4);
    expect((await packingApi.clone(1, 2)).item.bag_id).toBeNull();
    expect((await packingApi.clone(1, 3)).item.bag_id).toBe(6);
  });

  it('404s a row the viewer cannot see', async () => {
    await seedTrip();
    await db.packingItems.put(buildPackingItem({ id: 3, trip_id: 1, is_private: 1, owner_id: 2 }));
    const err = await fail(packingApi.clone(1, 3));
    expect(err.response.status).toBe(404);
  });
});

describe('packingApi category assignees', () => {
  it('groups junction rows by category in the GET record', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.packingCategoryAssignees.bulkPut([
      { id: 1, trip_id: 1, category_name: 'Gear', user_id: 1 },
      { id: 2, trip_id: 1, category_name: 'Gear', user_id: 2 },
      { id: 3, trip_id: 1, category_name: 'Docs', user_id: 2 },
      { id: 4, trip_id: 2, category_name: 'Gear', user_id: 1 },
    ]);

    const { assignees } = await packingApi.getCategoryAssignees(1);
    expect(assignees.Gear.map((a) => a.user_id).sort()).toEqual([1, 2]);
    expect(assignees.Docs).toEqual([{ user_id: 2, username: 'Alice', avatar: null }]);
    // A member whose user row vanished drops out like the INNER JOIN did.
  });

  it('rewrites one category, filters off-roster ids and survives path chars', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.packingCategoryAssignees.put({ id: 1, trip_id: 1, category_name: 'Docs', user_id: 1 });

    const { assignees } = await packingApi.setCategoryAssignees(1, 'Food & Drinks', [2, 99]);
    expect(assignees).toEqual([{ user_id: 2, username: 'Alice', avatar: null }]);

    const rows = await db.packingCategoryAssignees.toArray();
    expect(rows.filter((r) => r.category_name === 'Food & Drinks')).toHaveLength(1);
    expect(rows.some((r) => r.category_name === 'Docs')).toBe(true);

    // The same names with slashes never reached a path — the store is key-value.
    const { assignees: slash } = await packingApi.setCategoryAssignees(1, 'A/B', [1]);
    expect(slash).toEqual([{ user_id: 1, username: 'Me', avatar: null }]);
  });
});

describe('packingApi bags', () => {
  it('creates the bare row ({bag} — no members/totals projection) and 400s blank names', async () => {
    await seedTrip();
    const { bag: created } = await packingApi.createBag(1, { name: '  Duffel  ' });
    expect(created).toMatchObject({ name: 'Duffel', color: '#6366f1', weight_limit_grams: null, trip_id: 1 });
    expect(created).not.toHaveProperty('members');
    expect(created).not.toHaveProperty('total_weight_grams');

    const err = await fail(packingApi.createBag(1, { name: '   ' }));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('Name is required');
  });

  it('lists bags with members, per-bag totals and the unassigned pile — privacy-blind', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.packingBags.bulkPut([bag({ id: 4, sort_order: 0 }), bag({ id: 5, name: 'Second', sort_order: 1 })]);
    await db.packingBagMembers.put({ bag_id: 4, user_id: 2 });
    await db.packingItems.bulkPut([
      // weight * quantity sums under the bag key — even a private row of
      // somebody else counts (#2191: a scale does not care about visibility).
      buildPackingItem({ id: 1, trip_id: 1, bag_id: 4, weight_grams: 100, quantity: 2 }),
      buildPackingItem({ id: 2, trip_id: 1, bag_id: 4, weight_grams: 50, is_private: 1, owner_id: 2 }),
      buildPackingItem({ id: 3, trip_id: 1, bag_id: null, weight_grams: 40, quantity: 3 }),
      buildPackingItem({ id: 4, trip_id: 1, bag_id: null }),
    ]);

    const { bags, unassigned_weight_grams } = await packingApi.listBags(1);
    expect(bags.map((b) => b.id)).toEqual([4, 5]);
    expect(bags[0].total_weight_grams).toBe(250);
    expect(bags[0].members).toEqual([{ bag_id: 4, user_id: 2, username: 'Alice', avatar: null }]);
    expect(bags[1].total_weight_grams).toBe(0);
    expect(unassigned_weight_grams).toBe(120);
  });

  it('updates name/color/limit on the presence protocol and roster-filters user_id', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.packingBags.put(bag({ id: 4 }));

    const { bag: renamed } = await packingApi.updateBag(1, 4, { name: 'Hold', weight_limit_grams: 8000 });
    expect(renamed).toMatchObject({ name: 'Hold', weight_limit_grams: 8000 });

    const { bag: cleared } = await packingApi.updateBag(1, 4, { weight_limit_grams: null });
    expect(cleared.weight_limit_grams).toBeNull();
    expect(cleared.name).toBe('Hold');

    const { bag: owned } = await packingApi.updateBag(1, 4, { user_id: 2 });
    expect(owned.user_id).toBe(2);
    expect(owned.assigned_username).toBe('Alice');

    // Off-roster user_id unassigns rather than failing (the server's COALESCE
    // over an INNER JOIN left the column null).
    const { bag: nulled } = await packingApi.updateBag(1, 4, { user_id: 99 });
    expect(nulled.user_id).toBeNull();

    const err = await fail(packingApi.updateBag(1, 66, { name: 'x' }));
    expect(err.response.status).toBe(404);
  });

  it('deletes a bag: unassigns its items and drops the member rows', async () => {
    await seedTrip();
    await db.packingBags.put(bag({ id: 4 }));
    await db.packingBagMembers.put({ bag_id: 4, user_id: 1 });
    await db.packingItems.bulkPut([
      buildPackingItem({ id: 1, trip_id: 1, bag_id: 4 }),
      buildPackingItem({ id: 2, trip_id: 1, bag_id: null }),
    ]);

    await expect(packingApi.deleteBag(1, 4)).resolves.toEqual({ success: true });
    expect(await db.packingBags.get(4)).toBeUndefined();
    expect(await db.packingBagMembers.toArray()).toEqual([]);
    expect((await db.packingItems.get(1))!.bag_id).toBeNull();
    expect((await db.packingItems.get(2))!.bag_id).toBeNull();

    const err = await fail(packingApi.deleteBag(1, 4));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Bag not found');
  });

  it('setBagMembers rewrites the junction, roster-filtered, and returns the wire members', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.packingBags.put(bag({ id: 4 }));
    await db.packingBagMembers.put({ bag_id: 4, user_id: 1 });

    const { members } = await packingApi.setBagMembers(1, 4, [2, 99]);
    expect(members).toEqual([{ user_id: 2, username: 'Alice', avatar: null }]);
    expect(await db.packingBagMembers.toArray()).toEqual([
      expect.objectContaining({ bag_id: 4, user_id: 2 }),
    ]);

    const err = await fail(packingApi.setBagMembers(1, 99, [1]));
    expect(err.response.status).toBe(404);
  });
});
