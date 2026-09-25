/**
 * Parity tests for the local `reservationsApi` — the adapter that replaced the
 * axios object in api/client.ts — over the real Dexie `panelmint` database
 * (fake-indexeddb). The ported cascade's rules are pinned in
 * reservation-cascade.test.ts / night-seat.test.ts over the MemoryStore seam;
 * this file holds what only the adapter sees: the wire envelopes, the axios-
 * shaped errors, the side-channel fields the slices replay, and the junction /
 * endpoint tables behind the read model.
 *
 * Wire envelopes (reservations.ts):
 *   GET            → { reservations }
 *   POST/PUT       → { reservation, assignment|assignment[], movedAssignment,
 *                      removedAssignments, updatedAssignments, stampedPlace,
 *                      accommodationPing, budgetEvents }
 *   DELETE         → { success: true, …mirror fields, deletedAccommodationId,
 *                      deletedBudgetItemId }
 *   PUT travelers  → { travelers, reservation }
 *   PUT positions  → { success: true }
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillFlightEndpoints, reservationsApi } from '../../../src/api/local/reservations';
import type { DayRow, ReservationRow, StoredAssignment } from '../../../src/api/local/dexieStore';
import { db } from '../../../src/db/panelmintDb';
import type { LocalUser, Reservation } from '../../../src/types';
import type { LocalTripMember } from '../../../src/db/panelmintDb';
import { buildDay, buildPlace, buildReservation, buildTrip } from '../../helpers/factories';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const seedTrip = (id = 1) => db.trips.put(buildTrip({ id }));

const seedDay = (id: number, dayNumber = id, assignments: StoredAssignment[] = [], date?: string | null) =>
  db.days.put({
    vias: [],
    ...buildDay({ id, trip_id: 1, day_number: dayNumber, date: date === undefined ? `2025-06-0${dayNumber}` : date }),
    assignments: assignments as never,
  } as DayRow);

/** A stored reservation row — the wire shape plus the embedded collections. */
const storedReservation = (over: Partial<Reservation> = {}): ReservationRow => ({
  endpoints: [],
  day_positions: null,
  ingest_state: 'live',
  ...buildReservation(over),
} as ReservationRow);

const seedMember = (userId: number, name: string) =>
  db.tripMembers.put({
    tripId: 1, id: userId, username: name, role: 'member',
    added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
  } as LocalTripMember);

/** The booking-owned stops an accommodation put down, by seat day. */
const seatsOf = async (stayId: number): Promise<{ dayId: number; id: number }[]> => {
  const out: { dayId: number; id: number }[] = [];
  for (const day of await db.days.toArray()) {
    for (const a of (day.assignments ?? []) as unknown as StoredAssignment[]) {
      if (a.accommodation_id === stayId) out.push({ dayId: day.id, id: a.id });
    }
  }
  return out.sort((a, b) => a.dayId - b.dayId);
};

describe('reservationsApi.list', () => {
  it('LOCAL-RES-001 — the joined wire: day_number, place, stay and traveler joins', async () => {
    await seedTrip();
    await seedDay(2, 2);
    await db.places.put(buildPlace({ id: 5, trip_id: 1, name: 'Louvre' }));
    await db.reservations.put(storedReservation({
      id: 10, trip_id: 1, day_id: 2, place_id: 5,
      reservation_time: '2025-06-02T10:00', type: 'event',
    }));
    await db.reservationTravelers.put({ id: 1, reservation_id: 10, user_id: 1 });
    // A second trip's bookings never leak in.
    await db.trips.put(buildTrip({ id: 2 }));
    await db.reservations.put(storedReservation({ id: 11, trip_id: 2 }));

    const { reservations } = await reservationsApi.list(1);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      id: 10,
      day_number: 2,
      place_name: 'Louvre',
      accommodation_place_id: null,
      accommodation_name: null,
    });
    expect(reservations[0].travelers).toEqual([
      expect.objectContaining({ user_id: 1, username: 'Me' }),
    ]);
  });

  it('LOCAL-RES-002 — orders by reservation_time then created_at, nulls first like SQLite', async () => {
    await seedTrip();
    await db.reservations.put(storedReservation({ id: 12, trip_id: 1, reservation_time: '2025-06-02T10:00' }));
    await db.reservations.put(storedReservation({ id: 13, trip_id: 1, reservation_time: null, created_at: '2025-01-02T00:00:00.000Z' }));
    await db.reservations.put(storedReservation({ id: 14, trip_id: 1, reservation_time: null, created_at: '2025-01-01T00:00:00.000Z' }));

    const { reservations } = await reservationsApi.list(1);
    expect(reservations.map((r) => r.id)).toEqual([14, 13, 12]);
  });

  it('LOCAL-RES-003 — an unknown trip is the access guard’s 404', async () => {
    await expect(reservationsApi.list(404)).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Trip not found' } },
    });
  });
});

describe('reservationsApi.create', () => {
  it('LOCAL-RES-010 — writes the row and answers {reservation} with no side channels', async () => {
    await seedTrip();
    const result = await reservationsApi.create(1, { title: 'Museum', type: 'event' });
    expect(result.reservation).toMatchObject({ trip_id: 1, title: 'Museum', type: 'event' });
    expect(result.accommodationPing).toBeNull();
    expect(result.assignment).toBeNull();
    expect(result.budgetEvents).toEqual([]);
    expect(await db.reservations.get(result.reservation.id)).toMatchObject({ title: 'Museum' });
  });

  it('LOCAL-RES-011 — the contract’s 400: no title, wrong value types', async () => {
    await seedTrip();
    await expect(reservationsApi.create(1, {} as never)).rejects.toMatchObject({
      status: 400,
      response: { data: { error: expect.any(String) } },
    });
    await expect(reservationsApi.create(1, { title: 5 } as never)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('LOCAL-RES-012 — foreign refs 400 Not-part-of before unknown refs 400 Unknown-reference', async () => {
    await seedTrip();
    await db.trips.put(buildTrip({ id: 2 }));
    await db.days.put({ vias: [], ...buildDay({ id: 9, trip_id: 2, day_number: 1 }) } as DayRow);

    await expect(reservationsApi.create(1, { title: 'x', day_id: 9 })).rejects.toMatchObject({
      status: 400,
      response: { data: { error: 'Not part of this trip: day_id' } },
    });
    await expect(reservationsApi.create(1, { title: 'x', day_id: 999 })).rejects.toMatchObject({
      status: 400,
      response: { data: { error: 'Unknown reference: day_id' } },
    });
  });

  it('LOCAL-RES-013 — flight endpoints persist on the row, coordinate-less rows skipped', async () => {
    await seedTrip();
    const { reservation } = await reservationsApi.create(1, {
      title: 'LH 400',
      type: 'flight',
      endpoints: [
        { role: 'from', sequence: 0, name: 'Frankfurt (FRA)', code: 'FRA', lat: 50.03, lng: 8.57, timezone: 'Europe/Berlin', local_time: '10:00', local_date: '2025-06-01' },
        { role: 'to', sequence: 1, name: 'Nowhere', code: null, lat: null, lng: null, timezone: null, local_time: null, local_date: null },
      ],
    } as never);
    const row = (await db.reservations.get(reservation.id)) as ReservationRow;
    expect(row.endpoints).toHaveLength(1);
    expect(row.endpoints![0]).toMatchObject({ role: 'from', code: 'FRA', sequence: 0 });
    // …and the wire join hands them back ordered by sequence.
    const { reservations } = await reservationsApi.list(1);
    expect(reservations[0].endpoints).toHaveLength(1);
  });

  it('LOCAL-RES-014 — a multi-night hotel seats every night up to check-out', async () => {
    await seedTrip();
    await seedDay(1, 1);
    await seedDay(2, 2);
    await seedDay(3, 3);
    await db.places.put(buildPlace({ id: 5, trip_id: 1, name: 'Hotel' }));

    const result = await reservationsApi.create(1, {
      title: 'Hotel',
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 1, end_day_id: 3, check_in: '15:00' },
    });
    const stayId = Number(result.reservation.accommodation_id);
    expect(stayId).toBeGreaterThan(0);
    expect(await seatsOf(stayId)).toEqual([
      { dayId: 1, id: expect.any(Number) as number },
      { dayId: 2, id: expect.any(Number) as number },
    ]);
    // Two seats came down at once — the wire fans them out as a list.
    expect(Array.isArray(result.assignment)).toBe(true);
    expect((result.assignment as { day_id: number }[]).map((a) => a.day_id).sort()).toEqual([1, 2]);
    expect(result.accommodationPing).toBe('created');
    // The stay row landed with the verbatim columns.
    expect(await db.accommodations.get(stayId)).toMatchObject({
      trip_id: 1, place_id: 5, start_day_id: 1, end_day_id: 3, check_in: '15:00',
    });
  });

  it('LOCAL-RES-015 — create_budget_entry writes the linked item and its budget:created event', async () => {
    await seedTrip();
    const result = await reservationsApi.create(1, {
      title: 'Flight',
      type: 'flight',
      create_budget_entry: { total_price: 320, category: 'transport' },
    });
    const item = (await db.budgetItems.toArray())[0];
    expect(item).toMatchObject({ trip_id: 1, reservation_id: result.reservation.id, total_price: 320 });
    expect(result.budgetEvents.map((e) => e.event)).toEqual(['budget:created']);
    expect(result.budgetEvents[0].item).toMatchObject({ id: item.id, total_price: 320 });
  });
});

describe('reservationsApi.update', () => {
  it('LOCAL-RES-020 — merges fields, keeps what the body never named', async () => {
    await seedTrip();
    await db.reservations.put(storedReservation({ id: 20, trip_id: 1, title: 'Old', notes: 'keep', location: 'Paris' }));

    const { reservation } = await reservationsApi.update(1, 20, { title: 'New', location: '' });
    expect(reservation).toMatchObject({ id: 20, title: 'New', notes: 'keep', location: null });
  });

  it('LOCAL-RES-021 — missing row is the controller’s 404, verbatim', async () => {
    await seedTrip();
    await expect(reservationsApi.update(1, 404, { title: 'x' })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Reservation not found' } },
    });
  });

  it('LOCAL-RES-022 — replacing endpoints drops the old rows', async () => {
    await seedTrip();
    const { reservation } = await reservationsApi.create(1, {
      title: 'LH 400',
      type: 'flight',
      endpoints: [
        { role: 'from', sequence: 0, name: 'FRA', code: 'FRA', lat: 1, lng: 1, timezone: null, local_time: null, local_date: null },
        { role: 'to', sequence: 1, name: 'JFK', code: 'JFK', lat: 2, lng: 2, timezone: null, local_time: null, local_date: null },
      ],
    } as never);
    await reservationsApi.update(1, reservation.id, {
      endpoints: [
        { role: 'from', sequence: 0, name: 'MUC', code: 'MUC', lat: 3, lng: 3, timezone: null, local_time: null, local_date: null },
      ],
    } as never);
    const row = (await db.reservations.get(reservation.id)) as ReservationRow;
    expect(row.endpoints!.map((e) => e.code)).toEqual(['MUC']);
  });

  it('LOCAL-RES-023 — shortening the hotel stay re-seats the lost night', async () => {
    await seedTrip();
    await seedDay(1, 1);
    await seedDay(2, 2);
    await seedDay(3, 3);
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }));
    const created = await reservationsApi.create(1, {
      title: 'Hotel',
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 1, end_day_id: 3, check_in: '15:00' },
    });
    const stayId = Number(created.reservation.accommodation_id);
    expect(await seatsOf(stayId)).toHaveLength(2);

    const result = await reservationsApi.update(1, created.reservation.id, {
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 1, end_day_id: 2, check_in: '15:00' },
    });
    expect(await seatsOf(stayId)).toEqual([{ dayId: 1, id: expect.any(Number) as number }]);
    expect(result.removedAssignments).toHaveLength(1);
    expect(result.accommodationPing).toBe('updated');
    expect(await db.accommodations.get(stayId)).toMatchObject({ end_day_id: 2 });
  });
});

describe('reservationsApi.delete', () => {
  it('LOCAL-RES-030 — the row and its junctions go; other trips’ rows stay', async () => {
    await seedTrip();
    await db.reservations.put(storedReservation({ id: 30, trip_id: 1 }));
    await db.reservationTravelers.put({ id: 1, reservation_id: 30, user_id: 1 });
    await db.trips.put(buildTrip({ id: 2 }));
    await db.reservations.put(storedReservation({ id: 31, trip_id: 2 }));

    const result = await reservationsApi.delete(1, 30);
    expect(result.success).toBe(true);
    expect(await db.reservations.get(30)).toBeUndefined();
    expect(await db.reservationTravelers.where('reservation_id').equals(30).count()).toBe(0);
    expect(await db.reservations.get(31)).toBeDefined();
  });

  it('LOCAL-RES-031 — cascades the owned stay, its seats and the linked cost', async () => {
    await seedTrip();
    await seedDay(1, 1);
    await seedDay(2, 2);
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }));
    const created = await reservationsApi.create(1, {
      title: 'Hotel',
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 1, end_day_id: 2, check_in: '15:00' },
      create_budget_entry: { total_price: 200, category: 'accommodation' },
    });
    const stayId = Number(created.reservation.accommodation_id);
    const budgetId = (await db.budgetItems.toArray())[0].id;

    const result = await reservationsApi.delete(1, created.reservation.id);
    expect(result.deletedAccommodationId).toBe(stayId);
    expect(result.deletedBudgetItemId).toBe(budgetId);
    expect(await db.accommodations.get(stayId)).toBeUndefined();
    expect(await db.budgetItems.get(budgetId)).toBeUndefined();
    expect(await seatsOf(stayId)).toEqual([]);
    expect(result.removedAssignments).toHaveLength(1);
  });

  it('LOCAL-RES-032 — missing row is the 404, not a silent success', async () => {
    await seedTrip();
    await expect(reservationsApi.delete(1, 404)).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Reservation not found' } },
    });
  });
});

describe('reservationsApi.setTravelers', () => {
  it('LOCAL-RES-040 — rebuilds the junction, roster-filtered, and answers the joined row', async () => {
    await seedTrip();
    await db.localUsers.put({ id: 2, name: 'bob', is_self: 0 });
    await seedMember(2, 'bob');
    await db.reservations.put(storedReservation({ id: 40, trip_id: 1 }));

    const { travelers, reservation } = await reservationsApi.setTravelers(1, 40, [1, 2, 99]);
    // 1 is the trip owner, 2 a member — 99 is off-roster and drops silently.
    expect(travelers.map((t) => t.user_id).sort()).toEqual([1, 2]);
    expect(reservation.travelers).toEqual(travelers);
    const rows = await db.reservationTravelers.where('reservation_id').equals(40).toArray();
    expect(rows.map((r) => r.user_id).sort()).toEqual([1, 2]);
  });

  it('LOCAL-RES-041 — an empty list clears the junction', async () => {
    await seedTrip();
    await db.reservations.put(storedReservation({ id: 41, trip_id: 1 }));
    await db.reservationTravelers.put({ id: 1, reservation_id: 41, user_id: 1 });

    const { travelers } = await reservationsApi.setTravelers(1, 41, []);
    expect(travelers).toEqual([]);
    expect(await db.reservationTravelers.where('reservation_id').equals(41).count()).toBe(0);
  });

  it('LOCAL-RES-042 — missing booking is the 404', async () => {
    await seedTrip();
    await expect(reservationsApi.setTravelers(1, 404, [1])).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Reservation not found' } },
    });
  });
});

describe('reservationsApi.updatePositions', () => {
  it('LOCAL-RES-050 — a dayId writes the per-day position map, without it the global column', async () => {
    await seedTrip();
    await seedDay(3, 3);
    await db.reservations.put(storedReservation({ id: 50, trip_id: 1 }));
    await db.reservations.put(storedReservation({ id: 51, trip_id: 1 }));

    await reservationsApi.updatePositions(1, [{ id: 50, day_plan_position: 2 }], 3);
    let row = (await db.reservations.get(50)) as ReservationRow;
    expect(row.day_positions).toEqual({ '3': 2 });
    expect(row.day_plan_position ?? null).toBeNull();

    await reservationsApi.updatePositions(1, [{ id: 51, day_plan_position: 7 }]);
    row = (await db.reservations.get(51)) as ReservationRow;
    expect(row.day_plan_position).toBe(7);
  });

  it('LOCAL-RES-051 — foreign-trip and missing ids are the server’s quiet no-op', async () => {
    await seedTrip();
    await seedDay(3, 3);
    await db.trips.put(buildTrip({ id: 2 }));
    await db.reservations.put(storedReservation({ id: 52, trip_id: 2 }));

    await expect(
      reservationsApi.updatePositions(1, [{ id: 52, day_plan_position: 1 }, { id: 999, day_plan_position: 1 }], 3),
    ).resolves.toEqual({ success: true });
    const row = (await db.reservations.get(52)) as ReservationRow;
    expect(row.day_positions ?? null).toBeNull();
  });
});

describe('backfillFlightEndpoints', () => {
  const flight = (over: Partial<Reservation>): ReservationRow =>
    storedReservation({ type: 'flight', ingest_state: 'live', ...over });

  it('LOCAL-RES-060 — resolves metadata IATAs into from/to endpoints', async () => {
    await seedTrip();
    await db.reservations.put(flight({
      id: 60, trip_id: 1,
      metadata: JSON.stringify({ departure_airport: 'FRA', arrival_airport: 'JFK' }),
      reservation_time: '2025-06-01T10:00',
      reservation_end_time: '2025-06-01T13:30',
    }));

    await backfillFlightEndpoints();

    const row = (await db.reservations.get(60)) as ReservationRow;
    expect(row.needs_review ?? 0).toBe(0);
    expect(row.endpoints).toHaveLength(2);
    expect(row.endpoints![0]).toMatchObject({ role: 'from', code: 'FRA', sequence: 0, local_time: '10:00', local_date: '2025-06-01' });
    expect(row.endpoints![1]).toMatchObject({ role: 'to', code: 'JFK', sequence: 1, local_time: '13:30' });
  });

  it('LOCAL-RES-061 — unresolvable or malformed metadata flags needs_review', async () => {
    await seedTrip();
    await db.reservations.put(flight({
      id: 61, trip_id: 1,
      metadata: JSON.stringify({ departure_airport: 'XXX', arrival_airport: 'YYY' }),
    }));
    await db.reservations.put(flight({ id: 62, trip_id: 1, metadata: '{not json' }));
    await db.reservations.put(flight({ id: 63, trip_id: 1, metadata: null }));

    await backfillFlightEndpoints();

    for (const id of [61, 62, 63]) {
      expect((await db.reservations.get(id))!.needs_review).toBe(1);
    }
    expect(((await db.reservations.get(61)) as ReservationRow).endpoints).toEqual([]);
  });

  it('LOCAL-RES-062 — a flight that already has endpoints is left alone', async () => {
    await seedTrip();
    await db.reservations.put({
      ...flight({
        id: 64, trip_id: 1,
        metadata: JSON.stringify({ departure_airport: 'FRA', arrival_airport: 'JFK' }),
      }),
      endpoints: [{ id: 1, reservation_id: 64, role: 'from', sequence: 0, name: 'Frankfurt (FRA)', code: 'FRA', lat: 50, lng: 8, timezone: null, local_time: null, local_date: null }],
    } as ReservationRow);

    await backfillFlightEndpoints();

    const row = (await db.reservations.get(64)) as ReservationRow;
    expect(row.endpoints).toHaveLength(1);
    expect(row.needs_review ?? 0).toBe(0);
  });
});
