/**
 * Parity tests for the ported day operations.
 *
 * Source fixtures: server/tests/unit/nest/days.service.test.ts and the days
 * integration tests pin UTC date arithmetic, slot-pinned dates on reorder,
 * two-phase negative renumbering, the reservation restamp (date part moves,
 * time-of-day preserved), inverted-stay refusal, and dateless vs dated insert.
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertNoInvertedAccommodation,
  dayDelta,
  DayReorderError,
  insertDay,
  reorderDays,
  restampReservationDates,
  resyncAccommodationDays,
  withDatePart,
} from '../../../src/api/local/ported/day-ops';
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

describe('UTC date helpers', () => {
  it('addDays never leaves UTC (month/year boundaries included)', () => {
    expect(addDays('2026-03-01', 1)).toBe('2026-03-02');
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
  });
  it('dayDelta counts whole UTC days', () => {
    expect(dayDelta('2026-03-01', '2026-03-05')).toBe(4);
    expect(dayDelta('2026-03-05', '2026-03-01')).toBe(-4);
  });
  it('withDatePart keeps the time suffix', () => {
    expect(withDatePart('2026-03-01T18:30', '2026-03-05')).toBe('2026-03-05T18:30');
    expect(withDatePart('2026-03-01', '2026-03-05')).toBe('2026-03-05');
  });
});

describe('reorderDays', () => {
  const store = () =>
    new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
        { id: 3, trip_id: 1, day_number: 3, date: '2026-03-03' },
      ],
      reservations: [res({ id: 10, day_id: 3, reservation_time: '2026-03-03T18:30' })],
    });

  it('rejects anything that is not a full permutation of the trip days', () => {
    expect(() => reorderDays(store(), 1, [1, 2])).toThrow(DayReorderError);
    expect(() => reorderDays(store(), 1, [1, 2, 99])).toThrow(DayReorderError);
  });

  it('dates stay pinned to slots — reordered days take the slot’s date', () => {
    const s = store();
    const days = reorderDays(s, 1, [3, 1, 2]);
    // Position 1 keeps '2026-03-01', position 2 '2026-03-02', etc.
    expect(days.map((d) => [d.id, d.day_number, d.date])).toEqual([
      [3, 1, '2026-03-01'],
      [1, 2, '2026-03-02'],
      [2, 3, '2026-03-03'],
    ]);
  });

  it('restamps reservation dates on re-dated days, preserving the time', () => {
    const s = store();
    reorderDays(s, 1, [3, 1, 2]);
    // Day 3 moved from 2026-03-03 to slot 1 → 2026-03-01.
    expect(s.reservations.find((r) => r.id === 10)!.reservation_time).toBe('2026-03-01T18:30');
  });

  it('refuses a reorder that would invert a stay', () => {
    const s = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
      ],
      accommodations: [{ id: 7, trip_id: 1, place_id: null, start_day_id: 1, end_day_id: 2, check_in: null }],
    });
    // Swapping days puts the stay's start (day 1) after its end (day 2 → slot 1).
    expect(() => reorderDays(s, 1, [2, 1])).toThrow(DayReorderError);
  });
});

describe('insertDay', () => {
  it('appends a null-dated row on a dateless trip, shifting in place', () => {
    const s = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: null },
        { id: 2, trip_id: 1, day_number: 2, date: null },
        { id: 3, trip_id: 1, day_number: 3, date: null },
      ],
    });
    const { dayId, days } = insertDay(s, 1, 2);
    expect(days.map((d) => d.id)).toEqual([1, dayId, 2, 3]);
    expect(days.map((d) => d.day_number)).toEqual([1, 2, 3, 4]);
    // The shifted rows kept their ids — the negative renumber resolved back.
    expect(s.days.find((d) => d.id === 2)!.day_number).toBe(3);
  });

  it('a dated trip gains one calendar day and extends end_date', () => {
    const s = new MemoryStore({
      trips: [{ id: 1, start_date: '2026-03-01', end_date: '2026-03-02' }],
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-03-01' },
        { id: 2, trip_id: 1, day_number: 2, date: '2026-03-02' },
      ],
      reservations: [res({ id: 10, day_id: 2, reservation_time: '2026-03-02T10:00' })],
    });
    const { days } = insertDay(s, 1, 2); // insert between day 1 and day 2
    expect(days).toHaveLength(3);
    expect(days.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(s.trips[0].end_date).toBe('2026-03-03');
    // Day 2 shifted to slot 3 → its booking restamps to 03-03.
    expect(s.reservations[0].reservation_time).toBe('2026-03-03T10:00');
  });
});

describe('restampReservationDates', () => {
  it('shifts transport endpoint local_dates by the same day delta', () => {
    const s = new MemoryStore({
      days: [{ id: 1, trip_id: 1, day_number: 1, date: '2026-03-05' }],
      reservations: [res({ id: 10, day_id: 1, reservation_time: '2026-03-01T08:00' })],
      endpoints: [
        {
          id: 50,
          reservation_id: 10,
          role: 'from',
          sequence: 0,
          name: 'A',
          code: null,
          lat: 1,
          lng: 1,
          timezone: null,
          local_time: null,
          local_date: '2026-03-01',
        },
        {
          id: 51,
          reservation_id: 10,
          role: 'to',
          sequence: 1,
          name: 'B',
          code: null,
          lat: 1,
          lng: 1,
          timezone: null,
          local_time: null,
          local_date: '2026-03-02',
        },
      ],
    });
    // Day 1 re-dated 03-01 → 03-05 (+4d).
    restampReservationDates(s, 1, new Map([[1, '2026-03-01']]), new Map([[1, '2026-03-05']]));
    expect(s.reservations[0].reservation_time).toBe('2026-03-05T08:00');
    expect(s.endpoints.find((e) => e.id === 50)!.local_date).toBe('2026-03-05');
    expect(s.endpoints.find((e) => e.id === 51)!.local_date).toBe('2026-03-06');
  });
});

describe('resyncAccommodationDays', () => {
  it('re-anchors a stay to the days now holding its pre-change dates', () => {
    const s = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: '2026-04-10' }, // was 2026-03-01
        { id: 2, trip_id: 1, day_number: 2, date: '2026-04-11' }, // was 2026-03-02
      ],
      accommodations: [{ id: 7, trip_id: 1, place_id: null, start_day_id: 1, end_day_id: 2, check_in: null }],
      reservations: [res({ id: 10, type: 'hotel', accommodation_id: 7, day_id: 1, reservation_time: '2026-03-01' })],
    });
    // The range moved wholesale: old day-1 date 03-01 no longer exists, so the
    // stay stays glued; the linked hotel reservation is restamped to the NEW
    // date of the day it still points at.
    resyncAccommodationDays(
      s,
      1,
      new Map([
        [1, '2026-03-01'],
        [2, '2026-03-02'],
      ])
    );
    const r = s.reservations[0];
    expect(r.reservation_time).toBe('2026-04-10');
    expect(r.day_id).toBe(1);
  });
});

describe('assertNoInvertedAccommodation', () => {
  it('passes when every stay’s start day-number ≤ end', () => {
    const s = new MemoryStore({
      days: [
        { id: 1, trip_id: 1, day_number: 1, date: null },
        { id: 2, trip_id: 1, day_number: 2, date: null },
      ],
      accommodations: [{ id: 7, trip_id: 1, place_id: null, start_day_id: 1, end_day_id: 2, check_in: null }],
    });
    expect(() => assertNoInvertedAccommodation(s, 1)).not.toThrow();
  });
});

describe.todo('day ops under real Dexie persistence', () => {
  // The (trip_id, day_number) UNIQUE constraint is what the two-phase negative
  // renumber exists for — only a real adapter proves the ordering survives.
});
