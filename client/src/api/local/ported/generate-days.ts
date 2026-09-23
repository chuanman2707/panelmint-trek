/**
 * Port of TripsService.generateDays (server/src/nest/trips/trips.service.ts).
 *
 * The server version executed the day diff directly against SQLite inside a
 * transaction. This module computes the same diff as a pure function so the
 * result can be applied to any client persistence layer (Dexie, in-memory,
 * or replayed mutation payloads). Nothing here writes rows — callers apply
 * `created`, `updated`, and `deletedDayIds` to the store.
 *
 * Server behaviours preserved:
 *  - UTC-only date arithmetic (tripSpanDays / Date.UTC, no local timezone).
 *  - Regeneration refuses inverted ranges and ranges above MAX_TRIP_DAYS.
 *  - Existing dated rows are reused positionally; dateless days fill gaps.
 *  - Content-bearing excess dateless days are retained when shortening and
 *    compacted to the end by a final renumber.
 *  - Clearing the trip range keeps the existing day count (minimum 1) unless
 *    an explicit dayCount is given, and drops trailing empty days.
 *  - Reservations/accommodations are NOT touched here — that is the
 *    caller's follow-up (see planDayRegeneration and day-ops.ts).
 */
import { MAX_TRIP_DAYS, tripSpanDays } from '@trek/shared';
import type { Day } from '../../../types';
import { addDays } from './day-ops';

/** Validation failure for trip day generation (the server's ValidationError). */
export class DayRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DayRangeError';
  }
}

export type TripLike = { id: number; start_date: string | null; end_date: string | null };

export type DateShiftMode = 'keep_bookings' | 'shift_all';

export interface GenerateDaysResult {
  /** New day rows to insert. `id` is a negative placeholder (client temp-id convention). */
  created: Day[];
  /** Existing rows whose date and/or day_number changed. */
  updated: Day[];
  /** Existing rows to delete. */
  deletedDayIds: number[];
}

export interface DayRegenerationPlan {
  diff: GenerateDaysResult;
  /** day_id -> date before the diff (null for dateless days). */
  prevDateByDayId: Map<number, string | null>;
  /** day_id -> date after the diff (null for dateless days). */
  newDateByDayId: Map<number, string | null>;
  /** Which restamp path the integrator should run next — the server's
   *  `update()` branch on `date_shift_mode`:
   *  - 'restamp'  : 'shift_all' — bookings stay glued to their (re-dated) day rows;
   *                 run restampReservationDates(prev, new).
   *  - 'reanchor' : 'keep_bookings' (default) — run resyncReservationDays +
   *                 resyncAccommodationDays so dated bookings re-anchor to the day
   *                 matching their absolute reservation_time.
   *  - 'none'     : the trip is not dated after the diff; both paths are no-ops. */
  followUp: 'restamp' | 'reanchor' | 'none';
}

/** The server's assertTripSpan, verbatim: callers only ask when BOTH dates are
 *  set (a one-sided or empty range is the dateless path, not an invalid one). */
export function assertTripSpan(startDate: string | null | undefined, endDate: string | null | undefined): void {
  if (!startDate || !endDate) return;
  const span = tripSpanDays(startDate, endDate);
  if (span < 1) throw new DayRangeError('End date must be on or after start date');
  if (span > MAX_TRIP_DAYS) throw new DayRangeError(`Trip duration cannot exceed ${MAX_TRIP_DAYS} days`);
}

function hasContent(day: Day, contentDayIds: ReadonlySet<number> | undefined): boolean {
  if (contentDayIds?.has(day.id)) return true;
  const assignments = (day as { assignments?: unknown[] }).assignments;
  const notesItems = (day as { notes_items?: unknown[] }).notes_items;
  return (assignments?.length ?? 0) > 0 || (notesItems?.length ?? 0) > 0;
}

/**
 * Pure port of TripsService.generateDays. `trip` carries the *target* range.
 *
 * `dateShiftMode` does not change which rows change — on the server it only
 * selects which reservation/accommodation restamp path runs afterwards; it is
 * accepted (and echoed via planDayRegeneration) so callers pass intent once.
 */
export function computeDayDiff(
  trip: TripLike,
  existingDays: Day[],
  dateShiftMode: DateShiftMode,
  opts?: {
    /** Server `dayCount` parameter: target count for the dateless path. */
    dayCount?: number;
    /** Days referenced by accommodation rows (content for keep-on-shorten). */
    contentDayIds?: ReadonlySet<number>;
    /** First negative id used for created rows (default -1). */
    tempIdStart?: number;
  }
): GenerateDaysResult {
  void dateShiftMode; // selects the follow-up restamp path; the row diff is mode-independent.
  assertTripSpan(trip.start_date, trip.end_date);

  const created: Day[] = [];
  const updated: Day[] = [];
  const deletedDayIds: number[] = [];
  let nextTempId = opts?.tempIdStart ?? -1;
  const newDayRow = (dayNumber: number, date: string | null): Day =>
    ({ id: nextTempId--, trip_id: trip.id, date, day_number: dayNumber }) as Day;

  if (!trip.start_date || !trip.end_date) {
    // Dateless trip: nullify dates, adjust count by explicit dayCount (or keep
    // the current count, minimum 1), delete trailing empty days, renumber.
    const allDays = [...existingDays].sort((a, b) => a.day_number - b.day_number);
    const targetCount = Math.min(Math.max(opts?.dayCount ?? (allDays.length || 7), 1), MAX_TRIP_DAYS);
    const needed = targetCount - allDays.length;

    let remaining = allDays;
    if (needed > 0) {
      for (let i = 0; i < needed; i++) {
        created.push(newDayRow(allDays.length + i + 1, null));
      }
    } else if (needed < 0) {
      // ORDER BY day_number DESC LIMIT n over the *empty* rows: the n
      // highest-numbered empty days are dropped (not strictly the trailing
      // days — a trailing day with content keeps an earlier empty one).
      const emptyDesc = allDays
        .filter((d) => !hasContent(d, opts?.contentDayIds))
        .sort((a, b) => b.day_number - a.day_number)
        .slice(0, -needed);
      const drop = new Set(emptyDesc.map((d) => d.id));
      for (const id of drop) deletedDayIds.push(id);
      remaining = allDays.filter((d) => !drop.has(d.id));
    }

    // Final renumber compacts to 1..N in day_number order; dates are all null.
    for (const [i, d] of remaining.entries()) {
      if (d.date !== null || d.day_number !== i + 1) {
        updated.push({ id: d.id, trip_id: trip.id, date: null, day_number: i + 1 } as Day);
      }
    }
    return { created, updated, deletedDayIds };
  }

  // ── Dated path ────────────────────────────────────────────────────────────
  const numDays = tripSpanDays(trip.start_date, trip.end_date)!;
  const targetDates = Array.from({ length: numDays }, (_, i) => addDays(trip.start_date!, i));

  const dated = existingDays.filter((d) => d.date != null).sort((a, b) => a.day_number - b.day_number);
  const dateless = existingDays.filter((d) => d.date == null).sort((a, b) => a.day_number - b.day_number);
  let datelessIdx = 0;
  const finalAssign = new Map<number, { dayNumber: number; date: string | null }>();

  for (let i = 0; i < targetDates.length; i++) {
    const date = targetDates[i];
    const dayNumber = i + 1;
    if (i < dated.length) {
      finalAssign.set(dated[i].id, { dayNumber, date });
    } else if (datelessIdx < dateless.length) {
      finalAssign.set(dateless[datelessIdx++].id, { dayNumber, date });
    } else {
      created.push(newDayRow(dayNumber, date));
    }
  }

  // Extra dated rows beyond the new count are dropped.
  for (let i = targetDates.length; i < dated.length; i++) {
    deletedDayIds.push(dated[i].id);
  }

  // Leftover dateless days: empty ones go; days with content are kept. The
  // server's provisional day_number (maxAssigned + kept + 1) always lands
  // above the dated block, so the final compacting renumber appends them in
  // order at numDays + j + 1.
  const keptDateless: Day[] = [];
  for (let i = datelessIdx; i < dateless.length; i++) {
    const day = dateless[i];
    if (!hasContent(day, opts?.contentDayIds)) {
      deletedDayIds.push(day.id);
    } else {
      keptDateless.push(day);
    }
  }
  keptDateless.forEach((day, j) => finalAssign.set(day.id, { dayNumber: numDays + j + 1, date: null }));

  for (const day of existingDays) {
    const target = finalAssign.get(day.id);
    if (!target) continue; // deleted
    if (day.date !== target.date || day.day_number !== target.dayNumber) {
      updated.push({ id: day.id, trip_id: trip.id, date: target.date, day_number: target.dayNumber } as Day);
    }
  }

  return { created, updated, deletedDayIds };
}

/**
 * Wrap computeDayDiff with the restamp bookkeeping the server's generateDays
 * performs around the row diff, so the caller knows which follow-up to run.
 */
export function planDayRegeneration(
  trip: TripLike,
  existingDays: Day[],
  dateShiftMode: DateShiftMode,
  opts?: { dayCount?: number; contentDayIds?: ReadonlySet<number>; tempIdStart?: number }
): DayRegenerationPlan {
  const prevDateByDayId = new Map<number, string | null>();
  for (const d of existingDays) prevDateByDayId.set(d.id, d.date ?? null);

  const diff = computeDayDiff(trip, existingDays, dateShiftMode, opts);

  const newDateByDayId = new Map<number, string | null>(prevDateByDayId);
  for (const u of diff.updated) newDateByDayId.set(u.id, u.date ?? null);
  for (const c of diff.created) newDateByDayId.set(c.id, c.date ?? null);
  for (const id of diff.deletedDayIds) newDateByDayId.delete(id);

  const isDated = trip.start_date != null && trip.end_date != null;
  const followUp: DayRegenerationPlan['followUp'] = !isDated
    ? 'none'
    : dateShiftMode === 'shift_all'
      ? 'restamp'
      : 'reanchor';

  return { diff, prevDateByDayId, newDateByDayId, followUp };
}
