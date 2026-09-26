/**
 * todoRepo unit tests.
 *
 * The repo is a thin pass-through to the Dexie-backed `todoApi` adapter —
 * there is no REST layer and no offlineDb cache left to mediate. These tests
 * pin the delegation seam end-to-end over real IndexedDB; the adapter's full
 * parity coverage lives in tests/unit/local/todos.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { todoRepo } from '../../../src/repo/todoRepo';
import { todoApi } from '../../../src/api/client';
import { db } from '../../../src/db/panelmintDb';
import { buildTodoItem, buildTrip } from '../../helpers/factories';

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  await db.trips.put(buildTrip({ id: 1 }));
}

beforeEach(resetDb);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('todoRepo', () => {
  it('list delegates to the local adapter and returns the trip items', async () => {
    const spy = vi.spyOn(todoApi, 'list');
    const item = buildTodoItem({ trip_id: 1 });
    await db.todoItems.put(item);

    const result = await todoRepo.list(1);

    expect(spy).toHaveBeenCalledWith(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(item.id);
  });

  it('create writes the item through to Dexie', async () => {
    const result = await todoRepo.create(1, { name: 'Book train' });
    expect(result.item.name).toBe('Book train');
    expect(await db.todoItems.get(result.item.id)).toMatchObject({ name: 'Book train' });
  });

  it('update writes the change through to Dexie', async () => {
    const original = buildTodoItem({ id: 7, trip_id: 1, name: 'Book train', checked: 0 });
    await db.todoItems.put(original);

    const result = await todoRepo.update(1, 7, { checked: 1 });
    expect(result.item.checked).toBe(1);
    expect((await db.todoItems.get(7))!.checked).toBe(1);
  });

  it('delete removes the row from Dexie', async () => {
    const item = buildTodoItem({ id: 7, trip_id: 1 });
    await db.todoItems.put(item);

    await expect(todoRepo.delete(1, 7)).resolves.toEqual({ success: true });
    expect(await db.todoItems.get(7)).toBeUndefined();
  });

  it('reorder persists the new sort_order sequence', async () => {
    await db.todoItems.bulkPut([
      buildTodoItem({ id: 1, trip_id: 1, sort_order: 0 }),
      buildTodoItem({ id: 2, trip_id: 1, sort_order: 1 }),
    ]);

    await expect(todoRepo.reorder(1, [2, 1])).resolves.toEqual({ success: true });
    expect((await db.todoItems.get(2))!.sort_order).toBe(0);
    expect((await db.todoItems.get(1))!.sort_order).toBe(1);
  });

  it('propagates the adapter error shape (Trip not found on a foreign trip)', async () => {
    await expect(todoRepo.list(99)).rejects.toMatchObject({ status: 404 });
  });
});
