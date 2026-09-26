/**
 * packingRepo unit tests.
 *
 * The repo is a thin pass-through to the Dexie-backed `packingApi` adapter —
 * there is no REST layer and no offlineDb cache left to mediate. These tests
 * pin the delegation seam end-to-end over real IndexedDB; the adapter's full
 * parity coverage lives in tests/unit/local/packing.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { packingRepo } from '../../../src/repo/packingRepo';
import { packingApi } from '../../../src/api/client';
import { db } from '../../../src/db/panelmintDb';
import { buildPackingItem, buildTrip } from '../../helpers/factories';

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

describe('packingRepo', () => {
  it('list delegates to the local adapter and returns the trip items', async () => {
    const spy = vi.spyOn(packingApi, 'list');
    const item = buildPackingItem({ trip_id: 1 });
    await db.packingItems.put(item);

    const result = await packingRepo.list(1);

    expect(spy).toHaveBeenCalledWith(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(item.id);
  });

  it('create writes the item through to Dexie', async () => {
    const result = await packingRepo.create(1, { name: 'Sunscreen' });
    expect(result.item.name).toBe('Sunscreen');
    expect(await db.packingItems.get(result.item.id)).toMatchObject({ name: 'Sunscreen' });
  });

  it('update writes the change through to Dexie', async () => {
    const original = buildPackingItem({ id: 7, trip_id: 1, name: 'Jacket', checked: 0 });
    await db.packingItems.put(original);

    const result = await packingRepo.update(1, 7, { checked: true });
    expect(result.item.checked).toBe(1);
    expect((await db.packingItems.get(7))!.checked).toBe(1);
  });

  it('delete removes the row from Dexie', async () => {
    const item = buildPackingItem({ id: 7, trip_id: 1 });
    await db.packingItems.put(item);

    await expect(packingRepo.delete(1, 7)).resolves.toEqual({ success: true });
    expect(await db.packingItems.get(7)).toBeUndefined();
  });

  it('reorder persists the new sort_order sequence', async () => {
    await db.packingItems.bulkPut([
      buildPackingItem({ id: 1, trip_id: 1, sort_order: 0 }),
      buildPackingItem({ id: 2, trip_id: 1, sort_order: 1 }),
    ]);

    await expect(packingRepo.reorder(1, [2, 1])).resolves.toEqual({ success: true });
    expect((await db.packingItems.get(2))!.sort_order).toBe(0);
    expect((await db.packingItems.get(1))!.sort_order).toBe(1);
  });

  it('clone appends a personal copy through the adapter', async () => {
    await db.packingItems.put(buildPackingItem({ id: 1, trip_id: 1, name: 'Powerbank' }));

    const result = await packingRepo.clone(1, 1);
    expect(result.item).toMatchObject({ name: 'Powerbank', is_private: 1, checked: 0 });
    expect(result.item.id).not.toBe(1);
  });

  it('propagates the adapter error shape (Trip not found on a foreign trip)', async () => {
    await expect(packingRepo.list(99)).rejects.toMatchObject({ status: 404 });
  });
});
