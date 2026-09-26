import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildTodoItem, buildTrip } from '../../helpers/factories';
import { db } from '../../../src/db/panelmintDb';
import type { TodoItem } from '../../../src/types';

/** A clean panelmint db with the given todo rows — and trip 1 unless opted out. */
async function seedDb(items: TodoItem[] = [], opts: { trip?: boolean } = {}) {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  if (opts.trip !== false) await db.trips.put(buildTrip({ id: 1 }));
  if (items.length) await db.todoItems.bulkPut(items);
}

beforeEach(() => {
  resetAllStores();
});

describe('todoSlice', () => {
  describe('addTodoItem', () => {
    it('FE-TODO-001: addTodoItem writes to Dexie and appends item to todoItems', async () => {
      const existing = buildTodoItem({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { todoItems: [existing] });
      await seedDb([existing]);

      const result = await useTripStore.getState().addTodoItem(1, { name: 'Buy sunscreen', priority: 1 });

      expect(result.name).toBe('Buy sunscreen');
      const items = useTripStore.getState().todoItems;
      expect(items).toHaveLength(2);
      expect(await db.todoItems.get(result.id)).toMatchObject({ name: 'Buy sunscreen' });
    });

    it('FE-TODO-002: addTodoItem on failure throws', async () => {
      // No trip 1 in Dexie — the local adapter 404s like TripAccessGuard did.
      await seedDb([], { trip: false });
      await expect(
        useTripStore.getState().addTodoItem(1, { name: 'Fail' })
      ).rejects.toThrow('Trip not found');
    });
  });

  describe('updateTodoItem', () => {
    it('FE-TODO-003: updateTodoItem replaces item and preserves priority field', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, name: 'Old', priority: 2, sort_order: 5 });
      seedStore(useTripStore, { todoItems: [item] });
      await seedDb([item]);

      const result = await useTripStore.getState().updateTodoItem(1, 10, { name: 'Updated', priority: 2 });

      expect(result.name).toBe('Updated');
      expect(result.priority).toBe(2);
      expect(useTripStore.getState().todoItems[0].name).toBe('Updated');
      expect(useTripStore.getState().todoItems[0].priority).toBe(2);
    });
  });

  describe('deleteTodoItem', () => {
    it('FE-TODO-004: deleteTodoItem optimistically removes item, rollback on failure', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { todoItems: [item] });
      // Trip seeded but item absent — 'Item not found' rejects the delete.
      await seedDb();

      await expect(useTripStore.getState().deleteTodoItem(1, 10)).rejects.toThrow();

      expect(useTripStore.getState().todoItems).toHaveLength(1);
      expect(useTripStore.getState().todoItems[0].id).toBe(10);
    });

    it('FE-TODO-004b: deleteTodoItem success removes item from array', async () => {
      const item1 = buildTodoItem({ id: 10, trip_id: 1 });
      const item2 = buildTodoItem({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { todoItems: [item1, item2] });
      await seedDb([item1, item2]);

      await useTripStore.getState().deleteTodoItem(1, 10);

      const items = useTripStore.getState().todoItems;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(20);
      expect(await db.todoItems.get(10)).toBeUndefined();
    });
  });

  describe('toggleTodoItem', () => {
    it('FE-TODO-005: toggleTodoItem sets checked optimistically to 1', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, checked: 0 });
      seedStore(useTripStore, { todoItems: [item] });
      await seedDb([item]);

      await useTripStore.getState().toggleTodoItem(1, 10, true);

      expect(useTripStore.getState().todoItems[0].checked).toBe(1);
      expect((await db.todoItems.get(10))!.checked).toBe(1);
    });

    it('FE-TODO-006: toggleTodoItem rolls back checked on failure (silent)', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, checked: 0 });
      seedStore(useTripStore, { todoItems: [item] });
      await seedDb([], { trip: false }); // no trip — update rejects

      // Does NOT throw
      await useTripStore.getState().toggleTodoItem(1, 10, true);

      expect(useTripStore.getState().todoItems[0].checked).toBe(0);
    });

    it('FE-TODO-007: toggleTodoItem preserves sort_order field', async () => {
      const item = buildTodoItem({ id: 10, trip_id: 1, checked: 0, sort_order: 3 });
      seedStore(useTripStore, { todoItems: [item] });
      await seedDb([item]);

      await useTripStore.getState().toggleTodoItem(1, 10, true);

      expect(useTripStore.getState().todoItems[0].sort_order).toBe(3);
    });
  });
});
