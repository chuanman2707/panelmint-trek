/**
 * Port of ReservationsService create/update/remove cascade logic
 * (server/src/nest/reservations/reservations.service.ts) plus the metadata
 * helper from reservation-metadata.ts.
 *
 * The server version ran every statement over better-sqlite3. Here all reads
 * and writes go through `ReservationCascadeStore`, and the stay mirror goes
 * through the same `StayMirrorStore` seam night-seat.ts uses — one transaction
 * per write, same COALESCE/sentinel semantics, same guards.
 *
 * Server behaviours preserved:
 *  - keepMirroredPrice: a payload that does not name `price`/`priceCurrency`
 *    keeps the stored mirror; `undefined` leaves the column, `null` clears it,
 *    naming the key wins outright.
 *  - day_id/end_day_id derive from reservation_time's date part when the client
 *    didn't set them (non-hotel bookings); unresolvable refs store NULL.
 *  - Hotel bookings auto-create/update the day_accommodations row and mirror
 *    its day stop through the stay mirror.
 *  - referencesOutsideTrip / unresolvedReferences guards run before writes.
 *  - update() honours explicit vs absent fields distinctly (undefined =
 *    keep, null = clear), and hotels null out reservation_time(s).
 *  - remove() cascades: dropStayStops → delete stay → delete linked budget
 *    item → delete reservation, all inside one transaction; a foreign
 *    accommodation_id is not followed.
 */
import { typeToCostCategory } from '@trek/shared';
import type { Reservation } from '../../../types';
import {
  attachStayStop,
  dropStayStops,
  moveStayStop,
  noStayMirror,
  type AccommodationMirror,
  type StayMirrorStore,
} from './night-seat';

/** Validation failure the controller maps to HTTP 400 (the server's BadRequestException). */
export class ReservationValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ReservationValidationError';
  }
}

// ── reservation-metadata.ts, verbatim ────────────────────────────────────────

/** Read a stored metadata column into an object, or null if it is not one. */
function parseStored(stored: string | null | undefined): Record<string, unknown> | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Carry `price` / `priceCurrency` from the stored metadata into an incoming
 * object that does not name them. Verbatim from reservation-metadata.ts:
 * `undefined` (no metadata on the payload) leaves the row alone, `null` clears
 * the column, and naming the key — including setting it to null — is taken at
 * face value.
 */
export function keepMirroredPrice(incoming: unknown, stored: string | null | undefined): unknown {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const next = incoming as Record<string, unknown>;
  if ('price' in next) return incoming;

  const prev = parseStored(stored);
  if (!prev || prev.price === undefined) return incoming;

  const kept: Record<string, unknown> = { ...next, price: prev.price };
  if (prev.priceCurrency !== undefined && !('priceCurrency' in next)) kept.priceCurrency = prev.priceCurrency;
  return kept;
}

// ── Types mirroring the server's data shapes ─────────────────────────────────

export interface ReservationEndpointInput {
  role: 'from' | 'to' | 'stop';
  sequence?: number;
  name: string;
  code: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
  local_time: string | null;
  local_date: string | null;
}

export interface CreateAccommodationInput {
  place_id?: number;
  start_day_id?: number;
  end_day_id?: number;
  check_in?: string;
  check_out?: string;
  confirmation?: string;
}

export interface CreateReservationData {
  title: string;
  reservation_time?: string;
  reservation_end_time?: string;
  location?: string;
  confirmation_number?: string;
  notes?: string;
  url?: string;
  day_id?: number;
  end_day_id?: number;
  place_id?: number;
  assignment_id?: number;
  status?: string;
  type?: string;
  accommodation_id?: number;
  metadata?: unknown;
  create_accommodation?: CreateAccommodationInput;
  endpoints?: ReservationEndpointInput[];
  needs_review?: boolean;
}

export interface UpdateReservationData extends Partial<CreateReservationData> {
  end_day_id?: number | null;
}

export interface ResyncRow {
  id: number;
  reservation_time: string | null;
  reservation_end_time: string | null;
  day_id: number | null;
  end_day_id: number | null;
}

type RefTable = 'days' | 'places' | 'day_accommodations' | 'day_assignments';

/**
 * Persistence seam for the reservation cascade. Every method corresponds to one
 * statement (or small statement group) the server issued. `seat` is the same
 * store the stay mirror uses; `transaction` must provide rollback-on-throw.
 */
export interface ReservationCascadeStore {
  readonly seat: StayMirrorStore;
  transaction<T>(fn: () => T): T;

  /** The day row holding `date` on this trip. */
  dayByDate(tripId: number, date: string): { id: number } | undefined;
  /** Nearest day by |date difference|, ties to the earlier date (the server's
   *  ORDER BY ABS(JULIANDAY...) ASC, date ASC). */
  nearestDay(tripId: number, date: string): { id: number } | undefined;
  /** Dated, resyncable reservations: (type != 'hotel' OR accommodation_id IS NULL)
   *  AND reservation_time IS NOT NULL. */
  listResyncableReservations(tripId: number): ResyncRow[];
  setReservationDays(reservationId: number, dayId: number | null, endDayId: number | null): void;

  /** The trip a row belongs to (days/places/day_accommodations), undefined when absent. */
  rowTripId(table: 'days' | 'places' | 'day_accommodations', id: unknown): number | string | undefined;
  /** The trip an assignment belongs to through its day. */
  assignmentTripId(assignmentId: unknown): number | string | undefined;
  /** Row exists and belongs to this trip. */
  existsOnTrip(table: 'days' | 'places', id: unknown, tripId: number): boolean;
  /** Row exists at all (which trip it sits on is the guards' question). */
  rowExists(table: RefTable, id: unknown): boolean;
  /** Stay-ref validation (AccommodationsService.validateAccommodationRefs).
   *  The refs arrive untyped — the REST route hands the raw body values over,
   *  and a non-row value fails the lookup exactly like SQL binding NULL. */
  validateStayRefs(
    tripId: number,
    placeId?: unknown,
    startDayId?: unknown,
    endDayId?: unknown
  ): { field: string; message: string }[];

  /** The day_accommodations INSERT. The booking surface leaves check_in_end /
   *  notes out — they bind NULL like the server's omitted columns do. */
  insertStay(fields: {
    trip_id: number;
    place_id: number | null;
    start_day_id: number;
    end_day_id: number;
    check_in: string | null;
    check_in_end?: string | null;
    check_out: string | null;
    confirmation: string | null;
    notes?: string | null;
  }): number;
  updateStay(
    accommodationId: number,
    fields: {
      place_id: number | null;
      start_day_id: number;
      end_day_id: number;
      check_in: string | null;
      check_in_end?: string | null;
      check_out: string | null;
      confirmation: string | null;
      notes?: string | null;
    }
  ): void;
  /** The stay's check_in (for the moveStayStop checkInChanged comparison). */
  getStayCheckIn(accommodationId: number): string | null | undefined;
  /** The stay exists and belongs to this trip. */
  stayOnTrip(accommodationId: unknown, tripId: number): boolean;
  deleteStay(accommodationId: number, tripId: number): void;
  /** COALESCE-merge check-in/out times onto the stay (the metadata sync). */
  syncStayTimes(
    accommodationId: number,
    meta: { check_in_time?: string | null; check_in_end_time?: string | null; check_out_time?: string | null }
  ): void;
  /** COALESCE-merge the confirmation onto the stay. */
  syncStayConfirmation(accommodationId: number, confirmation: string): void;

  /** Insert a reservation row with already-resolved fields; returns its id. */
  insertReservation(fields: {
    trip_id: number;
    day_id: number | null;
    end_day_id: number | null;
    place_id: number | null;
    assignment_id: number | null;
    title: string;
    reservation_time: string | null;
    reservation_end_time: string | null;
    location: string | null;
    confirmation_number: string | null;
    notes: string | null;
    url: string | null;
    status: string;
    type: string;
    accommodation_id: number | null;
    metadata: string | null;
    needs_review: number;
  }): number;
  /** The server's COALESCE UPDATE with fully resolved values. */
  applyReservationUpdate(
    id: number,
    resolved: {
      title: string | null;
      reservation_time: string | null;
      reservation_end_time: string | null;
      location: string | null;
      confirmation_number: string | null;
      notes: string | null;
      url: string | null;
      day_id: number | null;
      end_day_id: number | null;
      place_id: number | null;
      assignment_id: number | null;
      status: string | null;
      type: string | null;
      accommodation_id: number | null;
      metadata: string | null;
      needs_review: number | null;
    }
  ): void;
  /** Delete + re-insert the endpoints (the server's saveEndpoints: rows without
   *  coordinates are skipped, not thrown on). */
  replaceEndpoints(reservationId: number, endpoints: ReservationEndpointInput[]): void;
  /** Re-read the stored reservation row (the server's getReservationWithJoins
   *  result; the read-model shape belongs to the store). */
  getReservation(id: number, tripId?: number): Record<string, unknown> | undefined;

  /** Linked hotel reservations of a stay (id + raw metadata). */
  listLinkedReservations(accommodationId: number): { id: number; metadata: string | null }[];
  /** Merge check-in/out times + confirmation onto a linked reservation. */
  updateReservationMeta(reservationId: number, metadata: string, confirmation: string | null): void;
  /** The budget item linked to this reservation, if any. */
  findLinkedBudgetItem(tripId: number, reservationId: number): { id: number } | undefined;
  deleteBudgetItem(budgetItemId: number): void;
  deleteReservation(reservationId: number): void;
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Name every id in the body that points outside this trip. Verbatim from the
 * server: an id that resolves to nothing is not an offender — only a row that
 * exists in a DIFFERENT trip is one the caller must not have reached for.
 */
export function referencesOutsideTrip(
  store: ReservationCascadeStore,
  tripId: number,
  data: CreateReservationData | UpdateReservationData
): string[] {
  const offenders: string[] = [];
  const elsewhere = (table: 'days' | 'places' | 'day_accommodations', id: unknown) => {
    const rowTrip = store.rowTripId(table, id);
    return rowTrip !== undefined && String(rowTrip) !== String(tripId);
  };

  const check = (field: string, offending: boolean) => {
    if (offending) offenders.push(field);
  };

  if (data.day_id != null) check('day_id', elsewhere('days', data.day_id));
  if (data.end_day_id != null) check('end_day_id', elsewhere('days', data.end_day_id));
  if (data.place_id != null) check('place_id', elsewhere('places', data.place_id));
  if (data.accommodation_id != null) check('accommodation_id', elsewhere('day_accommodations', data.accommodation_id));
  if (data.assignment_id != null) {
    const rowTrip = store.assignmentTripId(data.assignment_id);
    check('assignment_id', rowTrip !== undefined && String(rowTrip) !== String(tripId));
  }

  const acc = data.create_accommodation;
  if (acc) {
    if (acc.place_id != null) check('create_accommodation.place_id', elsewhere('places', acc.place_id));
    if (acc.start_day_id != null) check('create_accommodation.start_day_id', elsewhere('days', acc.start_day_id));
    if (acc.end_day_id != null) check('create_accommodation.end_day_id', elsewhere('days', acc.end_day_id));
  }

  return offenders;
}

/**
 * Name every id in the body that resolves to nothing on this trip. Verbatim:
 * only a truthy id is looked up (the write paths coerce 0/'' to NULL), and
 * create_accommodation refs are only checked for hotel bookings.
 */
export function unresolvedReferences(
  store: ReservationCascadeStore,
  tripId: number,
  data: CreateReservationData | UpdateReservationData
): string[] {
  const offenders: string[] = [];

  if (data.day_id && !store.existsOnTrip('days', data.day_id, tripId)) offenders.push('day_id');
  if (data.end_day_id && !store.existsOnTrip('days', data.end_day_id, tripId)) offenders.push('end_day_id');
  if (data.place_id && !store.existsOnTrip('places', data.place_id, tripId)) offenders.push('place_id');
  if (data.assignment_id) {
    if (
      store.assignmentTripId(data.assignment_id) === undefined ||
      String(store.assignmentTripId(data.assignment_id)) !== String(tripId)
    ) {
      offenders.push('assignment_id');
    }
  }

  // Only a hotel booking writes the stay row, so only there do these ids reach SQL.
  if (data.create_accommodation && data.type === 'hotel') {
    const acc = data.create_accommodation;
    const errors = store.validateStayRefs(
      tripId,
      acc.place_id || undefined,
      acc.start_day_id || undefined,
      acc.end_day_id || undefined
    );
    for (const { field } of errors) offenders.push(`create_accommodation.${field}`);
  }

  return offenders;
}

/** An id whose row is gone reads as no id at all (the server's resolvedOrNull). */
function resolvedOrNull(
  store: ReservationCascadeStore,
  table: 'days' | 'places' | 'day_assignments',
  id: number | null
): number | null {
  return id != null && store.rowExists(table, id) ? id : null;
}

/** accommodation_id is a TEXT column server-side; the integer FK reads back as a
 *  numeric string, so normalize to an int wherever it is used as a key. */
function accIdOrNull(v: number | string | null | undefined): number | null {
  return v == null || v === '' ? null : Math.trunc(Number(v));
}

/**
 * Stay day refs are NOT NULL server-side, so an unresolvable one is refused
 * rather than healed. Verbatim (the server's requireResolvableStay).
 */
function requireResolvableStay(store: ReservationCascadeStore, acc: CreateAccommodationInput): void {
  const missing: string[] = [];
  if (acc.place_id && !store.rowExists('places', acc.place_id)) missing.push('place_id');
  if (!store.rowExists('days', acc.start_day_id)) missing.push('start_day_id');
  if (!store.rowExists('days', acc.end_day_id)) missing.push('end_day_id');
  if (missing.length > 0) {
    throw new ReservationValidationError(
      `Unknown reference: ${missing.map((field) => `create_accommodation.${field}`).join(', ')}`
    );
  }
}

// Resolve the day row whose date matches the date portion of an ISO-ish
// timestamp. Verbatim (the server's resolveDayIdFromTime).
export function resolveDayIdFromTime(
  store: ReservationCascadeStore,
  tripId: number,
  time: string | null | undefined,
  clampToNearest = true
): number | null {
  if (!time) return null;
  const datePart = time.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const exact = store.dayByDate(tripId, datePart);
  if (exact) return exact.id;
  if (!clampToNearest) return null;
  return store.nearestDay(tripId, datePart)?.id ?? null;
}

/**
 * Re-anchor non-hotel bookings to the day matching their absolute
 * reservation_time after a range change. Verbatim (resyncReservationDays):
 * only updates when a matching day exists — a booking whose date now falls
 * outside the new range is left untouched.
 */
export function resyncReservationDays(store: ReservationCascadeStore, tripId: number): void {
  const rows = store.listResyncableReservations(tripId);
  store.transaction(() => {
    for (const r of rows) {
      const newDayId = resolveDayIdFromTime(store, tripId, r.reservation_time, false);
      if (newDayId == null) continue;
      const newEndDayId = r.reservation_end_time
        ? (resolveDayIdFromTime(store, tripId, r.reservation_end_time, false) ?? r.end_day_id)
        : r.end_day_id;
      if (newDayId !== r.day_id || newEndDayId !== r.end_day_id) {
        store.setReservationDays(r.id, newDayId, newEndDayId);
      }
    }
  });
}

// ── create ───────────────────────────────────────────────────────────────────

type AccommodationTimesMeta = {
  check_in_time?: string | null;
  check_in_end_time?: string | null;
  check_out_time?: string | null;
};

/**
 * The accommodation insert, the reservation insert, the endpoint save and the
 * metadata sync are one logical write — all-or-nothing. Verbatim from the
 * server's createInTx; the mirror is returned for the caller to dispatch
 * (broadcast) outside the transaction.
 */
export function createReservation(
  store: ReservationCascadeStore,
  tripId: number,
  data: CreateReservationData
): { reservation: Record<string, unknown>; accommodationCreated: boolean; stayMirror: AccommodationMirror } {
  return store.transaction(() => {
    const {
      title,
      reservation_time,
      reservation_end_time,
      location,
      confirmation_number,
      notes,
      url,
      day_id,
      end_day_id,
      place_id,
      assignment_id,
      status,
      type,
      accommodation_id,
      metadata,
      create_accommodation,
      endpoints,
      needs_review,
    } = data;

    let accommodationCreated = false;
    let stayMirror = noStayMirror();

    // Auto-create accommodation for hotel reservations.
    let resolvedAccommodationId: number | null = accIdOrNull(accommodation_id);
    if (type === 'hotel' && !resolvedAccommodationId && create_accommodation) {
      const {
        place_id: accPlaceId,
        start_day_id,
        end_day_id,
        check_in,
        check_out,
        confirmation: accConf,
      } = create_accommodation;
      if (start_day_id && end_day_id) {
        requireResolvableStay(store, create_accommodation);
        resolvedAccommodationId = store.insertStay({
          trip_id: tripId,
          place_id: accPlaceId || null,
          start_day_id,
          end_day_id,
          check_in: check_in || null,
          check_out: check_out || null,
          confirmation: accConf || confirmation_number || null,
        });
        accommodationCreated = true;
        stayMirror = attachStayStop(store.seat, resolvedAccommodationId, accPlaceId || null, start_day_id, check_in);
      }
    }

    // Derive day_id / end_day_id from reservation_time when the client didn't
    // explicitly set them (non-hotel bookings only).
    const resolvedType = type || 'other';
    let resolvedDayId: number | null = day_id ?? null;
    if (resolvedDayId == null && resolvedType !== 'hotel' && reservation_time) {
      resolvedDayId = resolveDayIdFromTime(store, tripId, reservation_time);
    }
    let resolvedEndDayId: number | null = end_day_id ?? null;
    if (resolvedEndDayId == null && resolvedType !== 'hotel' && reservation_end_time) {
      resolvedEndDayId = resolveDayIdFromTime(store, tripId, reservation_end_time);
    }

    resolvedDayId = resolvedOrNull(store, 'days', resolvedDayId);
    resolvedEndDayId = resolvedOrNull(store, 'days', resolvedEndDayId);
    const resolvedPlaceId = resolvedOrNull(store, 'places', place_id || null);
    const resolvedAssignmentId = resolvedOrNull(store, 'day_assignments', assignment_id || null);

    const newId = store.insertReservation({
      trip_id: tripId,
      day_id: resolvedDayId,
      end_day_id: resolvedEndDayId,
      place_id: resolvedPlaceId,
      assignment_id: resolvedAssignmentId,
      title,
      reservation_time: reservation_time || null,
      reservation_end_time: reservation_end_time || null,
      location: location || null,
      confirmation_number: confirmation_number || null,
      notes: notes || null,
      url: url || null,
      status: status || 'pending',
      type: resolvedType,
      accommodation_id: resolvedAccommodationId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      needs_review: needs_review ? 1 : 0,
    });

    if (endpoints && endpoints.length > 0) {
      store.replaceEndpoints(newId, endpoints);
    }

    // Sync check-in/out to accommodation if linked — keyed off the RESOLVED id.
    if (resolvedAccommodationId && metadata) {
      const meta = (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) as AccommodationTimesMeta;
      if (meta.check_in_time || meta.check_in_end_time || meta.check_out_time) {
        store.syncStayTimes(resolvedAccommodationId, meta);
      }
      if (confirmation_number) {
        store.syncStayConfirmation(resolvedAccommodationId, confirmation_number);
      }
    }

    const reservation = store.getReservation(newId, tripId);
    return { reservation: reservation!, accommodationCreated, stayMirror };
  });
}

// ── update ───────────────────────────────────────────────────────────────────

/**
 * The accommodation upsert, the reservation update, the endpoint replace and the
 * metadata sync are one logical write. Verbatim from the server's updateInTx.
 * `current` is the pre-checked stored row (as the server takes it).
 */
export function updateReservation(
  store: ReservationCascadeStore,
  id: number,
  tripId: number,
  data: UpdateReservationData,
  current: Reservation & { url?: string | null }
): { reservation: Record<string, unknown>; accommodationChanged: boolean; stayMirror: AccommodationMirror } {
  return store.transaction(() => {
    const {
      title,
      reservation_time,
      reservation_end_time,
      location,
      confirmation_number,
      notes,
      url,
      day_id,
      end_day_id,
      place_id,
      assignment_id,
      status,
      type,
      accommodation_id,
      metadata,
      create_accommodation,
      endpoints,
      needs_review,
    } = data;

    let accommodationChanged = false;
    let stayMirror = noStayMirror();

    // Update or create accommodation for hotel reservations
    let resolvedAccId: number | null =
      accommodation_id !== undefined ? accIdOrNull(accommodation_id) : accIdOrNull(current.accommodation_id);
    if (resolvedAccId != null) {
      // Scoped to the trip on purpose: an id belonging to someone else's trip
      // must read as absent here, not as an accommodation to write through to.
      if (!store.stayOnTrip(resolvedAccId, tripId)) resolvedAccId = null;
    }
    if (type === 'hotel' && create_accommodation) {
      const {
        place_id: accPlaceId,
        start_day_id,
        end_day_id,
        check_in,
        check_out,
        confirmation: accConf,
      } = create_accommodation;
      if (start_day_id && end_day_id) {
        requireResolvableStay(store, create_accommodation);
        if (resolvedAccId != null) {
          const prior = store.getStayCheckIn(resolvedAccId);
          store.updateStay(resolvedAccId, {
            place_id: accPlaceId || null,
            start_day_id,
            end_day_id,
            check_in: check_in || null,
            check_out: check_out || null,
            confirmation: accConf || confirmation_number || null,
          });
          // The stay just moved. Its stop moves with it.
          stayMirror = moveStayStop(store.seat, resolvedAccId, accPlaceId || null, start_day_id, check_in, {
            checkInChanged: (check_in || null) !== (prior ?? null),
          });
        } else if (accPlaceId) {
          resolvedAccId = store.insertStay({
            trip_id: tripId,
            place_id: accPlaceId,
            start_day_id,
            end_day_id,
            check_in: check_in || null,
            check_out: check_out || null,
            confirmation: accConf || confirmation_number || null,
          });
          stayMirror = attachStayStop(store.seat, resolvedAccId, accPlaceId, start_day_id, check_in);
        }
        accommodationChanged = true;
      }
    }

    // metadata.price / priceCurrency survive an edit that doesn't name them.
    const nextMetadata = keepMirroredPrice(metadata, current.metadata);

    const resolvedType = (type ?? current.type) || 'other';
    const nextReservationTime =
      resolvedType === 'hotel'
        ? null
        : reservation_time !== undefined
          ? reservation_time || null
          : current.reservation_time;
    const nextReservationEndTime =
      resolvedType === 'hotel'
        ? null
        : reservation_end_time !== undefined
          ? reservation_end_time || null
          : current.reservation_end_time;

    // day_id / end_day_id: honour an explicit value from the client, otherwise
    // derive from the (possibly updated) reservation_time.
    let nextDayId: number | null;
    if (day_id != null) {
      nextDayId = day_id;
    } else if (resolvedType !== 'hotel' && nextReservationTime) {
      nextDayId = resolveDayIdFromTime(store, tripId, nextReservationTime);
    } else if (day_id === undefined) {
      nextDayId = current.day_id ?? null;
    } else {
      nextDayId = null;
    }

    let nextEndDayId: number | null;
    if (end_day_id !== undefined) {
      nextEndDayId = end_day_id ?? null;
    } else if (reservation_end_time !== undefined && resolvedType !== 'hotel') {
      nextEndDayId = resolveDayIdFromTime(store, tripId, nextReservationEndTime);
    } else {
      nextEndDayId = current.end_day_id ?? null;
    }

    nextDayId = resolvedOrNull(store, 'days', nextDayId);
    nextEndDayId = resolvedOrNull(store, 'days', nextEndDayId);
    const nextPlaceId = resolvedOrNull(
      store,
      'places',
      place_id !== undefined ? place_id || null : (current.place_id ?? null)
    );
    const nextAssignmentId = resolvedOrNull(
      store,
      'day_assignments',
      assignment_id !== undefined ? assignment_id || null : (current.assignment_id ?? null)
    );

    store.applyReservationUpdate(id, {
      title: title || null,
      reservation_time: nextReservationTime ?? null,
      reservation_end_time: nextReservationEndTime ?? null,
      location: location !== undefined ? location || null : current.location,
      confirmation_number:
        confirmation_number !== undefined ? confirmation_number || null : current.confirmation_number,
      notes: notes !== undefined ? notes || null : current.notes,
      url: url !== undefined ? url || null : (current.url ?? null),
      day_id: nextDayId,
      end_day_id: nextEndDayId,
      place_id: nextPlaceId,
      assignment_id: nextAssignmentId,
      status: status || null,
      type: type || null,
      accommodation_id: resolvedAccId,
      metadata:
        nextMetadata !== undefined ? (nextMetadata ? JSON.stringify(nextMetadata) : null) : (current.metadata ?? null),
      needs_review: needs_review === undefined ? null : needs_review ? 1 : 0,
    });

    if (endpoints !== undefined) {
      store.replaceEndpoints(Number(id), endpoints);
    }

    // Sync check-in/out to accommodation if linked.
    const resolvedMeta =
      nextMetadata !== undefined ? nextMetadata : current.metadata ? JSON.parse(current.metadata as string) : null;
    if (resolvedAccId != null && resolvedMeta) {
      const meta = (
        typeof resolvedMeta === 'string' ? JSON.parse(resolvedMeta) : resolvedMeta
      ) as AccommodationTimesMeta;
      if (meta.check_in_time || meta.check_in_end_time || meta.check_out_time) {
        store.syncStayTimes(resolvedAccId, meta);
      }
      const resolvedConf = confirmation_number !== undefined ? confirmation_number : current.confirmation_number;
      if (resolvedConf) {
        store.syncStayConfirmation(resolvedAccId, resolvedConf);
      }
    }

    const reservation = store.getReservation(id, tripId);
    return { reservation: reservation!, accommodationChanged, stayMirror };
  });
}

// ── remove ───────────────────────────────────────────────────────────────────

/**
 * The accommodation + budget-item + reservation deletes are one logical
 * cascade — all-or-nothing. Verbatim from the server's remove().
 */
export function removeReservation(
  store: ReservationCascadeStore,
  id: number,
  tripId: number
): {
  deleted: { id: number; title: string; type: string; accommodation_id: number | null } | undefined;
  accommodationDeleted: boolean;
  deletedBudgetItemId: number | null;
  stayMirror: AccommodationMirror;
} {
  return store.transaction(() => {
    const reservation = store.getReservation(id, tripId) as
      | { id: number; title: string; type: string; accommodation_id: number | null }
      | undefined;
    if (!reservation) {
      return { deleted: undefined, accommodationDeleted: false, deletedBudgetItemId: null, stayMirror: noStayMirror() };
    }

    let accommodationDeleted = false;
    let stayMirror = noStayMirror();
    if (reservation.accommodation_id) {
      // trip_id in the check, not just the reservation's own scope: a row written
      // before referencesOutsideTrip existed can still carry a foreign
      // accommodation_id, and the cascade must not follow it.
      if (store.stayOnTrip(reservation.accommodation_id, tripId)) {
        // Released before the row goes, not after.
        stayMirror = dropStayStops(store.seat, Number(reservation.accommodation_id));
        store.deleteStay(Number(reservation.accommodation_id), tripId);
        accommodationDeleted = true;
      }
    }

    const linkedBudget = store.findLinkedBudgetItem(tripId, id);
    if (linkedBudget) {
      store.deleteBudgetItem(linkedBudget.id);
    }

    store.deleteReservation(id);
    return {
      deleted: reservation,
      accommodationDeleted,
      deletedBudgetItemId: linkedBudget ? linkedBudget.id : null,
      stayMirror,
    };
  });
}

// ── Budget side effects (the controller-facing sync helpers) ─────────────────

type BudgetEntry = { total_price?: number; category?: string } | undefined;

/** Write-side seam for the budget side effects (BudgetService is not ported —
 *  the linked-item create/update/delete is the seam). */
export interface BudgetSyncStore {
  /** The budget item linked to this reservation (category is read for the
   *  auto-derived-category sync; include it). */
  findLinkedBudgetItem(tripId: number, reservationId: number): { id: number; category: string } | undefined;
  /** BudgetService.linkBudgetItemToReservation: insert with reservation_id set. */
  createLinkedBudgetItem(
    tripId: number,
    reservationId: number,
    data: { name: string; category: string; total_price: number }
  ): { id: number };
  /** BudgetService.createBudgetItem, unlinked; paired with linkBudgetItem below. */
  createBudgetItem(tripId: number, data: { name: string; category: string; total_price: number }): { id: number };
  updateBudgetItem(
    id: number,
    tripId: number,
    data: { name?: string; category?: string; total_price?: number }
  ): unknown;
  deleteBudgetItem(id: number, tripId: number): void;
  /** Point a budget item at its reservation (UPDATE budget_items SET reservation_id). */
  linkBudgetItem(budgetItemId: number, reservationId: number): void;
}

/** What the server broadcasts after a budget side effect — the caller's
 *  dispatch (WebSocket on the server, a store event locally). */
export interface BudgetSyncEvent {
  event: 'budget:created' | 'budget:updated' | 'budget:deleted';
  item?: unknown;
  itemId?: number;
}

/** POST side effect: auto-create a linked budget item when a price is provided. */
export function syncBudgetOnCreate(
  store: BudgetSyncStore,
  tripId: number,
  reservationId: number,
  title: string,
  type: string | undefined,
  entry: BudgetEntry
): BudgetSyncEvent[] {
  if (!entry || !(Number(entry.total_price) > 0)) return [];
  try {
    const item = store.createLinkedBudgetItem(tripId, reservationId, {
      name: title,
      category: entry.category || type || 'Other',
      total_price: entry.total_price!,
    });
    return [{ event: 'budget:created', item }];
  } catch {
    return [];
  }
}

/** PUT side effect: drop the linked budget item when the price is cleared, else
 *  create/update it. Also keeps the linked expense's auto-derived category in
 *  sync when the booking type changes. Verbatim from syncBudgetOnUpdate. */
export function syncBudgetOnUpdate(
  store: BudgetSyncStore,
  tripId: number,
  id: number,
  title: string | undefined,
  type: string | undefined,
  currentTitle: string,
  currentType: string | undefined,
  entry: BudgetEntry
): BudgetSyncEvent[] {
  const events: BudgetSyncEvent[] = [];

  // When the booking type changes, keep a linked expense's category in sync —
  // but only if it still carries the auto-derived category.
  if (type && currentType && type !== currentType) {
    const linked = store.findLinkedBudgetItem(tripId, id);
    if (linked) {
      const oldCat = typeToCostCategory(currentType);
      const newCat = typeToCostCategory(type);
      if (oldCat !== newCat && linked.category === oldCat) {
        const updated = store.updateBudgetItem(linked.id, tripId, { category: newCat });
        events.push({ event: 'budget:updated', item: updated });
      }
    }
  }

  // No budget entry on the payload — leave any linked item alone.
  if (!entry) return events;

  if (!(Number(entry.total_price) > 0)) {
    // Explicit clear (total_price 0/empty) — drop the linked item.
    const linked = store.findLinkedBudgetItem(tripId, id);
    if (linked) {
      store.deleteBudgetItem(linked.id, tripId);
      events.push({ event: 'budget:deleted', itemId: linked.id });
    }
    return events;
  }

  try {
    const itemName = title || currentTitle;
    const category = entry.category || type || currentType || 'Other';
    const existing = store.findLinkedBudgetItem(tripId, id);
    if (existing) {
      const updated = store.updateBudgetItem(existing.id, tripId, {
        name: itemName,
        category,
        total_price: entry.total_price,
      });
      events.push({ event: 'budget:updated', item: updated });
    } else {
      const item = store.createBudgetItem(tripId, { name: itemName, category, total_price: entry.total_price! });
      store.linkBudgetItem(item.id, id);
      events.push({ event: 'budget:created', item: { ...(item as object), reservation_id: Number(id) } });
    }
  } catch {
    // The server logs and moves on: a failed budget entry never breaks the booking write.
  }
  return events;
}
