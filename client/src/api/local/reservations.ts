/**
 * Local `reservationsApi` — the Dexie port of the hosted
 * ReservationsController + ReservationsService pair
 * (server/src/nest/reservations/).
 *
 * A booking is one row in `reservations` plus the side effects the legacy
 * route chained off it — endpoints, traveler assignments, an auto-created /
 * re-seated hotel stay with its mirrored day stops, and the linked budget
 * item a `create_budget_entry` payload implies. The ported cascade
 * (`ported/reservation-cascade.ts`) carries all of it verbatim; this adapter
 * is the controller: trip-access guard → body contract → foreign-reference
 * guards → the port → the same response shape.
 *
 * Wire parity (the axios surface this replaced), widened with the socket's
 * side channel the way `accommodationsApi` already does:
 *   GET            → { reservations }
 *   POST           → { reservation, assignment, movedAssignment, removedAssignments,
 *                      updatedAssignments, stampedPlace, accommodationPing, budgetEvents }
 *   PUT :id        → same fields
 *   DELETE :id     → { success: true, assignment, movedAssignment, removedAssignments,
 *                      updatedAssignments, stampedPlace, deletedAccommodationId,
 *                      deletedBudgetItemId }
 *   PUT :id/travelers → { travelers, reservation }
 *   PUT positions  → { success: true }
 * The mirror fields feed `applyStayStops`; `accommodationPing` is the
 * `accommodation:*` broadcast the controller used to emit ('created' /
 * 'updated' / null — the payload was always `{}` or the id, and the only
 * client effect either way is the `accommodations:refresh` nudge the caller
 * replays); `budgetEvents` are the `budget:*` broadcasts in emit order;
 * `deletedAccommodationId`/`deletedBudgetItemId` are the two `*:deleted`
 * payloads DELETE emitted.
 *
 * Errors reproduce the controller verbatim: 'Trip not found' (the access
 * guard), 'Reservation not found', `Not part of this trip: …` before
 * `Unknown reference: …`, and the ZodValidationPipe 400 strings `parseBody`
 * produces.
 */
import {
  reservationCreateRequestSchema,
  reservationUpdateRequestSchema,
  reservationTravelersRequestSchema,
  reservationPositionsRequestSchema,
  type ReservationCreateRequest,
  type ReservationTraveler,
  type ReservationUpdateRequest,
} from '@trek/shared';
import type { Assignment, Place, Reservation } from '../../types';
import { DexieStore, withStore } from './dexieStore';
import { badRequest, detached, notFound, numId, parseBody } from './helpers';
import {
  createReservation,
  referencesOutsideTrip,
  removeReservation,
  syncBudgetOnCreate,
  syncBudgetOnUpdate,
  unresolvedReferences,
  updateReservation,
  ReservationValidationError,
  type BudgetSyncEvent,
  type CreateReservationData,
  type UpdateReservationData,
} from './ported/reservation-cascade';
import type { AccommodationMirror, MirroredAssignment } from './ported/night-seat';
import { backfillFlightEndpoints as backfillEndpoints } from './ported/airports';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** `getReservation(id, tripId)` — the raw row, trip-scoped, or the 404 the
 *  controller threw before touching the body refs. */
function requireReservation(store: DexieStore, tripId: number, id: number | string): Reservation {
  const r = store.reservationRecord(numId(id));
  if (!r || r.trip_id !== tripId) throw notFound('Reservation');
  return r;
}

/** The controller's rejectForeignReferences, verbatim: foreign rows first. */
function rejectForeignReferences(
  store: DexieStore,
  tripId: number,
  body: CreateReservationData | UpdateReservationData,
): void {
  const offenders = referencesOutsideTrip(store, tripId, body);
  if (offenders.length > 0) throw badRequest(`Not part of this trip: ${offenders.join(', ')}`);
  const unknown = unresolvedReferences(store, tripId, body);
  if (unknown.length > 0) throw badRequest(`Unknown reference: ${unknown.join(', ')}`);
}

/** The port's own validation throw, re-shaped into the axios-shaped 400 the
 *  global exception filter sent for the server's BadRequestException. */
function cascade<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ReservationValidationError) throw badRequest(err.message);
    throw err;
  }
}

/** The mirror's created seats — one object for the ordinary case, a list when
 *  several nights took a seat at once (the accommodations adapter's convention). */
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

/** The day-plan half of what a reservation write answers with — the same
 *  fields applyStayStops (store/stayStops.ts) folds in; declared here rather
 *  than imported so the adapter stays below the store layer. */
interface StayMirrorFields {
  assignment: Assignment | Assignment[] | null;
  movedAssignment:
    | { assignment: Assignment; oldDayId: number }
    | { assignment: Assignment; oldDayId: number }[]
    | null;
  removedAssignments: { id: number; dayId: number }[];
  updatedAssignments: Assignment[];
  stampedPlace: Place | null;
}

/** The stay mirror as the response's applyStayStops fields. */
function stayMirrorFields(mirror: AccommodationMirror): StayMirrorFields {
  return {
    assignment: wireAssignments(mirror.created, mirror.createdExtra),
    movedAssignment: wireMoved(mirror.moved, mirror.movedExtra),
    removedAssignments: mirror.removed,
    updatedAssignments: mirror.updated.map((m) => m as Assignment),
    stampedPlace: (mirror.stamped as Place | null) ?? null,
  };
}

/** The server's broadcast carried the joined budget item; the sync seam hands
 *  back the id it wrote — read the stored row so a replayed `budget:created`
 *  is the full wire shape the event applier + Dexie writer expect. */
function resolveBudgetEvents(store: DexieStore, tripId: number, events: BudgetSyncEvent[]): BudgetSyncEvent[] {
  return events.map((ev) => {
    const id = (ev.item as { id?: number } | undefined)?.id;
    if (id == null) return ev;
    const row = store.budgetItemsOfTrip(tripId).find((b) => b.id === id);
    return row ? { ...ev, item: detached(row) } : ev;
  });
}

/** POST/PUT's answer: the joined reservation plus every side channel the
 *  socket used to carry — the mirrored stops, the accommodation ping, and the
 *  budget broadcasts. */
export interface ReservationWriteResult extends StayMirrorFields {
  reservation: Reservation;
  /** Which `accommodation:*` ping the controller emitted ('created' when the
   *  write made a stay, 'updated' when it moved one, null otherwise). */
  accommodationPing: 'created' | 'updated' | null;
  /** The `budget:*` broadcasts the controller emitted, in order. */
  budgetEvents: BudgetSyncEvent[];
}

/** DELETE's answer: `success` plus the cascade's side-channel fields. */
export interface ReservationDeleteResult extends StayMirrorFields {
  success: true;
  /** The `accommodation:deleted` payload id — set when the reservation owned
   *  a stay that went with it. */
  deletedAccommodationId: number | null;
  /** The `budget:deleted` payload id — set when a linked cost went with it. */
  deletedBudgetItemId: number | null;
}

/** PUT :id/travelers's answer — the re-joined traveler list + the joined row. */
export interface ReservationTravelersResult {
  travelers: ReservationTraveler[];
  reservation: Reservation;
}

export const reservationsApi = {
  list: (tripId: number | string): Promise<{ reservations: Reservation[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return { reservations: store.listReservationsWire(tid) };
    }),

  create: (tripId: number | string, data: ReservationCreateRequest): Promise<ReservationWriteResult> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(reservationCreateRequestSchema, data);
      rejectForeignReferences(store, tid, body as CreateReservationData);
      const { reservation, accommodationCreated, stayMirror } = cascade(() =>
        createReservation(store, tid, body as CreateReservationData));
      // The controller's POST chain: stay mirror announce (its events fold
      // into the caller's applyStayStops) → accommodation:created → the budget
      // side effect's budget:* → reservation:created.
      const budgetEvents = resolveBudgetEvents(
        store,
        tid,
        syncBudgetOnCreate(
          store,
          tid,
          reservation.id as number,
          body.title,
          body.type as string | undefined,
          body.create_budget_entry as { total_price?: number; category?: string } | undefined,
        ),
      );
      return {
        reservation: reservation as unknown as Reservation,
        ...stayMirrorFields(stayMirror),
        accommodationPing: accommodationCreated ? 'created' : null,
        budgetEvents,
      };
    }),

  update: (tripId: number | string, id: number, data: ReservationUpdateRequest): Promise<ReservationWriteResult> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(reservationUpdateRequestSchema, data);
      const current = requireReservation(store, tid, id);
      rejectForeignReferences(store, tid, body as UpdateReservationData);
      const { reservation, accommodationChanged, stayMirror } = cascade(() =>
        updateReservation(store, numId(id), tid, body as UpdateReservationData, current));
      const budgetEvents = resolveBudgetEvents(
        store,
        tid,
        syncBudgetOnUpdate(
          store,
          tid,
          numId(id),
          (body.title ?? '') as string,
          body.type as string | undefined,
          current.title,
          current.type,
          body.create_budget_entry as { total_price?: number; category?: string } | undefined,
        ),
      );
      return {
        reservation: reservation as unknown as Reservation,
        ...stayMirrorFields(stayMirror),
        accommodationPing: accommodationChanged ? 'updated' : null,
        budgetEvents,
      };
    }),

  delete: (tripId: number | string, id: number): Promise<ReservationDeleteResult> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const { deleted, accommodationDeleted, deletedBudgetItemId, stayMirror } = cascade(() =>
        removeReservation(store, numId(id), tid));
      if (!deleted) throw notFound('Reservation');
      return {
        success: true,
        ...stayMirrorFields(stayMirror),
        deletedAccommodationId: accommodationDeleted ? Number(deleted.accommodation_id) : null,
        deletedBudgetItemId,
      };
    }),

  // Assign trip members / named guests to a booking (#1517).
  setTravelers: (tripId: number | string, id: number, userIds: number[]): Promise<ReservationTravelersResult> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(reservationTravelersRequestSchema, { user_ids: userIds });
      requireReservation(store, tid, id);
      store.setReservationTravelers(numId(id), tid, body.user_ids);
      const reservation = store.getReservation(numId(id), tid)! as unknown as Reservation;
      return { travelers: reservation.travelers ?? [], reservation };
    }),

  updatePositions: (
    tripId: number | string,
    positions: { id: number; day_plan_position: number }[],
    dayId?: number,
  ): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(reservationPositionsRequestSchema, { positions, day_id: dayId });
      store.updateReservationPositions(tid, body.positions, body.day_id);
      return { success: true };
    }),
};

/**
 * The server's `AirportsService.onApplicationBootstrap` hook: repair flight
 * bookings whose metadata still carries departure/arrival IATAs but no
 * `reservation_endpoints` rows — resolve them into `from`/`to` endpoints, or
 * flag `needs_review` when the codes don't resolve. `db/bootstrap.ts` runs it
 * at every local boot, best-effort like the server hook was: a repair pass
 * must never keep the app from starting.
 */
export async function backfillFlightEndpoints(): Promise<void> {
  try {
    await withStore((store) => {
      backfillEndpoints(store);
    });
  } catch {
    // The server logged and continued; nothing here may break boot.
  }
}
