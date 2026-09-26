/**
 * placeRepo unit tests.
 *
 * The repo is a pass-through over the Dexie-backed `placesApi` adapter (seeded
 * in `panelmintDb`) — these tests pin the envelopes and that writes land in the
 * real table.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { placeRepo } from '../../../src/repo/placeRepo';
import { placesApi } from '../../../src/api/client';
import { db } from '../../../src/db/panelmintDb';
import type { LocalPlace } from '../../../src/db/panelmintDb';
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

beforeEach(resetMainDb);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('placeRepo.list', () => {
  it('returns the trip places the adapter reads', async () => {
    await seedTrip(1);
    const place = await seedPlace({ trip_id: 1 });
    await seedPlace({ trip_id: 2 });

    const result = await placeRepo.list(1);
    expect(result.places).toHaveLength(1);
    expect(result.places[0].id).toBe(place.id);
  });

  it('a real adapter error rejects instead of being masked', async () => {
    await seedTrip(1);
    // A 404/500-shaped error is a real answer — the repo must surface it.
    const place = await seedPlace({ trip_id: 1 });
    expect(place.id).toBeGreaterThan(0);

    vi.spyOn(placesApi, 'list').mockRejectedValue(new LocalApiError(500, 'boom'));
    await expect(placeRepo.list(1)).rejects.toBeInstanceOf(LocalApiError);
  });
});

describe('placeRepo.create', () => {
  it('creates through the adapter — the row lands in panelmintDb', async () => {
    await seedTrip(1);

    const result = await placeRepo.create(1, { name: 'Eiffel Tower' });
    expect(result.place.name).toBe('Eiffel Tower');

    const stored = await db.places.get(result.place.id);
    expect(stored).toBeDefined();
    expect(stored!.name).toBe('Eiffel Tower');
  });
});

describe('placeRepo.update', () => {
  it('updates through the adapter — the stored row changes', async () => {
    await seedTrip(1);
    const original = await seedPlace({ trip_id: 1, name: 'Old Name' });

    const result = await placeRepo.update(1, original.id, { name: 'New Name' });
    expect(result.place.name).toBe('New Name');

    const stored = await db.places.get(original.id);
    expect(stored!.name).toBe('New Name');
  });
});

describe('placeRepo.delete', () => {
  it('deletes through the adapter — the stored row is gone', async () => {
    await seedTrip(1);
    const place = await seedPlace({ trip_id: 1 });

    await placeRepo.delete(1, place.id);

    expect(await db.places.get(place.id)).toBeUndefined();
  });
});

describe('placeRepo.deleteMany', () => {
  it('bulk-deletes through the adapter — only owned rows go', async () => {
    await seedTrip(1);
    const a = await seedPlace({ trip_id: 1 });
    const b = await seedPlace({ trip_id: 1 });
    const foreign = await seedPlace({ trip_id: 2 });

    const result = (await placeRepo.deleteMany(1, [a.id, b.id, foreign.id])) as {
      deleted: number[];
      count: number;
    };
    expect(result.deleted.sort()).toEqual([a.id, b.id].sort());
    expect(await db.places.get(foreign.id)).toBeDefined();
  });
});

describe('placeRepo.updateMany', () => {
  it('bulk-updates through the adapter', async () => {
    await seedTrip(1);
    const a = await seedPlace({ trip_id: 1 });
    const b = await seedPlace({ trip_id: 1 });

    const result = await placeRepo.updateMany(1, [a.id, b.id], { category_id: 7 });
    expect(result.updated.sort()).toEqual([a.id, b.id].sort());
    expect((await db.places.get(a.id))!.category_id).toBe(7);
    expect((await db.places.get(b.id))!.category_id).toBe(7);
  });
});
