/**
 * The local Dexie-backed persistence seam. One class implements every store
 * interface the ported algorithms run against — the same way SQLite was one
 * connection behind every server prepare():
 *
 *   - DayOpsStore + AssignmentTimeStore  (ported/day-ops.ts, assignment-time.ts)
 *   - NightSeatStore + StayMirrorStore   (ported/night-seat.ts), via `.seat`
 *   - ReservationCascadeStore + BudgetSyncStore (ported/reservation-cascade.ts)
 *
 * plus the row access the trips/days adapters need (member/guest rows, cascades,
 * bundle joins, id allocation, the currency rebase).
 *
 * How it composes with the ports: `DexieStore.load()` reads the tables once
 * into Maps inside `db.transaction('rw', db.tables, ...)`. The caller then runs
 * the pure ports synchronously — every seam read is a Map lookup returning a
 * DETACHED snapshot (the ports scribble on rows as bookkeeping, exactly like
 * the server's SELECT rows), every seam write mutates the Map and marks the
 * key dirty. `flush()` bulk-puts mutated rows and bulk-deletes removed keys,
 * still inside the same IDB transaction — so a thrown port unwinds everything
 * by never reaching the write phase. `transaction()` gives the ports
 * nested-transaction semantics by checkpointing the Maps and restoring on
 * throw. `tests/unit/local/helpers/memoryStore.ts` is the semantic reference;
 * keep the two identical.
 *
 * Server-table ↔ local-row mapping: `day_assignments`, `day_notes` and
 * `roadtrip_vias` have no tables of their own — they embed on the `days` row
 * (`assignments`, `notes_items`, `vias`), which is the same shape remoteEvent-
 * Handler and upsertDays already write. `reservation_endpoints` and
 * `reservation_day_positions` embed on the `reservations` row (`endpoints`,
 * `day_positions`). Everything else maps 1:1 onto its Dexie table.
 *
 * Embedded collections allocate ids through `reserveIds` on synthetic names
 * ('days.assignments', 'days.notes', 'days.vias', 'reservations.endpoints'),
 * sharing the monotonic session counters with `nextId`.
 *
 * The self user is `localUsers` row 1 — the row `db/bootstrap.ts` seeds as
 * `{ id: 1, name: 'Me', is_self: 1 }`. The seam reads it from the loaded map
 * rather than importing bootstrap, keeping `api/local` out of the
 * `store/settingsStore → api/client` import cycle.
 */
import {
  db,
  type LocalPlace,
  type LocalTripMember,
  type SettingsRow,
} from '../../db/panelmintDb';
import type {
  Accommodation,
  Assignment,
  AssignmentParticipant,
  BudgetItem,
  BudgetSettlement,
  Category,
  Day,
  LocalUser,
  PackingBag,
  PackingBagMemberRow,
  PackingItem,
  Reservation,
  ReservationEndpoint,
  ReservationTravelerRow,
  Tag,
  TodoItem,
  Trip,
} from '../../types';
import type {
  PlaceCategory,
  PlaceRatingVote,
  ReservationTraveler,
  RoadtripVia,
  TripMember,
} from '@trek/shared';
import type { AnchoredVia } from '@trek/shared/roadtrip';
import { detached, detachedList, nowIso } from './helpers';
import { reserveIds } from './ids';
import type { DayOpsStore } from './ported/day-ops';
import type { AssignmentTimeStore, DayStopRow } from './ported/assignment-time';
import { staySeatDays } from './ported/night-seat';
import type {
  MirroredAssignment,
  PinnedVia,
  SeatRow,
  StayMirrorStore,
} from './ported/night-seat';
import type {
  AirportBackfillStore,
  BackfillCandidate,
} from './ported/airports';
import type {
  BudgetSyncStore,
  ReservationCascadeStore,
  ReservationEndpointInput,
  ResyncRow,
} from './ported/reservation-cascade';
import tzlookup from 'tz-lookup';

/** `localUsers` row the bootstrap seeds as the self profile. */
export const SELF_ID = 1;

/** A stored day row: the wire `Day` plus the embedded `vias` array. */
export type DayRow = Day & { vias?: RoadtripVia[] };

/**
 * An embedded day_assignments row — the server's columns (id, day_id,
 * place_id, order_index, notes, reservation_status, reservation_notes,
 * reservation_datetime, assignment_time, assignment_end_time, end_day,
 * accommodation_id, leg_transport_mode, incoming_leg_transport_mode,
 * created_at). `place`/`participants` are joins, resolved at read.
 */
export interface StoredAssignment {
  id: number;
  day_id: number;
  place_id: number;
  order_index: number;
  notes: string | null;
  reservation_status: string | null;
  reservation_notes: string | null;
  reservation_datetime: string | null;
  assignment_time: string | null;
  assignment_end_time: string | null;
  end_day: number;
  accommodation_id: number | null;
  leg_transport_mode: string | null;
  incoming_leg_transport_mode: string | null;
  created_at: string;
}

/** A stored reservation row: server columns plus the embedded endpoint rows
 *  and the day_positions map (`Record<dayId, position>`). */
export type ReservationRow = Reservation & {
  endpoints?: ReservationEndpoint[];
  day_positions?: Record<string, number> | null;
};

/**
 * The server's place-list wire row (`SELECT p.*` + the category join): every
 * stored column is present on the wire — an unset column reads null, never
 * absent — plus the flat `category_*` join fields, the nested `category`
 * object, `tags`, `ratings` and the aggregate pair. `my_rating` is the local
 * fold of place_ratings and stays off the wire.
 */
export type PlaceWire = Omit<LocalPlace, 'my_rating'> & {
  description: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  category_id: number | null;
  price: number | null;
  currency: string | null;
  reservation_status: string | null;
  reservation_notes: string | null;
  reservation_datetime: string | null;
  place_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  notes: string | null;
  image_url: string | null;
  google_place_id: string | null;
  google_ftid: string | null;
  osm_id: string | null;
  amap_poi_id: string | null;
  website: string | null;
  phone: string | null;
  transport_mode: string | null;
  route_geometry: string | null;
  route_color: string | null;
  stop_type: LocalPlace['stop_type'];
  fill_percent: number | null;
  source: string | null;
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
  category: PlaceCategory | null;
  tags: Tag[];
  ratings: PlaceRatingVote[];
  rating_avg: number | null;
  rating_count: number;
};

/** Tables the seam mirrors. One entry per panelmintDb table. */
type TableName =
  | 'trips'
  | 'days'
  | 'places'
  | 'reservations'
  | 'accommodations'
  | 'budgetItems'
  | 'budgetSettlements'
  | 'packingItems'
  | 'packingBags'
  | 'packingBagMembers'
  | 'todoItems'
  | 'localUsers'
  | 'tripMembers'
  | 'reservationTravelers'
  | 'assignmentParticipants'
  | 'packingCategoryAssignees'
  | 'todoCategoryAssignees'
  | 'categories'
  | 'tags'
  | 'settings'
  | 'syncMeta';

const TABLE_NAMES: TableName[] = [
  'trips',
  'days',
  'places',
  'reservations',
  'accommodations',
  'budgetItems',
  'budgetSettlements',
  'packingItems',
  'packingBags',
  'packingBagMembers',
  'todoItems',
  'localUsers',
  'tripMembers',
  'reservationTravelers',
  'assignmentParticipants',
  'packingCategoryAssignees',
  'todoCategoryAssignees',
  'categories',
  'tags',
  'settings',
  'syncMeta',
];

type RowMap = Map<unknown, unknown>;

interface State {
  maps: Record<TableName, RowMap>;
  /** Canonical keys (compound keys joined) written since load, per table. */
  mutated: Map<TableName, Set<unknown>>;
  /** Canonical keys deleted since load — `realKey` restores the compound
   *  array form for `bulkDelete` at flush time. */
  deleted: Map<TableName, Set<unknown>>;
}

function cloneState(state: State): State {
  const maps = {} as Record<TableName, RowMap>;
  for (const name of TABLE_NAMES) maps[name] = structuredClone(state.maps[name]);
  return {
    maps,
    mutated: structuredClone(state.mutated),
    deleted: structuredClone(state.deleted),
  };
}

/** The Dexie PK of a row — compound for the natural-key junction tables. */
function dexieKey(name: TableName, row: unknown): unknown {
  const r = row as Record<string, unknown>;
  switch (name) {
    case 'tripMembers':
      return [r.tripId, r.id];
    case 'packingBagMembers':
      return [r.bag_id, r.user_id];
    case 'settings':
      return r.key;
    case 'syncMeta':
      return r.tripId;
    default:
      return r.id;
  }
}

/**
 * The canonical form a Map/Set can compare: compound keys join to `'a:b'`
 * (both compound tables key on numeric pairs), scalars pass through. Every
 * snapshot Map is keyed by this, and `mutated`/`deleted` track it too — an
 * array key in a Set would compare by identity and silently lose writes.
 */
function canonKey(key: unknown): unknown {
  return Array.isArray(key) ? key.join(':') : key;
}

/** Inverse of canonKey for the compound-key tables — `bulkDelete` wants the
 *  real `[a, b]` array back. Scalar-keyed tables pass through unchanged. */
function realKey(name: TableName, canon: unknown): unknown {
  if ((name === 'tripMembers' || name === 'packingBagMembers') && typeof canon === 'string') {
    return canon.split(':').map(Number);
  }
  return canon;
}

export class DexieStore
  implements
    DayOpsStore,
    StayMirrorStore,
    AssignmentTimeStore,
    ReservationCascadeStore,
    BudgetSyncStore,
    AirportBackfillStore
{
  private state: State;
  /** Highest id already persisted per table / embedded collection. */
  private maxStored = new Map<string, number>();

  private constructor(state: State) {
    this.state = state;
  }

  /**
   * Load every table into the snapshot. Call inside `runLocal`'s
   * `db.transaction('rw', db.tables, …)` so the subsequent `flush()` lands in
   * the same atomic commit.
   */
  static async load(): Promise<DexieStore> {
    const state: State = {
      maps: {} as Record<TableName, RowMap>,
      mutated: new Map(),
      deleted: new Map(),
    };
    const store = new DexieStore(state);
    await Promise.all(
      TABLE_NAMES.map(async (name) => {
        const rows = (await db.table(name).toArray()) as Record<string, unknown>[];
        const map: RowMap = new Map();
        for (const row of rows) {
          map.set(canonKey(dexieKey(name, row)), row);
        }
        state.maps[name] = map;
      }),
    );
    store.seedCounters();
    return store;
  }

  /** The stay-mirror seam is this store itself — the way MemoryStore does it. */
  get seat(): StayMirrorStore {
    return this;
  }

  /** Nested-transaction semantics for the ports: checkpoint, run, restore on
   *  throw. Snapshot cost is trip-scale small. */
  transaction<T>(fn: () => T): T {
    const checkpoint = cloneState(this.state);
    try {
      return fn();
    } catch (err) {
      this.state = checkpoint;
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Snapshot plumbing
  // ------------------------------------------------------------------

  private map(name: TableName): RowMap {
    return this.state.maps[name];
  }

  private seedCounters(): void {
    const embedded: Record<string, number> = {
      'days.assignments': 0,
      'days.notes': 0,
      'days.vias': 0,
      'reservations.endpoints': 0,
    };
    for (const day of this.daysMap().values()) {
      for (const a of this.assignmentsOf(day)) embedded['days.assignments'] = Math.max(embedded['days.assignments'], a.id);
      for (const n of day.notes_items ?? []) embedded['days.notes'] = Math.max(embedded['days.notes'], n.id);
      for (const v of day.vias ?? []) embedded['days.vias'] = Math.max(embedded['days.vias'], v.id ?? 0);
    }
    for (const r of (this.map('reservations') as Map<number, ReservationRow>).values()) {
      for (const e of r.endpoints ?? []) embedded['reservations.endpoints'] = Math.max(embedded['reservations.endpoints'], e.id ?? 0);
    }
    for (const name of TABLE_NAMES) {
      let max = 0;
      for (const row of this.map(name).values()) {
        const id = (row as { id?: unknown }).id;
        if (typeof id === 'number' && Number.isFinite(id)) max = Math.max(max, id);
      }
      this.maxStored.set(name, max);
      reserveIds(name, max, 0);
    }
    for (const [name, max] of Object.entries(embedded)) {
      this.maxStored.set(name, max);
      reserveIds(name, max, 0);
    }
  }

  /** Reserve the next id for a table or embedded collection. */
  allocId(name: string): number {
    const id = reserveIds(name, this.maxStored.get(name) ?? 0, 1)[0];
    this.maxStored.set(name, id);
    return id;
  }

  private mark(set: Map<TableName, Set<unknown>>, name: TableName, key: unknown): void {
    let s = set.get(name);
    if (!s) {
      s = new Set();
      set.set(name, s);
    }
    s.add(key);
  }

  /** Write a row: update the Map and mark its (canonical) key for bulkPut. */
  put<T>(name: TableName, row: T): T {
    const key = canonKey(dexieKey(name, row));
    this.map(name).set(key, row);
    this.mark(this.state.mutated, name, key);
    this.state.deleted.get(name)?.delete(key);
    return row;
  }

  /** Delete a row by row object or by its real Dexie key. A NaN component is
   *  the NULL-bound delete the server ran (matched nothing, still 200) — it is
   *  dropped from the delete set because IndexedDB rejects NaN keys outright. */
  delete(name: TableName, keyOrRow: unknown): void {
    const raw =
      keyOrRow !== null && typeof keyOrRow === 'object' && !Array.isArray(keyOrRow)
        ? dexieKey(name, keyOrRow)
        : keyOrRow;
    const key = canonKey(raw);
    this.map(name).delete(key);
    this.state.mutated.get(name)?.delete(key);
    const bad = (k: unknown) => typeof k === 'number' && !Number.isFinite(k);
    if (Array.isArray(raw) ? raw.some(bad) : bad(raw)) return;
    this.mark(this.state.deleted, name, key);
  }

  /** Persist the mutated/deleted rows. Must run inside the same transaction
   *  that loaded this store. */
  async flush(): Promise<void> {
    for (const name of TABLE_NAMES) {
      const mutated = this.state.mutated.get(name);
      const deleted = this.state.deleted.get(name);
      if (!mutated?.size && !deleted?.size) continue;
      const table = db.table(name);
      if (deleted?.size) {
        await table.bulkDelete([...deleted].map((k) => realKey(name, k)) as never[]);
      }
      if (mutated?.size) {
        const puts: unknown[] = [];
        for (const row of this.map(name).values()) {
          if (mutated.has(canonKey(dexieKey(name, row)))) puts.push(row);
        }
        if (name === 'days') {
          // The &[trip_id+day_number] unique index checks each put against the
          // still-stored rows, so renumbering in place collides mid-batch even
          // though the in-map two-phase already parked every row on a negative
          // number. Delete the mutated ids first (same transaction — no
          // observer sees the gap), then put the final rows.
          await table.bulkDelete(puts.map((r) => (r as { id: number }).id) as never[]);
        }
        await table.bulkPut(puts as never[]);
      }
    }
  }

  // ------------------------------------------------------------------
  // Row accessors shared by the seams and the adapters
  // ------------------------------------------------------------------

  private daysMap(): Map<number, DayRow> {
    return this.map('days') as Map<number, DayRow>;
  }

  private placesMap(): Map<number, LocalPlace> {
    return this.map('places') as Map<number, LocalPlace>;
  }

  private reservationsMap(): Map<number, ReservationRow> {
    return this.map('reservations') as Map<number, ReservationRow>;
  }

  private accommodationsMap(): Map<number, Accommodation> {
    return this.map('accommodations') as Map<number, Accommodation>;
  }

  private budgetItemsMap(): Map<number, BudgetItem> {
    return this.map('budgetItems') as Map<number, BudgetItem>;
  }

  private usersMap(): Map<number, LocalUser> {
    return this.map('localUsers') as Map<number, LocalUser>;
  }

  private membersMap(): Map<string, LocalTripMember> {
    return this.map('tripMembers') as Map<string, LocalTripMember>;
  }

  private assignmentsOf(day: DayRow | undefined): StoredAssignment[] {
    if (!day) return [];
    if (!day.assignments) day.assignments = [];
    return day.assignments as unknown as StoredAssignment[];
  }

  private assignmentRows(): StoredAssignment[] {
    const out: StoredAssignment[] = [];
    for (const day of this.daysMap().values()) out.push(...this.assignmentsOf(day));
    return out;
  }

  private findAssignment(id: unknown): { day: DayRow; assignment: StoredAssignment } | undefined {
    const numeric = typeof id === 'string' ? Number(id) : id;
    for (const day of this.daysMap().values()) {
      const a = this.assignmentsOf(day).find((x) => x.id === numeric);
      if (a) return { day, assignment: a };
    }
    return undefined;
  }

  private place(id: number | null | undefined): LocalPlace | undefined {
    return id == null ? undefined : this.placesMap().get(id);
  }

  private placeHasCoords(placeId: number | null | undefined): boolean {
    const p = this.place(placeId);
    return p?.lat != null && p?.lng != null;
  }

  /** `located` the way the server computes it: the stop's place carries both
   *  coordinates. A missing place (shouldn't happen — place_id is a FK) is not
   *  located. */
  private isLocated(a: StoredAssignment): number {
    return this.placeHasCoords(a.place_id) ? 1 : 0;
  }

  /** The joined place block both assignment projections share (the server's
   *  `p.*` select list): times COALESCE the assignment override over the place
   *  default, category/tags ride along, `fill_percent` is the list-only field. */
  private assignmentPlace(
    a: StoredAssignment,
    p: LocalPlace,
    withFillPercent: boolean,
  ): Record<string, unknown> {
    const cat =
      p.category_id != null ? (this.map('categories') as Map<number, Category>).get(p.category_id) : undefined;
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      address: p.address ?? null,
      category_id: p.category_id ?? null,
      price: p.price ?? null,
      currency: p.currency ?? null,
      place_time: a.assignment_time ?? p.place_time ?? null,
      end_time: a.assignment_end_time ?? p.end_time ?? null,
      duration_minutes: p.duration_minutes ?? null,
      notes: p.notes ?? null,
      image_url: p.image_url ?? null,
      transport_mode: p.transport_mode ?? null,
      google_place_id: p.google_place_id ?? null,
      google_ftid: p.google_ftid ?? null,
      osm_id: p.osm_id ?? null,
      amap_poi_id: p.amap_poi_id ?? null,
      website: p.website ?? null,
      phone: p.phone ?? null,
      stop_type: p.stop_type ?? null,
      ...(withFillPercent ? { fill_percent: p.fill_percent ?? null } : {}),
      category: cat ? { id: cat.id, name: cat.name, color: cat.color, icon: cat.icon } : null,
      tags: p.tags ?? [],
    };
  }

  /**
   * `formatAssignmentWithPlace` — the day-list projection. The server's
   * `JOIN places` is an inner join, so a stop whose place is gone does not
   * come back at all: `null` here means "skip".
   */
  private assignmentWire(a: StoredAssignment): Assignment | null {
    const p = this.place(a.place_id);
    if (!p) return null;
    const participants = this.participantsOf(a.id);
    return detached({
      id: a.id,
      day_id: a.day_id,
      place_id: a.place_id,
      order_index: a.order_index,
      notes: a.notes ?? null,
      assignment_time: a.assignment_time ?? null,
      assignment_end_time: a.assignment_end_time ?? null,
      end_day: a.end_day === 1,
      leg_transport_mode: a.leg_transport_mode ?? null,
      incoming_leg_transport_mode: a.incoming_leg_transport_mode ?? null,
      accommodation_id: a.accommodation_id ?? null,
      participants,
      created_at: a.created_at,
      place: this.assignmentPlace(a, p, true),
    } as Assignment);
  }

  /**
   * `DaysService.getAssignmentsForDay` — the slimmer projection the day
   * update/transport responses carried (no top-level place_id, no times or
   * participants, no place.fill_percent). Kept distinct from the list shape —
   * callers merge the returned day over the listed one.
   */
  private assignmentWireForDayUpdate(a: StoredAssignment): Record<string, unknown> | null {
    const p = this.place(a.place_id);
    if (!p) return null;
    return detached({
      id: a.id,
      day_id: a.day_id,
      order_index: a.order_index,
      end_day: a.end_day === 1,
      notes: a.notes ?? null,
      accommodation_id: a.accommodation_id ?? null,
      created_at: a.created_at,
      place: this.assignmentPlace(a, p, false),
    });
  }

  private storedAssignmentsInOrder(dayId: number): StoredAssignment[] {
    const day = this.daysMap().get(dayId);
    if (!day) return [];
    return this.assignmentsOf(day)
      .filter((a) => a.day_id === dayId)
      .sort((a, b) => a.order_index - b.order_index || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id);
  }

  // ==================================================================
  // NightSeatStore (ported/night-seat.ts)
  // ==================================================================

  /** The day's stops in order, each measured by the accommodation's check-in
   *  for a booking-owned stop, else its own time, else the place's. */
  dayStops(dayId: number): SeatRow[] {
    const day = this.daysMap().get(dayId);
    if (!day) return [];
    return this.assignmentsOf(day)
      .filter((a) => a.day_id === dayId)
      .sort((a, b) => a.order_index - b.order_index || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id)
      .map((a) => {
        const night =
          a.accommodation_id != null ? this.accommodationsMap().get(a.accommodation_id) : undefined;
        const p = this.place(a.place_id);
        return {
          id: a.id,
          order_index: a.order_index,
          at: night ? (night.check_in ?? null) : (a.assignment_time ?? p?.place_time ?? null),
          night_id: a.accommodation_id,
          located: this.isLocated(a),
        };
      });
  }

  listVias(dayId: number): PinnedVia[] {
    const day = this.daysMap().get(dayId);
    return (day?.vias ?? [])
      .filter((v) => v.after_order_index != null)
      .map((v) => ({ id: v.id!, after_order_index: v.after_order_index, sequence: v.sequence }));
  }

  closeOrderGap(dayId: number, afterOrderIndex: number): void {
    const day = this.daysMap().get(dayId);
    if (!day) return;
    let touched = false;
    for (const a of this.assignmentsOf(day)) {
      if (a.day_id === dayId && a.order_index > afterOrderIndex) {
        a.order_index -= 1;
        touched = true;
      }
    }
    if (touched) this.put('days', day);
  }

  maxOrderIndex(dayId: number, excludeId?: number): number | null {
    const day = this.daysMap().get(dayId);
    const inDay = this.assignmentsOf(day).filter((a) => a.day_id === dayId && a.id !== excludeId);
    return inDay.length ? Math.max(...inDay.map((a) => a.order_index)) : null;
  }

  moveStop(stopId: number, dayId: number, placeId: number, orderIndex: number): void {
    const ref = this.findAssignment(stopId);
    if (!ref) return;
    const { day, assignment } = ref;
    if (day.id !== dayId) {
      // Cross-day move: the row rides along (its booking link and times too).
      day.assignments = this.assignmentsOf(day).filter((a) => a.id !== stopId) as unknown as Assignment[];
      this.put('days', day);
      const target = this.daysMap().get(dayId);
      if (!target) return;
      assignment.day_id = dayId;
      assignment.place_id = placeId;
      assignment.order_index = orderIndex;
      this.assignmentsOf(target).push(assignment);
      this.put('days', target);
      return;
    }
    assignment.place_id = placeId;
    assignment.order_index = orderIndex;
    this.put('days', day);
  }

  bumpOrderIndexes(dayId: number, fromOrderIndex: number, excludeId?: number): void {
    const day = this.daysMap().get(dayId);
    if (!day) return;
    let touched = false;
    for (const a of this.assignmentsOf(day)) {
      if (a.day_id === dayId && a.order_index >= fromOrderIndex && a.id !== excludeId) {
        a.order_index += 1;
        touched = true;
      }
    }
    if (touched) this.put('days', day);
  }

  setViaLeg(viaId: number, dayId: number, afterOrderIndex: number): void {
    const day = this.daysMap().get(dayId);
    const via = day?.vias?.find((v) => v.id === viaId);
    if (day && via) {
      via.after_order_index = afterOrderIndex;
      this.put('days', day);
    }
  }

  setViaSequence(viaId: number, dayId: number, sequence: number): void {
    const day = this.daysMap().get(dayId);
    const via = day?.vias?.find((v) => v.id === viaId);
    if (day && via) {
      via.sequence = sequence;
      this.put('days', day);
    }
  }

  deleteVia(viaId: number, dayId: number): void {
    const day = this.daysMap().get(dayId);
    if (!day) return;
    day.vias = (day.vias ?? []).filter((v) => v.id !== viaId);
    this.put('days', day);
  }

  // ==================================================================
  // StayMirrorStore (ported/night-seat.ts) — same object as `.seat`
  // ==================================================================

  /** The day stops a booking put there itself (accommodation_id = id). */
  ownStops(
    accommodationId: number,
    excludeDayId?: number,
  ): { id: number; day_id: number; place_id: number; order_index: number }[] {
    return this.assignmentRows()
      .filter((a) => a.accommodation_id === accommodationId && (excludeDayId === undefined || a.day_id !== excludeDayId))
      .map((a) => ({ id: a.id, day_id: a.day_id, place_id: a.place_id, order_index: a.order_index }));
  }

  dayHasPlace(dayId: number, placeId: number, excludeId?: number): boolean {
    const day = this.daysMap().get(dayId);
    return this.assignmentsOf(day).some(
      (a) => a.day_id === dayId && a.place_id === placeId && a.id !== excludeId,
    );
  }

  placeStopType(placeId: number): string | null | undefined {
    const p = this.place(placeId);
    if (!p) return undefined;
    return p.stop_type ?? null;
  }

  stampPlaceLodging(placeId: number): void {
    const p = this.place(placeId);
    if (p) {
      p.stop_type = 'hotel';
      this.put('places', p);
    }
  }

  getPlaceForMirror(placeId: number): unknown | null {
    const p = this.place(placeId);
    return p ? this.placeWire(p) : null;
  }

  /** The server's createAssignment: clamp into [0, end], shift the rest down. */
  insertOwnedStop(dayId: number, placeId: number, orderIndex: number, accommodationId: number): number {
    return this.insertStop(dayId, placeId, orderIndex, null, accommodationId);
  }

  /** The INSERT half of createAssignment, shared by insertOwnedStop
   *  (booking-owned) and insertTravellerStop (the REST route). An
   *  `orderIndex` clamps into [0, end] and shifts the rest down; undefined
   *  appends, which is what every caller but one asked for. */
  private insertStop(
    dayId: number,
    placeId: number,
    orderIndex: number | undefined,
    notes: string | null,
    accommodationId: number | null,
  ): number {
    const day = this.daysMap().get(dayId);
    if (!day) return -1;
    const end = (this.maxOrderIndex(dayId) ?? -1) + 1;
    const at = orderIndex !== undefined ? Math.max(0, Math.min(orderIndex, end)) : end;
    if (at < end) this.bumpOrderIndexes(dayId, at);
    const id = this.allocId('days.assignments');
    this.assignmentsOf(day).push({
      id,
      day_id: dayId,
      place_id: placeId,
      order_index: at,
      notes,
      reservation_status: 'none',
      reservation_notes: null,
      reservation_datetime: null,
      assignment_time: null,
      assignment_end_time: null,
      end_day: 0,
      accommodation_id: accommodationId,
      leg_transport_mode: null,
      incoming_leg_transport_mode: null,
      created_at: nowIso(),
    });
    this.put('days', day);
    return id;
  }

  deleteStop(stopId: number): void {
    const ref = this.findAssignment(stopId);
    if (!ref) return;
    ref.day.assignments = this.assignmentsOf(ref.day).filter((a) => a.id !== stopId) as unknown as Assignment[];
    this.put('days', ref.day);
    const participants = this.map('assignmentParticipants') as Map<number, { assignment_id: number }>;
    for (const [k, p] of [...participants]) {
      if (p.assignment_id === stopId) this.delete('assignmentParticipants', k);
    }
  }

  /** Hand a stop back to the traveller: clear its booking link. */
  releaseStop(stopId: number): void {
    const ref = this.findAssignment(stopId);
    if (ref) {
      ref.assignment.accommodation_id = null;
      this.put('days', ref.day);
    }
  }

  getStopForMirror(stopId: number): MirroredAssignment | null {
    const ref = this.findAssignment(stopId);
    if (!ref) return null;
    return this.assignmentWire(ref.assignment) as MirroredAssignment | null;
  }

  /** The day's vias in broadcast shape: leg position, then sequence, then id. */
  listDayVias(dayId: number): RoadtripVia[] {
    const day = this.daysMap().get(dayId);
    return detachedList(day?.vias ?? []).sort(
      (a, b) => a.after_order_index - b.after_order_index || a.sequence - b.sequence || (a.id ?? 0) - (b.id ?? 0),
    );
  }

  // ==================================================================
  // AssignmentTimeStore (ported/assignment-time.ts)
  // ==================================================================

  /** The stop being edited: COALESCE(assignment_time, place_time, stay check_in). */
  getStopForTime(id: number): { day_id: number; start: string | null } | undefined {
    const ref = this.findAssignment(id);
    if (!ref) return undefined;
    const a = ref.assignment;
    const acc = a.accommodation_id != null ? this.accommodationsMap().get(a.accommodation_id) : undefined;
    const p = this.place(a.place_id);
    return { day_id: a.day_id, start: a.assignment_time ?? p?.place_time ?? acc?.check_in ?? null };
  }

  setAssignmentTimes(id: number, start: string | null, end: string | null): void {
    const ref = this.findAssignment(id);
    if (!ref) return;
    ref.assignment.assignment_time = start;
    ref.assignment.assignment_end_time = end;
    this.put('days', ref.day);
  }

  listDayStops(dayId: number): DayStopRow[] {
    const day = this.daysMap().get(dayId);
    if (!day) return [];
    return this.assignmentsOf(day)
      .filter((a) => a.day_id === dayId)
      .sort((a, b) => a.order_index - b.order_index || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id)
      .map((a) => {
        const acc = a.accommodation_id != null ? this.accommodationsMap().get(a.accommodation_id) : undefined;
        const p = this.place(a.place_id);
        return {
          id: a.id,
          order_index: a.order_index,
          effective_time: a.assignment_time ?? p?.place_time ?? acc?.check_in ?? null,
          located: this.isLocated(a),
        };
      });
  }

  setOrderIndex(stopId: number, orderIndex: number): void {
    const ref = this.findAssignment(stopId);
    if (ref) {
      ref.assignment.order_index = orderIndex;
      this.put('days', ref.day);
    }
  }

  listAnchoredVias(dayId: number): AnchoredVia[] {
    const day = this.daysMap().get(dayId);
    return (day?.vias ?? [])
      .filter((v) => v.after_order_index != null)
      .map((v) => ({ id: v.id!, after_order_index: v.after_order_index, lat: v.lat, lng: v.lng }));
  }

  getAssignment(id: number): unknown {
    const ref = this.findAssignment(id);
    return ref ? this.assignmentWire(ref.assignment) : null;
  }

  // ==================================================================
  // Assignments adapter (api/local/assignments.ts) — the seam the REST
  // surface runs on; not part of a ported store interface.
  // ==================================================================

  /** The server's getAssignmentForTrip JOIN (`JOIN days ON d.trip_id`) —
   *  the stored row plus the day it sits on, so the adapter reads trip_id
   *  and day_id for its guards and patches then flushes the row through
   *  put('days', day). */
  assignmentRef(id: unknown): { day: DayRow; assignment: StoredAssignment } | undefined {
    return this.findAssignment(id);
  }

  /** REST createAssignment — the route never sends an order index, so the
   *  stop always lands at the end; it carries the caller's note and stays
   *  traveller-owned (accommodation_id null), unlike insertOwnedStop's
   *  booking-owned stops. */
  insertTravellerStop(dayId: number, placeId: number, notes: string | null): number {
    return this.insertStop(dayId, placeId, undefined, notes, null);
  }

  /** The server's reorderAssignments — `UPDATE day_assignments SET
   *  order_index = ? WHERE id = ? AND day_id = ?` per listed id, in array
   *  order. An id that is not on this day (foreign or nonexistent) is a
   *  silent no-op that still consumes its slot — no permutation check. */
  reorderDayStops(dayId: number, orderedIds: number[]): void {
    const day = this.daysMap().get(dayId);
    if (!day) return;
    let touched = false;
    orderedIds.forEach((stopId, index) => {
      const a = this.assignmentsOf(day).find((x) => x.id === stopId && x.day_id === dayId);
      if (!a) return;
      a.order_index = index;
      touched = true;
    });
    if (touched) this.put('days', day);
  }

  /** The server's rosterUserIds — trip_members.user_id ∪ trips.user_id. */
  rosterUserIds(tripId: number): Set<number> {
    const ids = new Set<number>();
    const trip = this.tripRaw(tripId);
    if (trip) ids.add(trip.user_id);
    for (const m of this.memberRows(tripId)) ids.add(m.id);
    return ids;
  }

  /** The server's setParticipants junction rewrite — DELETE every row of
   *  the assignment, then INSERT OR IGNORE each scoped id; the Set is the
   *  UNIQUE(assignment_id, user_id) collapse INSERT OR IGNORE performed. */
  setAssignmentParticipants(assignmentId: number, userIds: number[]): void {
    const participants = this.map('assignmentParticipants') as Map<
      number,
      { assignment_id: number; user_id: number }
    >;
    for (const [k, p] of [...participants]) {
      if (p.assignment_id === assignmentId) this.delete('assignmentParticipants', k);
    }
    for (const userId of new Set(userIds)) {
      this.put('assignmentParticipants', {
        id: this.allocId('assignmentParticipants'),
        assignment_id: assignmentId,
        user_id: userId,
      });
    }
  }

  /** Participant rows in the wire projection — the server's
   *  `COALESCE(u.display_name, u.username) AS username, u.avatar` join.
   *  Local users have no avatar (always null); a missing user keeps the
   *  same 'Guest N' fallback assignmentWire uses. */
  participantsOf(assignmentId: number): AssignmentParticipant[] {
    return this.assignmentParticipantRows()
      .filter((r) => r.assignment_id === assignmentId)
      .map((r): AssignmentParticipant => {
        const u = this.usersMap().get(r.user_id);
        return { user_id: r.user_id, username: u?.name ?? `Guest ${r.user_id}`, avatar: null };
      });
  }

  // ==================================================================
  // DayOpsStore (ported/day-ops.ts)
  // ==================================================================

  listDays(tripId: number): { id: number; day_number: number; date: string | null }[] {
    return this.daysOfTrip(tripId).map((d) => ({ id: d.id, day_number: d.day_number!, date: d.date ?? null }));
  }

  listReservationDates(tripId: number): {
    id: number;
    day_id: number | null;
    end_day_id: number | null;
    reservation_time: string | null;
    reservation_end_time: string | null;
  }[] {
    return this.reservationsOfTrip(tripId).map((r) => ({
      id: r.id,
      day_id: r.day_id ?? null,
      end_day_id: r.end_day_id ?? null,
      reservation_time: r.reservation_time ?? null,
      reservation_end_time: r.reservation_end_time ?? null,
    }));
  }

  listEndpoints(reservationId: number): { id: number; local_date: string | null }[] {
    const r = this.reservationsMap().get(reservationId);
    return (r?.endpoints ?? []).map((e) => ({ id: e.id!, local_date: e.local_date }));
  }

  /** Accommodation spans as day numbers (the server's start_no/end_no join;
   *  a missing day row reads as 0, matching the LEFT JOIN's NULL→0 fixture). */
  listStaySpans(tripId: number): { id: number; start_no: number; end_no: number }[] {
    return this.accommodationsOfTrip(tripId).map((a) => ({
      id: a.id,
      start_no: this.daysMap().get(a.start_day_id)?.day_number ?? 0,
      end_no: this.daysMap().get(a.end_day_id)?.day_number ?? 0,
    }));
  }

  listStays(tripId: number): { id: number; start_day_id: number; end_day_id: number; check_in: string | null }[] {
    return this.accommodationsOfTrip(tripId).map((a) => ({
      id: a.id,
      start_day_id: a.start_day_id,
      end_day_id: a.end_day_id,
      check_in: a.check_in ?? null,
    }));
  }

  findDayByDate(tripId: number, date: string): { id: number; day_number: number } | undefined {
    const d = this.daysOfTrip(tripId).find((x) => x.date === date);
    return d ? { id: d.id, day_number: d.day_number! } : undefined;
  }

  getDayDate(dayId: number): string | null | undefined {
    return this.daysMap().get(dayId)?.date;
  }

  setDayNumber(dayId: number, dayNumber: number): void {
    const d = this.daysMap().get(dayId);
    if (d) {
      d.day_number = dayNumber;
      this.put('days', d);
    }
  }

  setDayNumberAndDate(dayId: number, dayNumber: number, date: string | null): void {
    const d = this.daysMap().get(dayId);
    if (d) {
      d.day_number = dayNumber;
      d.date = date;
      this.put('days', d);
    }
  }

  /** Insert a bare day row — the seam's own INSERT (trip_id, day_number, date).
   *  The server table has no timestamps, so none are written here. */
  insertDay(tripId: number, dayNumber: number, date: string | null): number {
    const id = this.allocId('days');
    this.put('days', {
      id,
      trip_id: tripId,
      day_number: dayNumber,
      date,
      title: null,
      notes: null,
      default_transport_mode: null,
      assignments: [],
      notes_items: [],
      vias: [],
    } as DayRow);
    return id;
  }

  setReservationTime(reservationId: number, time: string | null): void {
    const r = this.reservationsMap().get(reservationId);
    if (r) {
      r.reservation_time = time;
      this.put('reservations', r);
    }
  }

  setReservationEndTime(reservationId: number, time: string | null): void {
    const r = this.reservationsMap().get(reservationId);
    if (r) {
      r.reservation_end_time = time;
      this.put('reservations', r);
    }
  }

  setEndpointDate(endpointId: number, date: string | null): void {
    for (const r of this.reservationsMap().values()) {
      const e = r.endpoints?.find((x) => x.id === endpointId);
      if (e) {
        e.local_date = date;
        this.put('reservations', r);
        return;
      }
    }
  }

  updateStayDays(accommodationId: number, startDayId: number, endDayId: number): void {
    const a = this.accommodationsMap().get(accommodationId);
    if (a) {
      a.start_day_id = startDayId;
      a.end_day_id = endDayId;
      this.put('accommodations', a);
    }
  }

  /** The server's linked-hotel restamp: reservations on accommodation_id get
   *  day_id = dayId and reservation_time's date part replaced, time-of-day
   *  preserved (SUBSTR(x,11) → slice(10)). */
  restampLinkedHotelReservations(accommodationId: number, dayId: number, date: string): void {
    for (const r of this.reservationsMap().values()) {
      if (r.type !== 'hotel' || r.accommodation_id == null || Number(r.accommodation_id) !== accommodationId) continue;
      r.day_id = dayId;
      r.reservation_time = r.reservation_time == null ? date : date + r.reservation_time.slice(10);
      this.put('reservations', r);
    }
  }

  setTripEndDate(tripId: number, date: string): void {
    const t = this.tripsMap().get(tripId);
    if (t) {
      t.end_date = date;
      this.put('trips', t);
    }
  }

  // ==================================================================
  // ReservationCascadeStore (ported/reservation-cascade.ts)
  // ==================================================================

  dayByDate(tripId: number, date: string): { id: number } | undefined {
    const d = this.daysOfTrip(tripId).find((x) => x.date === date);
    return d ? { id: d.id } : undefined;
  }

  /** ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?)) ASC, date ASC LIMIT 1 —
   *  verbatim SQLite: JULIANDAY(NULL) is NULL and NULL keys sort first under
   *  ASC, so a dateless day always wins nearest-day when one exists (ties
   *  among them resolve in rowid order — the day id). */
  nearestDay(tripId: number, date: string): { id: number } | undefined {
    const ms = (d: string | null | undefined) => (d ? Date.parse(`${d}T00:00:00Z`) : Number.NaN);
    const target = ms(date);
    const days = this.daysOfTrip(tripId);
    const dateless = days.filter((d) => !d.date).sort((a, b) => a.id - b.id);
    if (dateless[0]) return { id: dateless[0].id };
    const sorted = days
      .filter((d) => d.date)
      .sort(
        (a, b) =>
          Math.abs(ms(a.date) - target) - Math.abs(ms(b.date) - target) ||
          (a.date! < b.date! ? -1 : 1),
      );
    return sorted[0] ? { id: sorted[0].id } : undefined;
  }

  /** The `[start_day, end_day)` slice of this trip's days in `day_number`
   *  order — the ported `staySeatDays` rule over `daysOfTrip`. */
  seatDayIds(tripId: number, startDayId: number, endDayId: number): number[] {
    return staySeatDays(
      this.daysOfTrip(tripId).map((d) => d.id),
      startDayId,
      endDayId,
    );
  }

  listResyncableReservations(tripId: number): ResyncRow[] {
    return this.reservationsOfTrip(tripId)
      .filter((r) => (r.type !== 'hotel' || r.accommodation_id == null) && r.reservation_time != null)
      .map((r) => ({
        id: r.id,
        reservation_time: r.reservation_time!,
        reservation_end_time: r.reservation_end_time ?? null,
        day_id: r.day_id ?? null,
        end_day_id: r.end_day_id ?? null,
      }));
  }

  setReservationDays(reservationId: number, dayId: number | null, endDayId: number | null): void {
    const r = this.reservationsMap().get(reservationId);
    if (r) {
      r.day_id = dayId;
      r.end_day_id = endDayId;
      this.put('reservations', r);
    }
  }

  rowTripId(table: 'days' | 'places' | 'day_accommodations', id: unknown): number | string | undefined {
    const numeric = typeof id === 'string' ? Number(id) : id;
    if (table === 'days') return this.daysMap().get(numeric as number)?.trip_id;
    if (table === 'places') return this.placesMap().get(numeric as number)?.trip_id;
    return this.accommodationsMap().get(numeric as number)?.trip_id;
  }

  assignmentTripId(assignmentId: unknown): number | string | undefined {
    const ref = this.findAssignment(assignmentId);
    return ref?.day.trip_id;
  }

  existsOnTrip(table: 'days' | 'places', id: unknown, tripId: number): boolean {
    return this.rowTripId(table, id) === tripId;
  }

  rowExists(table: 'days' | 'places' | 'day_accommodations' | 'day_assignments', id: unknown): boolean {
    const numeric = typeof id === 'string' ? Number(id) : id;
    switch (table) {
      case 'days':
        return this.daysMap().has(numeric as number);
      case 'places':
        return this.placesMap().has(numeric as number);
      case 'day_accommodations':
        return this.accommodationsMap().has(numeric as number);
      case 'day_assignments':
        return this.findAssignment(id) !== undefined;
    }
  }

  /** The server's validateAccommodationRefs — field names and messages verbatim.
   *  Refs arrive untyped (the REST route passes the raw body values); a non-row
   *  value fails the lookup the way SQL binding NULL did. */
  validateStayRefs(
    tripId: number,
    placeId?: unknown,
    startDayId?: unknown,
    endDayId?: unknown,
  ): { field: string; message: string }[] {
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
    const id = this.allocId('accommodations');
    this.put('accommodations', {
      id,
      ...fields,
      check_in_end: fields.check_in_end ?? null,
      notes: fields.notes ?? null,
      created_at: nowIso(),
    } as Accommodation);
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
    },
  ): void {
    const a = this.accommodationsMap().get(accommodationId);
    if (a) {
      Object.assign(a, fields);
      this.put('accommodations', a);
    }
  }

  /** The raw stay row (detached) — the adapter's `getAccommodation(id, tripId)`
   *  pair: it scopes the 404 itself (`WHERE id = ? AND trip_id = ?`). */
  stayRow(id: number): Accommodation | undefined {
    const a = this.accommodationsMap().get(id);
    return a ? detached(a) : undefined;
  }

  /** `SELECT name FROM places WHERE id = ?` — the linked-reservation title lookup. */
  placeName(id: number | null | undefined): string | undefined {
    return this.place(id)?.name;
  }

  getStayCheckIn(accommodationId: number): string | null | undefined {
    return this.accommodationsMap().get(accommodationId)?.check_in;
  }

  stayOnTrip(accommodationId: unknown, tripId: number): boolean {
    const a = this.accommodationsMap().get(Number(accommodationId));
    return a !== undefined && a.trip_id === tripId;
  }

  deleteStay(accommodationId: number, tripId: number): void {
    const a = this.accommodationsMap().get(accommodationId);
    if (!a || a.trip_id !== tripId) return;
    this.releaseStayLinks(new Set([accommodationId]), tripId);
    this.delete('accommodations', accommodationId);
  }

  /** The two legs every `day_accommodations` delete owes the rest of the
   *  schema: `reservations.accommodation_id` ON DELETE SET NULL, and trigger
   *  `trg_release_stop_on_stay_delete` handing each referencing stop's booking
   *  link back. `excludeDayId` is for deleteDayCascade — the dying day's own
   *  assignments are gone with the row anyway. */
  private releaseStayLinks(stayIds: ReadonlySet<number>, tripId: number, excludeDayId?: number): void {
    if (stayIds.size === 0) return;
    for (const day of this.daysOfTrip(tripId)) {
      if (day.id === excludeDayId) continue;
      for (const a of this.assignmentsOf(day)) {
        if (a.accommodation_id != null && stayIds.has(a.accommodation_id)) this.releaseStop(a.id);
      }
    }
    for (const r of this.reservationsOfTrip(tripId)) {
      if (r.accommodation_id != null && stayIds.has(Number(r.accommodation_id))) {
        r.accommodation_id = null;
        this.put('reservations', r);
      }
    }
  }

  /** `COALESCE(?, col)` binds `meta.* || null`: a non-null incoming value
   *  overwrites the stored column, a null one keeps it. */
  syncStayTimes(
    accommodationId: number,
    meta: { check_in_time?: string | null; check_in_end_time?: string | null; check_out_time?: string | null },
  ): void {
    const a = this.accommodationsMap().get(accommodationId);
    if (!a) return;
    if (meta.check_in_time != null) a.check_in = meta.check_in_time;
    if (meta.check_in_end_time != null) a.check_in_end = meta.check_in_end_time;
    if (meta.check_out_time != null) a.check_out = meta.check_out_time;
    this.put('accommodations', a);
  }

  /** `confirmation = COALESCE(?, confirmation)` — the caller only runs it
   *  with a real number, which always lands. */
  syncStayConfirmation(accommodationId: number, confirmation: string): void {
    const a = this.accommodationsMap().get(accommodationId);
    if (a) {
      a.confirmation = confirmation;
      this.put('accommodations', a);
    }
  }

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
  }): number {
    const id = this.allocId('reservations');
    this.put('reservations', {
      id,
      ...fields,
      day_plan_position: null,
      ingest_state: 'live',
      created_at: nowIso(),
      endpoints: [],
      day_positions: null,
    } as ReservationRow);
    return id;
  }

  /** The server's COALESCE UPDATE: title/status/type/needs_review keep the
   *  stored value on null; every other resolved field is always written. */
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
    },
  ): void {
    const r = this.reservationsMap().get(id);
    if (!r) return;
    const row = r as unknown as Record<string, unknown>;
    const coalesce = (key: 'title' | 'status' | 'type' | 'needs_review') => {
      const v = resolved[key];
      if (v !== null && v !== undefined) row[key] = v;
    };
    coalesce('title');
    coalesce('status');
    coalesce('type');
    coalesce('needs_review');
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
      if (key in resolved) row[key] = resolved[key];
    }
    this.put('reservations', r);
  }

  /** Delete + re-insert the reservation's endpoints, skipping rows without
   *  coordinates — the server's saveEndpoints, verbatim. */
  replaceEndpoints(reservationId: number, endpoints: ReservationEndpointInput[]): void {
    const r = this.reservationsMap().get(reservationId);
    if (!r) return;
    r.endpoints = endpoints
      .filter((e) => e.lat != null && e.lng != null)
      .map((e, i) => ({
        id: this.allocId('reservations.endpoints'),
        reservation_id: reservationId,
        role: e.role,
        sequence: e.sequence ?? i,
        name: e.name,
        code: e.code ?? null,
        lat: e.lat!,
        lng: e.lng!,
        timezone: e.timezone ?? null,
        local_time: e.local_time ?? null,
        local_date: e.local_date ?? null,
      }));
    this.put('reservations', r);
  }

  /** The server's getReservationWithJoins read model: the stored row plus the
   *  day_number / place_name / accommodation joins, endpoints, day_positions
   *  and travelers. */
  getReservation(id: number, tripId?: number): Record<string, unknown> | undefined {
    const r = this.reservationsMap().get(id);
    if (!r || (tripId !== undefined && r.trip_id !== tripId)) return undefined;
    return this.reservationWire(r) as Record<string, unknown>;
  }

  listLinkedReservations(accommodationId: number): { id: number; metadata: string | null }[] {
    return [...this.reservationsMap().values()]
      .filter((r) => r.accommodation_id != null && Number(r.accommodation_id) === accommodationId)
      .map((r) => ({ id: r.id, metadata: r.metadata ?? null }));
  }

  /** Merge check-in/out times + confirmation onto a linked reservation —
   *  metadata is overwritten, confirmation COALESCEs. */
  updateReservationMeta(reservationId: number, metadata: string, confirmation: string | null): void {
    const r = this.reservationsMap().get(reservationId);
    if (!r) return;
    r.metadata = metadata;
    // `confirmation_number = COALESCE(?, confirmation_number)`: a non-null
    // value overwrites, null keeps the stored one.
    if (confirmation != null) r.confirmation_number = confirmation;
    this.put('reservations', r);
  }

  findLinkedBudgetItem(tripId: number, reservationId: number): { id: number; category: string } | undefined {
    const b = [...this.budgetItemsMap().values()].find(
      (x) => x.trip_id === tripId && x.reservation_id === reservationId,
    );
    return b ? { id: b.id, category: b.category } : undefined;
  }

  /** The plain row delete the cascade's remove() ends on — embedded endpoints
   *  and day_positions die with the row; travelers are the junction cascade. */
  deleteReservation(reservationId: number): void {
    const travelers = this.map('reservationTravelers') as Map<number, { reservation_id: number }>;
    for (const [k, t] of [...travelers]) {
      if (t.reservation_id === reservationId) this.delete('reservationTravelers', k);
    }
    this.delete('reservations', reservationId);
  }

  /** `SELECT user_id FROM trip_members WHERE trip_id = ?` plus the trip's
   *  `user_id` owner — the service's assignableUserIds (#1517). */
  assignableUserIds(tripId: number): Set<number> {
    const ids = new Set(this.memberRows(tripId).map((m) => m.id));
    const owner = this.tripRaw(tripId)?.user_id;
    if (owner != null) ids.add(owner);
    return ids;
  }

  /** setReservationTravelers verbatim: only assignable ids are kept (a stale
   *  or foreign user id is silently dropped, never errors), deduped, then the
   *  junction is rebuilt as DELETE + INSERT OR IGNORE. */
  setReservationTravelers(reservationId: number, tripId: number, userIds: number[]): void {
    const allowed = this.assignableUserIds(tripId);
    const ids = [...new Set(userIds)].filter((uid) => allowed.has(uid));
    const travelers = this.map('reservationTravelers') as Map<number, ReservationTravelerRow>;
    for (const [k, t] of [...travelers]) {
      if (t.reservation_id === reservationId) this.delete('reservationTravelers', k);
    }
    for (const uid of ids) {
      this.put('reservationTravelers', {
        id: this.allocId('reservationTravelers'),
        reservation_id: reservationId,
        user_id: uid,
      });
    }
  }

  /** updatePositions, verbatim the service's two branches: a truthy dayId
   *  takes the per-day INSERT OR REPLACE — the row materialises only when the
   *  reservation and the day agree on the trip (d.trip_id = r.trip_id AND
   *  r.trip_id = tripId), so a stale id is a quiet no-op — and anything else
   *  writes the global day_plan_position, an absent value binding NULL. */
  updateReservationPositions(
    tripId: number,
    positions: { id: number; day_plan_position?: number }[],
    dayId?: number | string | null,
  ): void {
    if (dayId) {
      const day = this.daysMap().get(Number(dayId));
      for (const item of positions) {
        const r = this.reservationsMap().get(item.id);
        if (!r || r.trip_id !== tripId || !day || day.trip_id !== tripId) continue;
        r.day_positions = { ...r.day_positions, [String(day.id)]: item.day_plan_position ?? 0 };
        this.put('reservations', r);
      }
    } else {
      for (const item of positions) {
        const r = this.reservationsMap().get(item.id);
        if (!r || r.trip_id !== tripId) continue;
        r.day_plan_position = item.day_plan_position ?? null;
        this.put('reservations', r);
      }
    }
  }

  // ==================================================================
  // AirportBackfillStore (ported/airports.ts backfillFlightEndpoints)
  // ==================================================================

  /** The server's NOT EXISTS scan: flight rows whose embedded endpoints
   *  array is empty or absent. */
  listFlightReservationsWithoutEndpoints(): BackfillCandidate[] {
    return [...this.reservationsMap().values()]
      .filter((r) => r.type === 'flight' && !(r.endpoints?.length))
      .map((r) => ({
        id: r.id,
        metadata: r.metadata ?? null,
        reservation_time: r.reservation_time ?? null,
        reservation_end_time: r.reservation_end_time ?? null,
      }));
  }

  /** Append one backfilled endpoint onto the reservation row — the server's
   *  reservation_endpoints INSERT. `timezone` is the dataset row's `tz`,
   *  falling back to `tzlookup` by coordinates then null (the `withTz`
   *  pattern in api/local/airports.ts). */
  insertEndpoint(row: {
    reservation_id: number;
    role: 'from' | 'to' | 'stop';
    sequence: number;
    name: string;
    code: string | null;
    lat: number;
    lng: number;
    timezone: string | null;
    local_time: string | null;
    local_date: string | null;
  }): void {
    const r = this.reservationsMap().get(row.reservation_id);
    if (!r) return;
    let timezone = row.timezone;
    if (!timezone) {
      try {
        timezone = tzlookup(row.lat, row.lng);
      } catch {
        timezone = null;
      }
    }
    r.endpoints = [...(r.endpoints ?? []), { id: this.allocId('reservations.endpoints'), ...row, timezone }];
    this.put('reservations', r);
  }

  /** `UPDATE reservations SET needs_review = 1` — the backfill's flag for a
   *  flight whose metadata cannot resolve to known airports. */
  markNeedsReview(reservationId: number): void {
    const r = this.reservationsMap().get(reservationId);
    if (!r) return;
    r.needs_review = 1;
    this.put('reservations', r);
  }

  // ==================================================================
  // BudgetSyncStore (ported/reservation-cascade.ts budget side effects)
  // ==================================================================

  createLinkedBudgetItem(
    tripId: number,
    reservationId: number,
    data: { name: string; category: string; total_price: number },
  ): { id: number } {
    const id = this.allocId('budgetItems');
    this.put('budgetItems', {
      id,
      trip_id: tripId,
      category: data.category,
      name: data.name,
      total_price: data.total_price,
      currency: null,
      exchange_rate: 1,
      persons: null,
      days: null,
      note: null,
      sort_order: 0,
      reservation_id: reservationId,
      place_id: null,
      paid_by_user_id: null,
      expense_date: null,
      ticket_json: null,
      created_at: nowIso(),
      members: [],
      payers: [],
      receipts: [],
    } as BudgetItem);
    return { id };
  }

  createBudgetItem(tripId: number, data: { name: string; category: string; total_price: number }): { id: number } {
    const id = this.allocId('budgetItems');
    this.put('budgetItems', {
      id,
      trip_id: tripId,
      category: data.category,
      name: data.name,
      total_price: data.total_price,
      currency: null,
      exchange_rate: 1,
      persons: null,
      days: null,
      note: null,
      sort_order: 0,
      reservation_id: null,
      place_id: null,
      paid_by_user_id: null,
      expense_date: null,
      ticket_json: null,
      created_at: nowIso(),
      members: [],
      payers: [],
      receipts: [],
    } as BudgetItem);
    return { id };
  }

  updateBudgetItem(
    id: number,
    _tripId: number,
    data: { name?: string; category?: string; total_price?: number },
  ): unknown {
    const b = this.budgetItemsMap().get(id);
    if (!b) return null;
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) (b as unknown as Record<string, unknown>)[k] = v;
    }
    this.put('budgetItems', b);
    return detached(b);
  }

  deleteBudgetItem(id: number, _tripId?: number): void {
    this.delete('budgetItems', id);
  }

  linkBudgetItem(budgetItemId: number, reservationId: number): void {
    const b = this.budgetItemsMap().get(budgetItemId);
    if (b) {
      b.reservation_id = reservationId;
      this.put('budgetItems', b);
    }
  }

  // ==================================================================
  // Adapter-facing row access (trips/days adapters)
  // ==================================================================

  tripsMap(): Map<number, Trip> {
    return this.map('trips') as Map<number, Trip>;
  }

  trip(id: number): Trip | undefined {
    return detached(this.tripsMap().get(id));
  }

  tripRaw(id: number): Trip | undefined {
    return this.tripsMap().get(id);
  }

  putTrip(trip: Trip): Trip {
    return this.put('trips', trip);
  }

  /** The joined fields of the server's TRIP_SELECT, computed locally.
   *  `feed_token` is the server's public-feed column — TRIP_SELECT always
   *  overrode it with `NULL AS feed_token`, so the wire never carries it. */
  tripSelect(trip: Trip): Trip {
    const memberCount = this.memberRows(trip.id).length;
    const owner = this.usersMap().get(trip.user_id);
    return detached({
      ...trip,
      feed_token: null,
      day_count: this.daysOfTrip(trip.id).length,
      place_count: this.placesOfTrip(trip.id).length,
      is_owner: trip.user_id === SELF_ID ? 1 : 0,
      owner_username: owner?.name ?? null,
      shared_count: memberCount,
    } as Trip);
  }

  /** Trips the self user sees: owned, or carrying a self membership row. */
  accessibleTripIds(): Set<number> {
    const ids = new Set<number>();
    for (const t of this.tripsMap().values()) {
      if (t.user_id === SELF_ID) ids.add(t.id);
    }
    for (const m of this.membersMap().values()) {
      if (m.id === SELF_ID) ids.add(m.tripId);
    }
    return ids;
  }

  /** The seeded self profile (`localUsers` row SELF_ID); created on demand the
   *  way bootstrap's getSelf() does. */
  selfUser(): LocalUser {
    let self = this.usersMap().get(SELF_ID);
    if (!self) {
      self = { id: SELF_ID, name: 'Me', is_self: 1 };
      this.put('localUsers', self);
    }
    return self;
  }

  user(id: number | null | undefined): LocalUser | undefined {
    if (id == null) return undefined;
    return this.usersMap().get(id);
  }

  /** The roster — `localUsers` rows (self + guests). */
  listUsers(): LocalUser[] {
    return detachedList([...this.usersMap().values()]);
  }

  /** Raw assignment_participants junction rows — trip copy remaps them. */
  assignmentParticipantRows(): { id: number; assignment_id: number; user_id: number }[] {
    return [
      ...(
        this.map('assignmentParticipants') as Map<
          number,
          { id: number; assignment_id: number; user_id: number }
        >
      ).values(),
    ];
  }

  memberRows(tripId: number): LocalTripMember[] {
    return [...this.membersMap().values()]
      .filter((m) => m.tripId === tripId)
      .sort((a, b) => (a.added_at ?? '').localeCompare(b.added_at ?? '') || a.id - b.id);
  }

  memberRow(tripId: number, userId: number): LocalTripMember | undefined {
    return this.memberRows(tripId).find((m) => m.id === userId);
  }

  addMemberRow(tripId: number, user: LocalUser, invitedBy?: number): LocalTripMember {
    const row: LocalTripMember = {
      tripId,
      id: user.id,
      username: user.name,
      role: 'member',
      added_at: nowIso(),
      invited_by_username: invitedBy != null ? this.user(invitedBy)?.name ?? null : null,
      is_guest: user.is_self !== 1,
    };
    this.put('tripMembers', row);
    return row;
  }

  removeMemberRow(tripId: number, userId: number): void {
    this.delete('tripMembers', [tripId, userId]);
  }

  /** Wire member row (the server's listMembers row shape — guests carry the
   *  `guest-*@guests.invalid` placeholder they were created with, the way the
   *  server's users row held it; self has no email locally, so the key reads
   *  absent rather than a null the column never held). */
  memberWire(m: LocalTripMember, ownerId: number): TripMember {
    const u = this.user(m.id);
    return {
      id: m.id,
      username: u?.name ?? m.username,
      email: u?.email,
      avatar: null,
      is_guest: u ? u.is_self !== 1 : !!m.is_guest,
      role: m.id === ownerId ? 'owner' : 'member',
      added_at: m.added_at ?? null,
      invited_by_username: m.invited_by_username ?? null,
      avatar_url: null,
    };
  }

  /** The server's owner object for listMembers — the trip's user_id joined. */
  ownerWire(trip: Trip): TripMember | undefined {
    const u = this.user(trip.user_id);
    if (!u) return undefined;
    return {
      id: u.id,
      username: u.name,
      email: u.email,
      avatar: null,
      role: 'owner',
      is_guest: false,
      avatar_url: null,
    };
  }

  /** A guest is a localUsers row that isn't self — creating one is the row
   *  plus its trip_membership, the server's createGuest transaction. The
   *  generated `guest-*@guests.invalid` email rides along on the row the way
   *  the server's users row carried it (listMembers selects it back out). */
  createGuest(tripId: number, name: string, invitedBy: number): LocalUser {
    const id = this.allocId('localUsers');
    const row: LocalUser = {
      id,
      name,
      is_self: 0,
      email: `guest-${crypto.randomUUID()}@guests.invalid`,
    };
    this.put('localUsers', row);
    this.addMemberRow(tripId, row, invitedBy);
    return row;
  }

  /** Confirms a user id is a guest of THIS trip (the server's guestOfTrip). */
  guestOfTrip(tripId: number, userId: number): boolean {
    const u = this.usersMap().get(userId);
    return !!u && u.is_self !== 1 && this.memberRow(tripId, userId) !== undefined;
  }

  /** Deleting a guest's roster row cascades its memberships and every junction
   *  link (the server's ON DELETE FK set), after re-splitting the budget items
   *  it was a member of (removeUserFromBudgetItems). */
  purgeUserData(userId: number): void {
    for (const item of this.budgetItemsMap().values()) {
      let touched = false;
      if (item.members?.some((m) => m.user_id === userId)) {
        item.members = item.members.filter((m) => m.user_id !== userId);
        item.persons = item.members.length || null;
        touched = true;
      }
      if (item.payers?.some((p) => p.user_id === userId)) {
        item.payers = item.payers.filter((p) => p.user_id !== userId);
        touched = true;
      }
      if (item.paid_by_user_id === userId) {
        item.paid_by_user_id = null;
        touched = true;
      }
      if (touched) this.put('budgetItems', item);
    }
    // The rest of the users row's ON DELETE set: settlements CASCADE off either
    // end; the loose user_id columns SET NULL; the embedded packing junctions
    // (recipients/contributors — the server's packing_item_recipients /
    // packing_item_contributors tables) lose the dead id.
    for (const s of [...(this.map('budgetSettlements') as Map<number, BudgetSettlement>).values()]) {
      if (s.from_user_id === userId || s.to_user_id === userId) this.delete('budgetSettlements', s.id);
    }
    for (const t of (this.map('todoItems') as Map<number, TodoItem>).values()) {
      if (t.assigned_user_id === userId) {
        t.assigned_user_id = null;
        this.put('todoItems', t);
      }
    }
    for (const p of (this.map('packingItems') as Map<number, PackingItem>).values()) {
      let touched = false;
      if (p.owner_id === userId) {
        p.owner_id = null;
        touched = true;
      }
      if (p.recipients?.some((r) => r.user_id === userId)) {
        p.recipients = p.recipients.filter((r) => r.user_id !== userId);
        touched = true;
      }
      if (p.contributors?.some((c) => c.user_id === userId)) {
        p.contributors = p.contributors.filter((c) => c.user_id !== userId);
        touched = true;
      }
      if (touched) this.put('packingItems', p);
    }
    for (const b of (this.map('packingBags') as Map<number, PackingBag>).values()) {
      if (b.user_id === userId) {
        b.user_id = null;
        this.put('packingBags', b);
      }
    }
    for (const c of (this.map('categories') as Map<number, Category>).values()) {
      if (c.user_id === userId) {
        c.user_id = null;
        this.put('categories', c);
      }
    }
    for (const name of [
      'packingCategoryAssignees',
      'todoCategoryAssignees',
      'assignmentParticipants',
      'reservationTravelers',
    ] as TableName[]) {
      const map = this.map(name) as Map<unknown, { user_id?: number }>;
      for (const [k, row] of [...map]) {
        if (row.user_id === userId) this.delete(name, k);
      }
    }
    const bagMembers = this.map('packingBagMembers') as Map<string, PackingBagMemberRow>;
    for (const bm of [...bagMembers.values()]) {
      if (bm.user_id === userId) this.delete('packingBagMembers', bm);
    }
    for (const m of [...this.membersMap().values()]) {
      if (m.id === userId) this.delete('tripMembers', [m.tripId, m.id]);
    }
    this.delete('localUsers', userId);
  }

  // ---- days ---------------------------------------------------------

  daysOfTrip(tripId: number): DayRow[] {
    return [...this.daysMap().values()]
      .filter((d) => d.trip_id === tripId)
      .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));
  }

  dayRow(id: number): DayRow | undefined {
    return this.daysMap().get(id);
  }

  /** Day ids holding traveller content — the server's hasContent check (a
   *  day's own assignments/notes, plus rows pointing at it). */
  contentDayIds(tripId: number): Set<number> {
    const ids = new Set<number>();
    for (const d of this.daysOfTrip(tripId)) {
      if (this.assignmentsOf(d).length || (d.notes_items?.length ?? 0) > 0) ids.add(d.id);
    }
    for (const a of this.accommodationsOfTrip(tripId)) {
      if (a.start_day_id != null) ids.add(a.start_day_id);
      if (a.end_day_id != null) ids.add(a.end_day_id);
    }
    return ids;
  }

  /**
   * Apply a GenerateDaysResult diff to the store. Two-phase: every `updated`
   * row is first parked on a unique negative day_number (Dexie's compound
   * `&[trip_id+day_number]` rejects transient duplicates), then written to the
   * target; `created` rows get real ids; `deletedDayIds` cascade-delete.
   */
  applyDayDiff(diff: {
    created: Day[];
    updated: Day[];
    deletedDayIds: number[];
  }): Map<number, number> {
    const tempToReal = new Map<number, number>();
    diff.updated.forEach((d, i) => this.setDayNumber(d.id, -(i + 1)));
    for (const id of diff.deletedDayIds) this.deleteDayCascade(id);
    for (const d of diff.updated) this.setDayNumberAndDate(d.id, d.day_number!, d.date ?? null);
    for (const d of diff.created) {
      const realId = this.insertDay(d.trip_id, d.day_number!, d.date ?? null);
      tempToReal.set(d.id, realId);
    }
    return tempToReal;
  }

  /** The FK cascade the server gets from `DELETE FROM days`:
   *  - day_assignments / day_notes / roadtrip_vias — embedded, die with the row;
   *  - day_accommodations on either end — CASCADE (row gone);
   *  - reservations day_id / end_day_id / assignment_id — SET NULL;
   *  - junction rows for the day's assignments — CASCADE. */
  deleteDayCascade(dayId: number): void {
    const day = this.daysMap().get(dayId);
    if (!day) return;
    const assignmentIds = new Set(this.assignmentsOf(day).map((a) => a.id));
    const deletedStayIds = new Set<number>();
    for (const a of this.accommodationsOfTrip(day.trip_id)) {
      if (a.start_day_id === dayId || a.end_day_id === dayId) {
        deletedStayIds.add(a.id);
        this.delete('accommodations', a.id);
      }
    }
    // The stays' ON DELETE legs — surviving days' assignments hand the booking
    // back and reservations pointing at a deleted stay go null.
    this.releaseStayLinks(deletedStayIds, day.trip_id, dayId);
    for (const r of this.reservationsOfTrip(day.trip_id)) {
      let touched = false;
      if (r.day_id === dayId) {
        r.day_id = null;
        touched = true;
      }
      if (r.end_day_id === dayId) {
        r.end_day_id = null;
        touched = true;
      }
      if (r.assignment_id != null && assignmentIds.has(r.assignment_id)) {
        r.assignment_id = null;
        touched = true;
      }
      // reservation_day_positions.day_id ON DELETE CASCADE — the embedded map
      // drops the dead day's key.
      if (r.day_positions && Object.prototype.hasOwnProperty.call(r.day_positions, String(dayId))) {
        delete r.day_positions[String(dayId)];
        touched = true;
      }
      if (touched) this.put('reservations', r);
    }
    const participants = this.map('assignmentParticipants') as Map<number, { assignment_id: number }>;
    for (const [k, p] of [...participants]) {
      if (assignmentIds.has(p.assignment_id)) this.delete('assignmentParticipants', k);
    }
    this.delete('days', dayId);
  }

  /** Full trip delete — the server's ON DELETE CASCADE set across every
   *  trip-scoped table. */
  deleteTripCascade(tripId: number): void {
    for (const d of this.daysOfTrip(tripId)) this.deleteDayCascade(d.id);
    for (const p of this.placesOfTrip(tripId)) this.delete('places', p.id);
    for (const r of this.reservationsOfTrip(tripId)) this.deleteReservation(r.id);
    for (const a of this.accommodationsOfTrip(tripId)) this.delete('accommodations', a.id);
    for (const b of [...this.budgetItemsMap().values()]) {
      if (b.trip_id === tripId) this.delete('budgetItems', b.id);
    }
    const settlements = this.map('budgetSettlements') as Map<number, BudgetSettlement>;
    for (const s of [...settlements.values()]) {
      if (s.trip_id === tripId) this.delete('budgetSettlements', s.id);
    }
    const todos = this.map('todoItems') as Map<number, TodoItem>;
    for (const t of [...todos.values()]) {
      if (t.trip_id === tripId) this.delete('todoItems', t.id);
    }
    const packing = this.map('packingItems') as Map<number, PackingItem>;
    for (const p of [...packing.values()]) {
      if (p.trip_id === tripId) this.delete('packingItems', p.id);
    }
    const bags = this.map('packingBags') as Map<number, PackingBag>;
    const bagMembers = this.map('packingBagMembers') as Map<string, PackingBagMemberRow>;
    for (const bag of [...bags.values()]) {
      if (bag.trip_id === tripId) {
        for (const [k, bm] of [...bagMembers]) {
          if (bm.bag_id === bag.id) this.delete('packingBagMembers', k);
        }
        this.delete('packingBags', bag.id);
      }
    }
    for (const name of ['packingCategoryAssignees', 'todoCategoryAssignees'] as TableName[]) {
      const map = this.map(name) as Map<number, { trip_id?: number }>;
      for (const [k, row] of [...map]) {
        if (row.trip_id === tripId) this.delete(name, k);
      }
    }
    for (const m of [...this.membersMap().values()]) {
      if (m.tripId === tripId) this.delete('tripMembers', [tripId, m.id]);
    }
    this.delete('syncMeta', tripId);
    this.delete('trips', tripId);
  }

  // ---- read models ----------------------------------------------------

  /** A day in the server's `list` shape: stored columns +
   *  `formatAssignmentWithPlace` assignments + `notes_items` (the server
   *  SELECTed day_notes ORDER BY sort_order ASC, created_at ASC). */
  dayWire(dayId: number): Day | undefined {
    const d = this.daysMap().get(dayId);
    if (!d) return undefined;
    const { vias: _vias, ...rest } = d;
    const notes = [...(d.notes_items ?? [])].sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    );
    return detached({
      ...rest,
      assignments: this.getAssignmentsForDay(dayId),
      notes_items: notes,
    });
  }

  /** The same row in the `update`/`transport` response shape — the slimmer
   *  `getAssignmentsForDay` projection and no `notes_items` (the server
   *  spread the bare row, which never carried them). */
  dayWireForUpdate(dayId: number): Day | undefined {
    const d = this.daysMap().get(dayId);
    if (!d) return undefined;
    const { vias: _vias, notes_items: _notes, ...rest } = d;
    return detached({
      ...rest,
      assignments: this.storedAssignmentsInOrder(dayId)
        .map((a) => this.assignmentWireForDayUpdate(a))
        .filter((a): a is Record<string, unknown> => a !== null),
    } as unknown as Day);
  }

  getAssignmentsForDay(dayId: number): Assignment[] {
    return this.storedAssignmentsInOrder(dayId)
      .map((a) => this.assignmentWire(a))
      .filter((a): a is Assignment => a !== null);
  }

  listDaysWire(tripId: number): Day[] {
    return this.daysOfTrip(tripId).map((d) => this.dayWire(d.id)!);
  }

  reservationsOfTrip(tripId: number): ReservationRow[] {
    return [...this.reservationsMap().values()].filter((r) => r.trip_id === tripId);
  }

  accommodationsOfTrip(tripId: number): Accommodation[] {
    return [...this.accommodationsMap().values()].filter((a) => a.trip_id === tripId);
  }

  placesOfTrip(tripId: number): LocalPlace[] {
    return [...this.placesMap().values()].filter((p) => p.trip_id === tripId);
  }

  /** The server's listReservations join: day_number, place_name, the
   *  accommodation columns, endpoints ordered by sequence, travelers and
   *  day_positions. Order: reservation_time ASC, created_at ASC (nulls first,
   *  the way SQLite ASC orders NULL). */
  reservationWire(r: ReservationRow): Reservation {
    const day = r.day_id != null ? this.daysMap().get(r.day_id) : undefined;
    const p = this.place(r.place_id);
    const acc =
      r.accommodation_id != null ? this.accommodationsMap().get(Number(r.accommodation_id)) : undefined;
    const accPlace = acc?.place_id != null ? this.place(acc.place_id) : undefined;
    const travelers: ReservationTraveler[] = [
      ...(this.map('reservationTravelers') as Map<number, { reservation_id: number; user_id: number }>).values(),
    ]
      .filter((t) => t.reservation_id === r.id)
      .map((t) => {
        const u = this.user(t.user_id);
        return {
          user_id: t.user_id,
          username: u?.name ?? `Guest ${t.user_id}`,
          avatar: null,
          avatar_url: null,
          is_guest: u ? (u.is_self === 1 ? 0 : 1) : null,
        };
      });
    const endpoints = detachedList(r.endpoints ?? []).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    return detached({
      ...r,
      accommodation_id: r.accommodation_id == null ? null : Math.trunc(Number(r.accommodation_id)),
      day_number: day?.day_number ?? null,
      place_name: p?.name ?? null,
      accommodation_place_id: acc?.place_id ?? null,
      accommodation_name: accPlace?.name ?? null,
      accommodation_start_day_id: acc?.start_day_id ?? null,
      accommodation_end_day_id: acc?.end_day_id ?? null,
      day_positions: r.day_positions ?? null,
      endpoints,
      travelers,
    }) as unknown as Reservation;
  }

  listReservationsWire(tripId: number): Reservation[] {
    return this.reservationsOfTrip(tripId)
      .sort(
        (a, b) =>
          (a.reservation_time ?? '') < (b.reservation_time ?? '')
            ? -1
            : (a.reservation_time ?? '') > (b.reservation_time ?? '')
              ? 1
              : (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      )
      .map((r) => this.reservationWire(r));
  }

  /** `a.*` plus the LEFT JOIN places columns every accommodation wire carries. */
  private accommodationPlaceJoin(a: Accommodation) {
    const p = this.place(a.place_id);
    return {
      ...a,
      place_name: p?.name ?? null,
      place_address: p?.address ?? null,
      place_image: p?.image_url ?? null,
      place_lat: p?.lat ?? null,
      place_lng: p?.lng ?? null,
    };
  }

  /** The server's getAccommodationWithPlace — the row + place join, no
   *  reservation fan-out. What create/update answers with. */
  accommodationDetailWire(id: number): Accommodation | undefined {
    const a = this.accommodationsMap().get(id);
    if (!a) return undefined;
    return detached(this.accommodationPlaceJoin(a));
  }

  /** The server's getAccommodationWithPlace / listAccommodations join. The
   *  LEFT JOIN on reservations fans out one row per linked booking. */
  accommodationWire(a: Accommodation): Accommodation[] {
    const linked = this.reservationsOfTrip(a.trip_id).filter(
      (r) => r.accommodation_id != null && Number(r.accommodation_id) === a.id,
    );
    const base = this.accommodationPlaceJoin(a);
    if (!linked.length) return [detached({ ...base, reservation_title: null })];
    return linked.map((r) => detached({ ...base, reservation_title: r.title ?? null }));
  }

  /** The server's `ORDER BY a.created_at ASC` applied before the
   *  reservation-join fan-out. */
  listAccommodationsWire(tripId: number): Accommodation[] {
    return this.accommodationsOfTrip(tripId)
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id)
      .flatMap((a) => this.accommodationWire(a));
  }

  /** The place list/get read model: every stored column normalized to null
   *  (`SELECT p.*` never omitted a key) + the flat category join fields the
   *  dashboard's hero strip reads, the nested `category`, tags, and the self
   *  user's star vote folded into the ratings aggregates. */
  placeWire(p: LocalPlace): PlaceWire {
    const cat = p.category_id != null ? (this.map('categories') as Map<number, Category>).get(p.category_id) : undefined;
    const self = this.user(SELF_ID);
    const { my_rating, ...rest } = p;
    const ratings: PlaceRatingVote[] =
      my_rating != null
        ? [{ user_id: SELF_ID, username: self?.name ?? 'Me', avatar: null, rating: my_rating }]
        : [];
    return detached({
      ...rest,
      description: p.description ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      address: p.address ?? null,
      category_id: p.category_id ?? null,
      price: p.price ?? null,
      currency: p.currency ?? null,
      reservation_status: p.reservation_status ?? null,
      reservation_notes: p.reservation_notes ?? null,
      reservation_datetime: p.reservation_datetime ?? null,
      place_time: p.place_time ?? null,
      end_time: p.end_time ?? null,
      duration_minutes: p.duration_minutes ?? null,
      notes: p.notes ?? null,
      image_url: p.image_url ?? null,
      google_place_id: p.google_place_id ?? null,
      google_ftid: p.google_ftid ?? null,
      osm_id: p.osm_id ?? null,
      amap_poi_id: p.amap_poi_id ?? null,
      website: p.website ?? null,
      phone: p.phone ?? null,
      transport_mode: p.transport_mode ?? null,
      route_geometry: p.route_geometry ?? null,
      route_color: p.route_color ?? null,
      stop_type: p.stop_type ?? null,
      fill_percent: p.fill_percent ?? null,
      source: p.source ?? null,
      category_name: cat?.name ?? null,
      category_color: cat?.color ?? null,
      category_icon: cat?.icon ?? null,
      category: cat ? { id: cat.id, name: cat.name, color: cat.color, icon: cat.icon } : null,
      tags: (p.tags ?? []) as Tag[],
      ratings,
      rating_avg: my_rating ?? null,
      rating_count: ratings.length,
    } as PlaceWire);
  }

  /** The server place list's `ORDER BY p.created_at DESC`. */
  listPlacesWire(tripId: number): PlaceWire[] {
    return this.placesOfTrip(tripId)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id - a.id)
      .map((p) => this.placeWire(p));
  }

  budgetItemsOfTrip(tripId: number): BudgetItem[] {
    return [...this.budgetItemsMap().values()].filter((b) => b.trip_id === tripId);
  }

  /** The server's listBudgetItems read model: rows ordered by
   *  (category order → sort_order) — the local schema has no
   *  budget_category_order table, so sort_order alone carries it — with
   *  member/payer display fields resolved from the roster at read time, the
   *  way the server's JOINs produced them. */
  listBudgetItemsWire(tripId: number): BudgetItem[] {
    return this.budgetItemsOfTrip(tripId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
      .map((b) =>
        detached({
          ...b,
          members: (b.members ?? []).map((m) => ({
            ...m,
            username: this.user(m.user_id)?.name ?? m.username ?? `Guest ${m.user_id}`,
            avatar_url: null,
          })),
          payers: (b.payers ?? []).map((p) => ({
            ...p,
            username: this.user(p.user_id)?.name ?? p.username ?? `Guest ${p.user_id}`,
            avatar_url: null,
          })),
          receipts: b.receipts ?? [],
        }),
      );
  }

  todoItemsOfTrip(tripId: number): TodoItem[] {
    return [...(this.map('todoItems') as Map<number, TodoItem>).values()].filter((t) => t.trip_id === tripId);
  }

  packingItemsOfTrip(tripId: number): PackingItem[] {
    return [...(this.map('packingItems') as Map<number, PackingItem>).values()].filter((p) => p.trip_id === tripId);
  }

  packingBagsOfTrip(tripId: number): PackingBag[] {
    return [...(this.map('packingBags') as Map<number, PackingBag>).values()].filter((b) => b.trip_id === tripId);
  }

  packingBagMembersOf(bagId: number): PackingBagMemberRow[] {
    return [...(this.map('packingBagMembers') as Map<string, PackingBagMemberRow>).values()].filter(
      (m) => m.bag_id === bagId,
    );
  }

  tagRows(): Map<number, Tag> {
    return this.map('tags') as Map<number, Tag>;
  }

  settingsValue<T>(key: string): T | undefined {
    return (this.map('settings') as Map<string, SettingsRow>).get(key)?.value as T | undefined;
  }

  defaultCurrency(): string {
    const preferred = this.settingsValue<string>('default_currency');
    return typeof preferred === 'string' && preferred.trim() ? preferred.trim() : 'EUR';
  }

  /**
   * The server's rebaseTripCurrency: fill currency-less rows with the outgoing
   * base, then pin each row's exchange_rate to the rate against the new base
   * (1 when no rate is stored — "not frozen"). Priced places get the same pin.
   */
  rebaseTripCurrency(
    tripId: number,
    newCurrency: string | null | undefined,
    rates?: Record<string, number>,
  ): void {
    const next = (newCurrency || '').toUpperCase();
    if (!next) return;
    const trip = this.tripsMap().get(tripId);
    if (!trip) return;
    const prev = (trip.currency || 'EUR').toUpperCase();
    if (prev === next) return;
    const rateFor = (cur: string): number => {
      if (cur === next) return 1;
      const r = rates?.[cur];
      return r && r > 0 ? r : 1;
    };
    for (const b of this.budgetItemsMap().values()) {
      if (b.trip_id !== tripId) continue;
      if (b.currency == null || b.currency === '') b.currency = prev;
      b.exchange_rate = rateFor(b.currency.toUpperCase());
      this.put('budgetItems', b);
    }
    const settlements = this.map('budgetSettlements') as Map<number, BudgetSettlement>;
    for (const s of [...settlements.values()]) {
      if (s.trip_id !== tripId) continue;
      if (s.currency == null || s.currency === '') s.currency = prev;
      s.exchange_rate = rateFor(s.currency.toUpperCase());
      this.put('budgetSettlements', s);
    }
    for (const p of this.placesMap().values()) {
      if (p.trip_id === tripId && p.price != null && (p.currency == null || p.currency === '')) {
        p.currency = prev;
        p.updated_at = nowIso();
        this.put('places', p);
      }
    }
  }

  /** Raw reservation row for the update path's `current` — the persisted
   *  shape, not the joined projection. */
  reservationRecord(id: number): Reservation | undefined {
    const r = this.reservationsMap().get(id);
    return r ? detached(r) : undefined;
  }

  /** Every via of the trip (roadtripApi.listVias parity), broadcast-ordered. */
  viasOfTrip(tripId: number): RoadtripVia[] {
    return this.daysOfTrip(tripId).flatMap((d) => this.listDayVias(d.id));
  }
}

/**
 * The adapter's unit of work: one `rw` transaction over every table → load the
 * snapshot → run `fn` (pure port calls + seam reads) → `flush()` the dirty
 * rows — all inside the same IndexedDB transaction, so a thrown LocalApiError
 * or port error rolls everything back (Dexie aborts the tx and the flush's
 * partial writes never commit).
 *
 * Do NOT await non-Dexie work inside `fn` — a `FileReader`/`fetch` gap lets
 * Dexie auto-commit early. Resolve external async inputs first, then open the
 * transaction (uploadCover reads the File to a data URL before entering).
 */
export async function withStore<T>(fn: (store: DexieStore) => T | Promise<T>): Promise<T> {
  return db.transaction('rw', db.tables, async () => {
    const store = await DexieStore.load();
    const result = await fn(store);
    await store.flush();
    return result;
  });
}
