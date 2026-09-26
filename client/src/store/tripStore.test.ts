// FE-TSTORE-001 to FE-TSTORE-021 (trip-scoped root store: load, hydrate, refresh, mutate)
import 'fake-indexeddb/auto';
import { http, HttpResponse } from 'msw';
import { server } from '../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import {
  buildAssignment,
  buildBudgetItem,
  buildCategory,
  buildDay,
  buildDayNote,
  buildPackingItem,
  buildPlace,
  buildReservation,
  buildTag,
  buildTodoItem,
  buildTrip,
  buildTripFile,
} from '../../tests/helpers/factories';
import { offlineDb } from '../db/offlineDb';
import { db } from '../db/panelmintDb';
import { tripsApi, daysApi, tagsApi, placesApi, categoriesApi } from '../api/client';
import { budgetRepo } from '../repo/budgetRepo';
import { packingRepo } from '../repo/packingRepo';
import { reservationRepo } from '../repo/reservationRepo';
import { LocalApiError } from '../api/local/helpers';
import type { DayRow } from '../api/local/dexieStore';
import { setForcedOffline } from '../sync/networkMode';
import { useTripStore } from './tripStore';

/** Every cache table loadTrip reads from, so one test can never see another's writes. */
async function clearCache(): Promise<void> {
  await Promise.all([
    offlineDb.trips.clear(),
    offlineDb.days.clear(),
    offlineDb.places.clear(),
    offlineDb.reservations.clear(),
    offlineDb.tripFiles.clear(),
    offlineDb.tags.clear(),
    offlineDb.categories.clear(),
  ]);
}

/**
 * tripsApi/daysApi/tagsApi are local adapters — tripRepo.get/dayRepo.list and
 * the tag fan-out read the `panelmint` Dexie db, not the network. Seed the
 * trip + day (+ tag) rows into it; every other resource (places/packing/todo/
 * budget/categories/…) is still HTTP and stays on msw.
 */
async function seedLocalTrip(trip = buildTrip({ id: 1 }), days = serverDays()): Promise<void> {
  await db.trips.put(trip);
  // assignmentWire joins place_id against the places table — seed the places
  // embedded on the day rows or the assignments get filtered out of the wire.
  const places = days.flatMap((d) => (d.assignments ?? []).map((a) => a.place).filter((p) => p != null));
  if (places.length) await db.places.bulkPut(places as never[]);
  await db.days.bulkPut(days.map((d) => ({ ...d, vias: [] })) as DayRow[]);
}

beforeEach(async () => {
  resetAllStores();
  server.resetHandlers();
  await clearCache();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
});

afterEach(() => {
  setForcedOffline(false);
  vi.restoreAllMocks();
});

/** Days as the day list endpoint returns them: with embedded assignments + notes. */
function serverDays() {
  const place = buildPlace({ id: 500, trip_id: 1 });
  return [
    buildDay({
      id: 1,
      trip_id: 1,
      day_number: 1,
      assignments: [buildAssignment({ id: 900, day_id: 1, place })],
      notes_items: [buildDayNote({ id: 800, day_id: 1, text: 'Pick up keys' })],
    }),
    // A day row that arrives without the embedded arrays at all.
    buildDay({ id: 2, trip_id: 1, day_number: 2, assignments: undefined, notes_items: undefined }),
  ];
}

describe('tripStore', () => {
  describe('selectors and filters', () => {
    it('FE-TSTORE-001: setSelectedDay, setPlacesFilter and setPlacesCategoryFilter write through', () => {
      useTripStore.getState().setSelectedDay(42);
      useTripStore.getState().setPlacesFilter('unplanned');
      useTripStore.getState().setPlacesCategoryFilter(new Set(['3', '7']));

      const state = useTripStore.getState();
      expect(state.selectedDayId).toBe(42);
      expect(state.placesFilter).toBe('unplanned');
      expect([...state.placesCategoryFilter]).toEqual(['3', '7']);

      useTripStore.getState().setSelectedDay(null);
      expect(useTripStore.getState().selectedDayId).toBeNull();
    });
  });

  describe('resetTrip', () => {
    it('FE-TSTORE-002: clears every trip-scoped slice but keeps the global tags and categories', () => {
      seedStore(useTripStore, {
        trip: buildTrip({ id: 1 }),
        days: [buildDay({ id: 1, trip_id: 1 })],
        places: [buildPlace({ trip_id: 1 })],
        assignments: { '1': [buildAssignment({ day_id: 1 })] },
        dayNotes: { '1': [buildDayNote({ day_id: 1 })] },
        packingItems: [buildPackingItem({ trip_id: 1 })],
        todoItems: [buildTodoItem({ trip_id: 1 })],
        budgetItems: [buildBudgetItem({ trip_id: 1 })],
        files: [buildTripFile({ trip_id: 1 })],
        reservations: [buildReservation({ trip_id: 1 })],
        tags: [buildTag({ id: 5 })],
        categories: [buildCategory({ id: 6 })],
        selectedDayId: 1,
        placesFilter: 'unplanned',
        placesCategoryFilter: new Set(['3']),
        error: 'stale error',
      });

      useTripStore.getState().resetTrip();

      const state = useTripStore.getState();
      expect(state.trip).toBeNull();
      expect(state.days).toEqual([]);
      expect(state.places).toEqual([]);
      expect(state.assignments).toEqual({});
      expect(state.dayNotes).toEqual({});
      expect(state.packingItems).toEqual([]);
      expect(state.todoItems).toEqual([]);
      expect(state.budgetItems).toEqual([]);
      expect(state.files).toEqual([]);
      expect(state.reservations).toEqual([]);
      expect(state.selectedDayId).toBeNull();
      expect(state.placesFilter).toBe('all');
      expect(state.placesCategoryFilter.size).toBe(0);
      expect(state.error).toBeNull();
      // Global lookups survive a trip switch.
      expect(state.tags.map(t => t.id)).toEqual([5]);
      expect(state.categories.map(c => c.id)).toEqual([6]);
    });
  });

  describe('loadTrip', () => {
    it('FE-TSTORE-003: fills every slice and builds the assignments/dayNotes maps', async () => {
      await seedLocalTrip(buildTrip({ id: 1, title: 'Paris' }));
      server.use(
        http.get('/api/trips/1/files', () => HttpResponse.json({ files: [buildTripFile({ id: 95, trip_id: 1 })] })),
      );
      // packing/todo are local — the "endpoint answers" are rows in
      // `panelmintDb`, same as places/tags/categories/reservations/budget
      // (place 500 arrived via seedLocalTrip's assignment join).
      await db.packingItems.put(buildPackingItem({ id: 60, trip_id: 1 }));
      await db.todoItems.put(buildTodoItem({ id: 70, trip_id: 1 }));
      await db.budgetItems.put(buildBudgetItem({ id: 80, trip_id: 1 }));
      await db.reservations.put(buildReservation({ id: 90, trip_id: 1 }));
      await db.tags.put(buildTag({ id: 11, name: 'Loaded tag' }));
      await db.categories.put(buildCategory({ id: 12 }));

      await useTripStore.getState().loadTrip(1);

      const state = useTripStore.getState();
      expect(state.trip?.title).toBe('Paris');
      expect(state.days.map(d => d.id)).toEqual([1, 2]);
      expect(state.places.map(p => p.id)).toEqual([500]);
      expect(state.packingItems.map(i => i.id)).toEqual([60]);
      expect(state.todoItems.map(i => i.id)).toEqual([70]);
      expect(state.budgetItems.map(i => i.id)).toEqual([80]);
      expect(state.reservations.map(r => r.id)).toEqual([90]);
      expect(state.files.map(f => f.id)).toEqual([95]);
      expect(state.tags.map(t => t.id)).toEqual([11]);
      expect(state.categories.map(c => c.id)).toEqual([12]);
      expect(state.assignments['1'].map(a => a.id)).toEqual([900]);
      expect(state.dayNotes['1'].map(n => n.id)).toEqual([800]);
      // A day row without the embedded arrays still gets an entry.
      expect(state.assignments['2']).toEqual([]);
      expect(state.dayNotes['2']).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('FE-TSTORE-004: drops the previously loaded trip before fetching the next one', async () => {
      seedStore(useTripStore, {
        trip: buildTrip({ id: 9, title: 'Old trip' }),
        places: [buildPlace({ id: 111, trip_id: 9 })],
      });
      await db.trips.put(buildTrip({ id: 1 }));

      let placesDuringLoad: number[] = [];
      // tripsApi is local — spy to observe the store mid-flight the way the
      // msw handler used to.
      vi.spyOn(tripsApi, 'get').mockImplementation(async () => {
        placesDuringLoad = useTripStore.getState().places.map((p) => p.id);
        return { trip: buildTrip({ id: 1 }) };
      });

      await useTripStore.getState().loadTrip(1);

      expect(placesDuringLoad).toEqual([]);
      expect(useTripStore.getState().trip?.id).toBe(1);
    });

    it('FE-TSTORE-005: a failing budget/reservations/files fetch is non-fatal', async () => {
      await db.trips.put(buildTrip({ id: 1 }));
      // budgetRepo/reservationRepo are local — their failure is a rejected
      // adapter call, the same rejection loadTrip treats as non-fatal.
      vi.spyOn(budgetRepo, 'list').mockRejectedValue(new LocalApiError(500, 'nope'));
      vi.spyOn(reservationRepo, 'list').mockRejectedValue(new LocalApiError(500, 'nope'));
      server.use(
        http.get('/api/trips/1/files', () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
      );

      await useTripStore.getState().loadTrip(1);

      const state = useTripStore.getState();
      expect(state.trip?.id).toBe(1);
      expect(state.budgetItems).toEqual([]);
      expect(state.reservations).toEqual([]);
      expect(state.files).toEqual([]);
      expect(state.error).toBeNull();
    });

    it('FE-TSTORE-006: falls back to the cached tags and categories when their endpoints fail', async () => {
      await offlineDb.tags.put(buildTag({ id: 31, name: 'Cached tag' }));
      await offlineDb.categories.put(buildCategory({ id: 32, name: 'Cached category' }));
      await db.trips.put(buildTrip({ id: 1 }));

      // tagsApi reads db.tags now — its "endpoint failure" is a rejection at
      // the adapter boundary, which is what triggers the offlineDb fallback.
      vi.spyOn(tagsApi, 'list').mockRejectedValue(new LocalApiError(502, 'offline'));
      // categoriesApi is local too — its "endpoint failure" is a rejection at
      // the adapter boundary, which is what triggers the offlineDb fallback.
      vi.spyOn(categoriesApi, 'list').mockRejectedValue(new LocalApiError(502, 'offline'));

      await useTripStore.getState().loadTrip(1);

      expect(useTripStore.getState().tags.map(t => t.name)).toEqual(['Cached tag']);
      expect(useTripStore.getState().categories.map(c => c.name)).toEqual(['Cached category']);
    });

    it('FE-TSTORE-020: serves the whole trip from the offline cache when the app is forced offline', async () => {
      await offlineDb.trips.put(buildTrip({ id: 1, title: 'Cached trip' }));
      await offlineDb.days.bulkPut([buildDay({ id: 1, trip_id: 1, day_number: 1 })]);
      await offlineDb.places.bulkPut([buildPlace({ id: 502, trip_id: 1 })]);
      await offlineDb.tripFiles.bulkPut([buildTripFile({ id: 97, trip_id: 1 })]);
      // Packing/todo/reservations/budget live in panelmintDb now — forced
      // offline only gates the network, the local adapter reads the system of
      // record either way.
      await db.trips.put(buildTrip({ id: 1 }));
      await db.packingItems.put(buildPackingItem({ id: 62, trip_id: 1 }));
      await db.todoItems.put(buildTodoItem({ id: 73, trip_id: 1 }));
      await db.budgetItems.put(buildBudgetItem({ id: 82, trip_id: 1 }));
      await db.reservations.put(buildReservation({ id: 93, trip_id: 1 }));
      await offlineDb.tags.put(buildTag({ id: 41, name: 'Offline tag' }));
      await offlineDb.categories.put(buildCategory({ id: 42, name: 'Offline category' }));

      // Any request reaching the network would mean the offline gate leaked.
      const leaked: string[] = [];
      server.use(
        http.get('/api/*', ({ request }) => {
          leaked.push(new URL(request.url).pathname);
          return HttpResponse.json({}, { status: 500 });
        }),
      );
      setForcedOffline(true);

      await useTripStore.getState().loadTrip(1);

      expect(leaked).toEqual([]);
      const state = useTripStore.getState();
      expect(state.trip?.title).toBe('Cached trip');
      expect(state.days.map(d => d.id)).toEqual([1]);
      expect(state.places.map(p => p.id)).toEqual([502]);
      expect(state.packingItems.map(i => i.id)).toEqual([62]);
      expect(state.todoItems.map(i => i.id)).toEqual([73]);
      expect(state.budgetItems.map(i => i.id)).toEqual([82]);
      expect(state.reservations.map(r => r.id)).toEqual([93]);
      expect(state.files.map(f => f.id)).toEqual([97]);
      expect(state.tags.map(t => t.name)).toEqual(['Offline tag']);
      expect(state.categories.map(c => c.name)).toEqual(['Offline category']);
      expect(state.isLoading).toBe(false);
    });

    it('FE-TSTORE-021: reports a cache miss as an error when forced offline', async () => {
      setForcedOffline(true);

      await expect(useTripStore.getState().loadTrip(1)).rejects.toThrow();
      expect(useTripStore.getState().error).toBe('No cached trip data available offline');
      expect(useTripStore.getState().isLoading).toBe(false);
    });

    it('FE-TSTORE-007: sets the error state and rethrows when the trip itself cannot be fetched', async () => {
      await db.trips.put(buildTrip({ id: 1 }));
      vi.spyOn(tripsApi, 'get').mockRejectedValue(new LocalApiError(403, 'Forbidden'));

      await expect(useTripStore.getState().loadTrip(1)).rejects.toThrow();

      const state = useTripStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.error).toContain('Forbidden');
      expect(state.trip).toBeNull();
    });
  });

  describe('hydrateActiveTrip', () => {
    it('FE-TSTORE-008: silently re-pulls every collaborative slice and nudges the planner', async () => {
      seedStore(useTripStore, { trip: buildTrip({ id: 1 }), places: [], days: [] });
      // Days without embedded assignments so the re-pulled places list holds
      // exactly the row seeded below.
      await seedLocalTrip(buildTrip({ id: 1 }), [
        buildDay({ id: 1, trip_id: 1, day_number: 1 }),
        buildDay({ id: 2, trip_id: 1, day_number: 2 }),
      ]);
      await db.places.put(buildPlace({ id: 501, trip_id: 1 }));

      server.use(
        http.get('/api/trips/1/files', () => HttpResponse.json({ files: [buildTripFile({ id: 96, trip_id: 1 })] })),
      );
      await db.packingItems.put(buildPackingItem({ id: 61, trip_id: 1 }));
      await db.todoItems.put(buildTodoItem({ id: 71, trip_id: 1 }));
      await db.budgetItems.put(buildBudgetItem({ id: 81, trip_id: 1 }));
      await db.reservations.put(buildReservation({ id: 91, trip_id: 1 }));

      const nudged = vi.fn();
      window.addEventListener('accommodations:refresh', nudged);
      await useTripStore.getState().hydrateActiveTrip(1);
      window.removeEventListener('accommodations:refresh', nudged);

      const state = useTripStore.getState();
      expect(state.days.map(d => d.id)).toEqual([1, 2]);
      expect(state.places.map(p => p.id)).toEqual([501]);
      expect(state.packingItems.map(i => i.id)).toEqual([61]);
      expect(state.todoItems.map(i => i.id)).toEqual([71]);
      expect(state.budgetItems.map(i => i.id)).toEqual([81]);
      expect(state.reservations.map(r => r.id)).toEqual([91]);
      expect(state.files.map(f => f.id)).toEqual([96]);
      // The trip itself is not re-fetched — no splash, no resetTrip.
      expect(state.isLoading).toBe(false);
      expect(nudged).toHaveBeenCalledTimes(1);
    });

    it('FE-TSTORE-009: one failing resource does not wipe the others', async () => {
      const stalePlace = buildPlace({ id: 111, trip_id: 1, name: 'Kept' });
      seedStore(useTripStore, { places: [stalePlace], packingItems: [], todoItems: [] });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await db.trips.put(buildTrip({ id: 1 }));

      // placeRepo.list/packingRepo.list are local now — their failure is a
      // rejected adapter call, which hydrateActiveTrip treats as non-fatal.
      vi.spyOn(placesApi, 'list').mockRejectedValue(new LocalApiError(500, 'nope'));
      vi.spyOn(packingRepo, 'list').mockRejectedValue(new LocalApiError(500, 'nope'));
      await db.todoItems.put(buildTodoItem({ id: 72, trip_id: 1 }));

      await expect(useTripStore.getState().hydrateActiveTrip(1)).resolves.toBeUndefined();

      expect(useTripStore.getState().places.map(p => p.name)).toEqual(['Kept']);
      expect(useTripStore.getState().todoItems.map(i => i.id)).toEqual([72]);
    });
  });

  describe('refreshDays', () => {
    it('FE-TSTORE-010: rebuilds the days list plus the assignments and notes maps', async () => {
      seedStore(useTripStore, { days: [], assignments: { '99': [] }, dayNotes: { '99': [] } });
      await seedLocalTrip();

      await useTripStore.getState().refreshDays(1);

      const state = useTripStore.getState();
      expect(state.days.map(d => d.id)).toEqual([1, 2]);
      expect(state.assignments['1'].map(a => a.id)).toEqual([900]);
      expect(state.dayNotes['1'].map(n => n.id)).toEqual([800]);
      // The maps are rebuilt from scratch, so a stale day key is gone.
      expect(state.assignments['99']).toBeUndefined();
    });

    it('FE-TSTORE-011: swallows a failing day list and keeps the current days', async () => {
      const day = buildDay({ id: 1, trip_id: 1 });
      seedStore(useTripStore, { days: [day] });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(daysApi, 'list').mockRejectedValue(new LocalApiError(500, 'boom'));

      await expect(useTripStore.getState().refreshDays(1)).resolves.toBeUndefined();

      expect(useTripStore.getState().days.map(d => d.id)).toEqual([1]);
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe('updateTrip', () => {
    it('FE-TSTORE-012: persists the patch, refreshes days and re-pulls the re-anchored bookings', async () => {
      seedStore(useTripStore, { trip: buildTrip({ id: 1, title: 'Old' }), days: [], reservations: [] });
      await seedLocalTrip();
      const updateSpy = vi.spyOn(tripsApi, 'update');

      // The date change re-anchors bookings in panelmintDb — loadReservations
      // re-reads the same store of record the update wrote.
      await db.reservations.put(buildReservation({ id: 92, trip_id: 1, title: 'Re-anchored' }));

      const result = await useTripStore.getState().updateTrip(1, { title: 'New', start_date: '2025-06-01' });

      expect(result.title).toBe('New');
      expect(updateSpy).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ title: 'New', start_date: '2025-06-01' }),
      );
      expect(useTripStore.getState().trip?.title).toBe('New');
      expect(useTripStore.getState().days.map(d => d.id)).toEqual([1, 2]);
      expect(useTripStore.getState().assignments['1']).toHaveLength(1);
      expect(useTripStore.getState().reservations.map(r => r.title)).toEqual(['Re-anchored']);
    });

    it('FE-TSTORE-013: forwards the date_shift_mode flag', async () => {
      await db.trips.put(buildTrip({ id: 1 }));
      const updateSpy = vi.spyOn(tripsApi, 'update').mockResolvedValue({ trip: buildTrip({ id: 1 }) });

      await useTripStore.getState().updateTrip(1, { start_date: '2025-07-01', date_shift_mode: 'shift_all' });

      expect(updateSpy).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ date_shift_mode: 'shift_all' }),
      );
    });

    it('FE-TSTORE-014: throws the server message and leaves the trip untouched', async () => {
      const trip = buildTrip({ id: 1, title: 'Old' });
      seedStore(useTripStore, { trip });
      vi.spyOn(tripsApi, 'update').mockRejectedValue(new LocalApiError(403, 'Not the owner'));

      await expect(useTripStore.getState().updateTrip(1, { title: 'New' })).rejects.toThrow('Not the owner');
      expect(useTripStore.getState().trip?.title).toBe('Old');
    });
  });

  describe('addTag', () => {
    it('FE-TSTORE-015: appends the created tag to the global list', async () => {
      seedStore(useTripStore, { tags: [buildTag({ id: 1, name: 'Existing' })] });
      await db.tags.put(buildTag({ id: 1, name: 'Existing' }));

      const created = await useTripStore.getState().addTag({ name: 'Food', color: '#00ff00' });

      // The local adapter allocates a fresh surrogate id — strictly past the
      // highest id seen this session (the allocator is monotonic and never
      // rolls back), so assert uniqueness past the existing row, not "2".
      expect(created.id).toBeGreaterThan(1);
      expect(useTripStore.getState().tags.map(t => t.name)).toEqual(['Existing', 'Food']);
    });

    it('FE-TSTORE-016: throws the server message and keeps the list unchanged', async () => {
      seedStore(useTripStore, { tags: [buildTag({ id: 1 })] });
      // The create failing "server-side" is a rejection at the adapter boundary —
      // getApiErrorMessage still surfaces the response.data.error string.
      vi.spyOn(tagsApi, 'create').mockRejectedValue(new LocalApiError(409, 'Tag exists'));

      await expect(useTripStore.getState().addTag({ name: 'Food' })).rejects.toThrow('Tag exists');
      expect(useTripStore.getState().tags).toHaveLength(1);
    });
  });

  describe('handleRemoteEvent', () => {
    it('FE-TSTORE-019: routes a socket event into the store', () => {
      const place = buildPlace({ id: 500, trip_id: 1, name: 'Before' });
      seedStore(useTripStore, { places: [place] });

      useTripStore.getState().handleRemoteEvent({
        type: 'place:updated',
        place: { ...place, name: 'After' },
      });

      expect(useTripStore.getState().places[0].name).toBe('After');
    });

    it('FE-TSTORE-019b: asks the planner to reload accommodations when a place image changes', () => {
      // Accommodation cards keep their own copy of the place, so a new hero
      // image would otherwise only show up after a reload.
      const place = buildPlace({ id: 500, trip_id: 1, image_url: null });
      seedStore(useTripStore, { places: [place] });
      const listener = vi.fn();
      window.addEventListener('accommodations:refresh', listener);

      useTripStore.getState().handleRemoteEvent({
        type: 'place:updated',
        place: { ...place, image_url: '/api/maps/place-photo/way%3A1~p0/bytes' },
      });

      expect(listener).toHaveBeenCalledTimes(1);
      window.removeEventListener('accommodations:refresh', listener);
    });

    it('FE-TSTORE-019c: does not reload accommodations for an edit that leaves the image alone', () => {
      const place = buildPlace({ id: 500, trip_id: 1, name: 'Before', image_url: '/uploads/places/a.jpg' });
      seedStore(useTripStore, { places: [place] });
      const listener = vi.fn();
      window.addEventListener('accommodations:refresh', listener);

      useTripStore.getState().handleRemoteEvent({
        type: 'place:updated',
        place: { ...place, name: 'After' },
      });

      expect(listener).not.toHaveBeenCalled();
      window.removeEventListener('accommodations:refresh', listener);
    });
  });
});
