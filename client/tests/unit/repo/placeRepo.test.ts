/**
 * placeRepo unit tests.
 *
 * Online path:  calls the Dexie-backed `placesApi` adapter (seeded in
 *               `panelmintDb`), then mirrors the result into the legacy
 *               `offlineDb` cache.
 * Offline path: returns the `offlineDb` cache, skips the adapter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AxiosError } from 'axios';
import { placeRepo } from '../../../src/repo/placeRepo';
import { placesApi } from '../../../src/api/client';
import { db } from '../../../src/db/panelmintDb';
import type { LocalPlace } from '../../../src/db/panelmintDb';
import { offlineDb, clearAll } from '../../../src/db/offlineDb';
import { buildTrip, buildPlace } from '../../helpers/factories';
import { LocalApiError } from '../../../src/api/local/helpers';

async function resetMainDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
}

async function seedTrip(id = 1) {
  await db.trips.put(buildTrip({ id }));
}

async function seedPlace(overrides: Partial<LocalPlace> = {}) {
  const place = buildPlace(overrides) as LocalPlace;
  await db.places.put(place);
  return place;
}

beforeEach(async () => {
  await clearAll();
  await resetMainDb();
  Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('placeRepo.list', () => {
  it('online — reads through the local adapter and caches in offlineDb', async () => {
    await seedTrip(1);
    const place = await seedPlace({ trip_id: 1 });

    const result = await placeRepo.list(1);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].id).toBe(place.id);

    // Give fire-and-forget a tick to flush
    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.places.where('trip_id').equals(1).toArray();
    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe(place.id);
  });

  it('offline — returns Dexie cache without touching the adapter', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false });

    const place = buildPlace({ trip_id: 1 });
    await offlineDb.places.put(place);

    const listSpy = vi.spyOn(placesApi, 'list');

    const result = await placeRepo.list(1);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].id).toBe(place.id);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('offline — returns empty array when nothing cached', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false });
    const result = await placeRepo.list(99);
    expect(result.places).toHaveLength(0);
  });

  it('online but request fails — falls back to Dexie cache (captive portal)', async () => {
    // navigator.onLine lies "true" on a captive portal; the request throws at
    // the network level (an Axios error with no response).
    const place = buildPlace({ trip_id: 1 });
    await offlineDb.places.put(place);

    vi.spyOn(placesApi, 'list').mockRejectedValue(new AxiosError('Network Error'));

    const result = await placeRepo.list(1);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].id).toBe(place.id);
  });

  it('online with a real adapter error — does NOT fall back (server spoke)', async () => {
    // A 404/500 carries a `response`, so it is not a network failure: the cache
    // must not silently mask it.
    const place = buildPlace({ trip_id: 1 });
    await offlineDb.places.put(place);

    await expect(placeRepo.list(1)).rejects.toBeInstanceOf(LocalApiError);
  });
});

describe('placeRepo.create', () => {
  it('creates through the local adapter and caches in offlineDb', async () => {
    await seedTrip(1);

    const result = await placeRepo.create(1, { name: 'Eiffel Tower' });
    expect(result.place.name).toBe('Eiffel Tower');

    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.places.get(result.place.id);
    expect(cached).toBeDefined();
    expect(cached!.name).toBe('Eiffel Tower');
  });
});

describe('placeRepo.update', () => {
  it('updates through the local adapter and refreshes the Dexie cache', async () => {
    await seedTrip(1);
    const original = await seedPlace({ trip_id: 1, name: 'Old Name' });
    await offlineDb.places.put(original);

    const result = await placeRepo.update(1, original.id, { name: 'New Name' });
    expect(result.place.name).toBe('New Name');

    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.places.get(original.id);
    expect(cached!.name).toBe('New Name');
  });
});

describe('placeRepo.delete', () => {
  it('deletes through the local adapter and removes from Dexie', async () => {
    await seedTrip(1);
    const place = await seedPlace({ trip_id: 1 });
    await offlineDb.places.put(place);

    await placeRepo.delete(1, place.id);

    await new Promise(r => setTimeout(r, 0));
    const cached = await offlineDb.places.get(place.id);
    expect(cached).toBeUndefined();
    expect(await db.places.get(place.id)).toBeUndefined();
  });
});
