/**
 * Tests for the local `placesApi` — the Dexie adapter that replaced
 * /api/trips/:id/places. Pins the server's semantics on the real database:
 * validation order (pipe 400 before trip 404, in-handler guards after),
 * COALESCE vs presence-keyed update writes, the tag roster filter, the
 * delete cascade (embedded assignments, stays, expenses, reservation links)
 * and `rate` mapped onto `my_rating` without an `updated_at` bump.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { placesApi } from './places';
import { db } from '../../db/panelmintDb';
import type { LocalPlace } from '../../db/panelmintDb';
import { LocalApiError } from './helpers';
import {
  buildTrip, buildDay, buildPlace, buildCategory, buildTag,
  buildAssignment, buildReservation, buildBudgetItem,
} from '../../../tests/helpers/factories';
import type { Accommodation, BudgetItem, Day, Tag } from '../../types';

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
}

async function seedTrip(id = 1) {
  await db.trips.put(buildTrip({ id }));
}

function expectStatus(err: unknown, status: number) {
  expect(err).toBeInstanceOf(LocalApiError);
  expect((err as LocalApiError).status).toBe(status);
  // Axios-shaped compatibility: callers read response.status / .data.error.
  expect((err as LocalApiError).response?.status).toBe(status);
}

async function seedPlace(overrides: Partial<LocalPlace> = {}) {
  const place = buildPlace(overrides) as LocalPlace;
  await db.places.put(place);
  return place;
}

function accommodation(overrides: Partial<Accommodation> = {}): Accommodation {
  return {
    id: 1, trip_id: 1, place_id: null, start_day_id: 1, end_day_id: 2,
    check_in: null, check_out: null, confirmation: null, notes: null,
    ...overrides,
  } as Accommodation;
}

function budgetItem(overrides: Partial<BudgetItem> = {}): BudgetItem {
  return { ...buildBudgetItem({ id: 1, trip_id: 1 }), place_id: null, ...overrides } as BudgetItem;
}

function dayWithAssignment(day: Day, placeId: number, assignmentId: number): Day {
  const stored = buildAssignment({ id: assignmentId, day_id: day.id, place_id: placeId });
  // The embedded row is the stored shape (place_id + times), not the wire join.
  const { place: _place, ...row } = stored as unknown as Record<string, unknown>;
  return { ...day, assignments: [row] } as Day;
}

beforeEach(resetDb);

describe('placesApi.list', () => {
  it('FE-LOCAL-PLACES-001: lists a trip\'s places newest-first inside { places }', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, created_at: '2025-01-01T00:00:00.000Z' });
    await seedPlace({ id: 2, trip_id: 1, created_at: '2025-01-03T00:00:00.000Z' });
    await seedPlace({ id: 3, trip_id: 1, created_at: '2025-01-02T00:00:00.000Z' });
    await seedPlace({ id: 9, trip_id: 2, name: 'Foreign' }); // another trip — but trip 2 doesn't exist → just ensure isolation
    await db.trips.put(buildTrip({ id: 2 }));

    const { places } = await placesApi.list(1);
    expect(places.map(p => p.id)).toEqual([2, 3, 1]);
  });

  it('FE-LOCAL-PLACES-002: a missing trip is a 404 with the axios shape', async () => {
    try {
      await placesApi.list(999);
      expect.unreachable();
    } catch (err) {
      expectStatus(err, 404);
    }
  });

  it('FE-LOCAL-PLACES-003: search filters name/address/description case-insensitively', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, name: 'Eiffel Tower' });
    await seedPlace({ id: 2, trip_id: 1, name: 'Cafe', address: '12 eiffel street' });
    await seedPlace({ id: 3, trip_id: 1, name: 'Museum', description: null });
    const { places } = await placesApi.list(1, { search: 'eiffel' });
    expect(places.map(p => p.id).sort()).toEqual([1, 2]);
  });

  it('FE-LOCAL-PLACES-004: category + tag + assignment filters apply', async () => {
    await seedTrip(1);
    await db.categories.put(buildCategory({ id: 5, name: 'Food' }));
    await db.tags.put(buildTag({ id: 7, name: 'Wishlist' }) as Tag);
    const day = buildDay({ id: 10, trip_id: 1 });
    await db.days.put(dayWithAssignment(day, 2, 100));
    await seedPlace({ id: 1, trip_id: 1, category_id: 5, tags: [{ id: 7, name: 'Wishlist', color: '#fff', user_id: 1 }] as never });
    await seedPlace({ id: 2, trip_id: 1, category_id: 6 });
    await seedPlace({ id: 3, trip_id: 1 });

    expect((await placesApi.list(1, { category: '5' })).places.map(p => p.id)).toEqual([1]);
    expect((await placesApi.list(1, { tag: '7' })).places.map(p => p.id)).toEqual([1]);
    expect((await placesApi.list(1, { assignment: 'assigned' })).places.map(p => p.id)).toEqual([2]);
    expect((await placesApi.list(1, { assignment: 'unassigned' })).places.map(p => p.id).sort()).toEqual([1, 3]);
  });

  it('FE-LOCAL-PLACES-005: the wire projection joins the category and folds my_rating', async () => {
    await seedTrip(1);
    await db.categories.put(buildCategory({ id: 5, name: 'Food', color: '#123456', icon: 'Utensils' }));
    await seedPlace({ id: 1, trip_id: 1, category_id: 5, my_rating: 4 });

    const { places } = await placesApi.list(1);
    const p = places[0] as Record<string, unknown>;
    expect(p.category_name).toBe('Food');
    expect(p.category_color).toBe('#123456');
    expect(p.rating_avg).toBe(4);
    expect(p.rating_count).toBe(1);
    // my_rating is internal — the wire carries the self vote inside `ratings`.
    expect(p.my_rating).toBeUndefined();
    expect((p.ratings as Array<{ rating: number }>)[0].rating).toBe(4);
  });
});

describe('placesApi.get', () => {
  it('FE-LOCAL-PLACES-006: returns the place; a place of another trip is a 404', async () => {
    await seedTrip(1);
    await seedTrip(2);
    await seedPlace({ id: 1, trip_id: 2 });

    await expect(placesApi.get(1, 1)).rejects.toMatchObject({ status: 404 });
    const { place } = await placesApi.get(2, 1);
    expect(place.id).toBe(1);
  });

  it('FE-LOCAL-PLACES-007: a non-numeric id is the 404 the server\'s NULL-bound lookup produced', async () => {
    await seedTrip(1);
    await expect(placesApi.get(1, 'abc')).rejects.toMatchObject({ status: 404 });
  });
});

describe('placesApi.create', () => {
  it('FE-LOCAL-PLACES-008: creates with the server defaults', async () => {
    await seedTrip(1);
    const { place } = await placesApi.create(1, { name: 'Tower', lat: 48.85, lng: 2.29 });
    expect(place).toMatchObject({
      name: 'Tower', lat: 48.85, lng: 2.29,
      transport_mode: 'walking', duration_minutes: 60,
      description: null, address: null, currency: null,
    });
    expect(await db.places.get(place.id)).toBeTruthy();
  });

  it('FE-LOCAL-PLACES-009: a bad body on a MISSING trip is a 400, not a 404 (pipe first)', async () => {
    // No trip seeded — the schema rejection must win over the trip lookup.
    await expect(placesApi.create(999, { name: '' } as never)).rejects.toMatchObject({ status: 400 });
  });

  it('FE-LOCAL-PLACES-010: a valid body on a missing trip is a 404', async () => {
    await expect(placesApi.create(999, { name: 'X' })).rejects.toMatchObject({ status: 404 });
  });

  it('FE-LOCAL-PLACES-011: in-handler guards run after the trip 404', async () => {
    await seedTrip(1);
    await expect(placesApi.create(1, { name: 'x'.repeat(201) })).rejects.toMatchObject({ status: 400 });
    await expect(placesApi.create(1, { name: 'X', route_color: 'red' })).rejects.toMatchObject({ status: 400 });
    await expect(placesApi.create(1, { name: 'X', website: 'javascript:alert(1)' })).rejects.toMatchObject({ status: 400 });
  });

  it('FE-LOCAL-PLACES-012: unknown tag ids drop silently; known ones land', async () => {
    await seedTrip(1);
    await db.tags.put(buildTag({ id: 7, name: 'Wishlist' }) as Tag);
    const { place } = await placesApi.create(1, { name: 'X', tags: [7, 999] } as never);
    expect(place.tags).toHaveLength(1);
    expect(place.tags![0].id).toBe(7);
  });
});

describe('placesApi.update', () => {
  it('FE-LOCAL-PLACES-013: presence-keyed writes — null clears, absent keeps', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, name: 'Old', notes: 'keep me', website: 'https://a.example' });

    const { place } = await placesApi.update(1, 1, { website: null } as never);
    expect(place.website).toBeNull();
    expect(place.name).toBe('Old');
    expect(place.notes).toBe('keep me');
  });

  it('FE-LOCAL-PLACES-014: name/currency/transport_mode are COALESCE writes', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, name: 'Old', currency: 'EUR', transport_mode: 'car' });
    const { place } = await placesApi.update(1, 1, { name: '', currency: '', transport_mode: '' } as never);
    expect(place).toMatchObject({ name: 'Old', currency: 'EUR', transport_mode: 'car' });
  });

  it('FE-LOCAL-PLACES-015: route_color null clears the picked colour', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, route_color: '#e11d48' });
    const { place } = await placesApi.update(1, 1, { route_color: null } as never);
    expect(place.route_color).toBeNull();
  });

  it('FE-LOCAL-PLACES-016: route_geometry is not updateable (server UPDATE list parity)', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, route_geometry: '[[1,2],[3,4]]' });
    const { place } = await placesApi.update(1, 1, { route_geometry: '[[9,9],[8,8]]' } as never);
    expect(place.route_geometry).toBe('[[1,2],[3,4]]');
  });

  it('FE-LOCAL-PLACES-017: Zod-pipe failures precede the trip 404; in-handler guards follow it', async () => {
    // stop_type has a bounded vocabulary the schema polices — the pipe ran before requireTrip.
    await expect(placesApi.update(999, 1, { stop_type: 'banana' } as never)).rejects.toMatchObject({ status: 400 });
    // name length is an in-handler guard (validateLengths), which the controller
    // ran AFTER requireTrip — a missing trip answers 404 first.
    await expect(placesApi.update(999, 1, { name: 'x'.repeat(201) } as never)).rejects.toMatchObject({ status: 404 });
    // …and on an existing trip the same body is a 400.
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1 });
    await expect(placesApi.update(1, 1, { name: 'x'.repeat(201) } as never)).rejects.toMatchObject({ status: 400 });
  });
});

describe('placesApi.delete + bulkDelete', () => {
  it('FE-LOCAL-PLACES-018: delete cascades assignments, stays, expenses, reservation links', async () => {
    await seedTrip(1);
    const day = buildDay({ id: 10, trip_id: 1 });
    await db.days.put(dayWithAssignment(day, 5, 100));
    await db.assignmentParticipants.put({ id: 1, assignment_id: 100, user_id: 1 });
    await seedPlace({ id: 5, trip_id: 1 });
    await db.accommodations.put(accommodation({ id: 20, trip_id: 1, place_id: 5 }));
    await db.budgetItems.put(budgetItem({ id: 30, trip_id: 1, place_id: 5 }));
    await db.reservations.put(buildReservation({ id: 40, trip_id: 1, place_id: 5 } as never));

    const res = await placesApi.delete(1, 5);
    expect(res).toMatchObject({ success: true });

    expect(await db.places.get(5)).toBeUndefined();
    const dayAfter = await db.days.get(10);
    expect((dayAfter!.assignments as unknown[])).toHaveLength(0);
    expect(await db.assignmentParticipants.toArray()).toHaveLength(0);
    expect(await db.accommodations.toArray()).toHaveLength(0);
    expect(await db.budgetItems.toArray()).toHaveLength(0);
    expect((await db.reservations.get(40))!.place_id).toBeNull();
    // The side channel carries the deletions the server broadcast separately.
    expect(res.cancelled).toMatchObject({ accommodationIds: [20], budgetItemIds: [30] });
  });

  it('FE-LOCAL-PLACES-018b: a stay at the place takes its reservation and that reservation\'s expense (#1298 path)', async () => {
    await seedTrip(1);
    await seedPlace({ id: 5, trip_id: 1 });
    await db.accommodations.put(accommodation({ id: 20, trip_id: 1, place_id: 5 }));
    // Linked by accommodation_id, not place_id — the orphaned path the plain
    // deleteStay (SET NULL) would have left behind.
    await db.reservations.put(buildReservation({ id: 41, trip_id: 1, accommodation_id: 20 } as never));
    await db.budgetItems.put(budgetItem({ id: 31, trip_id: 1, reservation_id: 41 }));
    // An unrelated reservation on the same trip must survive.
    await db.reservations.put(buildReservation({ id: 42, trip_id: 1 } as never));

    const res = await placesApi.delete(1, 5);

    expect(await db.accommodations.toArray()).toHaveLength(0);
    expect(await db.reservations.get(41)).toBeUndefined();
    expect(await db.budgetItems.get(31)).toBeUndefined();
    expect(await db.reservations.get(42)).toBeTruthy();
    expect(res.cancelled).toEqual({
      reservationIds: [41],
      budgetItemIds: [31],
      accommodationIds: [20],
    });
  });

  it('FE-LOCAL-PLACES-018c: bulkDelete aggregates the cancelled ids of every place', async () => {
    await seedTrip(1);
    await seedPlace({ id: 5, trip_id: 1 });
    await seedPlace({ id: 6, trip_id: 1 });
    await db.accommodations.put(accommodation({ id: 20, trip_id: 1, place_id: 5 }));
    await db.reservations.put(buildReservation({ id: 41, trip_id: 1, accommodation_id: 20 } as never));
    await db.budgetItems.put(budgetItem({ id: 31, trip_id: 1, reservation_id: 41 }));
    await db.budgetItems.put(budgetItem({ id: 32, trip_id: 1, place_id: 6 }));

    const res = await placesApi.bulkDelete(1, [5, 6]);
    expect(res.deleted).toEqual([5, 6]);
    expect(res.cancelled).toEqual({
      reservationIds: [41],
      budgetItemIds: [31, 32],
      accommodationIds: [20],
    });
  });

  it('FE-LOCAL-PLACES-019: bulkDelete skips foreign ids without error', async () => {
    await seedTrip(1);
    await seedTrip(2);
    await seedPlace({ id: 1, trip_id: 1 });
    await seedPlace({ id: 2, trip_id: 2 });

    const res = await placesApi.bulkDelete(1, [1, 2, 999]);
    expect(res).toMatchObject({ deleted: [1], count: 1 });
    expect(await db.places.get(2)).toBeTruthy();
  });

  it('FE-LOCAL-PLACES-020: delete of a missing place is a 404', async () => {
    await seedTrip(1);
    await expect(placesApi.delete(1, 99)).rejects.toMatchObject({ status: 404 });
  });
});

describe('placesApi.bulkUpdate', () => {
  it('FE-LOCAL-PLACES-021: sets category_id on owned ids; null clears', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, category_id: 5 });
    await seedPlace({ id: 2, trip_id: 1, category_id: 5 });

    const res = await placesApi.bulkUpdate(1, [1, 2], { category_id: null });
    expect(res.count).toBe(2);
    expect((await db.places.get(1))!.category_id).toBeNull();
  });

  it('FE-LOCAL-PLACES-022: no updatable field is the server\'s 400', async () => {
    await seedTrip(1);
    await expect(placesApi.bulkUpdate(1, [1], {} as never)).rejects.toMatchObject({ status: 400 });
  });
});

describe('placesApi.rate', () => {
  it('FE-LOCAL-PLACES-023: sets and clears my_rating; re-derives the wire fields', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1 });

    const { place } = await placesApi.rate(1, 1, 5);
    expect((place as Record<string, unknown>).rating_avg).toBe(5);
    expect((await db.places.get(1))!.my_rating).toBe(5);

    const { place: cleared } = await placesApi.rate(1, 1, null);
    expect((cleared as Record<string, unknown>).rating_avg).toBeNull();
    expect((cleared as Record<string, unknown>).rating_count).toBe(0);
  });

  it('FE-LOCAL-PLACES-024: an out-of-range rating is a 400 before the trip 404', async () => {
    await expect(placesApi.rate(999, 1, 9)).rejects.toMatchObject({ status: 400 });
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1 });
    await expect(placesApi.rate(1, 1, 0)).rejects.toMatchObject({ status: 400 });
  });

  it('FE-LOCAL-PLACES-025: a vote never bumps updated_at', async () => {
    await seedTrip(1);
    await seedPlace({ id: 1, trip_id: 1, updated_at: '2025-01-01T00:00:00.000Z' });
    await placesApi.rate(1, 1, 4);
    expect((await db.places.get(1))!.updated_at).toBe('2025-01-01T00:00:00.000Z');
  });
});
