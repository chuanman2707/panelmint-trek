/**
 * offlineDb unit tests.
 *
 * Uses fake-indexeddb so no real browser IDB is needed.
 * Each test gets a fresh database by using `use-fake-indexeddb` with Dexie.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// Re-import after fake-indexeddb is set up so Dexie picks up the shim.
// We re-open a clean db in each test to isolate state.
import {
  offlineDb,
  clearTripData,
  clearAll,
  upsertTrip,
  upsertDays,
  upsertPlaces,
  upsertBudgetItems,
  upsertReservations,
  upsertSyncMeta,
  reopenForUser,
  reopenAnonymous,
  deleteCurrentUserDb,
  type SyncMeta,
} from '../../../src/db/offlineDb';
import type { Trip, Day, Place, BudgetItem, Reservation } from '../../../src/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeTrip = (id = 1): Trip => ({
  id,
  user_id: 42,
  title: `Trip ${id}`,
  description: null,
  start_date: '2026-07-01',
  end_date: '2026-07-05',
  currency: 'EUR',
  cover_image: null,
  is_archived: 0,
  reminder_days: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

const makeDay = (id: number, tripId = 1): Day => ({
  id,
  trip_id: tripId,
  date: '2026-07-01',
  title: null,
  notes: null,
  assignments: [],
  notes_items: [],
});

const makePlace = (id: number, tripId = 1): Place => ({
  id,
  trip_id: tripId,
  name: `Place ${id}`,
  description: null,
  notes: null,
  lat: 48.8566,
  lng: 2.3522,
  address: null,
  category_id: null,
  price: null,
  currency: null,
  image_url: null,
  google_place_id: null,
  osm_id: null,
  route_geometry: null,
  place_time: null,
  end_time: null,
  duration_minutes: null,
  transport_mode: null,
  website: null,
  phone: null,
  created_at: '2026-01-01T00:00:00Z',
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Ensure DB is open (fake-indexeddb resets between test files but not between tests).
  if (!offlineDb.isOpen()) await offlineDb.open();
  // Clear all tables before each test.
  await clearAll();
});

afterEach(async () => {
  if (!offlineDb.isOpen()) await offlineDb.open();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('offlineDb — trips', () => {
  it('stores and retrieves a trip via upsertTrip', async () => {
    const trip = makeTrip(10);
    await upsertTrip(trip);
    const stored = await offlineDb.trips.get(10);
    expect(stored).toBeDefined();
    expect(stored!.title).toBe('Trip 10');
  });

  it('upsertTrip overwrites an existing trip (put semantics)', async () => {
    await upsertTrip(makeTrip(1));
    await upsertTrip({ ...makeTrip(1), title: 'Updated' });
    const stored = await offlineDb.trips.get(1);
    expect(stored!.title).toBe('Updated');
  });
});

describe('offlineDb — days', () => {
  it('stores days and retrieves by trip_id index', async () => {
    await upsertDays([makeDay(1, 5), makeDay(2, 5), makeDay(3, 9)]);
    const trip5Days = await offlineDb.days.where('trip_id').equals(5).toArray();
    expect(trip5Days).toHaveLength(2);
    expect(trip5Days.map(d => d.id)).toContain(1);
    expect(trip5Days.map(d => d.id)).toContain(2);
  });
});

describe('offlineDb — places', () => {
  it('stores places and retrieves by trip_id', async () => {
    await upsertPlaces([makePlace(10, 1), makePlace(11, 1), makePlace(12, 2)]);
    const places = await offlineDb.places.where('trip_id').equals(1).toArray();
    expect(places).toHaveLength(2);
  });
});

describe('offlineDb — budget / reservations', () => {
  it('upserts budget items', async () => {
    const item: BudgetItem = {
      id: 1, trip_id: 1, name: 'Flight', total_price: 500,
      category: 'Transport', persons: 1, members: [], expense_date: null, sort_order: 0,
    };
    await upsertBudgetItems([item]);
    expect(await offlineDb.budgetItems.count()).toBe(1);
  });

  it('upserts reservations', async () => {
    const item: Reservation = {
      id: 1, trip_id: 1, title: 'Hotel', type: 'hotel', status: 'confirmed',
      reservation_time: null, confirmation_number: null, notes: null, created_at: '2026-01-01T00:00:00Z',
    };
    await upsertReservations([item]);
    expect(await offlineDb.reservations.count()).toBe(1);
  });
});

describe('offlineDb — syncMeta', () => {
  it('stores and retrieves syncMeta by tripId', async () => {
    const meta: SyncMeta = {
      tripId: 7,
      lastSyncedAt: Date.now(),
      status: 'idle',
      tilesBbox: null,
    };
    await upsertSyncMeta(meta);
    const stored = await offlineDb.syncMeta.get(7);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('idle');
  });
});

describe('offlineDb — clearTripData', () => {
  it('removes all data for the given trip across all tables', async () => {
    await upsertTrip(makeTrip(1));
    await upsertDays([makeDay(1, 1), makeDay(2, 1)]);
    await upsertPlaces([makePlace(10, 1)]);

    // Also add data for a different trip — should NOT be removed
    await upsertTrip(makeTrip(2));
    await upsertDays([makeDay(99, 2)]);

    await clearTripData(1);

    expect(await offlineDb.trips.get(1)).toBeUndefined();
    expect(await offlineDb.days.where('trip_id').equals(1).count()).toBe(0);
    expect(await offlineDb.places.where('trip_id').equals(1).count()).toBe(0);

    // Trip 2 intact
    expect(await offlineDb.trips.get(2)).toBeDefined();
    expect(await offlineDb.days.where('trip_id').equals(2).count()).toBe(1);
  });

  it('takes the trip cached area places with it, and leaves another trip its own', async () => {
    // They are searched across every trip, so a trip switched off for offline
    // use kept answering offline searches from an area nobody had asked to keep
    // — and nothing else ever deleted them, so they piled up for the life of the
    // install.
    await upsertTrip(makeTrip(1));
    await upsertTrip(makeTrip(2));
    const cached = (gers: string, tripId: number, name: string) => ({
      gers, tripId, name, searchName: name.toLowerCase(), address: '',
      lat: 52.5, lng: 13.4, category: null, website: null, phone: null, cachedAt: 1,
    });
    await offlineDb.areaPlaces.bulkPut([
      cached('a', 1, 'Ostpol'),
      cached('b', 1, 'Kollo'),
      cached('c', 2, 'Sonne'),
    ]);

    await clearTripData(1);

    expect(await offlineDb.areaPlaces.where('tripId').equals(1).count()).toBe(0);
    expect(await offlineDb.areaPlaces.where('tripId').equals(2).count()).toBe(1);
  });
});

describe('offlineDb — clearAll', () => {
  it('empties all tables', async () => {
    await upsertTrip(makeTrip(1));
    await upsertDays([makeDay(1, 1), makeDay(2, 1)]);
    await upsertPlaces([makePlace(10, 1)]);

    await clearAll();

    expect(await offlineDb.trips.count()).toBe(0);
    expect(await offlineDb.days.count()).toBe(0);
    expect(await offlineDb.places.count()).toBe(0);
  });
});

describe('offlineDb — per-user scoping (B4)', () => {
  afterEach(async () => {
    // Leave the suite on the anonymous DB so other tests are unaffected.
    await reopenAnonymous();
  });

  it('isolates one user\'s cached data from another', async () => {
    await reopenForUser(1);
    await upsertPlaces([makePlace(10, 1)]);
    expect(await offlineDb.places.count()).toBe(1);

    // Switching users must not expose user 1's rows.
    await reopenForUser(2);
    expect(await offlineDb.places.count()).toBe(0);

    // Switching back restores user 1's data (different physical DB).
    await reopenForUser(1);
    expect(await offlineDb.places.get(10)).toBeDefined();
  });

  it('deleteCurrentUserDb wipes the user DB and returns to anonymous', async () => {
    await reopenForUser(5);
    await upsertPlaces([makePlace(20, 1)]);

    await deleteCurrentUserDb();
    // Now on the anonymous DB — no user data.
    expect(await offlineDb.places.count()).toBe(0);

    // Re-opening user 5 starts empty (DB was deleted, not just detached).
    await reopenForUser(5);
    expect(await offlineDb.places.count()).toBe(0);
  });
});
