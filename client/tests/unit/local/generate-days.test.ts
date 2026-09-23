/**
 * Parity tests for the ported day-generation diff.
 *
 * Source fixtures: server/tests/unit/nest/trips.service.test.ts and
 * server/tests/integration/days*.test.ts pin the dateless keep/trim semantics,
 * positional row reuse, overflow deletion on shorten, and MAX_TRIP_DAYS.
 * The diff is pure; the last describe applies it through tripsApi over the
 * real Dexie database (fake-indexeddb) — the two-phase renumbering and the
 * &[trip_id+day_number] unique index only exist there.
 */
import 'fake-indexeddb/auto';
import { MAX_TRIP_DAYS } from '@trek/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertTripSpan,
  computeDayDiff,
  DayRangeError,
  planDayRegeneration,
} from '../../../src/api/local/ported/generate-days';
import { tripsApi } from '../../../src/api/local/trips';
import { db } from '../../../src/db/panelmintDb';
import { buildDay, buildReservation, buildTrip } from '../../helpers/factories';
import type { Day, LocalUser } from '../../../src/types';

const day = (id: number, day_number: number, date: string | null = null, extra: Partial<Day> = {}): Day =>
  ({ id, trip_id: 1, day_number, date, ...extra }) as Day;

describe('assertTripSpan', () => {
  it('refuses an inverted range', () => {
    // The service's verbatim ValidationError text (trips.service.ts).
    expect(() => assertTripSpan('2026-03-05', '2026-03-01')).toThrow('End date must be after start date');
    expect(() => assertTripSpan('2026-03-05', '2026-03-01')).toThrow(DayRangeError);
  });
  it(`refuses a span above ${MAX_TRIP_DAYS} days`, () => {
    expect(() => assertTripSpan('2026-01-01', '2029-01-01')).toThrow(
      `A trip can span at most ${MAX_TRIP_DAYS} days`,
    );
    expect(() => assertTripSpan('2026-01-01', '2029-01-01')).toThrow(DayRangeError);
  });
  it('accepts a single-day trip and a null range', () => {
    expect(() => assertTripSpan('2026-03-01', '2026-03-01')).not.toThrow();
    expect(() => assertTripSpan(null, null)).not.toThrow();
  });
});

describe('computeDayDiff — dateless trip', () => {
  it('nullifies dates but keeps the rows when dates are cleared', () => {
    const existing = [day(1, 1, '2026-03-01'), day(2, 2, '2026-03-02'), day(3, 3, '2026-03-03')];
    const diff = computeDayDiff({ id: 1, start_date: null, end_date: null }, existing, 'keep_bookings');
    expect(diff.deletedDayIds).toEqual([]);
    expect(diff.created).toEqual([]);
    // Same three rows, dates gone, numbers unchanged.
    expect(diff.updated.map((u) => u.id).sort()).toEqual([1, 2, 3]);
    expect(diff.updated.every((u) => u.date === null)).toBe(true);
  });

  it('a dateless trip with no days seeds the default 7', () => {
    const diff = computeDayDiff({ id: 1, start_date: null, end_date: null }, [], 'keep_bookings');
    expect(diff.created).toHaveLength(7);
    expect(diff.created.every((d) => d.date === null)).toBe(true);
  });

  it('explicit dayCount grows the trip with null-dated rows', () => {
    const existing = [day(1, 1), day(2, 2)];
    const diff = computeDayDiff({ id: 1, start_date: null, end_date: null }, existing, 'keep_bookings', {
      dayCount: 5,
    });
    expect(diff.created).toHaveLength(3);
    expect(diff.created.map((d) => d.day_number)).toEqual([3, 4, 5]);
  });

  it('shortening drops the highest-numbered EMPTY days, keeping content-bearing ones', () => {
    const existing = [
      day(1, 1),
      day(2, 2),
      day(3, 3),
      day(4, 4), // empty, dropped
      day(5, 5), // content-bearing (referenced by a stay) → kept
    ];
    const diff = computeDayDiff({ id: 1, start_date: null, end_date: null }, existing, 'keep_bookings', {
      dayCount: 4,
      contentDayIds: new Set([5]),
    });
    expect(diff.deletedDayIds).toEqual([4]);
    // Compaction: kept day 5 renumbers to 4.
    const five = diff.updated.find((u) => u.id === 5);
    expect(five?.day_number).toBe(4);
  });
});

describe('computeDayDiff — dated trip', () => {
  it('stamps dates on existing dateless rows positionally', () => {
    const existing = [day(1, 1), day(2, 2)];
    const diff = computeDayDiff({ id: 1, start_date: '2026-03-01', end_date: '2026-03-03' }, existing, 'keep_bookings');
    expect(diff.updated.map((u) => [u.id, u.date])).toEqual([
      [1, '2026-03-01'],
      [2, '2026-03-02'],
    ]);
    expect(diff.created.map((d) => d.date)).toEqual(['2026-03-03']);
  });

  it('reuses dated rows positionally when the range shifts', () => {
    const existing = [day(1, 1, '2026-03-01'), day(2, 2, '2026-03-02')];
    const diff = computeDayDiff({ id: 1, start_date: '2026-04-10', end_date: '2026-04-11' }, existing, 'keep_bookings');
    expect(diff.created).toEqual([]);
    expect(diff.deletedDayIds).toEqual([]);
    expect(diff.updated.map((u) => [u.id, u.date])).toEqual([
      [1, '2026-04-10'],
      [2, '2026-04-11'],
    ]);
  });

  it('deletes dated rows that overflow a shortened range', () => {
    const existing = [
      day(1, 1, '2026-03-01'),
      day(2, 2, '2026-03-02'),
      day(3, 3, '2026-03-03'),
      day(4, 4, '2026-03-04'),
    ];
    const diff = computeDayDiff({ id: 1, start_date: '2026-03-01', end_date: '2026-03-02' }, existing, 'keep_bookings');
    expect(diff.deletedDayIds.sort()).toEqual([3, 4]);
    expect(diff.updated.find((u) => u.id === 1)).toBeUndefined(); // unchanged
  });

  it('keeps content-bearing dateless rows past the dated block', () => {
    const existing = [
      day(1, 1, '2026-03-01'),
      day(2, 2, '2026-03-02'),
      day(9, 5, null), // content-bearing → kept past the dated block
      day(10, 4, null), // empty → dropped
    ];
    const diff = computeDayDiff(
      { id: 1, start_date: '2026-03-01', end_date: '2026-03-02' },
      existing,
      'keep_bookings',
      { contentDayIds: new Set([9]) }
    );
    expect(diff.deletedDayIds).toEqual([10]);
    const kept = diff.updated.find((u) => u.id === 9);
    expect(kept).toMatchObject({ date: null, day_number: 3 });
  });
});

describe('planDayRegeneration — the update() follow-up dispatch', () => {
  const dated = [day(1, 1, '2026-03-01'), day(2, 2, '2026-03-02')];

  it("'shift_all' → restamp (bookings glued to their day rows)", () => {
    const plan = planDayRegeneration({ id: 1, start_date: '2026-03-05', end_date: '2026-03-06' }, dated, 'shift_all');
    expect(plan.followUp).toBe('restamp');
    expect(plan.prevDateByDayId.get(1)).toBe('2026-03-01');
    expect(plan.newDateByDayId.get(1)).toBe('2026-03-05');
  });

  it("'keep_bookings' → reanchor (resync by absolute reservation dates)", () => {
    const plan = planDayRegeneration(
      { id: 1, start_date: '2026-03-05', end_date: '2026-03-06' },
      dated,
      'keep_bookings'
    );
    expect(plan.followUp).toBe('reanchor');
  });

  it('a dateless result → no follow-up', () => {
    const plan = planDayRegeneration({ id: 1, start_date: null, end_date: null }, dated, 'shift_all');
    expect(plan.followUp).toBe('none');
  });
});

describe('generateDays against real Dexie persistence', () => {
  const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };
  beforeEach(async () => {
    await db.transaction('rw', db.tables, async () => {
      for (const t of db.tables) await t.clear();
    });
    await db.localUsers.put(SELF);
  });

  it('create + update allocate day ids monotonically across trips', async () => {
    const { trip: a } = await tripsApi.create({ title: 'A', start_date: '2026-03-01', end_date: '2026-03-02' });
    const { trip: b } = await tripsApi.create({ title: 'B', start_date: '2026-05-01', end_date: '2026-05-03' });
    const aIds = (await db.days.where('trip_id').equals(a.id).toArray()).map((d) => d.id);
    const bIds = (await db.days.where('trip_id').equals(b.id).toArray()).map((d) => d.id);
    // Table-wide allocator: trip B's rows never reuse trip A's ids.
    expect(Math.min(...bIds)).toBeGreaterThan(Math.max(...aIds));
    // Extending B adds a row past every id issued so far.
    await tripsApi.update(b.id, { start_date: '2026-05-01', end_date: '2026-05-04' });
    const grown = await db.days.where('trip_id').equals(b.id).sortBy('day_number');
    expect(grown).toHaveLength(4);
    expect(grown[3].date).toBe('2026-05-04');
    expect(grown[3].id).toBeGreaterThan(Math.max(...bIds));
  });

  it('shortening a dated trip deletes the overflow rows — the unique index holds', async () => {
    await db.trips.put(buildTrip({ id: 1, start_date: '2026-03-01', end_date: '2026-03-04' }));
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
      buildDay({ id: 14, trip_id: 1, day_number: 4, date: '2026-03-04' }),
    ]);
    await tripsApi.update(1, { start_date: '2026-03-01', end_date: '2026-03-02' });
    const days = await db.days.where('trip_id').equals(1).sortBy('day_number');
    expect(days.map((d) => [d.id, d.day_number, d.date])).toEqual([
      [11, 1, '2026-03-01'],
      [12, 2, '2026-03-02'],
    ]);
    // No transient negative day_number ever persisted.
    expect(days.every((d) => (d.day_number ?? 0) > 0)).toBe(true);
  });

  it('keep_bookings leaves a booking whose date fell out of the range untouched', async () => {
    await db.trips.put(buildTrip({ id: 1, start_date: '2026-03-01', end_date: '2026-03-03' }));
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
    ]);
    await db.reservations.put(
      buildReservation({ id: 9, trip_id: 1, day_id: 11, reservation_time: '2026-03-01T20:00' }),
    );
    // The range shifts forward a week: no day holds 2026-03-01 anymore, and
    // resyncReservationDays' `newDayId == null → continue` leaves the row
    // glued to its old day and keeps the timestamp verbatim (server parity).
    await tripsApi.update(1, { start_date: '2026-03-08', end_date: '2026-03-10' });
    const r = await db.reservations.get(9);
    expect(r!.day_id).toBe(11);
    expect(r!.reservation_time).toBe('2026-03-01T20:00');
    const days = await db.days.where('trip_id').equals(1).sortBy('day_number');
    expect(days.map((d) => [d.id, d.date])).toEqual([
      [11, '2026-03-08'],
      [12, '2026-03-09'],
      [13, '2026-03-10'],
    ]);
  });

  it("shift_all restamps a booking's date — the reservation stays glued to its day row", async () => {
    await db.trips.put(buildTrip({ id: 1, start_date: '2026-03-01', end_date: '2026-03-03' }));
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
    ]);
    await db.reservations.put(
      buildReservation({ id: 9, trip_id: 1, day_id: 11, reservation_time: '2026-03-01T20:00' }),
    );
    // Same forward shift as the keep_bookings test, but the mode restamps the
    // timestamp's date part — the booking follows day 11, time preserved.
    await tripsApi.update(1, {
      start_date: '2026-03-08',
      end_date: '2026-03-10',
      date_shift_mode: 'shift_all',
    });
    const r = await db.reservations.get(9);
    expect(r!.day_id).toBe(11);
    expect(r!.reservation_time).toBe('2026-03-08T20:00');
  });
});
