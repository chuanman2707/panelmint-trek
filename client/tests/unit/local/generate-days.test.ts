/**
 * Parity tests for the ported day-generation diff.
 *
 * Source fixtures: server/tests/unit/nest/trips.service.test.ts and
 * server/tests/integration/days*.test.ts pin the dateless keep/trim semantics,
 * positional row reuse, overflow deletion on shorten, and MAX_TRIP_DAYS.
 * The diff is pure here; applying it (two-phase renumbering against a real
 * unique constraint) is the Dexie adapter's job and stays in describe.todo.
 */
import { MAX_TRIP_DAYS } from '@trek/shared';
import { describe, expect, it } from 'vitest';
import {
  assertTripSpan,
  computeDayDiff,
  DayRangeError,
  planDayRegeneration,
} from '../../../src/api/local/ported/generate-days';
import type { Day } from '../../../src/types';

const day = (id: number, day_number: number, date: string | null = null, extra: Partial<Day> = {}): Day =>
  ({ id, trip_id: 1, day_number, date, ...extra }) as Day;

describe('assertTripSpan', () => {
  it('refuses an inverted range', () => {
    expect(() => assertTripSpan('2026-03-05', '2026-03-01')).toThrow(DayRangeError);
  });
  it(`refuses a span above ${MAX_TRIP_DAYS} days`, () => {
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

describe.todo('generateDays against real Dexie persistence', () => {
  // The two-phase negative renumbering that keeps (trip_id, day_number) unique
  // mid-update, created-row id allocation, and the reservation/accommodation
  // restamp follow-ups all need the real adapter over offlineDb.
});
