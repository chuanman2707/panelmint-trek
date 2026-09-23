/**
 * Port of the day-reorder/insert/restamp half of DaysService
 * (server/src/nest/days/days.service.ts).
 *
 * Date helpers are verbatim; the multi-statement writes go through the
 * `DayOpsStore` seam so the same algorithm can run over Dexie or an in-memory
 * fixture. Every public function expects to run inside the caller's
 * transaction where the server ran inside db.transaction(); the store's
 * `transaction()` is exposed for callers that need to compose one.
 *
 * Server behaviours preserved:
 *  - UTC-only date arithmetic (addDays/dayDelta never touch local time).
 *  - Reorder keeps day ROWS stable and re-pins calendar dates to slots
 *    (position i keeps the i-th date); reservations on a re-dated day are
 *    re-stamped with the new date, time-of-day preserved.
 *  - Insert on a dated trip rebuilds N+1 contiguous dates, extends the trip's
 *    end_date, and restamps bookings on shifted days.
 *  - Two-phase negative day_number renumbering avoids unique-key collisions.
 *  - A stay must not end before it begins after a reorder/insert.
 *  - resyncAccommodationDays re-anchors stays to the days now holding their
 *    pre-change dates; a stay out of range stays glued to its day rows.
 */
import { carryVias, locatedStopIds, reseatOwnStop, type StayMirrorStore } from './night-seat';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Add `n` days to a YYYY-MM-DD date string, staying entirely in UTC.
 * Verbatim from the server.
 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * MS_PER_DAY;
  const dt = new Date(t);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Whole days between two YYYY-MM-DD dates, UTC. (Server: private dayDelta.) */
export function dayDelta(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_PER_DAY);
}

/** Replace the date part of an ISO-ish timestamp, keeping any time suffix. */
export function withDatePart(timestamp: string, date: string): string {
  return date + (timestamp.length > 10 ? timestamp.slice(10) : '');
}

/** Thrown for invalid reorder/insert requests; the server's DayReorderError. */
export class DayReorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DayReorderError';
  }
}

interface DayRowLite {
  id: number;
  day_number: number;
  date: string | null;
}

interface ReservationDateRow {
  id: number;
  day_id: number | null;
  end_day_id: number | null;
  reservation_time: string | null;
  reservation_end_time: string | null;
}

interface StaySpan {
  id: number;
  start_no: number;
  end_no: number;
}

interface StayRow {
  id: number;
  start_day_id: number;
  end_day_id: number;
  check_in: string | null;
}

/**
 * Persistence seam for the day-ops statements. `seat` is the same store the
 * night-seat mirror runs against — resyncAccommodationDays/carryStayStop need
 * its locatedStopIds/reseatOwnStop/carryVias plumbing on the same rows.
 */
export interface DayOpsStore {
  readonly seat: StayMirrorStore;
  /** The trip's days ordered by day_number. */
  listDays(tripId: number): DayRowLite[];
  /** All reservations of the trip, with the date fields restamp reads. */
  listReservationDates(tripId: number): ReservationDateRow[];
  /** A booking's transport legs (id + local_date). */
  listEndpoints(reservationId: number): { id: number; local_date: string | null }[];
  /** Accommodation spans as day numbers (the server's start_no/end_no join). */
  listStaySpans(tripId: number): StaySpan[];
  /** The trip's stay rows. */
  listStays(tripId: number): StayRow[];
  /** The day row holding `date`, if one exists. */
  findDayByDate(tripId: number, date: string): { id: number; day_number: number } | undefined;
  /** A day's stored date. */
  getDayDate(dayId: number): string | null | undefined;
  setDayNumber(dayId: number, dayNumber: number): void;
  setDayNumberAndDate(dayId: number, dayNumber: number, date: string | null): void;
  /** Insert a day row; returns its new id. */
  insertDay(tripId: number, dayNumber: number, date: string | null): number;
  /** Re-stamp reservation_time (date part only; time suffix preserved). */
  setReservationTime(reservationId: number, time: string | null): void;
  setReservationEndTime(reservationId: number, time: string | null): void;
  setEndpointDate(endpointId: number, date: string | null): void;
  /** Re-point a stay at new day rows. */
  updateStayDays(accommodationId: number, startDayId: number, endDayId: number): void;
  /** The server's linked-hotel restamp: reservations on accommodation_id get
   *  day_id = dayId and reservation_time's date part replaced by `date`. */
  restampLinkedHotelReservations(accommodationId: number, dayId: number, date: string): void;
  setTripEndDate(tripId: number, date: string): void;
  /** Run `fn` atomically (rollback on throw, like db.transaction). */
  transaction<T>(fn: () => T): T;
}

/**
 * After day dates have been re-pinned, re-stamp the date of every booking on a
 * moved day so reservation_time/reservation_end_time follow their day's new
 * date (time-of-day preserved). Transport endpoints shift by the same per-booking
 * day delta. Verbatim from the server.
 */
export function restampReservationDates(
  store: DayOpsStore,
  tripId: number,
  oldDateById: Map<number, string | null>,
  newDateById: Map<number, string | null>
): void {
  const reservations = store.listReservationDates(tripId);

  for (const r of reservations) {
    if (r.day_id != null && r.reservation_time) {
      const oldDate = oldDateById.get(r.day_id);
      const newDate = newDateById.get(r.day_id);
      if (oldDate && newDate && oldDate !== newDate) {
        store.setReservationTime(r.id, withDatePart(r.reservation_time, newDate));
        // Shift each transport leg's local_date by the same number of days.
        const delta = dayDelta(oldDate, newDate);
        if (delta !== 0) {
          for (const ep of store.listEndpoints(r.id)) {
            if (ep.local_date) store.setEndpointDate(ep.id, addDays(ep.local_date, delta));
          }
        }
      }
    }
    if (r.end_day_id != null && r.reservation_end_time) {
      const oldDate = oldDateById.get(r.end_day_id);
      const newDate = newDateById.get(r.end_day_id);
      if (oldDate && newDate && oldDate !== newDate) {
        store.setReservationEndTime(r.id, withDatePart(r.reservation_end_time, newDate));
      }
    }
  }
}

/** A stay must not end before it begins after a reorder/insert. */
export function assertNoInvertedAccommodation(store: DayOpsStore, tripId: number): void {
  for (const span of store.listStaySpans(tripId)) {
    if (span.start_no > span.end_no) {
      throw new DayReorderError('This move would make an accommodation end before it starts.');
    }
  }
}

/**
 * After a trip's date range changes, generateDays positionally re-dates the day
 * rows (keeping their ids), so an accommodation — which has no absolute date,
 * only start_day_id/end_day_id — visually shifts with the range (#1288).
 * Re-anchor each stay to the days now holding its pre-change dates. A stay whose
 * dates fall outside the new range is left glued to its day rows, mirroring
 * resyncReservationDays' out-of-range semantics. The linked hotel reservation
 * follows its accommodation's start day in both branches. Verbatim.
 */
export function resyncAccommodationDays(
  store: DayOpsStore,
  tripId: number,
  prevDateByDayId: Map<number, string | null>
): void {
  const stays = store.listStays(tripId);
  if (stays.length === 0) return;

  for (const stay of stays) {
    const oldStartDate = prevDateByDayId.get(stay.start_day_id);
    const oldEndDate = prevDateByDayId.get(stay.end_day_id);
    if (oldStartDate && oldEndDate) {
      const newStart = store.findDayByDate(tripId, oldStartDate);
      const newEnd = store.findDayByDate(tripId, oldEndDate);
      if (
        newStart &&
        newEnd &&
        newStart.day_number <= newEnd.day_number &&
        (newStart.id !== stay.start_day_id || newEnd.id !== stay.end_day_id)
      ) {
        store.updateStayDays(stay.id, newStart.id, newEnd.id);
        if (newStart.id !== stay.start_day_id) carryStayStop(store, stay, newStart.id);
        stay.start_day_id = newStart.id;
      }
    }
    // Keep the linked reservation on the stay's (possibly re-dated) start day — its
    // reservation_time is a snapshot of that day's date, stale after any range change.
    const startDayDate = store.getDayDate(stay.start_day_id);
    if (startDayDate) {
      store.restampLinkedHotelReservations(stay.id, stay.start_day_id, startDayDate);
    }
  }
}

/**
 * The day stop a booking wrote moves with it, the way its linked booking does.
 * (Server: DaysService.carryStayStop — private there, exported here because the
 * accommodation-resync path is its only caller and tests need it reachable.)
 */
export function carryStayStop(store: DayOpsStore, stay: { id: number; check_in: string | null }, dayId: number): void {
  const seat = store.seat;
  const own = seat.ownStops(stay.id, dayId);
  for (const stop of own) {
    const before: [number, number[]][] = [stop.day_id, dayId].map((id) => [id, locatedStopIds(seat, id)]);
    if (seat.dayHasPlace(dayId, stop.place_id)) {
      seat.deleteStop(stop.id);
      seat.closeOrderGap(stop.day_id, stop.order_index);
    } else {
      reseatOwnStop(seat, stop, stop.place_id, dayId, { id: stay.id, check_in: stay.check_in });
    }
    for (const [id, previousIds] of before) carryVias(seat, id, previousIds, locatedStopIds(seat, id));
  }
}

/**
 * Reorder whole days. `orderedIds` is the desired full sequence of this trip's
 * day ids (a permutation of the current ids). Verbatim from the server,
 * including the two-phase negative-day_number renumber and the reservation
 * restamp. Returns the trip's days in their new order.
 */
export function reorderDays(store: DayOpsStore, tripId: number, orderedIds: number[]): DayRowLite[] {
  const rows = store.listDays(tripId);

  const existingIds = new Set(rows.map((r) => r.id));
  if (orderedIds.length !== rows.length || !orderedIds.every((id) => existingIds.has(id))) {
    throw new DayReorderError('orderedIds must be a permutation of the trip day ids.');
  }

  const oldDateById = new Map(rows.map((r) => [r.id, r.date]));
  // Dates stay pinned to slots: position i keeps the i-th date (ascending).
  const sortedDates = rows
    .map((r) => r.date)
    .filter((d): d is string => !!d)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const isDated = sortedDates.length > 0;

  store.transaction(() => {
    // Two-phase renumber to dodge UNIQUE(trip_id, day_number) collisions.
    orderedIds.forEach((id, i) => store.setDayNumber(id, -(i + 1)));
    const newDateById = new Map<number, string | null>();
    orderedIds.forEach((id, i) => {
      const date = isDated ? (sortedDates[i] ?? null) : null;
      store.setDayNumberAndDate(id, i + 1, date);
      newDateById.set(id, date);
    });

    if (isDated) restampReservationDates(store, tripId, oldDateById, newDateById);
    assertNoInvertedAccommodation(store, tripId);
  });

  return store.listDays(tripId);
}

/**
 * Insert a new empty day at a 1-based position (default: append at the end).
 * On a dated trip the trip gains one calendar day: dates re-pin so the slots
 * stay contiguous, the trip's end_date extends by one day, and bookings on
 * shifted days have their dates re-stamped (same rules as reorder). Verbatim.
 */
export function insertDay(
  store: DayOpsStore,
  tripId: number,
  position?: number
): { dayId: number; days: DayRowLite[] } {
  const rows = store.listDays(tripId);
  const n = rows.length;
  const pos = Math.min(Math.max(position ?? n + 1, 1), n + 1);
  const datedRows = rows.filter((r) => r.date) as { id: number; day_number: number; date: string }[];
  const isDated = datedRows.length > 0;

  if (!isDated) {
    const newRowid = store.transaction(() => {
      const toShift = rows.filter((r) => r.day_number >= pos);
      toShift.forEach((r) => store.setDayNumber(r.id, -r.day_number));
      const id = store.insertDay(tripId, pos, null);
      toShift.forEach((r) => store.setDayNumber(r.id, r.day_number + 1));
      return id;
    });
    return { dayId: newRowid, days: store.listDays(tripId) };
  }

  // Dated trip: rebuild N+1 contiguous dates from the earliest date.
  const start = datedRows.map((r) => r.date).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
  const dates = Array.from({ length: n + 1 }, (_, i) => addDays(start, i));
  const oldDateById = new Map(rows.map((r) => [r.id, r.date]));

  const newId = store.transaction(() => {
    rows.forEach((r, i) => store.setDayNumber(r.id, -(i + 1)));
    const insertedId = store.insertDay(tripId, pos, dates[pos - 1]);

    const orderedIds = rows.map((r) => r.id);
    orderedIds.splice(pos - 1, 0, insertedId);
    const newDateById = new Map<number, string | null>();
    orderedIds.forEach((id, i) => {
      store.setDayNumberAndDate(id, i + 1, dates[i]);
      newDateById.set(id, dates[i]);
    });

    restampReservationDates(store, tripId, oldDateById, newDateById);
    assertNoInvertedAccommodation(store, tripId);
    store.setTripEndDate(tripId, dates[dates.length - 1]);

    return insertedId;
  });

  return { dayId: newId, days: store.listDays(tripId) };
}
