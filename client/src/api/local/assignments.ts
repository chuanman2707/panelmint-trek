/**
 * `assignmentsApi` — the local implementation. Same method list and
 * envelopes as the axios version in api/client.ts (`{assignments}` /
 * `{assignment}` / `{success: true}` / `{participants}`), backed by
 * `DexieStore` over the `panelmint` database.
 *
 * Server parity notes (server/src/nest/assignments/ — deleted with the
 * server, see git history):
 *  - TripAccessGuard 404s an unreachable trip with 'Trip not found', then
 *    the zod body pipe ran before the handler's own existence checks — a
 *    malformed body on a missing entity was a 400, not a 404.
 *  - The day-scoped routes (list/create/delete/reorder) answer
 *    'Day not found' / 'Place not found' / 'Assignment not found'
 *    verbatim; the trip-scoped routes (move, participants, time, notes,
 *    transport, end-day) answer only 'Assignment not found' /
 *    'Target day not found'. The different guard sets are kept on
 *    purpose — getAssignmentForTrip was a JOIN on the day's trip, not a
 *    route-param lookup.
 *  - `delete`'s 404 is the single three-way JOIN check, so a missing day
 *    AND a foreign trip both answer 'Assignment not found', never
 *    'Day not found'.
 *  - `updateTime` returns the WHOLE `{assignment, reordered, vias}` the
 *    port produces. The axios surface only carried `{assignment}` because
 *    the server broadcast the rest over the socket; with no socket the
 *    side channels ride the response and the caller replays them through
 *    applyLocalEffect (README.md §4 — assignmentRepo.setTimes,
 *    useTripPlanner.handleSavePlace).
 *  - `reorder` is the silent per-row UPDATE — an id that is not on the
 *    day no-ops but still consumes its order_index slot. No permutation
 *    check ever existed here (that one is daysApi.reorder's).
 *  - `move` derives the source day from the row, not the caller, and
 *    defaults `order_index` to 0 — never a bump/gap-close, matching the
 *    server's bare UPDATE.
 *  - `update` never had a server route (a dead client surface kept for
 *    the api surface): an allowlisted column patch returning the standard
 *    wire — id/day_id/place_id/created_at can never move.
 *  - `setEndDay` is the route api/assignmentEndDay.ts used to PUT itself;
 *    it now goes through here behind the same {assignment} envelope.
 */
import {
  assignmentCreateRequestSchema,
  assignmentEndDayRequestSchema,
  assignmentMoveRequestSchema,
  assignmentNotesRequestSchema,
  assignmentParticipantsRequestSchema,
  assignmentReorderRequestSchema,
  assignmentTimeRequestSchema,
  assignmentTransportRequestSchema,
  type AssignmentCreateRequest,
  type AssignmentEndDayRequest,
  type AssignmentNotesRequest,
  type AssignmentTimeRequest,
  type RoadtripVia,
} from '@trek/shared';
import type { Assignment, AssignmentParticipant } from '../../types';
import { notFound, numId, parseBody } from './helpers';
import { DexieStore, withStore } from './dexieStore';
import { updateTime as portUpdateTime } from './ported/assignment-time';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** `dayExists(dayId, tripId)` — the row exists AND belongs to the trip. */
function requireDay(store: DexieStore, tripId: number, dayId: number | string): number {
  const did = numId(dayId);
  const day = Number.isFinite(did) ? store.dayRow(did) : undefined;
  if (!day || day.trip_id !== tripId) throw notFound('Day');
  return did;
}

/** `getAssignmentForTrip` — the row sits on a day of THIS trip. */
function requireAssignmentOnTrip(store: DexieStore, tripId: number, id: number | string) {
  const ref = store.assignmentRef(id);
  if (!ref || ref.day.trip_id !== tripId) throw notFound('Assignment');
  return ref;
}

/** `assignmentExistsInDay` — the delete route's three-way JOIN check:
 *  id on day AND the day on trip, one 404 for every mismatch. */
function requireAssignmentInDay(store: DexieStore, tripId: number, dayId: number, id: number | string) {
  const ref = store.assignmentRef(id);
  if (!ref || ref.day.id !== dayId || ref.day.trip_id !== tripId) throw notFound('Assignment');
  return ref;
}

/** Columns the dead `update` surface is allowed to patch — never the
 *  identity columns (id/day_id/place_id/created_at) or the joins. */
const UPDATE_COLUMNS = [
  'notes',
  'order_index',
  'assignment_time',
  'assignment_end_time',
  'end_day',
  'leg_transport_mode',
  'incoming_leg_transport_mode',
  'accommodation_id',
] as const;

/**
 * `updateTime`'s response: the axios surface resolved to `{assignment}`
 * because the server broadcast the order change and the re-pinned vias
 * over the socket. With no socket they ride the response — the caller
 * replays `reordered` through applyLocalEffect('assignment:reordered').
 */
export interface AssignmentTimeResponse {
  assignment: Assignment;
  reordered: { dayId: number; orderedIds: number[] } | null;
  vias: { dayId: number; vias: RoadtripVia[] } | null;
}

export const assignmentsApi = {
  list: (tripId: number | string, dayId: number | string): Promise<{ assignments: Assignment[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const did = requireDay(store, tid, dayId);
      return { assignments: store.getAssignmentsForDay(did) };
    }),

  create: (
    tripId: number | string,
    dayId: number | string,
    data: AssignmentCreateRequest,
  ): Promise<{ assignment: Assignment }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(assignmentCreateRequestSchema, data);
      const did = requireDay(store, tid, dayId);
      if (!store.existsOnTrip('places', body.place_id, tid)) throw notFound('Place');
      // REST never sends an order index — always the append (max + 1).
      const id = store.insertTravellerStop(did, numId(body.place_id), body.notes || null);
      return { assignment: store.getAssignment(id) as Assignment };
    }),

  delete: (tripId: number | string, dayId: number | string, id: number): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      requireAssignmentInDay(store, tid, numId(dayId), id);
      // Embedded row out + the junction rows die with it (ON DELETE CASCADE).
      store.deleteStop(id);
      return { success: true as const };
    }),

  reorder: (tripId: number | string, dayId: number | string, orderedIds: number[]): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(assignmentReorderRequestSchema, { orderedIds });
      const did = requireDay(store, tid, dayId);
      store.reorderDayStops(did, body.orderedIds);
      return { success: true as const };
    }),

  move: (
    tripId: number | string,
    assignmentId: number,
    newDayId: number | string,
    orderIndex: number | null,
  ): Promise<{ assignment: Assignment }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(assignmentMoveRequestSchema, { new_day_id: newDayId, order_index: orderIndex });
      const ref = requireAssignmentOnTrip(store, tid, assignmentId);
      const did = numId(body.new_day_id);
      if (!store.existsOnTrip('days', body.new_day_id, tid)) throw notFound('Target day');
      // The server's UPDATE changed day_id + order_index only — place_id
      // rides along untouched, so hand moveStop the row's own.
      store.moveStop(assignmentId, did, ref.assignment.place_id, body.order_index ?? 0);
      return { assignment: store.getAssignment(assignmentId) as Assignment };
    }),

  update: (
    tripId: number | string,
    dayId: number | string,
    id: number,
    data: Record<string, unknown>,
  ): Promise<{ assignment: Assignment }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const did = requireDay(store, tid, dayId);
      const ref = requireAssignmentInDay(store, tid, did, id);
      for (const col of UPDATE_COLUMNS) {
        if (!(col in data)) continue;
        if (col === 'end_day') {
          ref.assignment.end_day = data[col] ? 1 : 0;
        } else {
          (ref.assignment as unknown as Record<string, unknown>)[col] = data[col];
        }
      }
      store.put('days', ref.day);
      return { assignment: store.getAssignment(id) as Assignment };
    }),

  getParticipants: (tripId: number | string, id: number): Promise<{ participants: AssignmentParticipant[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      requireAssignmentOnTrip(store, tid, id);
      return { participants: store.participantsOf(id) };
    }),

  setParticipants: (
    tripId: number | string,
    id: number,
    userIds: number[],
  ): Promise<{ participants: AssignmentParticipant[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(assignmentParticipantsRequestSchema, { user_ids: userIds });
      requireAssignmentOnTrip(store, tid, id);
      // Off-roster ids drop silently — the picker sends the whole list on
      // every edit, so a member gone since it opened would otherwise 400.
      const roster = store.rosterUserIds(tid);
      store.setAssignmentParticipants(id, body.user_ids.filter((uid) => roster.has(uid)));
      return { participants: store.participantsOf(id) };
    }),

  updateTime: (
    tripId: number | string,
    id: number,
    times: AssignmentTimeRequest,
  ): Promise<AssignmentTimeResponse> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(assignmentTimeRequestSchema, times);
      requireAssignmentOnTrip(store, tid, id);
      const res = portUpdateTime(store, id, body.place_time, body.end_time);
      return {
        assignment: res.assignment as Assignment,
        reordered: res.reordered,
        vias: res.vias,
      };
    }),

  setEndDay: (
    tripId: number | string,
    id: number,
    data: AssignmentEndDayRequest,
  ): Promise<{ assignment: Assignment }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(assignmentEndDayRequestSchema, data);
      const ref = requireAssignmentOnTrip(store, tid, id);
      ref.assignment.end_day = body.end_day ? 1 : 0;
      store.put('days', ref.day);
      return { assignment: store.getAssignment(id) as Assignment };
    }),

  // Day-specific note on an assignment (#2163) — falsy clears like null.
  updateNotes: (
    tripId: number | string,
    id: number,
    data: AssignmentNotesRequest,
  ): Promise<{ assignment: Assignment }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(assignmentNotesRequestSchema, data);
      const ref = requireAssignmentOnTrip(store, tid, id);
      ref.assignment.notes = body.notes || null;
      store.put('days', ref.day);
      return { assignment: store.getAssignment(id) as Assignment };
    }),

  // Per-segment travel mode (#1281): 'outgoing' is the leg leaving this
  // stop, 'incoming' the boundary leg arriving at it; null clears.
  updateTransport: (
    tripId: number | string,
    id: number,
    mode: string | null,
    direction: 'outgoing' | 'incoming' = 'outgoing',
  ): Promise<{ assignment: Assignment }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      // Same body the axios surface sent: direction only shipped when
      // 'incoming' (the schema default already says 'outgoing').
      const body = parseBody(
        assignmentTransportRequestSchema,
        direction === 'incoming' ? { transport_mode: mode, direction } : { transport_mode: mode },
      );
      const ref = requireAssignmentOnTrip(store, tid, id);
      if (body.direction === 'incoming') {
        ref.assignment.incoming_leg_transport_mode = body.transport_mode ?? null;
      } else {
        ref.assignment.leg_transport_mode = body.transport_mode ?? null;
      }
      store.put('days', ref.day);
      return { assignment: store.getAssignment(id) as Assignment };
    }),
};
