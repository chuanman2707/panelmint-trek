import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildDay, buildPlace, buildTrip, buildAssignment } from '../../helpers/factories';
import { db } from '../../../src/db/panelmintDb';
import { assignmentsApi } from '../../../src/api/client';
import { LocalApiError } from '../../../src/api/local/helpers';
import type { DayRow, StoredAssignment } from '../../../src/api/local/dexieStore';
import type { Assignment } from '../../../src/types';

// assignmentsApi is the local adapter — every "server" row the slice actions
// run against is a panelmint row now, seeded below the way daysSlice.test.ts
// does it. vi.spyOn keeps the three things MSW used to provide: the mid-flight
// optimistic snapshot (mockImplementation around the real call), the refusal
// (mockRejectedValue with a LocalApiError) and the doctored response
// (mockResolvedValue — the adapter can never produce a bare/unsynced row).
async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
}

beforeEach(async () => {
  resetAllStores();
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const storedAssignment = (over: Partial<StoredAssignment>): StoredAssignment => ({
  id: 500,
  day_id: 1,
  place_id: 10,
  order_index: 0,
  notes: null,
  reservation_status: 'none',
  reservation_notes: null,
  reservation_datetime: null,
  assignment_time: null,
  assignment_end_time: null,
  end_day: 0,
  accommodation_id: null,
  leg_transport_mode: null,
  incoming_leg_transport_mode: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ...over,
});

/** Trip 1 is seeded per test; this puts a day carrying the given stops. */
const seedDay = async (id: number, assignments: StoredAssignment[] = []) => {
  const day = { vias: [], ...buildDay({ id, trip_id: 1, day_number: id }) } as DayRow;
  day.assignments = assignments as never;
  await db.days.put(day);
};

const storedDay = async (id: number): Promise<DayRow> => (await db.days.get(id)) as DayRow;

describe('assignmentsSlice', () => {
  describe('assignPlaceToDay', () => {
    it('FE-ASSIGN-001: assignPlaceToDay adds optimistic temp ID (negative) immediately', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1);
      seedStore(useTripStore, {
        places: [place],
        assignments: { '1': [] },
      });

      // Don't await — check state mid-flight
      let tempAdded = false;
      const real = assignmentsApi.create.bind(assignmentsApi);
      vi.spyOn(assignmentsApi, 'create').mockImplementation(async (t, d, data) => {
        if ((useTripStore.getState().assignments['1'] ?? []).some(a => a.id < 0)) {
          tempAdded = true;
        }
        return real(t, d, data);
      });

      await useTripStore.getState().assignPlaceToDay(1, 1, 10);
      expect(tempAdded).toBe(true);
    });

    it('FE-ASSIGN-002: after API success, temp ID is replaced with real assignment', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1);
      seedStore(useTripStore, {
        places: [place],
        assignments: { '1': [] },
      });

      await useTripStore.getState().assignPlaceToDay(1, 1, 10);

      const dayAssignments = useTripStore.getState().assignments['1'];
      expect(dayAssignments).toHaveLength(1);
      // The local adapter allocated the real id — the persisted row's own.
      const created = (await storedDay(1)).assignments![0] as unknown as StoredAssignment;
      expect(dayAssignments[0].id).toBe(created.id);
      expect(dayAssignments.every(a => a.id > 0)).toBe(true);
    });

    it('FE-ASSIGN-003: on API failure, temp assignment is removed (rollback)', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      seedStore(useTripStore, {
        places: [place],
        assignments: { '1': [] },
      });

      vi.spyOn(assignmentsApi, 'create').mockRejectedValue(new LocalApiError(500, 'Error'));

      await expect(useTripStore.getState().assignPlaceToDay(1, 1, 10)).rejects.toThrow();

      const dayAssignments = useTripStore.getState().assignments['1'];
      expect(dayAssignments).toHaveLength(0);
    });

    it('FE-ASSIGN-001b: returns undefined if place not found in store', async () => {
      seedStore(useTripStore, {
        places: [], // no places seeded
        assignments: { '1': [] },
      });

      const result = await useTripStore.getState().assignPlaceToDay(1, 1, 999);
      expect(result).toBeUndefined();
    });

    it('FE-ASSIGN-008: a day with no assignments entry yet is seeded from scratch', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1);
      seedStore(useTripStore, { places: [place], assignments: {} });

      await useTripStore.getState().assignPlaceToDay(1, 1, 10);
      const created = (await storedDay(1)).assignments![0] as unknown as StoredAssignment;
      expect(useTripStore.getState().assignments['1'].map(a => a.id)).toEqual([created.id]);
    });

    it('FE-ASSIGN-009: a response without a nested place falls back to the store place', async () => {
      const place = buildPlace({ id: 10, trip_id: 1, name: 'Louvre' });
      seedStore(useTripStore, { places: [place], assignments: { '1': [] } });

      // The real adapter always joins the place; the bare row is the
      // offline-replay shape only a stub can produce.
      const bare = { ...buildAssignment({ id: 999, day_id: 1, place_id: 10 }), place: undefined };
      vi.spyOn(assignmentsApi, 'create').mockResolvedValue({ assignment: bare as Assignment });

      await useTripStore.getState().assignPlaceToDay(1, 1, 10);
      expect(useTripStore.getState().assignments['1'][0].place?.name).toBe('Louvre');
    });

    it('FE-ASSIGN-010: inserting at a position keeps the other rows and reorders server-side', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      const existing = buildAssignment({ id: 1, day_id: 1, order_index: 0 });
      const other = buildAssignment({ id: 2, day_id: 1, order_index: 1 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1, [
        storedAssignment({ id: 1, day_id: 1, place_id: 10, order_index: 0 }),
        storedAssignment({ id: 2, day_id: 1, place_id: 10, order_index: 1 }),
      ]);
      seedStore(useTripStore, { places: [place], assignments: { '1': [existing, other] } });

      let reorderBody: number[] | undefined;
      const realReorder = assignmentsApi.reorder.bind(assignmentsApi);
      vi.spyOn(assignmentsApi, 'reorder').mockImplementation(async (t, d, ids) => {
        reorderBody = ids;
        return realReorder(t, d, ids);
      });

      await useTripStore.getState().assignPlaceToDay(1, 1, 10, 1);

      const items = useTripStore.getState().assignments['1'];
      expect(items.map(a => a.id)).toEqual([1, items[1].id, 2]);
      expect(items[1].id).toBeGreaterThan(0);
      expect(items.map(a => a.order_index)).toEqual([0, 1, 2]);
      expect(reorderBody).toEqual([1, items[1].id, 2]);
    });

    it('FE-ASSIGN-011: a failing follow-up reorder keeps the optimistic order', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1, [storedAssignment({ id: 1, day_id: 1, place_id: 10, order_index: 0 })]);
      seedStore(useTripStore, {
        places: [place],
        assignments: { '1': [buildAssignment({ id: 1, day_id: 1, order_index: 0 })] },
      });

      vi.spyOn(assignmentsApi, 'reorder').mockRejectedValue(new LocalApiError(500, 'Error'));

      // The reorder failure is swallowed — the create itself already succeeded.
      await expect(useTripStore.getState().assignPlaceToDay(1, 1, 10, 0)).resolves.toBeDefined();
      const items = useTripStore.getState().assignments['1'];
      expect(items[0].id).toBeGreaterThan(1);
      expect(items[1].id).toBe(1);
    });

    it('FE-ASSIGN-023: the position counts in the day as sorted, not as the store happens to hold it', async () => {
      // A row that came in over the socket sits at the end of the stored list whatever
      // its order_index says, so the day the planner shows and the list the splice
      // ran on disagreed and the new row landed behind the wrong neighbour.
      const place = buildPlace({ id: 10, trip_id: 1 });
      const later = buildAssignment({ id: 2, day_id: 1, order_index: 1 });
      const first = buildAssignment({ id: 1, day_id: 1, order_index: 0 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1, [
        storedAssignment({ id: 1, day_id: 1, place_id: 10, order_index: 0 }),
        storedAssignment({ id: 2, day_id: 1, place_id: 10, order_index: 1 }),
      ]);
      seedStore(useTripStore, { places: [place], assignments: { '1': [later, first] } });

      let reorderBody: number[] | undefined;
      const realReorder = assignmentsApi.reorder.bind(assignmentsApi);
      vi.spyOn(assignmentsApi, 'reorder').mockImplementation(async (t, d, ids) => {
        reorderBody = ids;
        return realReorder(t, d, ids);
      });

      await useTripStore.getState().assignPlaceToDay(1, 1, 10, 1);

      const items = useTripStore.getState().assignments['1'];
      expect(items.map(a => a.id)).toEqual([1, items[1].id, 2]);
      expect(items.map(a => a.order_index)).toEqual([0, 1, 2]);
      expect(reorderBody).toEqual([1, items[1].id, 2]);
    });

    it('FE-ASSIGN-012: no reorder call when the day holds no server-side ids', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { places: [place], assignments: { '1': [] } });

      // An unsynced (still negative) id echoed back by the offline replay path.
      vi.spyOn(assignmentsApi, 'create').mockResolvedValue({
        assignment: buildAssignment({ id: -42, day_id: 1, place_id: 10, place }),
      });
      const reorderSpy = vi.spyOn(assignmentsApi, 'reorder');

      await useTripStore.getState().assignPlaceToDay(1, 1, 10, 0);
      expect(reorderSpy).not.toHaveBeenCalled();
      expect(useTripStore.getState().assignments['1'].map(a => a.id)).toEqual([-42]);
    });
  });

  describe('removeAssignment', () => {
    it('FE-ASSIGN-004: removeAssignment is optimistically removed, re-added on failure', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      const assignment = buildAssignment({ id: 100, day_id: 1, place });
      seedStore(useTripStore, {
        assignments: { '1': [assignment] },
      });

      vi.spyOn(assignmentsApi, 'delete').mockRejectedValue(new LocalApiError(500, 'Error'));

      await expect(useTripStore.getState().removeAssignment(1, 1, 100)).rejects.toThrow();

      // Should be rolled back
      const dayAssignments = useTripStore.getState().assignments['1'];
      expect(dayAssignments).toHaveLength(1);
      expect(dayAssignments[0].id).toBe(100);
    });

    it('FE-ASSIGN-004b: removeAssignment success removes from store', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      const assignment = buildAssignment({ id: 100, day_id: 1, place });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1, [storedAssignment({ id: 100, day_id: 1, place_id: 10 })]);
      seedStore(useTripStore, {
        assignments: { '1': [assignment] },
      });

      await useTripStore.getState().removeAssignment(1, 1, 100);

      expect(useTripStore.getState().assignments['1']).toHaveLength(0);
      expect((await storedDay(1)).assignments).toEqual([]);
    });
  });

  describe('reorderAssignments', () => {
    it('FE-ASSIGN-005: reorderAssignments updates order_index of assignments', async () => {
      const place1 = buildPlace({ id: 10 });
      const place2 = buildPlace({ id: 20 });
      const a1 = buildAssignment({ id: 1, day_id: 5, order_index: 0, place: place1 });
      const a2 = buildAssignment({ id: 2, day_id: 5, order_index: 1, place: place2 });
      await db.trips.put(buildTrip({ id: 1 }));
      await seedDay(5, [
        storedAssignment({ id: 1, day_id: 5, place_id: 10, order_index: 0 }),
        storedAssignment({ id: 2, day_id: 5, place_id: 20, order_index: 1 }),
      ]);
      seedStore(useTripStore, {
        assignments: { '5': [a1, a2] },
      });

      await useTripStore.getState().reorderAssignments(1, 5, [2, 1]);

      const dayAssignments = useTripStore.getState().assignments['5'];
      const reorderedA2 = dayAssignments.find(a => a.id === 2);
      const reorderedA1 = dayAssignments.find(a => a.id === 1);
      expect(reorderedA2?.order_index).toBe(0);
      expect(reorderedA1?.order_index).toBe(1);
    });

    it('FE-ASSIGN-005b: reorderAssignments rolls back on failure', async () => {
      const place1 = buildPlace({ id: 10 });
      const place2 = buildPlace({ id: 20 });
      const a1 = buildAssignment({ id: 1, day_id: 5, order_index: 0, place: place1 });
      const a2 = buildAssignment({ id: 2, day_id: 5, order_index: 1, place: place2 });
      seedStore(useTripStore, {
        assignments: { '5': [a1, a2] },
      });

      vi.spyOn(assignmentsApi, 'reorder').mockRejectedValue(new LocalApiError(500, 'Error'));

      await expect(useTripStore.getState().reorderAssignments(1, 5, [2, 1])).rejects.toThrow();

      const dayAssignments = useTripStore.getState().assignments['5'];
      expect(dayAssignments.find(a => a.id === 1)?.order_index).toBe(0);
      expect(dayAssignments.find(a => a.id === 2)?.order_index).toBe(1);
    });

    it('FE-ASSIGN-013: ids that are no longer on the day are dropped from the new order', async () => {
      const a1 = buildAssignment({ id: 1, day_id: 5, order_index: 0 });
      await db.trips.put(buildTrip({ id: 1 }));
      await seedDay(5, [storedAssignment({ id: 1, day_id: 5, place_id: 10, order_index: 0 })]);
      seedStore(useTripStore, { assignments: { '5': [a1] } });

      await useTripStore.getState().reorderAssignments(1, 5, [999, 1]);

      const dayAssignments = useTripStore.getState().assignments['5'];
      expect(dayAssignments.map(a => a.id)).toEqual([1]);
      expect(dayAssignments[0].order_index).toBe(1);
    });

    it('FE-ASSIGN-014: reordering a day with no assignments entry yields an empty list', async () => {
      await db.trips.put(buildTrip({ id: 1 }));
      await seedDay(5);
      seedStore(useTripStore, { assignments: {} });

      await useTripStore.getState().reorderAssignments(1, 5, [1, 2]);

      expect(useTripStore.getState().assignments['5']).toEqual([]);
    });
  });

  describe('moveAssignment', () => {
    it('FE-ASSIGN-006: moveAssignment removes from source day and adds to target day', async () => {
      const place = buildPlace({ id: 10 });
      const assignment = buildAssignment({ id: 50, day_id: 1, order_index: 0, place });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(place);
      await seedDay(1, [storedAssignment({ id: 50, day_id: 1, place_id: 10 })]);
      await seedDay(2);
      seedStore(useTripStore, {
        assignments: {
          '1': [assignment],
          '2': [],
        },
      });

      await useTripStore.getState().moveAssignment(1, 50, 1, 2);

      expect(useTripStore.getState().assignments['1']).toHaveLength(0);
      expect(useTripStore.getState().assignments['2']).toHaveLength(1);
      expect(useTripStore.getState().assignments['2'][0].id).toBe(50);
    });

    it('FE-ASSIGN-007: moveAssignment rolls back on failure', async () => {
      const place = buildPlace({ id: 10 });
      const assignment = buildAssignment({ id: 50, day_id: 1, order_index: 0, place });
      seedStore(useTripStore, {
        assignments: {
          '1': [assignment],
          '2': [],
        },
      });

      vi.spyOn(assignmentsApi, 'move').mockRejectedValue(new LocalApiError(500, 'Error'));

      await expect(useTripStore.getState().moveAssignment(1, 50, 1, 2)).rejects.toThrow();

      // Rolled back: assignment back in day 1
      expect(useTripStore.getState().assignments['1']).toHaveLength(1);
      expect(useTripStore.getState().assignments['1'][0].id).toBe(50);
      expect(useTripStore.getState().assignments['2']).toHaveLength(0);
    });

    it('FE-ASSIGN-015: an unknown assignment id is a no-op', async () => {
      seedStore(useTripStore, { assignments: { '1': [buildAssignment({ id: 50, day_id: 1 })] } });

      await useTripStore.getState().moveAssignment(1, 999, 1, 2);

      expect(useTripStore.getState().assignments['1']).toHaveLength(1);
      expect(useTripStore.getState().assignments['2']).toBeUndefined();
    });

    it('FE-ASSIGN-016: a source day with no assignments entry is a no-op', async () => {
      seedStore(useTripStore, { assignments: {} });

      await useTripStore.getState().moveAssignment(1, 50, 1, 2);

      expect(useTripStore.getState().assignments).toEqual({});
    });

    it('FE-ASSIGN-017: dropping at an explicit index renumbers the target day and pushes the new order', async () => {
      const moved = buildAssignment({ id: 50, day_id: 1, order_index: 0 });
      const t1 = buildAssignment({ id: 60, day_id: 2, order_index: 1 });
      const t2 = buildAssignment({ id: 61, day_id: 2, order_index: 0 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(buildPlace({ id: 10, trip_id: 1 }));
      await seedDay(1, [storedAssignment({ id: 50, day_id: 1, place_id: 10 })]);
      await seedDay(2, [
        storedAssignment({ id: 60, day_id: 2, place_id: 10, order_index: 1 }),
        storedAssignment({ id: 61, day_id: 2, place_id: 10, order_index: 0 }),
      ]);
      seedStore(useTripStore, { assignments: { '1': [moved], '2': [t1, t2] } });

      let reorderBody: number[] | undefined;
      const realReorder = assignmentsApi.reorder.bind(assignmentsApi);
      vi.spyOn(assignmentsApi, 'reorder').mockImplementation(async (t, d, ids) => {
        reorderBody = ids;
        return realReorder(t, d, ids);
      });

      await useTripStore.getState().moveAssignment(1, 50, 1, 2, 1);

      const target = useTripStore.getState().assignments['2'];
      // Target day is sorted by order_index first (61, 60), then the drop lands at index 1.
      expect(target.map(a => a.id)).toEqual([61, 50, 60]);
      expect(target.map(a => a.order_index)).toEqual([0, 1, 2]);
      expect(target[1].day_id).toBe(2);
      expect(reorderBody).toEqual([61, 50, 60]);
    });

    it('FE-ASSIGN-018: moving onto a day with no assignments entry skips the reorder call', async () => {
      const moved = buildAssignment({ id: 50, day_id: 1, order_index: 0 });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put(buildPlace({ id: 10, trip_id: 1 }));
      await seedDay(1, [storedAssignment({ id: 50, day_id: 1, place_id: 10 })]);
      await seedDay(2);
      seedStore(useTripStore, { assignments: { '1': [moved] } });

      const reorderSpy = vi.spyOn(assignmentsApi, 'reorder');

      await useTripStore.getState().moveAssignment(1, 50, 1, 2);

      expect(useTripStore.getState().assignments['2'].map(a => a.id)).toEqual([50]);
      expect(reorderSpy).not.toHaveBeenCalled();
    });
  });

  describe('setAssignmentTimes', () => {
    // The pool place still carries an End of its own, which the visit shows once its
    // own override is gone, exactly as a fresh read of the day would.
    const pool = () => buildPlace({ id: 10, trip_id: 1, place_time: null, end_time: '18:00' });
    const visit = () => buildAssignment({
      id: 5, day_id: 1, place_id: 10, assignment_time: '09:00', assignment_end_time: '14:00',
      place: { ...pool(), place_time: '09:00', end_time: '14:00' },
    });

    it('FE-ASSIGN-020: clears the End at once, with the place End showing through, and keeps the Start', async () => {
      await db.trips.put(buildTrip({ id: 1 }));
      await db.places.put({ ...pool(), place_time: '09:00' });
      await seedDay(1, [storedAssignment({
        id: 5, day_id: 1, place_id: 10, assignment_time: '09:00', assignment_end_time: '14:00',
      })]);
      seedStore(useTripStore, { places: [pool()], assignments: { '1': [visit()] } });

      let seen: unknown;
      let mid: unknown;
      const real = assignmentsApi.updateTime.bind(assignmentsApi);
      const spy = vi.spyOn(assignmentsApi, 'updateTime').mockImplementation(async (t, id, times) => {
        seen = times;
        mid = useTripStore.getState().assignments['1'][0];
        return real(t, id, times);
      });

      await useTripStore.getState().setAssignmentTimes(1, 1, 5, { place_time: '09:00', end_time: null });

      // The optimistic draft was already in the store when the write ran.
      expect(mid).toMatchObject({ assignment_end_time: null, place: { end_time: '18:00', place_time: '09:00' } });
      expect(spy).toHaveBeenCalledWith(1, 5, { place_time: '09:00', end_time: null });
      expect(seen).toEqual({ place_time: '09:00', end_time: null });
      expect(useTripStore.getState().assignments['1'][0]).toMatchObject({
        assignment_time: '09:00', assignment_end_time: null, place: { end_time: '18:00' },
      });
    });

    it('FE-ASSIGN-021: a refused write puts the visit back as it was', async () => {
      seedStore(useTripStore, { places: [pool()], assignments: { '1': [visit()] } });
      vi.spyOn(assignmentsApi, 'updateTime').mockRejectedValue(new LocalApiError(403, 'no'));

      await expect(useTripStore.getState().setAssignmentTimes(1, 1, 5, { place_time: '09:00', end_time: null })).rejects.toBeTruthy();

      expect(useTripStore.getState().assignments['1'][0]).toMatchObject({ assignment_end_time: '14:00', place: { end_time: '14:00' } });
    });

    it('FE-ASSIGN-022: a visit it cannot find, or one not yet saved, is left alone', async () => {
      const unsaved = { ...visit(), id: -3 };
      seedStore(useTripStore, { places: [pool()], assignments: { '1': [unsaved] } });

      await useTripStore.getState().setAssignmentTimes(1, 1, 5, { place_time: null, end_time: null });
      await useTripStore.getState().setAssignmentTimes(1, 1, -3, { place_time: null, end_time: null });

      expect(useTripStore.getState().assignments['1'][0]).toEqual(unsaved);
    });
  });

  describe('setAssignments', () => {
    it('FE-ASSIGN-019: replaces the whole assignments map', () => {
      seedStore(useTripStore, { assignments: { '1': [buildAssignment({ id: 1, day_id: 1 })] } });

      const next = { '9': [buildAssignment({ id: 90, day_id: 9 })] };
      useTripStore.getState().setAssignments(next);

      expect(useTripStore.getState().assignments).toEqual(next);
    });
  });
});
