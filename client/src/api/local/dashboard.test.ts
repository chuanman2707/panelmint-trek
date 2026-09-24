/**
 * Tests for `dashboardApi` — the local Dexie feed that replaced
 * GET /api/auth/travel-stats and GET /api/reservations/upcoming. Pins the
 * server's semantics on the real database: counts over every trip (archived
 * included), flight-distance haversine over ordered endpoints, hotels out of
 * the upcoming list, check-in/check-out minted from stays, and the local
 * wall-clock "today" edge.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dashboardApi } from './dashboard';
import { db } from '../../db/panelmintDb';
import { buildTrip, buildDay, buildPlace, buildReservation } from '../../../tests/helpers/factories';
import type { Accommodation } from '../../types';

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
}

function stay(overrides: Partial<Accommodation> = {}): Accommodation {
  return {
    id: 1,
    trip_id: 1,
    place_id: null,
    start_day_id: 1,
    end_day_id: 2,
    check_in: '15:00',
    check_out: '11:00',
    confirmation: null,
    notes: null,
    ...overrides,
  } as Accommodation;
}

beforeEach(resetDb);
afterEach(() => vi.useRealTimers());

describe('dashboardApi.travelStats', () => {
  it('FE-LOCAL-DASH-001: counts every trip, day and place — archived trips included', async () => {
    await db.trips.bulkPut([
      buildTrip({ id: 1 }),
      buildTrip({ id: 2, is_archived: 1 }),
    ]);
    await db.days.bulkPut([buildDay({ id: 1, trip_id: 1 }), buildDay({ id: 2, trip_id: 2 })]);
    await db.places.bulkPut([buildPlace({ id: 1, trip_id: 1 })]);

    const stats = await dashboardApi.travelStats();
    expect(stats).toMatchObject({ totalTrips: 2, totalDays: 2, totalPlaces: 1, countries: [] });
  });

  it('FE-LOCAL-DASH-002: flight distance sums consecutive endpoints of non-cancelled flights', async () => {
    // Berlin → Dresden (~165 km) → Prague (~118 km) on one booking, plus a
    // cancelled flight that must not count.
    await db.trips.put(buildTrip({ id: 1 }));
    await db.reservations.bulkPut([
      buildReservation({
        id: 1, trip_id: 1, type: 'flight', status: 'confirmed',
        endpoints: [
          { role: 'from', name: 'BER', sequence: 0, lat: 52.3667, lng: 13.5033, code: null, timezone: null, local_time: null, local_date: null },
          { role: 'stop', name: 'DRS', sequence: 1, lat: 51.0504, lng: 13.7373, code: null, timezone: null, local_time: null, local_date: null },
          { role: 'to', name: 'PRG', sequence: 2, lat: 50.1008, lng: 14.26, code: null, timezone: null, local_time: null, local_date: null },
        ],
      }),
      buildReservation({
        id: 2, trip_id: 1, type: 'flight', status: 'cancelled',
        endpoints: [
          { role: 'from', name: 'A', sequence: 0, lat: 0, lng: 0, code: null, timezone: null, local_time: null, local_date: null },
          { role: 'to', name: 'B', sequence: 1, lat: 40, lng: 40, code: null, timezone: null, local_time: null, local_date: null },
        ],
      }),
    ]);

    const stats = await dashboardApi.travelStats();
    // ~165 + ~118 ≈ 283 km, rounded.
    expect(stats.totalDistanceKm).toBeGreaterThan(250);
    expect(stats.totalDistanceKm).toBeLessThan(320);
  });

  it('FE-LOCAL-DASH-003: a flight naming only a guest does not count toward self', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    await db.reservations.put(buildReservation({
      id: 1, trip_id: 1, type: 'flight', status: 'confirmed',
      endpoints: [
        { role: 'from', name: 'BER', sequence: 0, lat: 52.3667, lng: 13.5033, code: null, timezone: null, local_time: null, local_date: null },
        { role: 'to', name: 'PRG', sequence: 1, lat: 50.1008, lng: 14.26, code: null, timezone: null, local_time: null, local_date: null },
      ],
    }));
    await db.reservationTravelers.put({ id: 1, reservation_id: 1, user_id: 99 });

    const stats = await dashboardApi.travelStats();
    expect(stats.totalDistanceKm).toBe(0);

    // …and an unassigned booking still counts (the pre-4.0 data shape).
    await db.reservationTravelers.clear();
    expect((await dashboardApi.travelStats()).totalDistanceKm).toBeGreaterThan(200);
  });
});

describe('dashboardApi.upcoming', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-05T12:00:00'));
  });

  it('FE-LOCAL-DASH-010: lists dated reservations soonest first, skipping cancelled, hotels and archived trips', async () => {
    await db.trips.bulkPut([
      buildTrip({ id: 1, title: 'Paris Adventure' }),
      buildTrip({ id: 2, title: 'Old Rome', is_archived: 1 }),
    ]);
    await db.reservations.bulkPut([
      buildReservation({ id: 1, trip_id: 1, title: 'Late show', type: 'ticket', reservation_time: '2026-07-20T20:00:00' }),
      buildReservation({ id: 2, trip_id: 1, title: 'Louvre', type: 'ticket', reservation_time: '2026-07-10T10:00:00', location: 'Paris' }),
      buildReservation({ id: 3, trip_id: 1, title: 'Cancelled', type: 'ticket', status: 'cancelled', reservation_time: '2026-07-08T10:00:00' }),
      buildReservation({ id: 4, trip_id: 1, title: 'Hotel Ibis', type: 'hotel', reservation_time: '2026-07-09T15:00:00' }),
      buildReservation({ id: 5, trip_id: 2, title: 'Archived trip booking', type: 'ticket', reservation_time: '2026-07-08T10:00:00' }),
      buildReservation({ id: 6, trip_id: 1, title: 'Yesterday', type: 'ticket', reservation_time: '2026-07-01T10:00:00' }),
    ]);

    const { reservations } = await dashboardApi.upcoming();
    expect(reservations.map(r => r.title)).toEqual(['Louvre', 'Late show']);
    expect(reservations[0]).toMatchObject({ trip_title: 'Paris Adventure', location: 'Paris' });
  });

  it('FE-LOCAL-DASH-011: a timeless reservation follows its day date', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Paris Adventure' }));
    await db.days.bulkPut([
      buildDay({ id: 1, trip_id: 1, date: '2026-07-12' }),
      buildDay({ id: 2, trip_id: 1, date: '2026-07-01' }),
    ]);
    await db.reservations.bulkPut([
      buildReservation({ id: 1, trip_id: 1, title: 'Day booking', type: 'ticket', day_id: 1, reservation_time: null }),
      buildReservation({ id: 2, trip_id: 1, title: 'Past day booking', type: 'ticket', day_id: 2, reservation_time: null }),
      buildReservation({ id: 3, trip_id: 1, title: 'Undated entirely', type: 'ticket', day_id: null, reservation_time: null }),
    ]);

    const { reservations } = await dashboardApi.upcoming();
    expect(reservations.map(r => r.title)).toEqual(['Day booking']);
    expect(reservations[0].day_date).toBe('2026-07-12');
  });

  it('FE-LOCAL-DASH-012: a stay produces check-in and check-out moments', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Paris Adventure' }));
    await db.days.bulkPut([
      buildDay({ id: 1, trip_id: 1, date: '2026-07-10' }),
      buildDay({ id: 2, trip_id: 1, date: '2026-07-14' }),
    ]);
    const place = buildPlace({ id: 9, trip_id: 1, name: 'The Plaza' });
    await db.places.put(place);
    await db.accommodations.put(stay({ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 2 }));

    const { reservations } = await dashboardApi.upcoming();
    expect(reservations.map(r => r.type)).toEqual(['checkin', 'checkout']);
    expect(reservations[0]).toMatchObject({ id: 7, title: 'The Plaza', day_date: '2026-07-10', reservation_time: '2026-07-10T15:00' });
    expect(reservations[1]).toMatchObject({ id: 7, day_date: '2026-07-14', reservation_time: '2026-07-14T11:00' });
  });

  it('FE-LOCAL-DASH-013: same-day entries still count when their time has not passed', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Paris Adventure' }));
    await db.days.put(buildDay({ id: 1, trip_id: 1, date: '2026-07-05' }));
    await db.reservations.bulkPut([
      buildReservation({ id: 1, trip_id: 1, title: 'Evening show', type: 'ticket', reservation_time: '2026-07-05T20:30:00' }),
      buildReservation({ id: 2, trip_id: 1, title: 'Morning museum', type: 'ticket', reservation_time: '2026-07-05T08:00:00' }),
      // A day-linked row with no clock time counts as still upcoming — the
      // '23:59' same-day edge the server's COALESCE(at_time, '23:59') had.
      buildReservation({ id: 3, trip_id: 1, title: 'All day', type: 'ticket', day_id: 1, reservation_time: null }),
    ]);

    const { reservations } = await dashboardApi.upcoming();
    // The 08:00 entry is already past (fake now is 12:00); the timeless one
    // sorts first at 00:00 but still counts under the same-day rule.
    expect(reservations.map(r => r.title)).toEqual(['All day', 'Evening show']);
  });

  it('FE-LOCAL-DASH-014: the limit holds at six', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    await db.reservations.bulkPut(
      Array.from({ length: 9 }, (_, i) =>
        buildReservation({ id: i + 1, trip_id: 1, title: `R${i}`, type: 'ticket', reservation_time: `2026-08-0${i + 1}T10:00:00` })),
    );

    const { reservations } = await dashboardApi.upcoming();
    expect(reservations).toHaveLength(6);
    expect(reservations.map(r => r.title)).toEqual(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
  });
});
