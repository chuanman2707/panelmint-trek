/**
 * Local `accommodationsApi` — the Dexie port of the hosted
 * AccommodationsController + AccommodationsService pair
 * (server/src/nest/accommodations/).
 *
 * A stay is one row in `accommodations` plus two side effects written in the
 * same transaction: the linked 'hotel' reservation (auto-created, kept in sync
 * on check-in/out edits, deleted on cancel — with its linked budget item) and
 * the mirrored day stops the ported night-seat rules maintain. Where the
 * server seated only the check-in day, PanelMint seats every night of the
 * stay — every day from check-in up to, not including, check-out — and only
 * ever touches the booking's own stops.
 *
 * Wire parity (the axios surface this replaced), widened for spanning stays
 * and the socket's side channel:
 *   POST   → { accommodation, assignment, movedAssignment, removedAssignments, updatedAssignments, stampedPlace }
 *   PUT    → same fields
 *   DELETE → { success: true, removedAssignments, updatedAssignments }
 * `assignment`/`movedAssignment` carry the one seat an ordinary write makes;
 * a stay spanning nights answers with a list instead. The fields are the
 * mirror's side channel: callers replay them through applyStayStops
 * (store/stayStops.ts) the way the socket used to announce them. `stampedPlace`
 * is the socket's `place:updated` — the broadcast reached the sender too, so
 * the place list and the map see the 'hotel' stamp the write made. `vias` is
 * not emitted: the road-trip surface refetches its own days.
 *
 * Errors reproduce the controller verbatim: 'Trip not found', the bespoke
 * 400 'place_id, start_day_id, and end_day_id are required', the first
 * validateRefs message ('Place not found' / 'Start day not found' /
 * 'End day not found') and 'Accommodation not found'.
 */
import {
  accommodationCreateBodySchema,
  accommodationUpdateRequestSchema,
  type AccommodationCreateRequest,
  type AccommodationUpdateRequest,
} from '@trek/shared';
import type { Accommodation, Assignment, Place } from '../../types';
import { DexieStore, withStore } from './dexieStore';
import { apiError, badRequest, notFound, numId, parseBody } from './helpers';
import { attachStayNights, dropStayStops, moveStayNights, type MirroredAssignment } from './ported/night-seat';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** `getAccommodation(id, tripId)` — `WHERE id = ? AND trip_id = ?` or 404. */
function requireStay(store: DexieStore, tripId: number, id: number | string): Accommodation {
  const stay = store.stayRow(numId(id));
  if (!stay || stay.trip_id !== tripId) throw notFound('Accommodation');
  return stay;
}

/**
 * The days a stay's nights land on: every trip day from the check-in day up to,
 * not including, the check-out day — the night of the check-out day is not the
 * hotel's anymore. A same-day (or reversed) stay keeps the server's one seat
 * on the start day. Day order is `day_number`, not id (#889).
 */
function staySeatDays(store: DexieStore, tripId: number, startDayId: number, endDayId: number): number[] {
  const days = store.daysOfTrip(tripId).map((d) => d.id!);
  const start = days.indexOf(startDayId);
  const end = days.indexOf(endDayId);
  if (start < 0 || end < 0 || end <= start) return [startDayId];
  return days.slice(start, end);
}

/** The mirror's created seats — one object when the night is the only seat, a
 * list when the stay spans nights, null when none were needed. */
function wireAssignments(
  created: MirroredAssignment | null,
  createdExtra: MirroredAssignment[]
): Assignment | Assignment[] | null {
  const all = [created, ...createdExtra].filter((a): a is MirroredAssignment => a != null);
  if (all.length === 0) return null;
  return all.length === 1 ? (all[0] as Assignment) : (all as Assignment[]);
}

/** The mirror's carried rows — same single-or-list convention. */
function wireMoved(
  moved: { assignment: MirroredAssignment; oldDayId: number } | null,
  movedExtra: { assignment: MirroredAssignment; oldDayId: number }[]
): { assignment: Assignment; oldDayId: number } | { assignment: Assignment; oldDayId: number }[] | null {
  const all = [moved, ...movedExtra].filter(
    (m): m is { assignment: MirroredAssignment; oldDayId: number } => m != null
  );
  if (all.length === 0) return null;
  const wire = all.map((m) => ({ assignment: m.assignment as Assignment, oldDayId: m.oldDayId }));
  return wire.length === 1 ? wire[0]! : wire;
}

/**
 * The stay write's response half: the row plus the assignment fields
 * `applyStayStops` replays. `assignment`/`movedAssignment` are a single value
 * for the ordinary one-night write and a list when a spanning stay seats or
 * carries several nights at once — applyStayStops folds both shapes in.
 */
export interface StayWriteResult {
  accommodation: Accommodation;
  assignment: Assignment | Assignment[] | null;
  movedAssignment?:
    | { assignment: Assignment; oldDayId: number }
    | { assignment: Assignment; oldDayId: number }[]
    | null;
  removedAssignments?: { id: number; dayId: number }[];
  updatedAssignments?: Assignment[];
  /** The place this write typed as lodging (the mirror's `stamped`) — the
   *  socket's `place:updated`, which the sender's session got too. null when
   *  the place was already typed or the write never reached the day plan. */
  stampedPlace: Place | null;
}

/** DELETE's answer: the booking's stops, taken back or handed over. */
export interface StayDeleteResult {
  success: true;
  removedAssignments: { id: number; dayId: number }[];
  updatedAssignments: Assignment[];
}

export const accommodationsApi = {
  list: (tripId: number | string): Promise<{ accommodations: Accommodation[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      // LEFT JOIN reservations fans out one row per linked booking — the wire
      // shape the tripAccommodations readers consume.
      return { accommodations: store.listAccommodationsWire(tid) };
    }),

  create: (tripId: number | string, data: AccommodationCreateRequest): Promise<StayWriteResult> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(accommodationCreateBodySchema, data);
      const { place_id, start_day_id, end_day_id, check_in, check_in_end, check_out, confirmation, notes } = body;
      // The bespoke 400 runs before any ref lookup — verbatim order.
      if (!place_id || !start_day_id || !end_day_id) {
        throw badRequest('place_id, start_day_id, and end_day_id are required');
      }
      const placeId = numId(place_id);
      const startDayId = numId(start_day_id);
      const endDayId = numId(end_day_id);
      const errors = store.validateStayRefs(tid, place_id, start_day_id, end_day_id);
      if (errors.length > 0) throw apiError(404, errors[0]!.message);

      // The stay, its partner hotel reservation and the day stop it implies
      // are one logical write — the server's transaction boundary.
      const { stayId, mirror } = store.transaction(() => {
        const stayId = store.insertStay({
          trip_id: tid,
          place_id: placeId,
          start_day_id: startDayId,
          end_day_id: endDayId,
          check_in: check_in || null,
          check_in_end: check_in_end || null,
          check_out: check_out || null,
          confirmation: confirmation || null,
          notes: notes || null,
        });

        // Auto-create the linked 'hotel' reservation the booking form shows.
        const placeName = store.placeName(placeId) || 'Hotel';
        const startDayDate = store.dayRow(startDayId)?.date || null;
        const meta: Record<string, string> = {};
        if (check_in) meta.check_in_time = check_in;
        if (check_in_end) meta.check_in_end_time = check_in_end;
        if (check_out) meta.check_out_time = check_out;
        store.insertReservation({
          trip_id: tid,
          day_id: startDayId,
          end_day_id: null,
          place_id: null,
          assignment_id: null,
          title: placeName,
          reservation_time: startDayDate,
          reservation_end_time: null,
          location: null,
          confirmation_number: confirmation || null,
          notes: notes || null,
          url: null,
          status: 'confirmed',
          type: 'hotel',
          accommodation_id: stayId,
          metadata: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
          needs_review: 0,
        });

        return {
          stayId,
          mirror: attachStayNights(store, stayId, placeId, staySeatDays(store, tid, startDayId, endDayId), check_in),
        };
      });

      return {
        accommodation: store.accommodationDetailWire(stayId)!,
        assignment: wireAssignments(mirror.created, mirror.createdExtra),
        movedAssignment: null,
        removedAssignments: [],
        updatedAssignments: [],
        stampedPlace: mirror.stamped as Place | null,
      };
    }),

  update: (tripId: number | string, id: number, data: AccommodationUpdateRequest): Promise<StayWriteResult> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(accommodationUpdateRequestSchema, data);
      const existing = requireStay(store, tid, id);
      const { place_id, start_day_id, end_day_id, check_in, check_in_end, check_out, confirmation, notes } = body;
      const errors = store.validateStayRefs(tid, place_id, start_day_id, end_day_id);
      if (errors.length > 0) throw apiError(404, errors[0]!.message);

      // The UPDATE binds all eight columns — an absent field keeps the stored
      // value, a null one clears it.
      const aid = numId(id);
      const newPlaceId = (place_id !== undefined ? numId(place_id as number | string) : existing.place_id) ?? null;
      const newStartDayId = start_day_id !== undefined ? numId(start_day_id as number | string) : existing.start_day_id;
      const newEndDayId = end_day_id !== undefined ? numId(end_day_id as number | string) : existing.end_day_id;
      const newCheckIn = (check_in !== undefined ? check_in : existing.check_in) as string | null | undefined;
      const newCheckInEnd = (check_in_end !== undefined ? check_in_end : existing.check_in_end) as
        | string
        | null
        | undefined;
      const newCheckOut = (check_out !== undefined ? check_out : existing.check_out) as string | null | undefined;
      const newConfirmation = (confirmation !== undefined ? confirmation : existing.confirmation) as
        | string
        | null
        | undefined;
      const newNotes = (notes !== undefined ? notes : existing.notes) as string | null | undefined;

      // The stay row and the day stop that mirrors it describe the same
      // booking — the server's transaction keeps both or neither.
      const mirror = store.transaction(() => {
        store.updateStay(aid, {
          place_id: newPlaceId,
          start_day_id: newStartDayId,
          end_day_id: newEndDayId,
          check_in: newCheckIn ?? null,
          check_in_end: newCheckInEnd ?? null,
          check_out: newCheckOut ?? null,
          confirmation: newConfirmation ?? null,
          notes: newNotes ?? null,
        });
        return moveStayNights(
          store,
          aid,
          newPlaceId,
          staySeatDays(store, tid, newStartDayId, newEndDayId),
          newCheckIn ?? null,
          {
            checkInChanged: check_in !== undefined && (check_in || null) !== (existing.check_in || null),
          }
        );
      });

      // Sync check-in/out + confirmation onto EVERY linked reservation —
      // merge into the stored metadata, never replace it (server verbatim).
      for (const res of store.listLinkedReservations(aid)) {
        const meta = (res.metadata ? JSON.parse(res.metadata) : {}) as Record<string, unknown>;
        if (newCheckIn) meta.check_in_time = newCheckIn;
        if (newCheckInEnd) meta.check_in_end_time = newCheckInEnd;
        if (newCheckOut) meta.check_out_time = newCheckOut;
        store.updateReservationMeta(res.id, JSON.stringify(meta), newConfirmation || null);
      }

      return {
        accommodation: store.accommodationDetailWire(aid)!,
        assignment: wireAssignments(mirror.created, mirror.createdExtra),
        movedAssignment: wireMoved(mirror.moved, mirror.movedExtra),
        removedAssignments: mirror.removed,
        updatedAssignments: mirror.updated.map((m) => m as Assignment),
        stampedPlace: mirror.stamped as Place | null,
      };
    }),

  delete: (tripId: number | string, id: number, opts?: { keepStop?: boolean }): Promise<StayDeleteResult> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const aid = numId(id);
      requireStay(store, tid, aid);

      const mirror = store.transaction(() => {
        // Every linked reservation goes, and each one's linked budget item —
        // not just the first, there is no unique constraint on the link.
        for (const res of store.listLinkedReservations(aid)) {
          const linkedBudget = store.findLinkedBudgetItem(tid, res.id);
          if (linkedBudget) store.deleteBudgetItem(linkedBudget.id);
          store.deleteReservation(res.id);
        }
        // keepStop hands the mirrored stop to the traveller (the road-trip
        // "turn this night back into a pause" path); the default takes it back.
        const m = dropStayStops(store, aid, { keepStop: opts?.keepStop });
        store.deleteStay(aid, tid);
        return m;
      });

      return {
        success: true,
        removedAssignments: mirror.removed,
        updatedAssignments: mirror.updated.map((m) => m as Assignment),
      };
    }),
};
