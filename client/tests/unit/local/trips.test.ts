/**
 * Parity tests for the local `tripsApi` — the adapter that replaced
 * `apiClient.get('/trips', …)` over the real Dexie `panelmint` database
 * (fake-indexeddb). Pins the server envelopes ({trip}/{trips}/{owner,members,
 * current_user_id}), the LocalApiError strings/statuses the controllers sent,
 * the generateDays diff on create/update (keep_bookings vs shift_all), the
 * delete cascade, and the deep copy's remapping rules.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The currency rebase fetches live FX before its transaction — keep tests
// offline by stubbing the fetcher the adapter imports (its per-test return is
// set in beforeEach / the rate-pinning case).
vi.mock('../../../src/api/ext/fx', () => ({
  fetchExchangeRates: vi.fn(),
}));
import { fetchExchangeRates } from '../../../src/api/ext/fx';
import { tripsApi } from '../../../src/api/local/trips';
import { usersApi } from '../../../src/api/local/users';
import { budgetApi } from '../../../src/api/local/budget';
import { db } from '../../../src/db/panelmintDb';
import { LocalApiError } from '../../../src/api/local/helpers';
import { buildTrip, buildDay, buildPlace, buildReservation, buildBudgetItem, buildPackingItem, buildTodoItem } from '../../helpers/factories';
import type { LocalUser, Trip } from '../../../src/types';
import type { LocalTripMember } from '../../../src/db/panelmintDb';
import type { DayRow, StoredAssignment } from '../../../src/api/local/dexieStore';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };
const mockFetchRates = vi.mocked(fetchExchangeRates);

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
  // Default: the fetch fails (offline) — the server wrote the same "not
  // frozen" pins when Frankfurter was unreachable. mockReset also clears the
  // call log — vitest here doesn't auto-clear between tests.
  mockFetchRates.mockReset().mockResolvedValue(null);
}

beforeEach(resetDb);

const seedTrip = (over: Partial<Trip> = {}) => db.trips.put(buildTrip({ id: 1, ...over }));

const seedAssignment = (day: DayRow, over: Partial<StoredAssignment> = {}) => {
  const a: StoredAssignment = {
    id: over.id ?? 500,
    day_id: day.id,
    place_id: 1,
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
  };
  day.assignments = [...((day.assignments ?? []) as unknown as StoredAssignment[]), a] as never;
  return db.days.put(day);
};

/** Catch the rejection as a LocalApiError-shaped value. */
const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('tripsApi.create', () => {
  it('creates the trip and generates one dated day per calendar day', async () => {
    const { trip } = await tripsApi.create({ title: 'Alpine', start_date: '2026-03-01', end_date: '2026-03-03' });
    expect(trip.title).toBe('Alpine');
    expect(trip.user_id).toBe(1);
    expect(trip.is_owner).toBe(1);
    expect(trip.day_count).toBe(3);
    expect(trip.place_count).toBe(0);
    expect(trip.owner_username).toBe('Me');
    const days = await db.days.where('trip_id').equals(trip.id).toArray();
    expect(days.map((d) => [d.day_number, d.date])).toEqual([
      [1, '2026-03-01'],
      [2, '2026-03-02'],
      [3, '2026-03-03'],
    ]);
  });

  it('infers the missing endpoint the way the controller did (+6 days)', async () => {
    const { trip } = await tripsApi.create({ title: 'T', start_date: '2026-03-01' });
    expect(trip.start_date).toBe('2026-03-01');
    expect(trip.end_date).toBe('2026-03-07');
    expect(await db.days.where('trip_id').equals(trip.id).count()).toBe(7);
  });

  it('honors day_count on a dateless trip', async () => {
    const { trip } = await tripsApi.create({ title: 'T', day_count: 4 });
    const days = await db.days.where('trip_id').equals(trip.id).toArray();
    expect(days).toHaveLength(4);
    expect(days.every((d) => d.date === null)).toBe(true);
  });

  it('rejects an inverted range with the controller message', async () => {
    const err = await fail(tripsApi.create({ title: 'T', start_date: '2026-03-05', end_date: '2026-03-01' }));
    expect(err).toBeInstanceOf(LocalApiError);
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('End date must be after start date');
  });

  it('formats zod failures like the server validation pipe', async () => {
    const err = await fail(tripsApi.create({} as never));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toContain('title:');
  });
});

describe('tripsApi.list/get/active', () => {
  it('lists only unarchived trips by default, newest first', async () => {
    await db.trips.bulkPut([
      buildTrip({ id: 1, title: 'Old', created_at: '2025-01-01T00:00:00.000Z' }),
      buildTrip({ id: 2, title: 'New', created_at: '2025-02-01T00:00:00.000Z' }),
      buildTrip({ id: 3, title: 'Arch', is_archived: 1, created_at: '2025-03-01T00:00:00.000Z' }),
    ]);
    const { trips } = await tripsApi.list();
    expect(trips.map((t: Trip) => t.title)).toEqual(['New', 'Old']);
    const { trips: archived } = await tripsApi.list({ archived: '1' });
    expect(archived.map((t: Trip) => t.title)).toEqual(['Arch']);
  });

  it('404s a trip self cannot reach', async () => {
    const err = await fail(tripsApi.get(999));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Trip not found');
    // A NaN route param produced the same 404 server-side — never a DataError.
    const nan = await fail(tripsApi.get('abc'));
    expect(nan.response.status).toBe(404);
  });

  it('active prefers the trip running today, else the next starting', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await db.trips.bulkPut([
      buildTrip({ id: 1, title: 'Past', start_date: '2020-01-01', end_date: '2020-01-05' }),
      buildTrip({ id: 2, title: 'Now', start_date: today, end_date: today }),
      buildTrip({ id: 3, title: 'Future', start_date: '2999-01-01', end_date: '2999-01-05' }),
      buildTrip({ id: 4, title: 'ArchivedNow', start_date: today, end_date: today, is_archived: 1 }),
    ]);
    const { trip } = await tripsApi.active();
    expect(trip.title).toBe('Now');
  });

  it('active returns {trip: null} with no unarchived trips', async () => {
    expect(await tripsApi.active()).toEqual({ trip: null });
  });
});

describe('tripsApi.update', () => {
  it('regenerates days when the range moves (keep_bookings default)', async () => {
    await seedTrip({ start_date: '2026-03-01', end_date: '2026-03-03' });
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
    ]);
    const { trip } = await tripsApi.update(1, { start_date: '2026-03-05', end_date: '2026-03-07' });
    const days = await db.days.where('trip_id').equals(1).sortBy('day_number');
    expect(days.map((d) => [d.id, d.date])).toEqual([
      [11, '2026-03-05'],
      [12, '2026-03-06'],
      [13, '2026-03-07'],
    ]);
    expect(trip.start_date).toBe('2026-03-05');
  });

  it('keep_bookings re-anchors a dated reservation to the day now holding its date', async () => {
    await seedTrip({ start_date: '2026-03-01', end_date: '2026-03-03' });
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
    ]);
    await db.reservations.put(
      buildReservation({ id: 9, trip_id: 1, day_id: 13, reservation_time: '2026-03-03T18:30' }),
    );
    // Move the range one day earlier: day rows slide back and 2026-03-03 is now
    // held by a NEW fourth row — the booking re-anchors to it by absolute date.
    await tripsApi.update(1, { start_date: '2026-02-28', end_date: '2026-03-03' });
    const r = await db.reservations.get(9);
    expect(r!.day_id).not.toBe(13);
    const day = await db.days.get(r!.day_id!);
    expect(day!.date).toBe('2026-03-03');
    expect(r!.reservation_time).toBe('2026-03-03T18:30'); // keep_bookings does not restamp
    // Day 13 slid to slot 3 → 2026-03-02.
    expect((await db.days.get(13))!.date).toBe('2026-03-02');
  });

  it('shift_all keeps the booking glued to its day row and restamps the time', async () => {
    await seedTrip({ start_date: '2026-03-01', end_date: '2026-03-03' });
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
    ]);
    await db.reservations.put(
      buildReservation({ id: 9, trip_id: 1, day_id: 13, reservation_time: '2026-03-03T18:30' }),
    );
    await tripsApi.update(1, {
      start_date: '2026-03-11',
      end_date: '2026-03-13',
      date_shift_mode: 'shift_all',
    });
    const r = await db.reservations.get(9);
    // Day 13 is still slot 3 → 2026-03-13, and the timestamp follows it.
    expect(r!.day_id).toBe(13);
    expect(r!.reservation_time).toBe('2026-03-13T18:30');
  });

  it('rebases budget currencies when the trip currency changes', async () => {
    await seedTrip({ currency: 'EUR' });
    await db.budgetItems.put(buildBudgetItem({ id: 5, trip_id: 1, currency: null, exchange_rate: 1 }));
    await tripsApi.update(1, { currency: 'USD' });
    const b = await db.budgetItems.get(5);
    expect(b!.currency).toBe('EUR'); // currency-less rows take the OUTGOING base
    expect(b!.exchange_rate).toBe(1); // no live rate offline → the "not frozen" pin
    expect((await db.trips.get(1))!.currency).toBe('USD');
    expect(mockFetchRates).toHaveBeenCalledWith('USD');
  });

  it('freezes the live FX rate on the rebase when the fetch succeeds', async () => {
    await seedTrip({ currency: 'EUR' });
    await db.budgetItems.put(buildBudgetItem({ id: 5, trip_id: 1, currency: 'EUR', exchange_rate: 1 }));
    await db.budgetItems.put(buildBudgetItem({ id: 6, trip_id: 1, currency: 'JPY', exchange_rate: 1 }));
    mockFetchRates.mockResolvedValue({ USD: 1, EUR: 0.9, JPY: 150 });
    await tripsApi.update(1, { currency: 'USD' });
    // rateFor = units of the row's currency per 1 unit of the new base.
    expect((await db.budgetItems.get(5))!.exchange_rate).toBe(0.9);
    expect((await db.budgetItems.get(6))!.exchange_rate).toBe(150);
  });

  it('does not fetch FX when the currency is unchanged or absent', async () => {
    await seedTrip({ currency: 'EUR' });
    await tripsApi.update(1, { title: 'Same currency', currency: 'EUR' });
    await tripsApi.update(1, { title: 'No currency' });
    expect(mockFetchRates).not.toHaveBeenCalled();
  });

  it('updates title and returns the enriched row', async () => {
    await seedTrip();
    const { trip } = await tripsApi.update(1, { title: 'Renamed' });
    expect(trip.title).toBe('Renamed');
    expect(trip.day_count).toBe(0);
  });

  it('validates the body before the trip lookup (the pipe ran first)', async () => {
    const err = await fail(tripsApi.update(999, { title: 5 } as never));
    expect(err.response.status).toBe(400);
  });

  it('archive/unarchive flip is_archived through the update path', async () => {
    await seedTrip();
    await tripsApi.archive(1);
    expect((await db.trips.get(1))!.is_archived).toBe(1);
    await tripsApi.unarchive(1);
    expect((await db.trips.get(1))!.is_archived).toBe(0);
  });
});

describe('tripsApi.delete', () => {
  it('cascades every trip-scoped row', async () => {
    await seedTrip();
    await db.days.put(buildDay({ id: 11, trip_id: 1 }));
    await db.places.put(buildPlace({ id: 21, trip_id: 1 }));
    await db.reservations.put(buildReservation({ id: 31, trip_id: 1 }));
    await db.budgetItems.put(buildBudgetItem({ id: 41, trip_id: 1 }));
    await db.todoItems.put(buildTodoItem({ id: 51, trip_id: 1 }));
    await db.packingItems.put(buildPackingItem({ id: 61, trip_id: 1 }));
    const res = await tripsApi.delete(1);
    expect(res).toEqual({ success: true });
    for (const t of [db.days, db.places, db.reservations, db.budgetItems, db.todoItems, db.packingItems]) {
      expect(await t.count()).toBe(0);
    }
    expect(await db.trips.count()).toBe(0);
  });
});


describe('tripsApi members', () => {
  beforeEach(() => seedTrip());

  it('getMembers returns owner + members + current_user_id', async () => {
    const res = await tripsApi.getMembers(1);
    expect(res.current_user_id).toBe(1);
    expect(res.owner).toMatchObject({ id: 1, username: 'Me', role: 'owner', is_guest: false });
    expect(res.members).toEqual([]);
  });

  it('addMember rejects in the server order', async () => {
    expect((await fail(tripsApi.addMember(1, ''))).response.data.error).toBe('Email or username required');
    expect((await fail(tripsApi.addMember(1, 'nobody'))).response.status).toBe(404);
    expect((await fail(tripsApi.addMember(1, 'nobody'))).response.data.error).toBe('User not found');
    // Self resolves but is the owner.
    expect((await fail(tripsApi.addMember(1, 'Me'))).response.data.error).toBe('Trip owner is already a member');
    // Guests are excluded from resolution → 'User not found'.
    await usersApi.create(1, 'Anna');
    expect((await fail(tripsApi.addMember(1, 'Anna'))).response.data.error).toBe('User not found');
  });

  it('transferOwnership keeps the guard chain: self → guest → member checks', async () => {
    expect((await fail(tripsApi.transferOwnership(1, 1))).response.data.error).toBe('You already own this trip');
    expect((await fail(tripsApi.transferOwnership(1, 999))).response.data.error).toBe('User not found');
    const { member } = await usersApi.create(1, 'Anna');
    const err = await fail(tripsApi.transferOwnership(1, member.id));
    expect(err.response.data.error).toBe('Cannot transfer ownership to a guest');
    // Non-integer ids fail the DTO, after the owner guard.
    const bad = await fail(tripsApi.transferOwnership(1, 'x' as never));
    expect(bad.response.status).toBe(400);
  });

  it('removeMember drops the membership row', async () => {
    const { member } = await usersApi.create(1, 'Anna');
    await tripsApi.removeMember(1, member.id);
    expect(await db.tripMembers.get([1, member.id])).toBeUndefined();
  });
});

describe('tripsApi.copy', () => {
  it('duplicates the sub-tree with remapped ids and no sync identity', async () => {
    await seedTrip({ title: 'Source' });
    const day: DayRow = { vias: [], ...buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }) } as DayRow;
    await db.places.put(buildPlace({ id: 21, trip_id: 1, name: 'Hotel' }));
    await seedAssignment(day, { id: 71, place_id: 21 });
    await db.days.put(day);
    await db.reservations.put(
      buildReservation({ id: 31, trip_id: 1, day_id: 11, place_id: 21, external_id: 'ext-9', sync_enabled: 1 }),
    );
    await db.budgetItems.put(buildBudgetItem({ id: 41, trip_id: 1, reservation_id: 31 }));
    await db.todoItems.put(buildTodoItem({ id: 51, trip_id: 1, checked: 1, assigned_user_id: 1 }));
    await db.assignmentParticipants.put({ id: 81, assignment_id: 71, user_id: 1 });

    const { trip } = await tripsApi.copy(1, { title: 'Copy' });
    expect(trip.title).toBe('Copy');
    expect(trip.day_count).toBe(1);

    const days = await db.days.where('trip_id').equals(trip.id).toArray();
    expect(days).toHaveLength(1);
    const newDay = days[0] as DayRow;
    expect(newDay.id).not.toBe(11);
    const copiedAssignments = newDay.assignments as unknown as StoredAssignment[];
    expect(copiedAssignments).toHaveLength(1);
    expect(copiedAssignments[0].id).not.toBe(71);

    const places = await db.places.where('trip_id').equals(trip.id).toArray();
    expect(places).toHaveLength(1);
    expect(copiedAssignments[0].place_id).toBe(places[0].id);

    const res = await db.reservations.where('trip_id').equals(trip.id).toArray();
    expect(res).toHaveLength(1);
    expect(res[0].day_id).toBe(newDay.id);
    expect(res[0].place_id).toBe(places[0].id);
    expect(res[0].external_id).toBeNull();
    expect(res[0].sync_enabled).toBe(0);

    const budget = await db.budgetItems.where('trip_id').equals(trip.id).toArray();
    expect(budget).toHaveLength(1);
    expect(budget[0].reservation_id).toBe(res[0].id);
    expect(budget[0].place_id).toBeNull();

    const todos = await db.todoItems.where('trip_id').equals(trip.id).toArray();
    expect(todos[0].checked).toBe(0);
    expect(todos[0].assigned_user_id).toBeNull();

    const participants = await db.assignmentParticipants.toArray();
    expect(participants).toHaveLength(2); // source row + copied row
    expect(participants.find((p) => p.assignment_id === copiedAssignments[0].id)).toBeTruthy();
  });

  it('carries the budget category order onto the new trip', async () => {
    await seedTrip();
    // A non-default group order: 'food' outranks 'travel' — the
    // budget_category_order rows carry that, the items don't.
    await db.budgetCategoryOrder.bulkPut([
      { id: 91, trip_id: 1, category: 'travel', sort_order: 1 },
      { id: 92, trip_id: 1, category: 'food', sort_order: 0 },
    ]);
    await db.budgetItems.bulkPut([
      // Train's sort_order beats Dinner's — under the 999999 fallback the
      // copy would list it first; only the carried category order puts
      // 'food' ahead.
      buildBudgetItem({ id: 41, trip_id: 1, category: 'travel', name: 'Train', sort_order: 0 }),
      buildBudgetItem({ id: 42, trip_id: 1, category: 'food', name: 'Dinner', sort_order: 1 }),
    ]);

    const { trip } = await tripsApi.copy(1, {});

    // Row-for-row copy under the NEW trip id; the source rows are untouched.
    const copiedRows = await db.budgetCategoryOrder.where('trip_id').equals(trip.id).toArray();
    expect(
      copiedRows
        .map((r) => ({ category: r.category, sort_order: r.sort_order }))
        .sort((a, b) => a.sort_order - b.sort_order),
    ).toEqual([
      { category: 'food', sort_order: 0 },
      { category: 'travel', sort_order: 1 },
    ]);
    expect(await db.budgetCategoryOrder.where('trip_id').equals(1).count()).toBe(2);

    // The copy's budget list honours the carried order (Dinner first), the
    // same ordering listBudgetItemsWire produced for the source.
    const { items } = await budgetApi.list(trip.id);
    expect(items.map((i) => i.name)).toEqual(['Dinner', 'Train']);
    expect((await budgetApi.list(1)).items.map((i) => i.name)).toEqual(['Dinner', 'Train']);
  });

  it('404s a missing source trip', async () => {
    const err = await fail(tripsApi.copy(999));
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('tripsApi.bundle', () => {
  it('aggregates every sub-collection in the server envelope', async () => {
    await seedTrip();
    await db.days.put(buildDay({ id: 11, trip_id: 1, day_number: 1 }));
    await db.places.put(buildPlace({ id: 21, trip_id: 1 }));
    await db.reservations.put(buildReservation({ id: 31, trip_id: 1 }));
    await db.accommodations.put({
      id: 41, trip_id: 1, place_id: 21, start_day_id: 11, end_day_id: 11,
      check_in: null, check_in_end: null, check_out: null, confirmation: null, notes: null,
    });
    const b = await tripsApi.bundle(1);
    expect(b.trip.id).toBe(1);
    expect(b.days).toHaveLength(1);
    expect(b.places).toHaveLength(1);
    expect(b.reservations).toHaveLength(1);
    expect(b.accommodations).toHaveLength(1);
    expect(b.members[0]).toMatchObject({ id: 1, role: 'owner' });
    expect(Array.isArray(b.packingItems)).toBe(true);
    expect(Array.isArray(b.todoItems)).toBe(true);
    expect(Array.isArray(b.budgetItems)).toBe(true);
  });
});

describe('tripsApi member store round-trip', () => {
  it('persists members the way the server tables did', async () => {
    await seedTrip();
    await usersApi.create(1, 'Anna');
    const members = (await db.tripMembers.toArray()) as LocalTripMember[];
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ tripId: 1, username: 'Anna', is_guest: true });
  });
});
