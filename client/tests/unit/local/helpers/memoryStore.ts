/**
 * In-memory implementation of the ported persistence seams.
 *
 * One table bag, one class implementing every seam — the same way SQLite was
 * one connection behind every server's prepare(). Tests build a fixture with
 * `seed()` and hand the store straight to the ported functions. `transaction()`
 * is a passthrough (no rollback — the tests that need atomicity would use the
 * real Dexie adapter).
 */
import type { RoadtripVia } from '@trek/shared';
import type { AnchoredVia } from '@trek/shared/roadtrip';
import type { AssignmentTimeStore, DayStopRow } from '../../../../src/api/local/ported/assignment-time';
import type { DayOpsStore } from '../../../../src/api/local/ported/day-ops';
import type {
  MirroredAssignment,
  PinnedVia,
  SeatRow,
  StayMirrorStore,
} from '../../../../src/api/local/ported/night-seat';
import type {
  BudgetSyncStore,
  ReservationCascadeStore,
  ReservationEndpointInput,
  ResyncRow,
} from '../../../../src/api/local/ported/reservation-cascade';
import type {
  SettlementStore,
  SettlementStoreRow,
  SettlementWriteData,
} from '../../../../src/api/local/ported/settlement';

export interface MemDay {
  id: number;
  trip_id: number;
  day_number: number;
  date: string | null;
}
export interface MemPlace {
  id: number;
  trip_id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  place_time?: string | null;
  end_time?: string | null;
  stop_type?: string | null;
}
export interface MemAssignment {
  id: number;
  day_id: number;
  place_id: number;
  order_index: number;
  assignment_time: string | null;
  assignment_end_time: string | null;
  accommodation_id: number | null;
  notes?: string | null;
  created_at?: string;
}
export interface MemAccommodation {
  id: number;
  trip_id: number;
  place_id: number | null;
  start_day_id: number;
  end_day_id: number;
  check_in: string | null;
  check_in_end?: string | null;
  check_out?: string | null;
  confirmation?: string | null;
  notes?: string | null;
}
export interface MemReservation {
  id: number;
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
  accommodation_id: number | string | null;
  metadata: string | null;
  needs_review: number;
}
export interface MemEndpoint {
  id: number;
  reservation_id: number;
  role: string;
  sequence: number;
  name: string;
  code: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
  local_time: string | null;
  local_date: string | null;
}
export interface MemVia {
  id: number;
  day_id: number;
  after_order_index: number;
  sequence: number;
  lat: number;
  lng: number;
}
export interface MemTrip {
  id: number;
  start_date: string | null;
  end_date: string | null;
}
export interface MemBudgetItem {
  id: number;
  trip_id: number;
  reservation_id: number | null;
  name: string;
  category: string;
  total_price: number;
}

export interface MemTables {
  trips?: MemTrip[];
  days?: MemDay[];
  places?: MemPlace[];
  assignments?: MemAssignment[];
  accommodations?: MemAccommodation[];
  reservations?: MemReservation[];
  endpoints?: MemEndpoint[];
  vias?: MemVia[];
  budgetItems?: MemBudgetItem[];
  settlements?: SettlementStoreRow[];
}

let seq = 1000;
const nextId = () => ++seq;

export class MemoryStore
  implements
    DayOpsStore,
    StayMirrorStore,
    AssignmentTimeStore,
    ReservationCascadeStore,
    BudgetSyncStore,
    SettlementStore
{
  trips: MemTrip[];
  days: MemDay[];
  places: MemPlace[];
  assignments: MemAssignment[];
  accommodations: MemAccommodation[];
  reservations: MemReservation[];
  endpoints: MemEndpoint[];
  vias: MemVia[];
  budgetItems: MemBudgetItem[];
  settlements: SettlementStoreRow[];

  constructor(t: MemTables = {}) {
    this.trips = t.trips ?? [];
    this.days = t.days ?? [];
    this.places = t.places ?? [];
    this.assignments = t.assignments ?? [];
    this.accommodations = t.accommodations ?? [];
    this.reservations = t.reservations ?? [];
    this.endpoints = t.endpoints ?? [];
    this.vias = t.vias ?? [];
    this.budgetItems = t.budgetItems ?? [];
    this.settlements = t.settlements ?? [];
  }

  get seat(): this {
    return this;
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }

  // ── NightSeatStore ─────────────────────────────────────────────────────────

  dayStops(dayId: number): SeatRow[] {
    return this.assignments
      .filter((a) => a.day_id === dayId)
      .sort(
        (a, b) => a.order_index - b.order_index || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id
      )
      .map((a) => {
        const place = this.places.find((p) => p.id === a.place_id);
        const night =
          a.accommodation_id != null ? this.accommodations.find((x) => x.id === a.accommodation_id) : undefined;
        return {
          id: a.id,
          order_index: a.order_index,
          at: night ? night.check_in : (a.assignment_time ?? place?.place_time ?? null),
          night_id: a.accommodation_id,
          located: place && place.lat != null && place.lng != null ? 1 : 0,
        };
      });
  }

  listVias(dayId: number): PinnedVia[] {
    return this.vias
      .filter((v) => v.day_id === dayId)
      .map((v) => ({ id: v.id, after_order_index: v.after_order_index, sequence: v.sequence }));
  }

  closeOrderGap(dayId: number, afterOrderIndex: number): void {
    for (const a of this.assignments) if (a.day_id === dayId && a.order_index > afterOrderIndex) a.order_index -= 1;
  }

  maxOrderIndex(dayId: number, excludeId?: number): number | null {
    const inDay = this.assignments.filter((a) => a.day_id === dayId && a.id !== excludeId);
    return inDay.length ? Math.max(...inDay.map((a) => a.order_index)) : null;
  }

  moveStop(stopId: number, dayId: number, placeId: number, orderIndex: number): void {
    const stop = this.assignments.find((a) => a.id === stopId);
    if (!stop) return;
    stop.day_id = dayId;
    stop.place_id = placeId;
    stop.order_index = orderIndex;
  }

  bumpOrderIndexes(dayId: number, fromOrderIndex: number, excludeId?: number): void {
    for (const a of this.assignments) {
      if (a.day_id === dayId && a.order_index >= fromOrderIndex && a.id !== excludeId) a.order_index += 1;
    }
  }

  setViaLeg(viaId: number, dayId: number, afterOrderIndex: number): void {
    const v = this.vias.find((x) => x.id === viaId && x.day_id === dayId);
    if (v) v.after_order_index = afterOrderIndex;
  }

  setViaSequence(viaId: number, dayId: number, sequence: number): void {
    const v = this.vias.find((x) => x.id === viaId && x.day_id === dayId);
    if (v) v.sequence = sequence;
  }

  deleteVia(viaId: number, dayId: number): void {
    this.vias = this.vias.filter((v) => !(v.id === viaId && v.day_id === dayId));
  }

  // ── StayMirrorStore ────────────────────────────────────────────────────────

  ownStops(accommodationId: number, excludeDayId?: number) {
    return this.assignments
      .filter(
        (a) => a.accommodation_id === accommodationId && (excludeDayId === undefined || a.day_id !== excludeDayId)
      )
      .map((a) => ({ id: a.id, day_id: a.day_id, place_id: a.place_id, order_index: a.order_index }));
  }

  dayHasPlace(dayId: number, placeId: number, excludeId?: number): boolean {
    return this.assignments.some((a) => a.day_id === dayId && a.place_id === placeId && a.id !== excludeId);
  }

  placeStopType(placeId: number): string | null | undefined {
    const p = this.places.find((x) => x.id === placeId);
    if (!p) return undefined;
    return p.stop_type ?? null;
  }

  stampPlaceLodging(placeId: number): void {
    const p = this.places.find((x) => x.id === placeId);
    if (p) p.stop_type = 'hotel';
  }

  getPlaceForMirror(placeId: number): unknown | null {
    return this.places.find((p) => p.id === placeId) ?? null;
  }

  insertOwnedStop(dayId: number, placeId: number, orderIndex: number, accommodationId: number): number {
    // The server's createAssignment: clamp into [0, end], shift the rest down.
    const end = (this.maxOrderIndex(dayId) ?? -1) + 1;
    const at = Math.max(0, Math.min(orderIndex, end));
    if (at < end) this.bumpOrderIndexes(dayId, at);
    const id = nextId();
    this.assignments.push({
      id,
      day_id: dayId,
      place_id: placeId,
      order_index: at,
      assignment_time: null,
      assignment_end_time: null,
      accommodation_id: accommodationId,
      notes: null,
    });
    return id;
  }

  deleteStop(stopId: number): void {
    this.assignments = this.assignments.filter((a) => a.id !== stopId);
  }

  releaseStop(stopId: number): void {
    const a = this.assignments.find((x) => x.id === stopId);
    if (a) a.accommodation_id = null;
  }

  getStopForMirror(stopId: number): MirroredAssignment | null {
    const a = this.assignments.find((x) => x.id === stopId);
    if (!a) return null;
    const place = this.places.find((p) => p.id === a.place_id);
    return { ...a, place: place ? { ...place } : undefined } as MirroredAssignment;
  }

  listDayVias(dayId: number): RoadtripVia[] {
    return this.vias
      .filter((v) => v.day_id === dayId)
      .sort((a, b) => a.after_order_index - b.after_order_index || a.sequence - b.sequence || a.id - b.id)
      .map((v) => ({ ...v }));
  }

  // ── AssignmentTimeStore ────────────────────────────────────────────────────

  getStopForTime(id: number): { day_id: number; start: string | null } | undefined {
    const a = this.assignments.find((x) => x.id === id);
    if (!a) return undefined;
    const place = this.places.find((p) => p.id === a.place_id);
    const acc = a.accommodation_id != null ? this.accommodations.find((x) => x.id === a.accommodation_id) : undefined;
    return { day_id: a.day_id, start: a.assignment_time ?? place?.place_time ?? acc?.check_in ?? null };
  }

  setAssignmentTimes(id: number, start: string | null, end: string | null): void {
    const a = this.assignments.find((x) => x.id === id);
    if (!a) return;
    a.assignment_time = start;
    a.assignment_end_time = end;
  }

  listDayStops(dayId: number): DayStopRow[] {
    return this.assignments
      .filter((a) => a.day_id === dayId)
      .sort(
        (a, b) => a.order_index - b.order_index || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id
      )
      .map((a) => {
        const place = this.places.find((p) => p.id === a.place_id);
        const acc =
          a.accommodation_id != null ? this.accommodations.find((x) => x.id === a.accommodation_id) : undefined;
        return {
          id: a.id,
          order_index: a.order_index,
          effective_time: a.assignment_time ?? place?.place_time ?? acc?.check_in ?? null,
          located: place && place.lat != null && place.lng != null ? 1 : 0,
        };
      });
  }

  setOrderIndex(stopId: number, orderIndex: number): void {
    const a = this.assignments.find((x) => x.id === stopId);
    if (a) a.order_index = orderIndex;
  }

  /** AssignmentTimeStore: the anchored projection (id, after_order_index, lat, lng). */
  listAnchoredVias(dayId: number): AnchoredVia[] {
    return this.vias
      .filter((v) => v.day_id === dayId)
      .map((v) => ({ id: v.id, after_order_index: v.after_order_index, lat: v.lat, lng: v.lng }));
  }

  getAssignment(id: number): unknown {
    const a = this.assignments.find((x) => x.id === id);
    if (!a) return null;
    const place = this.places.find((p) => p.id === a.place_id);
    return { ...a, place: place ? { ...place } : undefined };
  }

  // ── DayOpsStore ────────────────────────────────────────────────────────────

  // The ported algorithms rely on SELECT semantics: list* methods must return
  // DETACHED snapshots, not live rows — e.g. insertDay reads `r.day_number + 1`
  // after a negative renumber wrote through the store, and resyncAccommodationDays
  // scribbles on the stay row as local bookkeeping. Return fresh objects.

  listDays(tripId: number) {
    return this.days
      .filter((d) => d.trip_id === tripId)
      .sort((a, b) => a.day_number - b.day_number)
      .map((d) => ({ id: d.id, day_number: d.day_number, date: d.date }));
  }

  listReservationDates(tripId: number) {
    return this.reservations
      .filter((r) => r.trip_id === tripId)
      .map((r) => ({
        id: r.id,
        day_id: r.day_id,
        end_day_id: r.end_day_id,
        reservation_time: r.reservation_time,
        reservation_end_time: r.reservation_end_time,
      }));
  }

  listEndpoints(reservationId: number) {
    return this.endpoints
      .filter((e) => e.reservation_id === reservationId)
      .map((e) => ({ id: e.id, local_date: e.local_date }));
  }

  listStaySpans(tripId: number) {
    return this.accommodations
      .filter((a) => a.trip_id === tripId)
      .map((a) => ({
        id: a.id,
        start_no: this.days.find((d) => d.id === a.start_day_id)?.day_number ?? 0,
        end_no: this.days.find((d) => d.id === a.end_day_id)?.day_number ?? 0,
      }));
  }

  listStays(tripId: number) {
    return this.accommodations
      .filter((a) => a.trip_id === tripId)
      .map((a) => ({ id: a.id, start_day_id: a.start_day_id, end_day_id: a.end_day_id, check_in: a.check_in }));
  }

  findDayByDate(tripId: number, date: string) {
    const d = this.days.find((x) => x.trip_id === tripId && x.date === date);
    return d ? { id: d.id, day_number: d.day_number } : undefined;
  }

  getDayDate(dayId: number): string | null | undefined {
    return this.days.find((d) => d.id === dayId)?.date;
  }

  setDayNumber(dayId: number, dayNumber: number): void {
    const d = this.days.find((x) => x.id === dayId);
    if (d) d.day_number = dayNumber;
  }

  setDayNumberAndDate(dayId: number, dayNumber: number, date: string | null): void {
    const d = this.days.find((x) => x.id === dayId);
    if (d) {
      d.day_number = dayNumber;
      d.date = date;
    }
  }

  insertDay(tripId: number, dayNumber: number, date: string | null): number {
    const id = nextId();
    this.days.push({ id, trip_id: tripId, day_number: dayNumber, date });
    return id;
  }

  setReservationTime(reservationId: number, time: string | null): void {
    const r = this.reservations.find((x) => x.id === reservationId);
    if (r) r.reservation_time = time;
  }

  setReservationEndTime(reservationId: number, time: string | null): void {
    const r = this.reservations.find((x) => x.id === reservationId);
    if (r) r.reservation_end_time = time;
  }

  setEndpointDate(endpointId: number, date: string | null): void {
    const e = this.endpoints.find((x) => x.id === endpointId);
    if (e) e.local_date = date;
  }

  updateStayDays(accommodationId: number, startDayId: number, endDayId: number): void {
    const a = this.accommodations.find((x) => x.id === accommodationId);
    if (a) {
      a.start_day_id = startDayId;
      a.end_day_id = endDayId;
    }
  }

  restampLinkedHotelReservations(accommodationId: number, dayId: number, date: string): void {
    // UPDATE reservations SET day_id=?, reservation_time = CASE WHEN NULL THEN
    // :date ELSE :date || SUBSTR(reservation_time,11) END WHERE accommodation_id
    // = :accId AND type = 'hotel' — SUBSTR(x,11) is 1-based → slice(10).
    for (const r of this.reservations) {
      if (r.type !== 'hotel' || Number(r.accommodation_id) !== accommodationId) continue;
      r.day_id = dayId;
      r.reservation_time = r.reservation_time == null ? date : date + r.reservation_time.slice(10);
    }
  }

  setTripEndDate(tripId: number, date: string): void {
    const t = this.trips.find((x) => x.id === tripId);
    if (t) t.end_date = date;
  }

  // ── ReservationCascadeStore ────────────────────────────────────────────────

  dayByDate(tripId: number, date: string) {
    const d = this.days.find((x) => x.trip_id === tripId && x.date === date);
    return d ? { id: d.id } : undefined;
  }

  nearestDay(tripId: number, date: string) {
    // ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?)) ASC, date ASC
    const ms = (d: string | null) => (d ? Date.parse(`${d}T00:00:00Z`) : Number.NaN);
    const target = ms(date);
    const sorted = this.days
      .filter((d) => d.trip_id === tripId && d.date)
      .sort((a, b) => Math.abs(ms(a.date) - target) - Math.abs(ms(b.date) - target) || (a.date! < b.date! ? -1 : 1));
    return sorted[0] ? { id: sorted[0].id } : undefined;
  }

  listResyncableReservations(tripId: number): ResyncRow[] {
    return this.reservations
      .filter(
        (r) => r.trip_id === tripId && (r.type !== 'hotel' || r.accommodation_id == null) && r.reservation_time != null
      )
      .map((r) => ({
        id: r.id,
        reservation_time: r.reservation_time,
        reservation_end_time: r.reservation_end_time,
        day_id: r.day_id,
        end_day_id: r.end_day_id,
      }));
  }

  setReservationDays(reservationId: number, dayId: number | null, endDayId: number | null): void {
    const r = this.reservations.find((x) => x.id === reservationId);
    if (r) {
      r.day_id = dayId;
      r.end_day_id = endDayId;
    }
  }

  rowTripId(table: 'days' | 'places' | 'day_accommodations', id: unknown): number | string | undefined {
    if (table === 'days') return this.days.find((d) => d.id === id)?.trip_id;
    if (table === 'places') return this.places.find((p) => p.id === id)?.trip_id;
    return this.accommodations.find((a) => a.id === id)?.trip_id;
  }

  assignmentTripId(assignmentId: unknown): number | string | undefined {
    const a = this.assignments.find((x) => x.id === assignmentId);
    if (!a) return undefined;
    return this.days.find((d) => d.id === a.day_id)?.trip_id;
  }

  existsOnTrip(table: 'days' | 'places', id: unknown, tripId: number): boolean {
    return this.rowTripId(table, id) === tripId;
  }

  rowExists(table: 'days' | 'places' | 'day_accommodations' | 'day_assignments', id: unknown): boolean {
    switch (table) {
      case 'days':
        return this.days.some((d) => d.id === id);
      case 'places':
        return this.places.some((p) => p.id === id);
      case 'day_accommodations':
        return this.accommodations.some((a) => a.id === id);
      case 'day_assignments':
        return this.assignments.some((a) => a.id === id);
    }
  }

  validateStayRefs(tripId: number, placeId?: unknown, startDayId?: unknown, endDayId?: unknown) {
    const errors: { field: string; message: string }[] = [];
    if (placeId !== undefined && !this.existsOnTrip('places', placeId, tripId))
      errors.push({ field: 'place_id', message: 'Place not found' });
    if (startDayId !== undefined && !this.existsOnTrip('days', startDayId, tripId))
      errors.push({ field: 'start_day_id', message: 'Start day not found' });
    if (endDayId !== undefined && !this.existsOnTrip('days', endDayId, tripId))
      errors.push({ field: 'end_day_id', message: 'End day not found' });
    return errors;
  }

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
  }): number {
    const id = nextId();
    this.accommodations.push({ id, ...fields });
    return id;
  }

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
  ): void {
    const a = this.accommodations.find((x) => x.id === accommodationId);
    if (a) Object.assign(a, fields);
  }

  getStayCheckIn(accommodationId: number): string | null | undefined {
    return this.accommodations.find((a) => a.id === accommodationId)?.check_in;
  }

  stayOnTrip(accommodationId: unknown, tripId: number): boolean {
    return this.accommodations.some((a) => a.id === Number(accommodationId) && a.trip_id === tripId);
  }

  deleteStay(accommodationId: number, tripId: number): void {
    // Same two legs as the seam: trg_release_stop_on_stay_delete hands the
    // booking back to every referencing stop, reservations.accommodation_id
    // SET NULLs.
    for (const a of this.assignments) {
      if (a.accommodation_id === accommodationId) a.accommodation_id = null;
    }
    for (const r of this.reservations) {
      if (Number(r.accommodation_id) === accommodationId) r.accommodation_id = null;
    }
    this.accommodations = this.accommodations.filter((a) => !(a.id === accommodationId && a.trip_id === tripId));
  }

  syncStayTimes(
    accommodationId: number,
    meta: { check_in_time?: string | null; check_in_end_time?: string | null; check_out_time?: string | null }
  ): void {
    const a = this.accommodations.find((x) => x.id === accommodationId);
    if (!a) return;
    // COALESCE(?, col): a non-null incoming value overwrites, null keeps.
    if (meta.check_in_time != null) a.check_in = meta.check_in_time;
    if (meta.check_in_end_time != null) a.check_in_end = meta.check_in_end_time;
    if (meta.check_out_time != null) a.check_out = meta.check_out_time;
  }

  syncStayConfirmation(accommodationId: number, confirmation: string): void {
    const a = this.accommodations.find((x) => x.id === accommodationId);
    if (a) a.confirmation = confirmation;
  }

  insertReservation(fields: Omit<MemReservation, 'id'>): number {
    const id = nextId();
    this.reservations.push({ id, ...fields });
    return id;
  }

  applyReservationUpdate(id: number, resolved: Partial<MemReservation> & { needs_review: number | null }): void {
    const r = this.reservations.find((x) => x.id === id);
    if (!r) return;
    // The server's COALESCE(?, col) columns keep the old value on null.
    const row = r as unknown as Record<string, unknown>;
    const coalesce = <K extends 'title' | 'status' | 'type' | 'needs_review'>(key: K) => {
      const v = resolved[key];
      if (v !== null && v !== undefined) row[key] = v;
    };
    coalesce('title');
    coalesce('status');
    coalesce('type');
    if (resolved.needs_review !== null && resolved.needs_review !== undefined) r.needs_review = resolved.needs_review;
    // The rest are always-written resolved values.
    for (const key of [
      'reservation_time',
      'reservation_end_time',
      'location',
      'confirmation_number',
      'notes',
      'url',
      'day_id',
      'end_day_id',
      'place_id',
      'assignment_id',
      'accommodation_id',
      'metadata',
    ] as const) {
      if (key in resolved) row[key] = resolved[key as keyof typeof resolved];
    }
  }

  replaceEndpoints(reservationId: number, endpoints: ReservationEndpointInput[]): void {
    this.endpoints = this.endpoints.filter((e) => e.reservation_id !== reservationId);
    endpoints
      .filter((e) => e.lat != null && e.lng != null)
      .forEach((e, i) => {
        this.endpoints.push({
          id: nextId(),
          reservation_id: reservationId,
          role: e.role,
          sequence: e.sequence ?? i,
          name: e.name,
          code: e.code ?? null,
          lat: e.lat,
          lng: e.lng,
          timezone: e.timezone ?? null,
          local_time: e.local_time ?? null,
          local_date: e.local_date ?? null,
        });
      });
  }

  getReservation(id: number, tripId?: number): Record<string, unknown> | undefined {
    const r = this.reservations.find((x) => x.id === id && (tripId === undefined || x.trip_id === tripId));
    return r ? { ...(r as unknown as Record<string, unknown>) } : undefined;
  }

  listLinkedReservations(accommodationId: number) {
    return this.reservations
      .filter((r) => Number(r.accommodation_id) === accommodationId)
      .map((r) => ({ id: r.id, metadata: r.metadata }));
  }

  updateReservationMeta(reservationId: number, metadata: string, confirmation: string | null): void {
    const r = this.reservations.find((x) => x.id === reservationId);
    if (!r) return;
    r.metadata = metadata;
    if (confirmation != null) r.confirmation_number = confirmation;
  }

  findLinkedBudgetItem(tripId: number, reservationId: number) {
    const b = this.budgetItems.find((x) => x.trip_id === tripId && x.reservation_id === reservationId);
    return b ? { id: b.id, category: b.category } : undefined;
  }

  /** BudgetSyncStore.deleteBudgetItem (trip-scoped). */
  deleteBudgetItem(budgetItemId: number, _tripId?: number): void {
    this.budgetItems = this.budgetItems.filter((b) => b.id !== budgetItemId);
  }

  createLinkedBudgetItem(
    tripId: number,
    reservationId: number,
    data: { name: string; category: string; total_price: number }
  ): { id: number } {
    const id = nextId();
    this.budgetItems.push({ id, trip_id: tripId, reservation_id: reservationId, ...data });
    return { id };
  }

  createBudgetItem(tripId: number, data: { name: string; category: string; total_price: number }): { id: number } {
    const id = nextId();
    this.budgetItems.push({ id, trip_id: tripId, reservation_id: null, ...data });
    return { id };
  }

  updateBudgetItem(id: number, _tripId: number, data: { name?: string; category?: string; total_price?: number }) {
    const b = this.budgetItems.find((x) => x.id === id);
    if (!b) return null;
    Object.assign(b, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
    return { ...b };
  }

  linkBudgetItem(budgetItemId: number, reservationId: number): void {
    const b = this.budgetItems.find((x) => x.id === budgetItemId);
    if (b) b.reservation_id = reservationId;
  }

  deleteReservation(reservationId: number): void {
    this.reservations = this.reservations.filter((r) => r.id !== reservationId);
    this.endpoints = this.endpoints.filter((e) => e.reservation_id !== reservationId);
  }

  // ── SettlementStore ────────────────────────────────────────────────────────

  listSettlementRows(tripId: number): SettlementStoreRow[] {
    return this.settlements
      .filter((s) => String(s.trip_id) === String(tripId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  }

  getSettlementRow(id: number, tripId: number): SettlementStoreRow | undefined {
    return this.settlements.find((s) => s.id === id && String(s.trip_id) === String(tripId));
  }

  insertSettlementRow(tripId: number, data: SettlementWriteData, createdByUserId?: number): number {
    const id = nextId();
    this.settlements.push({
      id,
      trip_id: String(tripId),
      from_user_id: data.from_user_id,
      to_user_id: data.to_user_id,
      amount: Math.round(data.amount * 100) / 100,
      currency: data.currency ? data.currency.toUpperCase() : null,
      exchange_rate: data.exchange_rate != null ? data.exchange_rate : 1,
      settled_at: data.settled_at || null,
      created_by_user_id: createdByUserId ?? null,
      created_at: new Date().toISOString(),
      from_username: '',
      from_avatar: null,
      to_username: '',
      to_avatar: null,
    });
    return id;
  }

  applySettlementRowUpdate(id: number, tripId: number, data: SettlementWriteData): boolean {
    const s = this.getSettlementRow(id, tripId);
    if (!s) return false;
    s.from_user_id = data.from_user_id;
    s.to_user_id = data.to_user_id;
    s.amount = Math.round(data.amount * 100) / 100;
    if (data.currency !== undefined) s.currency = data.currency ? data.currency.toUpperCase() : null;
    if (data.exchange_rate !== undefined) s.exchange_rate = data.exchange_rate;
    if (data.settled_at !== undefined) s.settled_at = data.settled_at || null;
    return true;
  }

  deleteSettlementRow(id: number, tripId: number): boolean {
    const before = this.settlements.length;
    this.settlements = this.settlements.filter((s) => !(s.id === id && String(s.trip_id) === String(tripId)));
    return this.settlements.length < before;
  }

  rosterUserIds(): Set<number> {
    return new Set(this.roster ?? []);
  }

  /** Roster for settlementPartiesOnTrip; set in the fixture. */
  roster: number[] = [];

  // ── AirportBackfillStore (added when a test needs it) ──────────────────────

  listFlightReservationsWithoutEndpoints() {
    return this.reservations
      .filter((r) => r.type === 'flight' && !this.endpoints.some((e) => e.reservation_id === r.id))
      .map((r) => ({
        id: r.id,
        metadata: r.metadata,
        reservation_time: r.reservation_time,
        reservation_end_time: r.reservation_end_time,
      }));
  }

  insertEndpoint(row: Omit<MemEndpoint, 'id'>): void {
    this.endpoints.push({ id: nextId(), ...row });
  }

  markNeedsReview(reservationId: number): void {
    const r = this.reservations.find((x) => x.id === reservationId);
    if (r) r.needs_review = 1;
  }
}
