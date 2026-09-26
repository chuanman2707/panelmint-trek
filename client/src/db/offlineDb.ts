import Dexie, { type Table } from 'dexie';
import type { Trip, Day, Place, BudgetItem, Reservation, Accommodation, TripMember, Tag, Category } from '../types';

/** TripMember enriched with tripId so we can index by trip. */
export interface CachedTripMember extends TripMember {
  tripId: number;
}

export interface SyncMeta {
  tripId: number;
  lastSyncedAt: number | null;
  status: 'idle' | 'syncing' | 'error';
  /** Bounding box [minLng, minLat, maxLng, maxLat] of pre-downloaded map tiles */
  tilesBbox: [number, number, number, number] | null;
  /**
   * The rounded bbox the cached area places were fetched for. Compared rather
   * than a timestamp: adding a place inside the area the trip already covers
   * should not re-download it, and moving the trip should.
   *
   * Optional so a row written before this landed still reads.
   */
  areaPlacesKey?: string;
}

/**
 * A place from the TREK Places index, cached for the area of one trip.
 *
 * NOT a trip place — those are in `places` and belong to the user. These are
 * candidates: the shops, restaurants and stations that happen to be near where
 * the trip goes, taken once so search still answers on a plane. They are
 * disposable and are re-fetched whenever the trip's area changes.
 *
 * The key is the GERS id, which is stable across index rebuilds; `tripId` is
 * indexed so the whole set can be dropped with the trip.
 */
export interface CachedAreaPlace {
  /** GERS id, without the `gers:` prefix the server puts on `osm_id`. */
  gers: string;
  tripId: number;
  name: string;
  /** Lowercased, diacritics folded — what an offline search actually matches on. */
  searchName: string;
  address: string;
  lat: number | null;
  lng: number | null;
  category: string | null;
  website: string | null;
  phone: string | null;
  cachedAt: number;
}

// ── Dexie class ────────────────────────────────────────────────────────────────

/**
 * The offline DB is scoped per user so that one account can never read another
 * account's cached data on a shared device. Anonymous (logged-out) state uses
 * the base name; a logged-in user uses `trek-offline-u<userId>`.
 */
const ANON_DB_NAME = 'trek-offline';

function userDbName(userId: number | string): string {
  return `trek-offline-u${userId}`;
}

/**
 * Best-effort read of the persisted auth snapshot so the very first DB opened on
 * app load (before loadUser resolves) is already the correct per-user one — the
 * PWA can render cached data offline without leaking across users.
 */
function initialDbName(): string {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('trek_auth_snapshot') : null;
    if (!raw) return ANON_DB_NAME;
    const id = JSON.parse(raw)?.state?.user?.id;
    return id != null ? userDbName(id) : ANON_DB_NAME;
  } catch {
    return ANON_DB_NAME;
  }
}

class TrekOfflineDb extends Dexie {
  trips!: Table<Trip, number>;
  days!: Table<Day, number>;
  places!: Table<Place, number>;
  budgetItems!: Table<BudgetItem, number>;
  reservations!: Table<Reservation, number>;
  accommodations!: Table<Accommodation, number>;
  tripMembers!: Table<CachedTripMember, [number, number]>;
  tags!: Table<Tag, number>;
  categories!: Table<Category, number>;
  syncMeta!: Table<SyncMeta, number>;
  areaPlaces!: Table<CachedAreaPlace, [string, number]>;

  constructor(name: string = ANON_DB_NAME) {
    super(name);

    this.version(1).stores({
      trips:        'id',
      days:         'id, trip_id',
      places:       'id, trip_id',
      budgetItems:  'id, trip_id',
      reservations: 'id, trip_id',
      tripFiles:    'id, trip_id',
      mutationQueue:'id, tripId, status, createdAt',
      syncMeta:     'tripId',
      blobCache:    'url, cachedAt',
    });

    this.version(2).stores({
      accommodations: 'id, trip_id',
      tripMembers:    '[tripId+id], tripId',
      tags:           'id',
      categories:     'id',
    });

    // v3: scope the blob cache by trip so it can be evicted with the trip and
    // bounded by an LRU budget (see enforceBlobBudget).
    this.version(3).stores({
      blobCache: 'url, cachedAt, tripId',
    }).upgrade(async (tx) => {
      await tx.table('blobCache').toCollection().modify((row: { tripId?: number; bytes?: number; blob?: Blob }) => {
        if (row.tripId == null) row.tripId = -1;
        if (row.bytes == null) row.bytes = row.blob?.size ?? 0;
      });
    });

    // v4: durable store for booking-import source files (survives a reload mid-parse).
    this.version(4).stores({
      importFiles: '[jobId+fileName], jobId, createdAt',
    });

    // v5: places from the TREK Places index for the trip's area, so search
    // answers offline. `searchName` is indexed because that is what an offline
    // query filters on; `tripId` so the set drops with its trip.
    this.version(6).stores({ roadtripPreferences: 'tripId' });
    this.version(5).stores({
      areaPlaces: 'gers, tripId, searchName',
    });

    // v7/v8: the same place near two trips is two rows now.
    //
    // Keyed on the GERS id alone, one row could only ever name one trip, and a
    // bulkPut for the second trip rewrote the first trip's rows to point at it.
    // Switching the second trip off then deleted the shared set by tripId, and
    // the first trip's areaPlacesKey still matched its bbox, so nothing ever
    // downloaded them again: a trip whose switch read "on" with no offline
    // search behind it. Dexie cannot change a primary key in place, so the
    // table is dropped and rebuilt, and every stored fingerprint is cleared so
    // the next sync refills what the drop took.
    this.version(7).stores({ areaPlaces: null });
    this.version(8).stores({
      areaPlaces: '[gers+tripId], gers, tripId, searchName',
    }).upgrade(async (tx) => {
      await tx.table('syncMeta').toCollection().modify((row: { areaPlacesKey?: string }) => {
        delete row.areaPlacesKey;
      });
    });

    // v9: the booking-import flow is gone with the server (there is no parse
    // endpoint to feed the files to), so its durable source-file store goes
    // with it.
    this.version(9).stores({ importFiles: null });

    // v10: packing and todo items live in panelmintDb now — the local
    // adapters are the write path, so this read-through cache went dead.
    this.version(10).stores({ packingItems: null, todoItems: null });

    // v11: trip files are a cut feature (there is no /files endpoint or UI to
    // feed them), the blob cache only ever served them, roadtrip preferences
    // went with the roadtrip mode, and the mutation queue was the offline
    // write-replay machinery for a server that no longer exists — writes are
    // local and durable immediately.
    this.version(11).stores({
      tripFiles: null,
      blobCache: null,
      roadtripPreferences: null,
      mutationQueue: null,
    });
  }
}

// Monotonic counter for optimistic (negative) ids on locally-created rows —
// same-millisecond creates must not collide (rapid tapping, bulk writes).
let _lastTempId = 0;

/**
 * Mint a collision-free temporary (negative) id for a locally-created entity.
 * Monotonic across the session so same-millisecond creates never collide.
 */
export function nextTempId(): number {
  const now = Date.now();
  _lastTempId = now > _lastTempId ? now : _lastTempId + 1;
  return -_lastTempId;
}

// The live instance is swapped on login/logout via reopenForUser/reopenAnonymous.
// A Proxy keeps the exported `offlineDb` binding stable for the ~19 modules that
// import it directly, while every access forwards to the current connection.
let _db = new TrekOfflineDb(initialDbName());

export const offlineDb = new Proxy({} as TrekOfflineDb, {
  get(_target, prop) {
    const value = (_db as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(_db) : value;
  },
  set(_target, prop, value) {
    (_db as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
}) as TrekOfflineDb;

async function switchTo(name: string): Promise<void> {
  if (_db.name === name) {
    if (!_db.isOpen()) await _db.open();
    return;
  }
  if (_db.isOpen()) _db.close();
  _db = new TrekOfflineDb(name);
  await _db.open();
}

/** Point the offline DB at a specific user's scoped database (call on login). */
export async function reopenForUser(userId: number | string): Promise<void> {
  await switchTo(userDbName(userId));
}

/** Point the offline DB at the anonymous database (call on logout). */
export async function reopenAnonymous(): Promise<void> {
  await switchTo(ANON_DB_NAME);
}

/**
 * Delete the current user's scoped database entirely and return to the anonymous
 * DB. Used on logout so no trace of the account's data remains on the device.
 */
export async function deleteCurrentUserDb(): Promise<void> {
  // Already anonymous: there is nothing to delete, and opening a second
  // connection to the same name would leak the current handle for the session.
  if (_db.name === ANON_DB_NAME) {
    await switchTo(ANON_DB_NAME);
    return;
  }
  try { await _db.delete(); } catch { /* ignore — fall through to anon */ }
  _db = new TrekOfflineDb(ANON_DB_NAME);
  await _db.open();
}

// ── Bulk upsert helpers ────────────────────────────────────────────────────────

export async function upsertTrip(trip: Trip): Promise<void> {
  await offlineDb.trips.put(trip);
}

export async function upsertDays(days: Day[]): Promise<void> {
  await offlineDb.days.bulkPut(days);
}

export async function upsertPlaces(places: Place[]): Promise<void> {
  await offlineDb.places.bulkPut(places);
}

export async function upsertBudgetItems(items: BudgetItem[]): Promise<void> {
  await offlineDb.budgetItems.bulkPut(items);
}

export async function upsertReservations(items: Reservation[]): Promise<void> {
  await offlineDb.reservations.bulkPut(items);
}

export async function upsertAccommodations(items: Accommodation[]): Promise<void> {
  await offlineDb.accommodations.bulkPut(items);
}

export async function upsertSyncMeta(meta: SyncMeta): Promise<void> {
  await offlineDb.syncMeta.put(meta);
}

// ── Eviction / cleanup ────────────────────────────────────────────────────────

/**
 * Delete one trip's cached read data (eviction, per-trip opt-out). The full
 * "Clear cache" wipe goes through clearAll(), which intentionally drops
 * everything.
 */
export async function clearTripData(tripId: number): Promise<void> {
  await offlineDb.transaction(
    'rw',
    [
      offlineDb.days,
      offlineDb.places,
      offlineDb.budgetItems,
      offlineDb.reservations,
      offlineDb.accommodations,
      offlineDb.tripMembers,
      offlineDb.syncMeta,
      offlineDb.areaPlaces,
    ],
    async () => {
      await offlineDb.days.where('trip_id').equals(tripId).delete();
      await offlineDb.places.where('trip_id').equals(tripId).delete();
      await offlineDb.budgetItems.where('trip_id').equals(tripId).delete();
      await offlineDb.reservations.where('trip_id').equals(tripId).delete();
      await offlineDb.accommodations.where('trip_id').equals(tripId).delete();
      await offlineDb.tripMembers.where('tripId').equals(tripId).delete();
      await offlineDb.syncMeta.where('tripId').equals(tripId).delete();
      // The cached places around this trip's area go with it. They are searched
      // across every trip, so leaving them behind kept a switched-off trip
      // answering offline searches — and nothing else ever deleted them, so they
      // accumulated for the life of the install.
      await offlineDb.areaPlaces.where('tripId').equals(tripId).delete();
    },
  );
  // Remove the trip row itself outside the transaction since it's a separate table
  await offlineDb.trips.delete(tripId);
}

/** Wipe the entire offline database (called on logout). */
export async function clearAll(): Promise<void> {
  await offlineDb.delete();
  // Re-open so subsequent operations don't fail
  await offlineDb.open();
}
