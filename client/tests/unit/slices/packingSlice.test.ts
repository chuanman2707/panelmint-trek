// FE-PACKING-001 to FE-PACKING-006 (add/update/delete/toggle paths)
//
// packingRepo is the Dexie-backed local adapter now — there is no HTTP layer
// to mock. Happy paths seed the rows the calls act on; failure paths omit the
// trip, the local equivalent of the server's 4xx/5xx rejections.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildPackingItem, buildTrip } from '../../helpers/factories';
import { db } from '../../../src/db/panelmintDb';
import type { PackingItem } from '../../../src/types';

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
});

describe('packingSlice', () => {
  describe('addPackingItem', () => {
    it('FE-PACKING-001: addPackingItem writes to Dexie and appends item to packingItems', async () => {
      const existing = buildPackingItem({ trip_id: 1, name: 'Existing' });
      seedStore(useTripStore, { packingItems: [existing] });
      await seedDb([existing]);

      const result = await useTripStore.getState().addPackingItem(1, { name: 'Toothbrush', quantity: 1 });

      expect(result.name).toBe('Toothbrush');
      const items = useTripStore.getState().packingItems;
      expect(items).toHaveLength(2);
      // addPackingItem appends (not prepends)
      expect(items[items.length - 1].name).toBe('Toothbrush');
      expect((await db.packingItems.get(result.id))!.name).toBe('Toothbrush');
    });

    it('FE-PACKING-002: addPackingItem on failure throws', async () => {
      await seedDb([], { trip: false }); // no trip — the local adapter 404s

      await expect(
        useTripStore.getState().addPackingItem(1, { name: 'Fail item' })
      ).rejects.toThrow();
    });
  });

  describe('updatePackingItem', () => {
    it('FE-PACKING-003: updatePackingItem replaces item in array by id', async () => {
      const item = buildPackingItem({ id: 10, trip_id: 1, name: 'Old name', quantity: 1 });
      seedStore(useTripStore, { packingItems: [item] });
      await seedDb([item]);

      const result = await useTripStore.getState().updatePackingItem(1, 10, { name: 'New name' });

      expect(result.name).toBe('New name');
      expect(useTripStore.getState().packingItems[0].name).toBe('New name');
      expect((await db.packingItems.get(10))!.name).toBe('New name');
    });
  });

  describe('deletePackingItem', () => {
    it('FE-PACKING-004: deletePackingItem optimistically removes item, rollback on failure', async () => {
      const item = buildPackingItem({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { packingItems: [item] });
      await seedDb([], { trip: false }); // no trip — the local adapter 404s

      await expect(useTripStore.getState().deletePackingItem(1, 10)).rejects.toThrow();

      expect(useTripStore.getState().packingItems).toHaveLength(1);
      expect(useTripStore.getState().packingItems[0].id).toBe(10);
    });

    it('FE-PACKING-004b: deletePackingItem success removes item', async () => {
      const item1 = buildPackingItem({ id: 10, trip_id: 1 });
      const item2 = buildPackingItem({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { packingItems: [item1, item2] });
      await seedDb([item1, item2]);

      await useTripStore.getState().deletePackingItem(1, 10);

      const items = useTripStore.getState().packingItems;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(20);
      expect(await db.packingItems.get(10)).toBeUndefined();
    });
  });

  describe('togglePackingItem', () => {
    it('FE-PACKING-005: togglePackingItem sets checked optimistically', async () => {
      const item = buildPackingItem({ id: 10, trip_id: 1, checked: 0 });
      seedStore(useTripStore, { packingItems: [item] });
      await seedDb([item]);

      await useTripStore.getState().togglePackingItem(1, 10, true);

      expect(useTripStore.getState().packingItems[0].checked).toBe(1);
      expect((await db.packingItems.get(10))!.checked).toBe(1);
    });

    it('FE-PACKING-006: togglePackingItem rolls back checked on adapter failure', async () => {
      const item = buildPackingItem({ id: 10, trip_id: 1, checked: 0 });
      seedStore(useTripStore, { packingItems: [item] });
      await seedDb([], { trip: false }); // no trip — the local adapter 404s

      // toggle does NOT throw on error (silent rollback)
      await useTripStore.getState().togglePackingItem(1, 10, true);

      // Should be rolled back to original value
      expect(useTripStore.getState().packingItems[0].checked).toBe(0);
    });
  });
});
