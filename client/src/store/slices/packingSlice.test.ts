// FE-STORE-PACKING-001 to FE-STORE-PACKING-002 (reorder, #969)
// FE-STORE-PACKING-003, -006 to -008, -013 to -015 (mutation and error paths)
//
// packingRepo is the Dexie-backed local adapter now — there is no HTTP layer
// to mock. Happy paths seed the rows the calls act on; failure paths simply
// omit the trip, which is the local equivalent of the server's 403/500
// rejections ('Trip not found' is what TripAccessGuard produced).
import 'fake-indexeddb/auto';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildPackingItem, buildTrip } from '../../../tests/helpers/factories';
import { db } from '../../db/panelmintDb';
import { packingApi } from '../../api/client';
import { useTripStore } from '../tripStore';
import type { PackingItem } from '../../types';

let addToast: ReturnType<typeof vi.fn>;

/** A clean panelmint db with the given packing rows — and trip 1 unless opted out. */
async function seedDb(items: PackingItem[] = [], opts: { trip?: boolean } = {}) {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  if (opts.trip !== false) await db.trips.put(buildTrip({ id: 1 }));
  if (items.length) await db.packingItems.bulkPut(items);
}

beforeEach(() => {
  resetAllStores();
  addToast = vi.fn();
  window.__addToast = addToast as unknown as typeof window.__addToast;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__addToast;
});

describe('packingSlice', () => {
  it('FE-STORE-PACKING-001: reorderPackingItems reorders optimistically and reindexes sort_order', async () => {
    const a = buildPackingItem({ id: 1, trip_id: 1, sort_order: 0 });
    const b = buildPackingItem({ id: 2, trip_id: 1, sort_order: 1 });
    seedStore(useTripStore, { packingItems: [a, b] });
    await seedDb([a, b]);

    await useTripStore.getState().reorderPackingItems(1, [2, 1]);
    const items = useTripStore.getState().packingItems;
    expect(items[0].id).toBe(2);
    expect(items[0].sort_order).toBe(0);
    expect(items[1].id).toBe(1);
    expect(items[1].sort_order).toBe(1);
  });

  it('FE-STORE-PACKING-002: reorderPackingItems rolls back to previous order on failure', async () => {
    const a = buildPackingItem({ id: 1, trip_id: 1, sort_order: 0 });
    const b = buildPackingItem({ id: 2, trip_id: 1, sort_order: 1 });
    seedStore(useTripStore, { packingItems: [a, b] });
    // No trip 1 in Dexie — the local adapter 404s like TripAccessGuard did.
    await seedDb([], { trip: false });

    await useTripStore.getState().reorderPackingItems(1, [2, 1]);
    // After failure the original order is restored
    const items = useTripStore.getState().packingItems;
    expect(items[0].id).toBe(1);
    expect(items[1].id).toBe(2);
    expect(addToast).toHaveBeenCalledWith('Trip not found', 'error', undefined);
  });

  it('FE-STORE-PACKING-003: updatePackingItem throws the adapter message and keeps the item', async () => {
    const item = buildPackingItem({ id: 1, trip_id: 1, name: 'Tent' });
    seedStore(useTripStore, { packingItems: [item] });
    await seedDb([], { trip: false }); // no trip — update rejects

    await expect(
      useTripStore.getState().updatePackingItem(1, 1, { name: 'Tarp' })
    ).rejects.toThrow('Trip not found');
    expect(useTripStore.getState().packingItems[0].name).toBe('Tent');
  });

  it('FE-STORE-PACKING-006: clonePackingItem appends the personal copy', async () => {
    const item = buildPackingItem({ id: 1, trip_id: 1, name: 'Powerbank' });
    seedStore(useTripStore, { packingItems: [item] });
    await seedDb([item]);

    await useTripStore.getState().clonePackingItem(1, 1);

    // nextId is session-monotonic — assert the clone landed, not a fixed id.
    const items = useTripStore.getState().packingItems;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe(1);
    expect(items[1].id).not.toBe(1);
    expect(items[1]).toMatchObject({ name: 'Powerbank', is_private: 1, checked: 0 });
  });

  it('FE-STORE-PACKING-007: clonePackingItem ignores a copy the list already holds', async () => {
    const item = buildPackingItem({ id: 1, trip_id: 1 });
    const clone = buildPackingItem({ id: 2, trip_id: 1, is_private: 1 });
    seedStore(useTripStore, { packingItems: [item, clone] });
    await seedDb([item]);
    // Return a clone whose id the list already holds — the dedupe branch must
    // keep the array untouched. (Which id nextId allocates varies by test
    // order, so pin the response instead of the allocator.)
    vi.spyOn(packingApi, 'clone').mockResolvedValue({ item: clone });

    await useTripStore.getState().clonePackingItem(1, 1);

    expect(useTripStore.getState().packingItems.map(i => i.id)).toEqual([1, 2]);
  });

  it('FE-STORE-PACKING-008: clonePackingItem notifies instead of throwing on failure', async () => {
    const item = buildPackingItem({ id: 1, trip_id: 1 });
    seedStore(useTripStore, { packingItems: [item] });
    await seedDb([], { trip: false }); // no trip — clone rejects

    await expect(useTripStore.getState().clonePackingItem(1, 1)).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledWith('Trip not found', 'error', undefined);
    expect(useTripStore.getState().packingItems).toHaveLength(1);
  });

  it('FE-STORE-PACKING-014: add, update, toggle and delete only touch the targeted item', async () => {
    const target = buildPackingItem({ id: 1, trip_id: 1, name: 'Tent', checked: 0 });
    const sibling = buildPackingItem({ id: 2, trip_id: 1, name: 'Stove', checked: 0 });
    seedStore(useTripStore, { packingItems: [target, sibling] });
    await seedDb([target, sibling]);

    const added = await useTripStore.getState().addPackingItem(1, { name: 'Mat' });
    // nextId is session-monotonic — the new id is whatever the adapter issued.
    expect(useTripStore.getState().packingItems.map(i => i.id)).toEqual([1, 2, added.id]);

    await useTripStore.getState().updatePackingItem(1, 1, { name: 'Tarp' });
    await useTripStore.getState().togglePackingItem(1, 1, true);
    await useTripStore.getState().deletePackingItem(1, added.id);

    const items = useTripStore.getState().packingItems;
    expect(items.map(i => i.id)).toEqual([1, 2]);
    expect(items[0].name).toBe('Tarp');
    expect(items[0].checked).toBe(1);
    expect(items[1].name).toBe('Stove');
    expect(items[1].checked).toBe(0);
  });

  it('FE-STORE-PACKING-015: reorderPackingItems drops unknown ids and keeps unlisted items at the end', async () => {
    const a = buildPackingItem({ id: 1, trip_id: 1, sort_order: 0 });
    const b = buildPackingItem({ id: 2, trip_id: 1, sort_order: 1 });
    const untouched = buildPackingItem({ id: 3, trip_id: 1, sort_order: 2 });
    seedStore(useTripStore, { packingItems: [a, b, untouched] });
    await seedDb([a, b, untouched]);

    await useTripStore.getState().reorderPackingItems(1, [2, 999, 1]);

    const items = useTripStore.getState().packingItems;
    expect(items.map(i => i.id)).toEqual([2, 1, 3]);
    // The unknown id is dropped before reindexing, so the reordered items get a
    // gapless sequence; the unlisted item keeps its own sort_order.
    expect(items.map(i => i.sort_order)).toEqual([0, 1, 2]);
  });

  it('FE-STORE-PACKING-013: togglePackingItem rolls the checkbox back and notifies on failure', async () => {
    const item = buildPackingItem({ id: 1, trip_id: 1, checked: 0 });
    seedStore(useTripStore, { packingItems: [item] });
    await seedDb([], { trip: false }); // no trip — update rejects

    await useTripStore.getState().togglePackingItem(1, 1, true);

    expect(useTripStore.getState().packingItems[0].checked).toBe(0);
    expect(addToast).toHaveBeenCalledWith('Trip not found', 'error', undefined);
  });
});
