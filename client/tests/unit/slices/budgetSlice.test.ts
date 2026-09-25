import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildBudgetItem, buildReservation, buildTrip } from '../../helpers/factories';
import { budgetApi } from '../../../src/api/local/budget';
import { usersApi } from '../../../src/api/local/users';
import { LocalApiError } from '../../../src/api/local/helpers';
import { db } from '../../../src/db/panelmintDb';

beforeEach(async () => {
  resetAllStores();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  await db.trips.put(buildTrip({ id: 1 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('budgetSlice', () => {
  describe('loadBudgetItems', () => {
    it('FE-BUDGET-001: loadBudgetItems fetches and replaces budgetItems', async () => {
      seedStore(useTripStore, { budgetItems: [] });

      const item = buildBudgetItem({ trip_id: 1 });
      await db.budgetItems.put(item);

      await useTripStore.getState().loadBudgetItems(1);

      expect(useTripStore.getState().budgetItems).toHaveLength(1);
      expect(useTripStore.getState().budgetItems[0].id).toBe(item.id);
    });
  });

  describe('addBudgetItem', () => {
    it('FE-BUDGET-002: addBudgetItem appends to budgetItems', async () => {
      const existing = buildBudgetItem({ trip_id: 1 });
      seedStore(useTripStore, { budgetItems: [existing] });

      const result = await useTripStore.getState().addBudgetItem(1, { name: 'Hotel', total_price: 200 });

      expect(result.name).toBe('Hotel');
      expect(result.total_price).toBe(200);
      expect(useTripStore.getState().budgetItems).toHaveLength(2);
    });

    it('FE-BUDGET-003: addBudgetItem on failure throws', async () => {
      vi.spyOn(budgetApi, 'create').mockRejectedValueOnce(new LocalApiError(500, 'server error'));

      await expect(
        useTripStore.getState().addBudgetItem(1, { name: 'Fail' })
      ).rejects.toThrow('server error');
    });
  });

  describe('updateBudgetItem', () => {
    it('FE-BUDGET-004: updateBudgetItem replaces item in array', async () => {
      const item = buildBudgetItem({ id: 10, trip_id: 1, name: 'Old', total_price: 100 });
      await db.budgetItems.put(item);
      seedStore(useTripStore, { budgetItems: [item] });

      const result = await useTripStore.getState().updateBudgetItem(1, 10, { name: 'Updated', total_price: 150 });

      expect(result.name).toBe('Updated');
      expect(useTripStore.getState().budgetItems[0].name).toBe('Updated');
    });

    it('FE-BUDGET-005: updateBudgetItem with total_price triggers loadReservations when reservation_id present', async () => {
      const reservation = buildReservation({ id: 42, trip_id: 1 });
      const item = buildBudgetItem({ id: 10, trip_id: 1, total_price: 100, reservation_id: 42 });
      await db.reservations.put(reservation);
      await db.budgetItems.put(item);
      const initialReservation = buildReservation({ id: 42, trip_id: 1 });
      seedStore(useTripStore, {
        budgetItems: [item],
        reservations: [initialReservation],
      });

      // The mirrored price lands on the reservation's metadata; the slice's
      // refresh re-reads panelmintDb so the reservation list picks it up.
      await db.reservations.put({ ...reservation, title: 'Refreshed Reservation' });

      await useTripStore.getState().updateBudgetItem(1, 10, { total_price: 200 });

      // Wait for the async loadReservations to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(useTripStore.getState().reservations).toHaveLength(1);
      expect(useTripStore.getState().reservations[0].title).toBe('Refreshed Reservation');
    });
  });

  describe('deleteBudgetItem', () => {
    it('FE-BUDGET-006: deleteBudgetItem optimistically removes item, rolls back on failure', async () => {
      const item = buildBudgetItem({ id: 10, trip_id: 1 });
      await db.budgetItems.put(item);
      seedStore(useTripStore, { budgetItems: [item] });

      vi.spyOn(budgetApi, 'delete').mockRejectedValueOnce(new LocalApiError(500, 'server error'));

      await expect(useTripStore.getState().deleteBudgetItem(1, 10)).rejects.toThrow();

      expect(useTripStore.getState().budgetItems).toHaveLength(1);
      expect(useTripStore.getState().budgetItems[0].id).toBe(10);
    });

    it('FE-BUDGET-006b: deleteBudgetItem success removes item', async () => {
      const item1 = buildBudgetItem({ id: 10, trip_id: 1 });
      const item2 = buildBudgetItem({ id: 20, trip_id: 1 });
      await db.budgetItems.bulkPut([item1, item2]);
      seedStore(useTripStore, { budgetItems: [item1, item2] });

      await useTripStore.getState().deleteBudgetItem(1, 10);

      expect(useTripStore.getState().budgetItems).toHaveLength(1);
      expect(useTripStore.getState().budgetItems[0].id).toBe(20);
      expect(await db.budgetItems.get(10)).toBeUndefined();
    });
  });

  describe('setBudgetItemMembers', () => {
    it('FE-BUDGET-007: setBudgetItemMembers updates members array on item', async () => {
      const item = buildBudgetItem({ id: 10, trip_id: 1, members: [] });
      await db.budgetItems.put(item);
      seedStore(useTripStore, { budgetItems: [item] });
      const { member: anna } = await usersApi.create(1, 'Anna');

      const result = await useTripStore.getState().setBudgetItemMembers(1, 10, [1, anna.id]);

      expect(result.members).toHaveLength(2);
      const updatedItem = useTripStore.getState().budgetItems.find(i => i.id === 10);
      expect(updatedItem?.members).toHaveLength(2);
      expect(updatedItem?.persons).toBe(2);
    });
  });

  describe('toggleBudgetMemberPaid', () => {
    it('FE-BUDGET-008: toggleBudgetMemberPaid updates paid status after API success', async () => {
      const { member: anna } = await usersApi.create(1, 'Anna');
      const member = { user_id: anna.id, paid: 0, amount: null, username: 'Anna' };
      const item = buildBudgetItem({ id: 10, trip_id: 1, members: [member] });
      await db.budgetItems.put(item);
      seedStore(useTripStore, { budgetItems: [item] });

      await useTripStore.getState().toggleBudgetMemberPaid(1, 10, anna.id, true);

      const updatedItem = useTripStore.getState().budgetItems.find(i => i.id === 10);
      const updatedMember = updatedItem?.members.find(m => m.user_id === anna.id);
      expect(updatedMember?.paid).toBe(1);
      expect((await db.budgetItems.get(10))!.members![0].paid).toBe(1);
    });
  });
});
