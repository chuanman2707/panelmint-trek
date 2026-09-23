// FE-TSLICE-DAYS-001 to FE-TSLICE-DAYS-008 (whole-day reorder + insert, #589)
import 'fake-indexeddb/auto';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildDay, buildReservation, buildTrip } from '../../../tests/helpers/factories';
import { useTripStore } from '../tripStore';
import { db } from '../../db/panelmintDb';
import { daysApi } from '../../api/client';
import { LocalApiError } from '../../api/local/helpers';
import type { Day } from '../../types';
import type { DayRow } from '../../api/local/dexieStore';

beforeEach(async () => {
  resetAllStores();
  server.resetHandlers();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function datedDays(): Day[] {
  return [
    buildDay({ id: 1, trip_id: 1, day_number: 1, date: '2025-06-01', title: 'Arrival' }),
    buildDay({ id: 2, trip_id: 1, day_number: 2, date: '2025-06-02', title: 'Museums' }),
    buildDay({ id: 3, trip_id: 1, day_number: 3, date: '2025-06-03', title: 'Departure' }),
  ];
}

/** daysApi is the local adapter — the rows the store's day actions run on are
 *  panelmint rows now, so the fixtures are seeded there. */
async function seedTripDays(days: Day[]) {
  await db.trips.put(buildTrip({ id: 1, start_date: '2025-06-01', end_date: '2025-06-03' }));
  await db.days.bulkPut(days.map((d) => ({ ...d, vias: [] }) as DayRow));
}

/** Capture the optimistic state at the moment the api call runs, then let the
 *  real adapter finish. */
function captureOnReorder(into: { days: Day[] }) {
  const real = daysApi.reorder.bind(daysApi);
  return vi.spyOn(daysApi, 'reorder').mockImplementation(async (tripId, orderedIds) => {
    into.days = useTripStore.getState().days;
    return real(tripId, orderedIds);
  });
}

describe('daysSlice', () => {
  describe('reorderDays', () => {
    it('FE-TSLICE-DAYS-001: optimistically renumbers days and pins the dates to their slots', async () => {
      const days = datedDays();
      await seedTripDays(days);
      seedStore(useTripStore, { days });

      const captured = { days: [] as Day[] };
      captureOnReorder(captured);

      await useTripStore.getState().reorderDays(1, [3, 1, 2]);

      expect(captured.days.map(d => d.id)).toEqual([3, 1, 2]);
      expect(captured.days.map(d => d.day_number)).toEqual([1, 2, 3]);
      // Content moves across the slots; the dates stay pinned to the slots.
      expect(captured.days.map(d => d.date)).toEqual(['2025-06-01', '2025-06-02', '2025-06-03']);
      expect(captured.days[0].title).toBe('Departure');
    });

    it('FE-TSLICE-DAYS-002: sends the requested order and refreshes days plus bookings', async () => {
      const days = datedDays();
      await seedTripDays(days);
      seedStore(useTripStore, { days, reservations: [] });

      const spy = vi.spyOn(daysApi, 'reorder');
      server.use(
        http.get('/api/trips/1/reservations', () =>
          HttpResponse.json({ reservations: [buildReservation({ id: 77, trip_id: 1, title: 'Re-stamped' })] }),
        ),
      );

      await useTripStore.getState().reorderDays(1, [3, 1, 2]);

      expect(spy).toHaveBeenCalledWith(1, [3, 1, 2]);
      // The local adapter really reordered — the refreshed list is the new order.
      expect(useTripStore.getState().days.map(d => d.id)).toEqual([3, 1, 2]);
      expect(useTripStore.getState().reservations.map(r => r.title)).toEqual(['Re-stamped']);
    });

    it('FE-TSLICE-DAYS-003: an undated trip keeps each day carrying its own date', async () => {
      const undated = [
        buildDay({ id: 1, trip_id: 1, day_number: 1, date: null }),
        buildDay({ id: 2, trip_id: 1, day_number: 2, date: null }),
      ];
      await db.trips.put(buildTrip({ id: 1, start_date: null, end_date: null }));
      await db.days.bulkPut(undated.map((d) => ({ ...d, vias: [] }) as DayRow));
      seedStore(useTripStore, { days: undated });

      const captured = { days: [] as Day[] };
      captureOnReorder(captured);

      await useTripStore.getState().reorderDays(1, [2, 1]);

      expect(captured.days.map(d => d.id)).toEqual([2, 1]);
      expect(captured.days.every(d => d.date === null)).toBe(true);
    });

    it('FE-TSLICE-DAYS-004: ids that are not in the store are dropped from the optimistic list', async () => {
      const days = datedDays();
      await seedTripDays(days);
      seedStore(useTripStore, { days });

      // A bogus id fails the real adapter's permutation check — the slice's
      // optimistic drop is what this test pins, so the call is stubbed.
      const captured = { days: [] as Day[] };
      vi.spyOn(daysApi, 'reorder').mockImplementation(async () => {
        captured.days = useTripStore.getState().days;
        return { success: true as const };
      });

      await useTripStore.getState().reorderDays(1, [2, 999, 1, 3]);

      expect(captured.days.map(d => d.id)).toEqual([2, 1, 3]);
    });

    it('FE-TSLICE-DAYS-005: rolls back to the previous order and throws the server message', async () => {
      const days = datedDays();
      await seedTripDays(days);
      seedStore(useTripStore, { days });
      vi.spyOn(daysApi, 'reorder').mockRejectedValue(new LocalApiError(409, 'Reorder rejected'));

      await expect(useTripStore.getState().reorderDays(1, [3, 1, 2])).rejects.toThrow('Reorder rejected');

      const days2 = useTripStore.getState().days;
      expect(days2.map(d => d.id)).toEqual([1, 2, 3]);
      expect(days2.map(d => d.title)).toEqual(['Arrival', 'Museums', 'Departure']);
    });
  });

  describe('insertDay', () => {
    it('FE-TSLICE-DAYS-006: appends a day, refreshes the list and returns the new day', async () => {
      const days = datedDays();
      await seedTripDays(days);
      seedStore(useTripStore, { days });

      const spy = vi.spyOn(daysApi, 'create');

      const result = await useTripStore.getState().insertDay(1);

      expect(spy).toHaveBeenCalledWith(1, { position: undefined });
      expect(result?.day_number).toBe(4);
      expect(useTripStore.getState().days).toHaveLength(4);
    });

    it('FE-TSLICE-DAYS-007: forwards the 1-based insert position', async () => {
      const days = datedDays();
      await seedTripDays(days);
      seedStore(useTripStore, { days });

      const spy = vi.spyOn(daysApi, 'create');

      const result = await useTripStore.getState().insertDay(1, 2);

      expect(spy).toHaveBeenCalledWith(1, { position: 2 });
      // The real insert shifts the tail — the new row takes slot 2.
      const storeDays = useTripStore.getState().days;
      expect(storeDays.map(d => d.day_number)).toEqual([1, 2, 3, 4]);
      expect(storeDays[1].id).toBe(result!.id);
    });

    it('FE-TSLICE-DAYS-008: leaves the day list untouched and throws when the insert fails', async () => {
      const days = datedDays();
      await seedTripDays(days);
      seedStore(useTripStore, { days });
      vi.spyOn(daysApi, 'create').mockRejectedValue(new LocalApiError(403, 'Trip is locked'));

      await expect(useTripStore.getState().insertDay(1, 2)).rejects.toThrow('Trip is locked');
      // The insert never writes optimistically, so a failure needs no rollback.
      expect(useTripStore.getState().days.map(d => d.id)).toEqual([1, 2, 3]);
    });
  });
});
