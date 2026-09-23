/**
 * Port of the assignment time-sort half of AssignmentsService
 * (server/src/nest/assignments/assignments.service.ts).
 *
 * The ordering rule is shared `chronoOrder` from @trek/shared; what this module
 * ports is how the server reads a day's stops for that sort (a booked night is
 * timed by its check-in, not by a time nobody typed) and how it persists the
 * result + re-pins the day's road-trip vias. Persistence goes through
 * `AssignmentTimeStore`.
 *
 * Server behaviours preserved:
 *  - sortMinutes: a readable clock parses to minutes; an unreadable value gets
 *    the '99:99' sentinel (sorts after every real time); null stays untimed.
 *  - updateTime: falsy times clear the override ('' is a clear, not a stored
 *    value); only a start that moved sorts — an end is a label; a start sent
 *    again as it stood leaves the day alone; so does a cleared start.
 *  - sortDayByTime writes only rows whose index changes, numbered from 0.
 *  - reanchorVias maps each via's leg from the old located-stop order to the
 *    new one via shared reanchorByStopOrder — except a via behind the day's
 *    last stop, which stays while that stop is still last.
 */
import { chronoOrder, type RoadtripVia } from '@trek/shared';
import { isEmptyReanchoring, reanchorByStopOrder, type AnchoredVia } from '@trek/shared/roadtrip';

/**
 * Where the time sort puts a value it cannot read as a clock time: after every real
 * time, which is where the '99:99' sentinel has always put a time without a colon.
 */
export const UNREADABLE_TIME = 99 * 60 + 99;

/** Minutes since midnight for a readable clock time; sentinel for unreadable;
 *  null for untimed. Verbatim. */
export function sortMinutes(time: string | null): number | null {
  if (!time) return null;
  const clock = /(?:^|T)(\d{1,2}):(\d{2})/.exec(time);
  return clock ? Number(clock[1]) * 60 + Number(clock[2]) : UNREADABLE_TIME;
}

/** One stop of a day as the time sort reads it. */
export interface DayStopRow {
  id: number;
  order_index: number;
  effective_time: string | null;
  located: number;
}

/** What saving a time changed besides the stop itself. */
export interface AssignmentTimeUpdate {
  assignment: unknown;
  reordered: { dayId: number; orderedIds: number[] } | null;
  vias: { dayId: number; vias: RoadtripVia[] } | null;
}

/**
 * Persistence seam for the assignment-time statements. Everything runs inside
 * `transaction`.
 */
export interface AssignmentTimeStore {
  transaction<T>(fn: () => T): T;
  /** The stop being edited: its day and the time the sort reads
   *  (COALESCE(assignment_time, place_time, accommodation check_in)). */
  getStopForTime(id: number): { day_id: number; start: string | null } | undefined;
  /** Write the assignment's own start/end override (null clears). */
  setAssignmentTimes(id: number, start: string | null, end: string | null): void;
  /** The day's stops as sortDayByTime reads them, in stored order. */
  listDayStops(dayId: number): DayStopRow[];
  /** Write a stop's order_index. */
  setOrderIndex(stopId: number, orderIndex: number): void;
  /** The day's vias as reanchorByStopOrder reads them (the server's
   *  `SELECT id, after_order_index, lat, lng` — deliberately a different
   *  projection than the night-seat seam's pinned-via view). */
  listAnchoredVias(dayId: number): AnchoredVia[];
  deleteVia(viaId: number, dayId: number): void;
  setViaLeg(viaId: number, dayId: number, afterOrderIndex: number): void;
  /** The day's vias in broadcast shape, for the `vias` result. */
  listDayVias(dayId: number): RoadtripVia[];
  /** Re-read the stop in wire shape for the `assignment` result. */
  getAssignment(id: number): unknown;
}

/**
 * Puts one day in time order. Writes nothing when it already is. Verbatim from
 * the server's private sortDayByTime.
 */
export function sortDayByTime(
  store: AssignmentTimeStore,
  dayId: number
): { dayId: number; orderedIds: number[]; viasMoved: boolean } | null {
  const rows = store.listDayStops(dayId);

  const sorted = chronoOrder(rows, (row) => sortMinutes(row.effective_time));
  if (sorted.every((row, i) => row === rows[i])) return null;

  // Numbered from 0, the way a drag stores a day. Only a stop whose key changes
  // is written.
  sorted.forEach((row, i) => {
    if (row.order_index !== i) store.setOrderIndex(row.id, i);
  });

  return { dayId, orderedIds: sorted.map((row) => row.id), viasMoved: reanchorVias(store, dayId, rows, sorted) };
}

/**
 * Keeps every drawn road behind the stop it was drawn after, the rule the
 * planner applies when stops are dragged (reanchorByStopOrder). Verbatim from
 * the server's private reanchorVias — no sequence renumbering, and a via behind
 * the day's last stop keeps its place while that stop is still last.
 */
export function reanchorVias(
  store: AssignmentTimeStore,
  dayId: number,
  before: DayStopRow[],
  after: DayStopRow[]
): boolean {
  const located = (rows: DayStopRow[]) => rows.filter((row) => row.located).map((row) => row.id);
  const previousIds = located(before);
  const nextIds = located(after);
  // Only stops without coordinates moved. The router never sees those, so every leg
  // is still the one it was.
  if (previousIds.every((stopId, i) => stopId === nextIds[i])) return false;

  // A via behind the day's last stop bends the drive into the next day.
  const lastAt = previousIds.length - 1;
  const seam = previousIds[lastAt] === nextIds[lastAt] ? lastAt : null;
  const vias = store.listAnchoredVias(dayId).filter((via) => via.after_order_index !== seam);
  const plan = reanchorByStopOrder(vias, previousIds, nextIds);
  for (const viaId of plan.remove) {
    store.deleteVia(viaId, dayId);
  }
  for (const via of plan.vias) {
    store.setViaLeg(via.id, dayId, via.after_order_index);
  }
  return !isEmptyReanchoring(plan);
}

/**
 * Saves a visit's own start and end, and puts the day back in time order when the
 * start changed. Verbatim from the server's updateTime.
 */
export function updateTime(
  store: AssignmentTimeStore,
  id: number,
  placeTime: unknown,
  endTime: unknown
): AssignmentTimeUpdate {
  const sorted = store.transaction(() => {
    const stored = store.getStopForTime(id);

    // Falsy times (null, undefined, '') all clear the override — an empty
    // string is a clear, not a stored value.
    store.setAssignmentTimes(id, (placeTime as string) || null, (endTime as string) || null);

    // Only a start that moved sorts. An end is a label. A start sent again as it
    // stood leaves the day the way the traveller left it. A cleared start leaves
    // the day alone too.
    if (!placeTime || !stored) return null;
    if (sortMinutes(String(placeTime)) === sortMinutes(stored.start)) return null;
    return sortDayByTime(store, stored.day_id);
  });

  return {
    assignment: store.getAssignment(id),
    reordered: sorted ? { dayId: sorted.dayId, orderedIds: sorted.orderedIds } : null,
    vias: sorted?.viasMoved ? { dayId: sorted.dayId, vias: store.listDayVias(sorted.dayId) } : null,
  };
}
