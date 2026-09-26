// FE-STORE-TODO-001 to FE-STORE-TODO-006 (reorder, #969, plus mutation and error paths)
//
// todoRepo is the Dexie-backed local adapter now — there is no HTTP layer to
// mock. Happy paths seed the rows the calls act on; failure paths omit the
// trip, the local equivalent of the server's rejections ('Trip not found' is
// what TripAccessGuard produced).
import 'fake-indexeddb/auto';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildTodoItem, buildTrip } from '../../../tests/helpers/factories';
import { db } from '../../db/panelmintDb';
import { useTripStore } from '../tripStore';
import type { TodoItem } from '../../types';

let addToast: ReturnType<typeof vi.fn>;

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
  addToast = vi.fn();
  window.__addToast = addToast as unknown as typeof window.__addToast;
});

afterEach(() => {
  delete window.__addToast;
});

describe('todoSlice', () => {
  it('FE-STORE-TODO-001: reorderTodoItems reorders optimistically and reindexes sort_order', async () => {
    const a = buildTodoItem({ id: 1, trip_id: 1, sort_order: 0 });
    const b = buildTodoItem({ id: 2, trip_id: 1, sort_order: 1 });
    seedStore(useTripStore, { todoItems: [a, b] });
    await seedDb([a, b]);

    await useTripStore.getState().reorderTodoItems(1, [2, 1]);
    const items = useTripStore.getState().todoItems;
    expect(items[0].id).toBe(2);
    expect(items[0].sort_order).toBe(0);
    expect(items[1].id).toBe(1);
    expect(items[1].sort_order).toBe(1);
  });

  it('FE-STORE-TODO-002: reorderTodoItems rolls back to previous order on failure', async () => {
    const a = buildTodoItem({ id: 1, trip_id: 1, sort_order: 0 });
    const b = buildTodoItem({ id: 2, trip_id: 1, sort_order: 1 });
    seedStore(useTripStore, { todoItems: [a, b] });
    await seedDb([], { trip: false }); // no trip — the local adapter 404s like TripAccessGuard did

    await useTripStore.getState().reorderTodoItems(1, [2, 1]);
    // After failure the original order is restored
    const items = useTripStore.getState().todoItems;
    expect(items[0].id).toBe(1);
    expect(items[1].id).toBe(2);
    expect(addToast).toHaveBeenCalledWith('Trip not found', 'error', undefined);
  });

  it('FE-STORE-TODO-003: updateTodoItem throws the adapter message and keeps the item', async () => {
    const item = buildTodoItem({ id: 1, trip_id: 1, name: 'Book ferry' });
    seedStore(useTripStore, { todoItems: [item] });
    await seedDb([], { trip: false }); // no trip — update rejects

    await expect(
      useTripStore.getState().updateTodoItem(1, 1, { name: 'Book train' })
    ).rejects.toThrow('Trip not found');
    expect(useTripStore.getState().todoItems[0].name).toBe('Book ferry');
  });

  it('FE-STORE-TODO-005: add, update, toggle and delete only touch the targeted todo', async () => {
    const target = buildTodoItem({ id: 1, trip_id: 1, name: 'Book ferry', checked: 0 });
    const sibling = buildTodoItem({ id: 2, trip_id: 1, name: 'Renew passport', checked: 0 });
    seedStore(useTripStore, { todoItems: [target, sibling] });
    await seedDb([target, sibling]);

    // nextId is session-monotonic — the new id is whatever the adapter issued.
    const added = await useTripStore.getState().addTodoItem(1, { name: 'Pack meds' });
    expect(useTripStore.getState().todoItems.map(i => i.id)).toEqual([1, 2, added.id]);

    await useTripStore.getState().updateTodoItem(1, 1, { name: 'Book train' });
    await useTripStore.getState().toggleTodoItem(1, 1, true);
    await useTripStore.getState().deleteTodoItem(1, added.id);

    const items = useTripStore.getState().todoItems;
    expect(items.map(i => i.id)).toEqual([1, 2]);
    expect(items[0].name).toBe('Book train');
    expect(items[0].checked).toBe(1);
    expect(items[1].name).toBe('Renew passport');
    expect(items[1].checked).toBe(0);
  });

  it('FE-STORE-TODO-006: reorderTodoItems drops unknown ids and keeps unlisted todos at the end', async () => {
    const a = buildTodoItem({ id: 1, trip_id: 1, sort_order: 0 });
    const b = buildTodoItem({ id: 2, trip_id: 1, sort_order: 1 });
    const untouched = buildTodoItem({ id: 3, trip_id: 1, sort_order: 2 });
    seedStore(useTripStore, { todoItems: [a, b, untouched] });
    await seedDb([a, b, untouched]);

    await useTripStore.getState().reorderTodoItems(1, [2, 999, 1]);

    const items = useTripStore.getState().todoItems;
    expect(items.map(i => i.id)).toEqual([2, 1, 3]);
    // The unknown id is dropped before reindexing, so the reordered todos get a
    // gapless sequence; the unlisted todo keeps its own sort_order.
    expect(items.map(i => i.sort_order)).toEqual([0, 1, 2]);
  });

  it('FE-STORE-TODO-004: toggleTodoItem rolls the checkbox back and notifies on failure', async () => {
    const item = buildTodoItem({ id: 1, trip_id: 1, checked: 0 });
    seedStore(useTripStore, { todoItems: [item] });
    await seedDb([], { trip: false }); // no trip — update rejects

    await useTripStore.getState().toggleTodoItem(1, 1, true);

    expect(useTripStore.getState().todoItems[0].checked).toBe(0);
    expect(addToast).toHaveBeenCalledWith('Trip not found', 'error', undefined);
  });
});
