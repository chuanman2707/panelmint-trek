// FE-STORE-BUDGET-001 to FE-STORE-BUDGET-017 — the budget slice against the
// local budgetApi (Dexie-backed): success paths seed panelmintDb and let the
// real adapter run; failure paths stub the adapter method the slice calls,
// the same boundary MSW used to fake.
import 'fake-indexeddb/auto';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildBudgetItem, buildReservation, buildTrip } from '../../../tests/helpers/factories';
import { useTripStore } from '../tripStore';
import { budgetApi } from '../../api/local/budget';
import { usersApi } from '../../api/local/users';
import { LocalApiError } from '../../api/local/helpers';
import { db } from '../../db/panelmintDb';

let addToast: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  resetAllStores();
  addToast = vi.fn();
  window.__addToast = addToast as unknown as typeof window.__addToast;
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  await db.trips.put(buildTrip({ id: 1 }));
});

afterEach(() => {
  delete window.__addToast;
  vi.restoreAllMocks();
});

describe('budgetSlice', () => {
  it('FE-STORE-BUDGET-001: loadBudgetItems populates store', async () => {
    const item = buildBudgetItem({ trip_id: 1 });
    await db.budgetItems.put(item);
    await useTripStore.getState().loadBudgetItems(1);
    expect(useTripStore.getState().budgetItems).toHaveLength(1);
    expect(useTripStore.getState().budgetItems[0].id).toBe(item.id);
  });

  it('FE-STORE-BUDGET-002: loadBudgetItems swallows errors silently', async () => {
    vi.spyOn(budgetApi, 'list').mockRejectedValueOnce(new LocalApiError(500, 'server error'));
    // Should NOT throw
    await expect(useTripStore.getState().loadBudgetItems(1)).resolves.toBeUndefined();
    expect(useTripStore.getState().budgetItems).toEqual([]);
  });

  it('FE-STORE-BUDGET-003: addBudgetItem appends to store and returns item', async () => {
    const result = await useTripStore.getState().addBudgetItem(1, { name: 'Hotel' });
    expect(result.name).toBe('Hotel');
    expect(useTripStore.getState().budgetItems.map(i => i.id)).toContain(result.id);
  });

  it('FE-STORE-BUDGET-004: addBudgetItem throws on API error', async () => {
    // The adapter's validation pipe produces the same 400 the server sent.
    await expect(useTripStore.getState().addBudgetItem(1, {} as never)).rejects.toThrow();
  });

  it('FE-STORE-BUDGET-005: updateBudgetItem replaces item in store', async () => {
    const existing = buildBudgetItem({ id: 10, trip_id: 1, name: 'Old' });
    await db.budgetItems.put(existing);
    seedStore(useTripStore, { budgetItems: [existing] });

    await useTripStore.getState().updateBudgetItem(1, 10, { name: 'New' });
    const items = useTripStore.getState().budgetItems;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('New');
  });

  it('FE-STORE-BUDGET-006: updateBudgetItem calls loadReservations when reservation_id + total_price provided', async () => {
    const existing = buildBudgetItem({ id: 20, trip_id: 1, reservation_id: 99 });
    await db.reservations.put(buildReservation({ id: 99, trip_id: 1 }));
    await db.budgetItems.put(existing);
    seedStore(useTripStore, { budgetItems: [existing] });

    const loadReservations = vi.fn().mockResolvedValue(undefined);
    seedStore(useTripStore, { loadReservations });

    await useTripStore.getState().updateBudgetItem(1, 20, { total_price: 50 });
    expect(loadReservations).toHaveBeenCalledWith(1);
  });

  it('FE-STORE-BUDGET-007: deleteBudgetItem optimistically removes and rolls back on error', async () => {
    const item = buildBudgetItem({ id: 5, trip_id: 1 });
    await db.budgetItems.put(item);
    seedStore(useTripStore, { budgetItems: [item] });

    vi.spyOn(budgetApi, 'delete').mockRejectedValueOnce(new LocalApiError(403, 'forbidden'));
    // The item is removed immediately (optimistic), then restored on error
    const deletePromise = useTripStore.getState().deleteBudgetItem(1, 5);
    await expect(deletePromise).rejects.toThrow();
    // After rollback, item is back
    expect(useTripStore.getState().budgetItems).toContainEqual(item);
  });

  it('FE-STORE-BUDGET-008: setBudgetItemMembers updates members on matching item', async () => {
    const item = buildBudgetItem({ id: 7, trip_id: 1, members: [] });
    await db.budgetItems.put(item);
    seedStore(useTripStore, { budgetItems: [item] });
    const { member: anna } = await usersApi.create(1, 'Anna');

    await useTripStore.getState().setBudgetItemMembers(1, 7, [1, anna.id]);
    const stored = useTripStore.getState().budgetItems.find(i => i.id === 7);
    expect(stored?.members).toHaveLength(2);
    expect(stored?.persons).toBe(2);
  });

  it('FE-STORE-BUDGET-009: toggleBudgetMemberPaid updates paid flag on matching member', async () => {
    const { member: carol } = await usersApi.create(1, 'carol');
    const item = buildBudgetItem({
      id: 8,
      trip_id: 1,
      members: [{ user_id: carol.id, paid: 0, amount: null, username: 'carol' }],
    });
    await db.budgetItems.put(item);
    seedStore(useTripStore, { budgetItems: [item] });

    await useTripStore.getState().toggleBudgetMemberPaid(1, 8, carol.id, true);
    const stored = useTripStore.getState().budgetItems.find(i => i.id === 8);
    expect(stored?.members?.[0]?.paid).toBe(1);
  });

  it('FE-STORE-BUDGET-010: reorderBudgetItems reorders optimistically and persists', async () => {
    const a = buildBudgetItem({ id: 1, trip_id: 1, sort_order: 0 });
    const b = buildBudgetItem({ id: 2, trip_id: 1, sort_order: 1 });
    await db.budgetItems.bulkPut([a, b]);
    seedStore(useTripStore, { budgetItems: [a, b] });

    await useTripStore.getState().reorderBudgetItems(1, [2, 1]);
    const items = useTripStore.getState().budgetItems;
    expect(items[0].id).toBe(2);
    expect(items[1].id).toBe(1);
    expect((await db.budgetItems.get(2))!.sort_order).toBe(0);
  });

  it('FE-STORE-BUDGET-011: reorderBudgetItems reloads list on API error', async () => {
    const a = buildBudgetItem({ id: 1, trip_id: 1 });
    const b = buildBudgetItem({ id: 2, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [a, b] });

    const freshItem = buildBudgetItem({ id: 99, trip_id: 1 });
    await db.budgetItems.put(freshItem);
    vi.spyOn(budgetApi, 'reorderItems').mockRejectedValueOnce(new LocalApiError(500, 'error'));
    await useTripStore.getState().reorderBudgetItems(1, [2, 1]);
    // After failure, the store reflects what the adapter's list actually holds.
    expect(useTripStore.getState().budgetItems.map(i => i.id)).toEqual([99]);
    expect(addToast).toHaveBeenCalledWith(expect.any(String), 'error', undefined);
  });

  it('FE-STORE-BUDGET-016: toggleBudgetMemberPaid tolerates an item that carries no members array', async () => {
    const bare = buildBudgetItem({ id: 40, trip_id: 1 });
    delete (bare as Partial<typeof bare>).members;
    const { member: carol } = await usersApi.create(1, 'carol');
    const other = buildBudgetItem({ id: 41, trip_id: 1, members: [{ user_id: carol.id, paid: 0, amount: null, username: 'carol' }] });
    await db.budgetItems.bulkPut([bare, other]);
    seedStore(useTripStore, { budgetItems: [bare, other] });

    await useTripStore.getState().toggleBudgetMemberPaid(1, 40, carol.id, true);

    expect(useTripStore.getState().budgetItems[0].members).toEqual([]);
    // The untouched item keeps its own members.
    expect(useTripStore.getState().budgetItems[1].members?.[0]?.paid).toBe(0);
  });

  it('FE-STORE-BUDGET-012: updateBudgetItem throws the server message and keeps the item', async () => {
    const existing = buildBudgetItem({ id: 30, trip_id: 1, name: 'Old' });
    await db.budgetItems.put(existing);
    seedStore(useTripStore, { budgetItems: [existing] });

    vi.spyOn(budgetApi, 'update').mockRejectedValueOnce(new LocalApiError(403, 'Budget is locked'));
    await expect(
      useTripStore.getState().updateBudgetItem(1, 30, { name: 'New' })
    ).rejects.toThrow('Budget is locked');
    expect(useTripStore.getState().budgetItems[0].name).toBe('Old');
  });

  it('FE-STORE-BUDGET-013: reorderBudgetCategories regroups items and appends unlisted categories', async () => {
    const food = buildBudgetItem({ id: 1, trip_id: 1, category: 'Food' });
    const transport = buildBudgetItem({ id: 2, trip_id: 1, category: 'Transport' });
    const food2 = buildBudgetItem({ id: 3, trip_id: 1, category: 'Food' });
    // No category at all — grouped under the 'Other' bucket.
    const uncategorised = buildBudgetItem({ id: 4, trip_id: 1, category: null });
    await db.budgetItems.bulkPut([food, transport, food2, uncategorised]);
    seedStore(useTripStore, { budgetItems: [food, transport, food2, uncategorised] });

    await useTripStore.getState().reorderBudgetCategories(1, ['Transport', 'Food']);

    expect(useTripStore.getState().budgetItems.map(i => i.id)).toEqual([2, 1, 3, 4]);
    // The category order table took the permutation the wire body used to send.
    const rows = await db.budgetCategoryOrder.where('trip_id').equals(1).toArray();
    expect(rows.map(r => [r.category, r.sort_order])).toEqual([['Transport', 0], ['Food', 1]]);
  });

  it('FE-STORE-BUDGET-014: reorderBudgetCategories ignores a category with no items', async () => {
    const food = buildBudgetItem({ id: 1, trip_id: 1, category: 'Food' });
    await db.budgetItems.put(food);
    seedStore(useTripStore, { budgetItems: [food] });

    await useTripStore.getState().reorderBudgetCategories(1, ['Lodging', 'Food']);

    expect(useTripStore.getState().budgetItems.map(i => i.id)).toEqual([1]);
  });

  it('FE-STORE-BUDGET-015: reorderBudgetCategories reloads the server order and notifies on failure', async () => {
    const food = buildBudgetItem({ id: 1, trip_id: 1, category: 'Food' });
    const transport = buildBudgetItem({ id: 2, trip_id: 1, category: 'Transport' });
    await db.budgetItems.bulkPut([food, transport]);
    seedStore(useTripStore, { budgetItems: [food, transport] });

    vi.spyOn(budgetApi, 'reorderCategories').mockRejectedValueOnce(new LocalApiError(500, 'Reorder rejected'));
    await useTripStore.getState().reorderBudgetCategories(1, ['Transport', 'Food']);

    // The reload re-read the adapter's real order (sort_order of the rows).
    expect(useTripStore.getState().budgetItems.map(i => i.id)).toEqual([1, 2]);
    expect(addToast).toHaveBeenCalledWith('Reorder rejected', 'error', undefined);
  });

  it('FE-STORE-BUDGET-017: a reorder whose reload also fails still notifies instead of rejecting', async () => {
    const a = buildBudgetItem({ id: 1, trip_id: 1 });
    const b = buildBudgetItem({ id: 2, trip_id: 1 });
    seedStore(useTripStore, { budgetItems: [a, b] });

    // The reorder and the recovery read both fail. The caller fires this
    // without awaiting, so nothing may escape as a rejection.
    vi.spyOn(budgetApi, 'reorderItems').mockRejectedValueOnce(new LocalApiError(500, 'error'));
    vi.spyOn(budgetApi, 'reorderCategories').mockRejectedValueOnce(new LocalApiError(500, 'error'));
    vi.spyOn(budgetApi, 'list').mockRejectedValue(new LocalApiError(500, 'offline'));

    await expect(useTripStore.getState().reorderBudgetItems(1, [2, 1])).resolves.toBeUndefined();
    await expect(useTripStore.getState().reorderBudgetCategories(1, ['Transport'])).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledTimes(2);
  });
});
