import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../helpers/msw/server';
import 'fake-indexeddb/auto';
import { db } from '../../../src/db/panelmintDb';
import { buildDay, buildPlace, buildTrip } from '../../helpers/factories';
import type { DayRow } from '../../../src/api/local/dexieStore';

const {
  apiClient,
  placesApi,
  packingApi,
  categoriesApi,
  mapsApi,
  budgetApi,
  filesApi,
  reservationsApi,
  accommodationsApi,
  dayNotesApi,
} = await import('../../../src/api/client');

/** Clean IndexedDB for the local-adapter smoke tests. */
async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
}

describe('API client interceptors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset window.location to a neutral path
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: 'http://localhost/', pathname: '/', search: '', hash: '' },
    });
  });

  it('FE-API-001: mutating requests carry a generated X-Idempotency-Key', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post('/api/trips/1/places', ({ request }) => {
        receivedKey = request.headers.get('X-Idempotency-Key');
        return HttpResponse.json({ id: 1 });
      })
    );

    // Probe the axios instance directly — the interceptor lives on apiClient;
    // placesApi is a local adapter now and would never reach the wire.
    await apiClient.post('/trips/1/places', { name: 'Paris' });
    expect(receivedKey).toBeTruthy();
  });

  it('FE-API-002: read requests carry no idempotency key', async () => {
    let receivedKey: string | null = 'sentinel';
    server.use(
      http.get('/api/tags', ({ request }) => {
        receivedKey = request.headers.get('X-Idempotency-Key');
        return HttpResponse.json({ settings: {} });
      })
    );

    // Probe the axios instance directly — the interceptors live on apiClient;
    // tagsApi is a local adapter now and would never reach the wire.
    await apiClient.get('/tags');
    expect(receivedKey).toBeNull();
  });

  it('FE-API-003: a 401 never redirects — there is no login page to go to', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: 'http://localhost/dashboard', pathname: '/dashboard', search: '', hash: '' },
    });
    const originalHref = window.location.href;

    server.use(
      http.get('/api/tags', () => HttpResponse.json({ code: 'AUTH_REQUIRED' }, { status: 401 }))
    );

    await expect(apiClient.get('/tags')).rejects.toThrow();
    expect(window.location.href).toBe(originalHref);
  });

  it('FE-API-004: a 429 surfaces the translated rate-limit message', async () => {
    server.use(
      http.post('/api/maps/autocomplete', () =>
        HttpResponse.json({ error: 'slow down' }, { status: 429 }))
    );

    await expect(apiClient.post('/maps/autocomplete', { input: 'x' })).rejects.toThrow();
  });

  it('FE-API-005: successful API call returns response data', async () => {
    server.use(http.get('/api/tags', () => HttpResponse.json({ settings: { theme: 'dark' } })));

    const res = await apiClient.get('/tags');
    expect(res.data).toMatchObject({ settings: { theme: 'dark' } });
  });

  it('FE-API-017: placesApi.create writes the place locally and returns { place }', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));

    const result = await placesApi.create(1, { name: 'Paris' });
    expect(result.place).toMatchObject({ name: 'Paris', trip_id: 1 });
    expect(await db.places.get(result.place.id)).toMatchObject({ name: 'Paris' });
  });

  it('FE-API-018: packingApi.create writes the item to Dexie', async () => {
    // packingApi is a local adapter now — create lands on panelmintDb with
    // no /api traffic; bulkImport is gone with the hosted template library.
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));

    const { item } = await packingApi.create(1, { name: 'Sunscreen' });
    expect(item).toMatchObject({ name: 'Sunscreen', trip_id: 1 });
    expect(await db.packingItems.get(item.id)).toMatchObject({ name: 'Sunscreen' });
  });

  it('FE-API-007: non-401 errors are passed through as rejections', async () => {
    server.use(
      http.get('/api/tags', () => HttpResponse.json({ error: 'Internal error' }, { status: 500 }))
    );

    await expect(apiClient.get('/tags')).rejects.toThrow();
  });
});

// ── API namespace smoke tests ────────────────────────────────────────────────
// (tripsApi/daysApi/tagsApi/weatherApi/placesApi/categoriesApi/mapsApi,
// assignmentsApi/accommodationsApi and now packingApi/todoApi/dayNotesApi are
// local adapters — api/local/* — so there is no matching /api traffic left to
// smoke-test here; their coverage lives in tests/unit/local/*.test.ts.)

describe('API namespace smoke tests', () => {
  it('categoriesApi.list returns the seeded palette envelope', async () => {
    await resetDb();
    await expect(categoriesApi.list()).resolves.toEqual({ categories: [] });
  });

  it('mapsApi keeps its no-network stubs honest', async () => {
    // search/reverse/autocomplete/details/enrichment delegate to the ext
    // clients — covered by src/api/local/maps.test.ts and the ext suites. The
    // two deliberate stubs resolve without any network at all.
    await expect(mapsApi.placePhoto('place/1')).resolves.toMatchObject({ photoUrl: null });
    await expect(
      mapsApi.area({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }),
    ).resolves.toMatchObject({ results: [], unavailable: true });
  });

  it('budgetApi.list returns the trip items from Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await expect(budgetApi.list(1)).resolves.toEqual({ items: [] });
  });

  it('filesApi.list fetches trip files', async () => {
    server.use(http.get('/api/trips/1/files', () => HttpResponse.json([])));
    await expect(filesApi.list(1)).resolves.toEqual([]);
  });

  it('reservationsApi.list returns the trip bookings from Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await expect(reservationsApi.list(1)).resolves.toEqual({ reservations: [] });
  });

  it('accommodationsApi.list returns the trip stays from Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await expect(accommodationsApi.list(1)).resolves.toEqual({ accommodations: [] });
  });

  it('dayNotesApi.list reads embedded notes from Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.days.put({ ...buildDay({ id: 1, trip_id: 1 }), vias: [] } as DayRow);
    await expect(dayNotesApi.list(1, 1)).resolves.toEqual({ notes: [] });
  });

  it('placesApi.list returns the trip places from Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }));

    await expect(placesApi.list(1)).resolves.toEqual({
      places: [expect.objectContaining({ id: 5 })],
    });
  });

  it('placesApi.get returns a single place', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }));

    await expect(placesApi.get(1, 5)).resolves.toMatchObject({ place: { id: 5 } });
  });

  it('placesApi.update writes the change to Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1, name: 'Rome' }));

    await expect(placesApi.update(1, 5, { name: 'Venice' })).resolves.toMatchObject({ place: { id: 5, name: 'Venice' } });
    expect((await db.places.get(5))?.name).toBe('Venice');
  });

  it('placesApi.delete removes the row', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }));

    await placesApi.delete(1, 5);
    expect(await db.places.get(5)).toBeUndefined();
  });

  // ── packingApi additional methods ────────────────────────────────────────────
  // (packingApi is a local adapter — Dexie-backed; its full parity coverage
  // lives in tests/unit/local/packing.test.ts.)

  it('packingApi.list returns the trip items from Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await expect(packingApi.list(1)).resolves.toEqual({ items: [] });
  });

  it('packingApi.delete removes the item row', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    const { item } = await packingApi.create(1, { name: 'Towel' });
    await expect(packingApi.delete(1, item.id)).resolves.toEqual({ success: true });
    expect(await db.packingItems.get(item.id)).toBeUndefined();
  });

  // ── categoriesApi additional methods ────────────────────────────────────────
  // (categoriesApi is a local adapter — a frozen seeded palette; mutations
  // reject with a local 403. tagsApi is covered by tests/unit/local/tags.test.ts.)

  it('categoriesApi.create rejects — the palette is frozen in the local build', async () => {
    await expect(categoriesApi.create({ name: 'Food' })).rejects.toThrow('fixed palette');
  });

  it('categoriesApi.delete rejects — the palette is frozen in the local build', async () => {
    await expect(categoriesApi.delete(1)).rejects.toThrow('fixed palette');
  });

  // ── budgetApi additional methods ──────────────────────────────────────────
  // (budgetApi is a local adapter — Dexie-backed; its full parity coverage
  // lives in tests/unit/local/budget.test.ts.)

  it('budgetApi.create writes the item to Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    const { item } = await budgetApi.create(1, { name: 'Hotel' });
    expect(item).toMatchObject({ trip_id: 1, name: 'Hotel' });
    expect(await db.budgetItems.get(item.id)).toMatchObject({ name: 'Hotel' });
  });

  it('budgetApi.delete removes the item row', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    const { item } = await budgetApi.create(1, { name: 'Hotel' });
    await expect(budgetApi.delete(1, item.id)).resolves.toEqual({ success: true });
    expect(await db.budgetItems.get(item.id)).toBeUndefined();
  });

  // ── reservationsApi additional methods ───────────────────────────────────────
  // (reservationsApi is a local adapter — Dexie-backed; its full parity
  // coverage lives in tests/unit/local/reservations.test.ts.)

  it('reservationsApi.create writes the booking to Dexie', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    const { reservation } = await reservationsApi.create(1, { title: 'Hotel' });
    expect(reservation).toMatchObject({ trip_id: 1, title: 'Hotel' });
    expect(await db.reservations.get(reservation.id)).toMatchObject({ title: 'Hotel' });
  });

  it('reservationsApi.delete removes the booking row', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    const { reservation } = await reservationsApi.create(1, { title: 'Hotel' });
    await expect(reservationsApi.delete(1, reservation.id)).resolves.toMatchObject({ success: true });
    expect(await db.reservations.get(reservation.id)).toBeUndefined();
  });

  // ── accommodationsApi additional methods ─────────────────────────────────────
  // (accommodationsApi is a local adapter — Dexie-backed; its full parity
  // coverage lives in tests/unit/local/accommodations.test.ts.)

  it('accommodationsApi.create writes the stay, its booking and a night seat', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.days.bulkPut([1, 2].map((i) => ({
      ...buildDay({ id: i, trip_id: 1, day_number: i, date: `2025-06-0${i}` }),
      assignments: [], vias: [],
    })) as DayRow[]);
    await db.places.put(buildPlace({ id: 1, trip_id: 1 }));

    await expect(
      accommodationsApi.create(1, { place_id: 1, start_day_id: 1, end_day_id: 2 }),
    ).resolves.toMatchObject({
      accommodation: { place_id: 1, start_day_id: 1, end_day_id: 2 },
      assignment: { day_id: 1, place_id: 1 },
    });
  });

  it('accommodationsApi.delete removes the stay row', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.days.bulkPut([1, 2].map((i) => ({
      ...buildDay({ id: i, trip_id: 1, day_number: i, date: `2025-06-0${i}` }),
      assignments: [], vias: [],
    })) as DayRow[]);
    await db.places.put(buildPlace({ id: 1, trip_id: 1 }));
    const { accommodation } = await accommodationsApi.create(1, { place_id: 1, start_day_id: 1, end_day_id: 2 });

    await expect(accommodationsApi.delete(1, accommodation.id)).resolves.toMatchObject({ success: true });
    expect(await db.accommodations.get(accommodation.id)).toBeUndefined();
  });

  // ── dayNotesApi additional methods ───────────────────────────────────────────
  // (dayNotesApi is a local adapter — notes embed on days.notes_items; its
  // full parity coverage lives in tests/unit/local/notes.test.ts.)

  it('dayNotesApi.create embeds the note on the day row', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.days.put({ ...buildDay({ id: 1, trip_id: 1 }), vias: [] } as DayRow);

    const { note } = await dayNotesApi.create(1, 1, { text: 'Hello' });
    expect(note).toMatchObject({ text: 'Hello', day_id: 1 });
    const day = (await db.days.get(1)) as DayRow;
    expect(day.notes_items).toEqual([expect.objectContaining({ id: note.id, text: 'Hello' })]);
  });

  it('dayNotesApi.delete removes the embedded note', async () => {
    await resetDb();
    await db.trips.put(buildTrip({ id: 1 }));
    await db.days.put({ ...buildDay({ id: 1, trip_id: 1 }), vias: [] } as DayRow);
    const { note } = await dayNotesApi.create(1, 1, { text: 'Hello' });

    await expect(dayNotesApi.delete(1, 1, note.id)).resolves.toEqual({ success: true });
    const day = (await db.days.get(1)) as DayRow;
    expect(day.notes_items).toEqual([]);
  });

  // ── mapsApi additional methods ──────────────────────────────────────────────
  // The facade delegates to api/ext/* (Photon, Nominatim, Overpass, Wikimedia);
  // request shapes and provider fallbacks are pinned in src/api/local/maps.test.ts
  // and the ext suites, not repeated here.
});
