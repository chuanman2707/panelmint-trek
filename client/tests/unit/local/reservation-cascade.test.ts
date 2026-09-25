/**
 * Parity tests for the ported reservation cascade.
 *
 * Source fixtures: server/tests/unit/nest/reservations.service.test.ts pins
 * keepMirroredPrice, the hotel auto-accommodation write, endpoint replacement
 * (coordinate-less rows skipped), the foreign-trip guards, the COALESCE update
 * semantics, and the remove() cascade ordering. The guards and pure helpers run
 * bare; the cascade runs over the MemoryStore seam.
 */
import { describe, expect, it } from 'vitest';
import {
  createReservation,
  keepMirroredPrice,
  referencesOutsideTrip,
  removeReservation,
  resolveDayIdFromTime,
  resyncReservationDays,
  syncBudgetOnCreate,
  syncBudgetOnUpdate,
  unresolvedReferences,
  updateReservation,
} from '../../../src/api/local/ported/reservation-cascade';
import { MemoryStore, type MemReservation } from './helpers/memoryStore';

const res = (over: Partial<MemReservation>): MemReservation => ({
  id: 1,
  trip_id: 1,
  day_id: null,
  end_day_id: null,
  place_id: null,
  assignment_id: null,
  title: 'r',
  reservation_time: null,
  reservation_end_time: null,
  location: null,
  confirmation_number: null,
  notes: null,
  url: null,
  status: 'pending',
  type: 'other',
  accommodation_id: null,
  metadata: null,
  needs_review: 0,
  ...over,
});

describe('keepMirroredPrice', () => {
  const stored = JSON.stringify({ price: 120, priceCurrency: 'EUR', other: 'x' });

  it('keeps the stored price when the incoming metadata does not name it', () => {
    expect(keepMirroredPrice({ other: 'y' }, stored)).toEqual({ other: 'y', price: 120, priceCurrency: 'EUR' });
  });
  it('a named price wins outright — even null', () => {
    expect(keepMirroredPrice({ price: null }, stored)).toEqual({ price: null });
    expect(keepMirroredPrice({ price: 50 }, stored)).toEqual({ price: 50 });
  });
  it('undefined leaves the row alone (caller decides)', () => {
    expect(keepMirroredPrice(undefined, stored)).toBeUndefined();
  });
  it('null clears the column', () => {
    expect(keepMirroredPrice(null, stored)).toBeNull();
  });
  it('non-objects pass through untouched', () => {
    expect(keepMirroredPrice('str', stored)).toBe('str');
    expect(keepMirroredPrice([1], stored)).toEqual([1]);
  });
  it('no stored metadata → nothing to keep', () => {
    expect(keepMirroredPrice({ a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe('trip-scope guards', () => {
  const store = new MemoryStore({
    days: [
      { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
      { id: 9, trip_id: 2, day_number: 1, date: '2026-03-01' },
    ],
    places: [
      { id: 5, trip_id: 1, name: 'p', lat: 1, lng: 1 },
      { id: 6, trip_id: 2, name: 'q', lat: 1, lng: 1 },
    ],
    accommodations: [{ id: 7, trip_id: 1, place_id: 5, start_day_id: 1, end_day_id: 1, check_in: null }],
    assignments: [
      {
        id: 3,
        day_id: 1,
        place_id: 5,
        order_index: 0,
        assignment_time: null,
        assignment_end_time: null,
        accommodation_id: null,
      },
    ],
  });

  it('names refs that point at ANOTHER trip', () => {
    expect(referencesOutsideTrip(store, 1, { title: 'x', day_id: 9, place_id: 6 })).toEqual(['day_id', 'place_id']);
  });
  it('a row that does not exist at all is not a foreign-trip offender', () => {
    expect(referencesOutsideTrip(store, 1, { title: 'x', day_id: 999 })).toEqual([]);
    expect(unresolvedReferences(store, 1, { title: 'x', day_id: 999 })).toEqual(['day_id']);
  });
  it('unresolvedReferences names refs that resolve to nothing on this trip', () => {
    expect(unresolvedReferences(store, 1, { title: 'x', day_id: 9, place_id: 5 })).toEqual(['day_id']);
    expect(unresolvedReferences(store, 1, { title: 'x', assignment_id: 3 })).toEqual([]);
  });
  it('create_accommodation refs are only validated for hotel bookings', () => {
    const data = { title: 'x', type: 'flight' as const, create_accommodation: { start_day_id: 999, end_day_id: 999 } };
    expect(unresolvedReferences(store, 1, data)).toEqual([]);
    const hotel = { ...data, type: 'hotel' as const };
    expect(unresolvedReferences(store, 1, hotel)).toEqual([
      'create_accommodation.start_day_id',
      'create_accommodation.end_day_id',
    ]);
  });
});

describe('resolveDayIdFromTime', () => {
  const store = new MemoryStore({
    days: [
      { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
      { id: 2, trip_id: 1, day_number: 2, date: '2026-03-05' },
    ],
  });

  it('matches the date part of an ISO timestamp', () => {
    expect(resolveDayIdFromTime(store, 1, '2026-03-01T18:30')).toBe(1);
  });
  it('clamps to the nearest day when no exact date exists', () => {
    // 2026-03-03 is equidistant? no — 2d from 03-01, 2d from 03-05 → earlier date wins.
    expect(resolveDayIdFromTime(store, 1, '2026-03-03T12:00')).toBe(1);
    expect(resolveDayIdFromTime(store, 1, '2026-03-04T12:00')).toBe(2);
  });
  it('a dateless day wins the nearest-day clamp — SQLite NULL-first (#889)', () => {
    // JULIANDAY(NULL) is NULL and NULL sorts first under ASC, so the server's
    // ORDER BY ABS(...) always landed on a dateless day before measuring any
    // real distance — even with a dated day a single day away.
    const withBlank = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-05' },
        { id: 3, trip_id: 1, day_number: 3, date: null },
        { id: 4, trip_id: 1, day_number: 4, date: null },
      ],
    });
    expect(resolveDayIdFromTime(withBlank, 1, '2026-03-04T12:00')).toBe(3);
    // …and two dateless days settle by id, the way SQLite's stable sort did.
    expect(withBlank.nearestDay(1, '2026-03-04')?.id).toBe(3);
  });
  it('returns null without clamping or a usable date part', () => {
    expect(resolveDayIdFromTime(store, 1, '2026-03-03', false)).toBeNull();
    expect(resolveDayIdFromTime(store, 1, 'not-a-date')).toBeNull();
    expect(resolveDayIdFromTime(store, 1, null)).toBeNull();
  });
});

describe('resyncReservationDays', () => {
  it('re-anchors bookings to the day matching their reservation_time', () => {
    const store = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
      ],
      reservations: [
        res({ id: 1, day_id: 1, reservation_time: '2026-03-02T10:00' }), // drifts to day 2
        res({ id: 2, day_id: 1, reservation_time: '2026-03-01T10:00' }), // stays
        res({ id: 3, day_id: 1, reservation_time: '2026-03-09T10:00' }), // outside → untouched
        res({ id: 4, day_id: 1, type: 'hotel', accommodation_id: 7, reservation_time: '2026-03-02T10:00' }), // hotel+linked → skipped
      ],
    });
    resyncReservationDays(store, 1);
    expect(store.reservations.find((r) => r.id === 1)!.day_id).toBe(2);
    expect(store.reservations.find((r) => r.id === 2)!.day_id).toBe(1);
    expect(store.reservations.find((r) => r.id === 3)!.day_id).toBe(1);
    expect(store.reservations.find((r) => r.id === 4)!.day_id).toBe(1);
  });
});

describe('createReservation', () => {
  it('derives day_id from reservation_time when the client did not set it', () => {
    const store = new MemoryStore({
      days: [{ id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' }],
    });
    const { reservation } = createReservation(store, 1, {
      title: 'Train',
      type: 'train',
      reservation_time: '2026-03-01T08:00',
    });
    expect(reservation.day_id).toBe(1);
  });

  it('hotel booking auto-creates the stay and mirrors its stop', () => {
    const store = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
      ],
      places: [{ id: 5, trip_id: 1, name: 'Hotel', lat: 1, lng: 1 }],
    });
    const { reservation, accommodationCreated, stayMirror } = createReservation(store, 1, {
      title: 'Hotel',
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 1, end_day_id: 2, check_in: '15:00' },
    });
    expect(accommodationCreated).toBe(true);
    expect(reservation.accommodation_id).not.toBeNull();
    expect(stayMirror.created).not.toBeNull();
    const acc = store.accommodations[0];
    expect(acc).toMatchObject({ place_id: 5, start_day_id: 1, end_day_id: 2, check_in: '15:00' });
  });

  it('a multi-night hotel seats every night up to check-out, not just check-in', () => {
    const store = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
        { id: 3, trip_id: 1, day_number: 3, date: '2026-03-03' },
      ],
      places: [{ id: 5, trip_id: 1, name: 'Hotel', lat: 1, lng: 1 }],
    });
    const { stayMirror } = createReservation(store, 1, {
      title: 'Hotel',
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 1, end_day_id: 3, check_in: '15:00' },
    });
    // Nights of day 1 and day 2 both get the booking-owned stop; day 3 is
    // check-out. The first seat is `created`, the rest ride `createdExtra`.
    expect(stayMirror.created?.day_id).toBe(1);
    expect(stayMirror.createdExtra.map((a) => a.day_id)).toEqual([2]);
    const accId = store.accommodations[0].id;
    expect(store.assignments.filter((a) => a.accommodation_id === accId).map((a) => a.day_id).sort())
      .toEqual([1, 2]);
  });

  it('a same-day stay keeps the single start-day seat', () => {
    const store = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
      ],
      places: [{ id: 5, trip_id: 1, name: 'Hotel', lat: 1, lng: 1 }],
    });
    createReservation(store, 1, {
      title: 'Hotel',
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 2, end_day_id: 2, check_in: '15:00' },
    });
    const accId = store.accommodations[0].id;
    expect(store.assignments.filter((a) => a.accommodation_id === accId).map((a) => a.day_id)).toEqual([2]);
  });

  it('replaces endpoints, skipping rows without coordinates', () => {
    const store = new MemoryStore({});
    createReservation(store, 1, {
      title: 'Flight',
      type: 'flight',
      endpoints: [
        {
          role: 'from',
          name: 'JFK',
          code: 'JFK',
          lat: 40.6,
          lng: -73.7,
          timezone: null,
          local_time: null,
          local_date: null,
        },
        {
          role: 'to',
          name: 'Nowhere',
          code: null,
          lat: null,
          lng: null,
          timezone: null,
          local_time: null,
          local_date: null,
        },
      ],
    });
    expect(store.endpoints).toHaveLength(1);
    expect(store.endpoints[0].role).toBe('from');
  });
});

describe('updateReservation', () => {
  it('undefined fields keep stored values; null clears', () => {
    const store = new MemoryStore({
      days: [{ id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' }],
      reservations: [res({ id: 1, title: 'Old', location: 'Paris', notes: 'keep me' })],
    });
    const current = store.getReservation(1, 1)! as never;
    updateReservation(store, 1, 1, { title: 'New', location: '' }, current);
    const r = store.reservations[0];
    expect(r.title).toBe('New');
    expect(r.location).toBeNull(); // '' → NULL
    expect(r.notes).toBe('keep me'); // untouched
  });

  it('a hotel update nulls out reservation_time and keeps the metadata price', () => {
    const store = new MemoryStore({
      days: [{ id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' }],
      reservations: [
        res({ id: 1, type: 'hotel', reservation_time: '2026-03-01T15:00', metadata: JSON.stringify({ price: 90 }) }),
      ],
    });
    const current = store.getReservation(1, 1)! as never;
    updateReservation(store, 1, 1, { notes: 'x' }, current);
    const r = store.reservations[0];
    expect(r.reservation_time).toBeNull();
    expect(JSON.parse(r.metadata!).price).toBe(90);
  });

  it('shortening a multi-night stay re-seats only the nights still covered', () => {
    const store = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
        { id: 3, trip_id: 1, day_number: 3, date: '2026-03-03' },
      ],
      places: [{ id: 5, trip_id: 1, name: 'Hotel', lat: 1, lng: 1 }],
      accommodations: [{ id: 7, trip_id: 1, place_id: 5, start_day_id: 1, end_day_id: 3, check_in: '15:00' }],
      assignments: [
        { id: 20, day_id: 1, place_id: 5, order_index: 0, assignment_time: null, assignment_end_time: null, accommodation_id: 7 },
        { id: 21, day_id: 2, place_id: 5, order_index: 0, assignment_time: null, assignment_end_time: null, accommodation_id: 7 },
      ],
      reservations: [res({ id: 1, type: 'hotel', accommodation_id: 7 })],
    });
    const current = store.getReservation(1, 1)! as never;
    // The stay shrinks [1,3) → [1,2): the night-2 seat goes back.
    const { stayMirror } = updateReservation(store, 1, 1, {
      type: 'hotel',
      create_accommodation: { place_id: 5, start_day_id: 1, end_day_id: 2, check_in: '15:00' },
    }, current);
    expect(stayMirror.removed).toEqual([{ id: 21, dayId: 2 }]);
    expect(store.assignments.find((a) => a.id === 21)).toBeUndefined();
    expect(store.assignments.find((a) => a.id === 20)?.accommodation_id).toBe(7);
    expect(store.accommodations[0].end_day_id).toBe(2);
  });
});

describe('removeReservation', () => {
  it('cascades stay → linked budget item → reservation, in one transaction', () => {
    const store = new MemoryStore({
      days: [{ id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' }],
      places: [{ id: 5, trip_id: 1, name: 'Hotel', lat: 1, lng: 1 }],
      accommodations: [{ id: 7, trip_id: 1, place_id: 5, start_day_id: 1, end_day_id: 1, check_in: null }],
      assignments: [
        {
          id: 20,
          day_id: 1,
          place_id: 5,
          order_index: 0,
          assignment_time: null,
          assignment_end_time: null,
          accommodation_id: 7,
        },
      ],
      reservations: [res({ id: 1, type: 'hotel', accommodation_id: 7 })],
      budgetItems: [{ id: 42, trip_id: 1, reservation_id: 1, name: 'Hotel', category: 'hotel', total_price: 100 }],
    });
    const out = removeReservation(store, 1, 1);
    expect(out.accommodationDeleted).toBe(true);
    expect(out.deletedBudgetItemId).toBe(42);
    expect(out.stayMirror.removed).toEqual([{ id: 20, dayId: 1 }]);
    expect(store.accommodations).toHaveLength(0);
    expect(store.budgetItems).toHaveLength(0);
    expect(store.reservations).toHaveLength(0);
  });

  it('does not follow a foreign accommodation_id', () => {
    const store = new MemoryStore({
      accommodations: [{ id: 7, trip_id: 2, place_id: null, start_day_id: 1, end_day_id: 1, check_in: null }],
      reservations: [res({ id: 1, type: 'hotel', accommodation_id: 7 })],
    });
    const out = removeReservation(store, 1, 1);
    expect(out.accommodationDeleted).toBe(false);
    expect(store.accommodations).toHaveLength(1); // the other trip's stay survives
  });
});

describe('budget sync helpers', () => {
  it('syncBudgetOnCreate writes a linked item only when a positive price is given', () => {
    const store = new MemoryStore({});
    expect(syncBudgetOnCreate(store, 1, 9, 'Flight', 'flight', { total_price: 0 })).toEqual([]);
    const events = syncBudgetOnCreate(store, 1, 9, 'Flight', 'flight', { total_price: 120 });
    expect(events).toHaveLength(1);
    expect(store.budgetItems[0]).toMatchObject({ reservation_id: 9, total_price: 120, category: 'flight' });
  });

  it('syncBudgetOnUpdate drops the linked item when the price is cleared', () => {
    const store = new MemoryStore({
      budgetItems: [{ id: 42, trip_id: 1, reservation_id: 9, name: 'F', category: 'flight', total_price: 120 }],
    });
    const events = syncBudgetOnUpdate(store, 1, 9, undefined, undefined, 'F', 'flight', { total_price: 0 });
    expect(events.map((e) => e.event)).toEqual(['budget:deleted']);
    expect(store.budgetItems).toHaveLength(0);
  });

  it('keeps an auto-derived category in sync when the booking type changes', () => {
    const store = new MemoryStore({
      budgetItems: [{ id: 42, trip_id: 1, reservation_id: 9, name: 'F', category: 'flights', total_price: 120 }],
    });
    // typeToCostCategory('flight') = 'flights' — still the auto-derived category,
    // so retyping to 'hotel' moves it to 'accommodation'.
    syncBudgetOnUpdate(store, 1, 9, undefined, 'hotel', 'F', 'flight', undefined);
    expect(store.budgetItems[0].category).toBe('accommodation');
  });

  it('leaves a manually-chosen category alone on a type change', () => {
    const store = new MemoryStore({
      budgetItems: [{ id: 42, trip_id: 1, reservation_id: 9, name: 'F', category: 'food', total_price: 120 }],
    });
    syncBudgetOnUpdate(store, 1, 9, undefined, 'hotel', 'F', 'flight', undefined);
    expect(store.budgetItems[0].category).toBe('food');
  });
});

describe.todo('reservation cascade under real Dexie persistence', () => {
  // Transaction rollback across the multi-table write, the getReservation
  // read-model join shape, and the websocket→store-event dispatch all need the
  // repo adapter over offlineDb.
});
