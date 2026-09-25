import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useTripStore } from '../../src/store/tripStore';
import { tripsApi, daysApi, tagsApi, placesApi, categoriesApi } from '../../src/api/client';
import { resetAllStores } from '../helpers/store';
import { buildTrip, buildDay, buildPlace, buildPackingItem, buildTodoItem, buildTag, buildCategory, buildAssignment, buildDayNote, buildBudgetItem, buildReservation, buildTripFile } from '../helpers/factories';
import { server } from '../helpers/msw/server';
import { db } from '../../src/db/panelmintDb';
import type { DayRow } from '../../src/api/local/dexieStore';
import type { Tag } from '../../src/types';

beforeEach(async () => {
  resetAllStores();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Seed trip (+optional days) into the local `panelmint` db — tripsApi/daysApi read it, not HTTP. */
async function seedLocalTrip(id: number, days: import('../../src/types').Day[] = []) {
  await db.trips.put(buildTrip({ id }));
  // assignmentWire joins place_id against the places table — seed the embedded
  // places or the day's assignments are filtered out of the wire projection.
  const places = days.flatMap((d) => (d.assignments ?? []).map((a) => a.place).filter((p) => p != null));
  if (places.length) await db.places.bulkPut(places as never[]);
  await db.days.bulkPut(days.map((d) => ({ ...d, trip_id: id, vias: [] })) as DayRow[]);
}

/**
 * Full set of MSW handlers for one trip's loadTrip fan-out — trips/days/tags
 * are local now, so the trip row (and any `data.tags` rows) are seeded into
 * `panelmint` and only the still-HTTP resources keep handlers.
 */
async function tripHandlers(
  id: number,
  data: {
    budget?: unknown[]; reservations?: unknown[]; files?: unknown[];
    tags?: unknown[]; categories?: unknown[];
  },
) {
  await seedLocalTrip(id);
  for (const tag of data.tags ?? []) {
    await db.tags.put(tag as Tag);
  }
  return [
    http.get(`/api/trips/${id}/packing`, () => HttpResponse.json({ items: [] })),
    http.get(`/api/trips/${id}/todo`, () => HttpResponse.json({ items: [] })),
    http.get(`/api/trips/${id}/budget`, () => HttpResponse.json({ items: data.budget ?? [] })),
    http.get(`/api/trips/${id}/reservations`, () => HttpResponse.json({ reservations: data.reservations ?? [] })),
    http.get(`/api/trips/${id}/files`, () => HttpResponse.json({ files: data.files ?? [] })),
  ];
}

describe('tripStore', () => {
  describe('loadTrip', () => {
    it('FE-TRIP-001: fires parallel API calls for trips, days, places, packing, todo, tags, categories', async () => {
      await seedLocalTrip(1);
      const calledUrls: string[] = [];
      // trips/days/places/tags/categories are local adapter calls; the rest are
      // still HTTP fan-out.
      const tripsGet = vi.spyOn(tripsApi, 'get');
      const daysList = vi.spyOn(daysApi, 'list');
      const placesList = vi.spyOn(placesApi, 'list');
      const tagsList = vi.spyOn(tagsApi, 'list');
      const categoriesList = vi.spyOn(categoriesApi, 'list');
      server.use(
        http.get('/api/trips/:id/packing', ({ params }) => {
          calledUrls.push(`/api/trips/${params.id}/packing`);
          return HttpResponse.json({ items: [] });
        }),
        http.get('/api/trips/:id/todo', ({ params }) => {
          calledUrls.push(`/api/trips/${params.id}/todo`);
          return HttpResponse.json({ items: [] });
        }),
      );

      await useTripStore.getState().loadTrip(1);

      expect(tripsGet).toHaveBeenCalledWith(1);
      expect(daysList).toHaveBeenCalledWith(1);
      expect(placesList).toHaveBeenCalledWith(1, undefined);
      expect(tagsList).toHaveBeenCalled();
      expect(categoriesList).toHaveBeenCalled();
      expect(calledUrls).toContain('/api/trips/1/packing');
      expect(calledUrls).toContain('/api/trips/1/todo');
    });

    it('FE-TRIP-002: after loadTrip, all store fields are populated', async () => {
      const trip = buildTrip({ id: 1 });
      const place = buildPlace({ trip_id: 1 });
      const packingItem = buildPackingItem({ trip_id: 1 });
      const todoItem = buildTodoItem({ trip_id: 1 });
      const tag = buildTag();
      const category = buildCategory();

      // Seed the exact row the assertion compares against (buildTrip mints a
      // fresh title per call). places/tags/categories are local — the rows
      // come from `panelmintDb`.
      await db.trips.put(trip);
      await db.places.put(place);
      await db.tags.put(tag);
      await db.categories.put(category);
      server.use(
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [packingItem] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [todoItem] })),
      );

      await useTripStore.getState().loadTrip(1);
      const state = useTripStore.getState();

      // The wire rows carry adapter-normalised fields (feed_token, tags join, …)
      // beyond the seeded columns — match on what the test set.
      expect(state.trip).toMatchObject(trip);
      expect(state.places).toHaveLength(1);
      expect(state.places[0]).toMatchObject(place);
      expect(state.packingItems).toEqual([packingItem]);
      expect(state.todoItems).toEqual([todoItem]);
      expect(state.tags).toHaveLength(1);
      expect(state.tags[0]).toMatchObject(tag);
      expect(state.categories).toHaveLength(1);
      expect(state.categories[0]).toMatchObject(category);
    });

    it('FE-TRIP-003: loadTrip extracts assignments map from days response', async () => {
      const assignment = buildAssignment({ day_id: 10, order_index: 0 });
      const day = buildDay({ id: 10, assignments: [assignment], notes_items: [] });

      await seedLocalTrip(1, [day]);
      server.use(
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
      );

      await useTripStore.getState().loadTrip(1);
      const { assignments } = useTripStore.getState();

      expect(assignments['10']).toHaveLength(1);
      // The wire assignment carries server-joined fields (place, participants)
      // beyond the seeded row — match on the columns the test set.
      expect(assignments['10'][0]).toMatchObject({
        id: assignment.id,
        day_id: 10,
        place_id: assignment.place_id,
        order_index: 0,
      });
    });

    it('FE-TRIP-004: loadTrip extracts dayNotes map from days response', async () => {
      const note = buildDayNote({ day_id: 10 });
      const day = buildDay({ id: 10, assignments: [], notes_items: [note] });

      await seedLocalTrip(1, [day]);
      server.use(
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
      );

      await useTripStore.getState().loadTrip(1);
      const { dayNotes } = useTripStore.getState();

      expect(dayNotes['10']).toBeDefined();
      expect(dayNotes['10']).toEqual([note]);
    });

    it('FE-TRIP-005: loadTrip sets isLoading true during, false after', async () => {
      let wasLoadingDuringFetch = false;
      await seedLocalTrip(1);
      vi.spyOn(tripsApi, 'get').mockImplementation(async () => {
        wasLoadingDuringFetch = useTripStore.getState().isLoading;
        return { trip: buildTrip({ id: 1 }) };
      });

      server.use(
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
      );

      const promise = useTripStore.getState().loadTrip(1);
      expect(useTripStore.getState().isLoading).toBe(true);
      await promise;
      expect(wasLoadingDuringFetch).toBe(true);
      expect(useTripStore.getState().isLoading).toBe(false);
    });

    it('FE-TRIP-006: loadTrip on API failure sets error and isLoading: false', async () => {
      // Trip 1 is absent from the local db → tripsApi.get throws its 404.
      server.use(
        http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
        http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
      );

      await expect(useTripStore.getState().loadTrip(1)).rejects.toThrow();

      const state = useTripStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.error).not.toBeNull();
    });

    it('FE-TRIP-H5: loadTrip uniformly hydrates budget, reservations and files', async () => {
      const budgetItem = buildBudgetItem({ trip_id: 1 });
      const reservation = buildReservation({ trip_id: 1 });
      const file = buildTripFile({ trip_id: 1 });
      server.use(...(await tripHandlers(1, { budget: [budgetItem], reservations: [reservation], files: [file] })));

      await useTripStore.getState().loadTrip(1);
      const state = useTripStore.getState();

      expect(state.budgetItems).toEqual([budgetItem]);
      expect(state.reservations).toEqual([reservation]);
      expect(state.files).toEqual([file]);
    });

    it('FE-TRIP-H4: switching trips does not leak budget/reservations/files from the previous trip', async () => {
      // Trip 1 has budget/reservations/files; trip 2 has none.
      server.use(...(await tripHandlers(1, {
        budget: [buildBudgetItem({ trip_id: 1 })],
        reservations: [buildReservation({ trip_id: 1 })],
        files: [buildTripFile({ trip_id: 1 })],
      })));
      await useTripStore.getState().loadTrip(1);
      expect(useTripStore.getState().budgetItems).toHaveLength(1);

      server.use(...(await tripHandlers(2, {})));
      await useTripStore.getState().loadTrip(2);
      const state = useTripStore.getState();

      expect(state.trip!.id).toBe(2);
      expect(state.budgetItems).toEqual([]);
      expect(state.reservations).toEqual([]);
      expect(state.files).toEqual([]);
    });

    it('FE-TRIP-H4b: resetTrip clears every trip-scoped slice but keeps tags/categories', async () => {
      server.use(...(await tripHandlers(1, {
        budget: [buildBudgetItem({ trip_id: 1 })],
        reservations: [buildReservation({ trip_id: 1 })],
        files: [buildTripFile({ trip_id: 1 })],
        tags: [buildTag()],
      })));
      await useTripStore.getState().loadTrip(1);
      expect(useTripStore.getState().budgetItems).toHaveLength(1);

      useTripStore.getState().resetTrip();
      const state = useTripStore.getState();

      expect(state.trip).toBeNull();
      expect(state.places).toEqual([]);
      expect(state.budgetItems).toEqual([]);
      expect(state.reservations).toEqual([]);
      expect(state.files).toEqual([]);
      expect(state.selectedDayId).toBeNull();
      // Global lookups survive a trip reset.
      expect(state.tags).toHaveLength(1);
    });
  });

  describe('hydrateActiveTrip', () => {
    const loadHandlers = (budget: unknown[] = []) => [
      http.get('/api/trips/1/packing', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/todo', () => HttpResponse.json({ items: [] })),
      http.get('/api/trips/1/budget', () => HttpResponse.json({ items: budget })),
      http.get('/api/trips/1/reservations', () => HttpResponse.json({ reservations: [] })),
      http.get('/api/trips/1/files', () => HttpResponse.json({ files: [] })),
    ];

    it('FE-TRIP-H1: silently refreshes resources without resetting or splashing', async () => {
      await seedLocalTrip(1);
      server.use(...loadHandlers());
      await useTripStore.getState().loadTrip(1);
      expect(useTripStore.getState().trip!.id).toBe(1);

      // New collaborative state arrives (as if edited by someone while we were
      // offline) — places are local, so the "edit" lands in `panelmintDb`.
      const place = buildPlace({ trip_id: 1 });
      const budgetItem = buildBudgetItem({ trip_id: 1 });
      await db.places.put(place);
      server.use(...loadHandlers([budgetItem]));

      await useTripStore.getState().hydrateActiveTrip(1);
      const state = useTripStore.getState();

      expect(state.places).toHaveLength(1);
      expect(state.places[0]).toMatchObject(place);
      expect(state.budgetItems).toEqual([budgetItem]);
      expect(state.trip!.id).toBe(1);      // trip not reset
      expect(state.isLoading).toBe(false); // no splash toggled
    });
  });

  describe('refreshDays', () => {
    it('FE-TRIP-007: refreshDays re-fetches days and rebuilds assignments/dayNotes maps', async () => {
      const assignment = buildAssignment({ day_id: 20, order_index: 0 });
      const note = buildDayNote({ day_id: 20 });
      const day = buildDay({ id: 20, assignments: [assignment], notes_items: [note] });
      await seedLocalTrip(1, [day]);

      await useTripStore.getState().refreshDays(1);
      const state = useTripStore.getState();

      expect(state.days).toHaveLength(1);
      expect(state.assignments['20']).toHaveLength(1);
      expect(state.assignments['20'][0]).toMatchObject({
        id: assignment.id,
        day_id: 20,
        place_id: assignment.place_id,
      });
      expect(state.dayNotes['20']).toEqual([note]);
    });
  });

  describe('updateTrip', () => {
    it('FE-TRIP-008: updateTrip persists and refreshes trip + days', async () => {
      await seedLocalTrip(1);

      const result = await useTripStore.getState().updateTrip(1, { title: 'Updated Trip' });

      expect(result).toMatchObject({ id: 1, title: 'Updated Trip' });
      expect(useTripStore.getState().trip).toMatchObject({ id: 1, title: 'Updated Trip' });
    });

    it('FE-TRIP-011: updateTrip reloads reservations (re-anchored server-side on date changes, #1288)', async () => {
      await seedLocalTrip(1);
      const reservation = buildReservation({ id: 7, trip_id: 1, day_id: 21 });

      server.use(
        http.get('/api/trips/1/reservations', () => HttpResponse.json({ reservations: [reservation] })),
      );

      await useTripStore.getState().updateTrip(1, { start_date: '2025-05-31' });

      expect(useTripStore.getState().reservations).toEqual([reservation]);
    });
  });

  describe('setSelectedDay', () => {
    it('FE-TRIP-009: setSelectedDay updates selectedDayId', () => {
      useTripStore.getState().setSelectedDay(42);
      expect(useTripStore.getState().selectedDayId).toBe(42);

      useTripStore.getState().setSelectedDay(null);
      expect(useTripStore.getState().selectedDayId).toBeNull();
    });
  });

  describe('addTag', () => {
    it('FE-TRIP-010: addTag creates tag and appends to tags', async () => {
      const existingTag = buildTag();
      useTripStore.setState({ tags: [existingTag] });

      const newTagData = { name: 'New Tag', color: '#00ff00' };

      const result = await useTripStore.getState().addTag(newTagData);

      expect(result.name).toBe('New Tag');
      const tags = useTripStore.getState().tags;
      expect(tags).toHaveLength(2);
      expect(tags[tags.length - 1].name).toBe('New Tag');
    });
  });

});
