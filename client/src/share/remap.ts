/**
 * `saveBundle` — write a decoded {@link ShareBundle} into the local database as
 * a brand-new trip owned by self.
 *
 * Every id the bundle carries is foreign: it could collide with a row that
 * already exists on this device. The importer therefore never trusts one — it
 * allocates a fresh id from the local counter (`store.allocId`, the same
 * `reserveIds` seam the adapters use, so embedded rows get ids that are unique
 * across every day/reservation on the device, not just inside this trip) and
 * remaps each foreign key through an old→new map. References that point at a
 * row the bundle does not carry are dropped to null — or, where the column is
 * non-nullable and the row would be meaningless without it, the row itself is
 * skipped (the same "INNER JOIN drops it" behaviour the wire emitters apply).
 *
 * Ordering is re-derived rather than trusted: days are renumbered 1..N by
 * `(day_number, id)` because `days` has a UNIQUE(trip_id, day_number) index,
 * and `order_index`/`sort_order` columns are rewritten dense from the bundle's
 * own ordering so stale gaps or duplicates can't scramble the lists.
 *
 * The whole import runs inside `withStore`'s single `rw` transaction — a throw
 * anywhere rolls the entire trip back; the device never holds half a bundle.
 */
import type { RoadtripVia } from '@trek/shared';
import {
  SELF_ID,
  withStore,
  type DayRow,
  type DexieStore,
  type ReservationRow,
  type StoredAssignment,
} from '../api/local/dexieStore';
import { nowIso } from '../api/local/helpers';
import type { LocalPlace } from '../db/panelmintDb';
import type {
  BudgetItem,
  Category,
  DayNote,
  LocalUser,
  PackingBag,
  PackingBagMemberRow,
  PackingItem,
  ReservationEndpoint,
  Tag,
  TodoItem,
  Trip,
} from '../types';
import type { ShareBundle } from './codec';

/** The trip's joined-display columns — read-time projections, not storage. */
const TRIP_JOIN_FIELDS = ['day_count', 'place_count', 'is_owner', 'owner_username', 'shared_count'] as const;

type BundleUser = ShareBundle['users'][number];
type BundleDay = ShareBundle['days'][number];
type BundleAssignment = NonNullable<BundleDay['assignments']>[number];
type BundlePlace = ShareBundle['places'][number];
type BundleReservation = ShareBundle['reservations'][number];

/** Trimmed, case-insensitive name key — ' Anna ' and 'anna' are one person. */
function nameKey(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Every old→new id map in one place, plus the resolved-user lookup the
 * username-carrying embeds refresh themselves from.
 */
interface IdMaps {
  users: Map<number, number>;
  days: Map<number, number>;
  places: Map<number, number>;
  categories: Map<number, number>;
  assignments: Map<number, number>;
  accommodations: Map<number, number>;
  reservations: Map<number, number>;
  bags: Map<number, number>;
  /** local user id → roster row (self + matched/created guests). */
  userRows: Map<number, LocalUser>;
}

function mapId(map: Map<number, number>, id: number | null | undefined): number | null {
  if (id == null) return null;
  return map.get(id) ?? null;
}

/** `accommodation_id` is the one column the wire widened to string — fold it
 *  back to a number before the map lookup the way reservationWire truncs it. */
function mapNumId(map: Map<number, number>, id: number | string | null | undefined): number | null {
  if (id == null) return null;
  const numeric = typeof id === 'string' ? Number(id) : id;
  if (!Number.isFinite(numeric)) return null;
  return map.get(numeric) ?? null;
}

function userName(maps: IdMaps, localId: number): string {
  return maps.userRows.get(localId)?.name ?? `Guest ${localId}`;
}

function pushTo<K>(map: Map<K, Set<number>>, key: K, value: number): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

// ── JSON-string embeds ─────────────────────────────────────────────────────
// Two columns smuggle structured data inside a JSON string. Their inner ids
// are foreign too — carrying them verbatim would either dangle or, worse,
// alias an unrelated local row.

/** `reservations.metadata.legs[]` carry `dep_day_id`/`arr_day_id` and per-leg
 *  `day_positions` keys — foreign day ids. `expandFlightLegsForDay` looks them
 *  up against the imported trip's days; a foreign id orders to 0, which drops
 *  every leg — a shared multi-leg booking would vanish from every day. Remap
 *  each id (dangling → null, so the leg falls back to the reservation's own
 *  remapped `day_id`/`end_day_id` span instead of disappearing). */
function remapReservationMetadata(raw: string | null | undefined, maps: IdMaps): string | null | undefined {
  if (raw == null) return raw;
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    return raw;
  }
  // The readers already heal a double-encoded metadata string — decode it so
  // the legs are reachable, then the write-back stores the clean single
  // encoding.
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return raw;
    }
  }
  if (!meta || typeof meta !== 'object' || !Array.isArray((meta as { legs?: unknown }).legs)) return raw;
  const legs = (meta as { legs: unknown[] }).legs.map((leg) => {
    if (!leg || typeof leg !== 'object') return leg;
    const l = leg as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...l,
      dep_day_id: mapId(maps.days, l.dep_day_id as number | null | undefined),
      arr_day_id: mapId(maps.days, l.arr_day_id as number | null | undefined),
    };
    if (l.day_positions && typeof l.day_positions === 'object') {
      const positions: Record<string, number> = {};
      for (const [dayId, position] of Object.entries(l.day_positions)) {
        const mapped = maps.days.get(Number(dayId));
        if (mapped !== undefined && typeof position === 'number') positions[String(mapped)] = position;
      }
      next.day_positions = Object.keys(positions).length > 0 ? positions : null;
    }
    return next;
  });
  return JSON.stringify({ ...(meta as Record<string, unknown>), legs });
}

/** `budget_items.ticket_json` (and the legacy `note` prefix) serializes the
 *  receipt split as `{items: [{name, price, parts: [user_id…]}]}` — the parts
 *  are foreign user ids that readers compare against member `user_id`s.
 *  Remap them; dangling ids drop out of the split rather than pointing at a
 *  stranger. */
function remapTicketJson(raw: string | null | undefined, maps: IdMaps): string | null | undefined {
  if (raw == null) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) return raw;
  const items = (parsed as { items: unknown[] }).items.map((line) => {
    if (!line || typeof line !== 'object') return line;
    const l = line as Record<string, unknown>;
    if (!Array.isArray(l.parts)) return l;
    const parts = new Set<number>();
    for (const uid of l.parts) {
      const mapped = typeof uid === 'number' ? maps.users.get(uid) : undefined;
      if (mapped !== undefined) parts.add(mapped);
    }
    return { ...l, parts: [...parts] };
  });
  return JSON.stringify({ ...(parsed as Record<string, unknown>), items });
}

/** The pre-migration-186 smuggle: `note` carries the ticket split as a
 *  `TICKETJSON:`-prefixed JSON string. */
const TICKET_NOTE_PREFIX = 'TICKETJSON:';
function remapTicketNote(raw: string | null | undefined, maps: IdMaps): string | null | undefined {
  if (raw == null || !raw.startsWith(TICKET_NOTE_PREFIX)) return raw;
  return TICKET_NOTE_PREFIX + (remapTicketJson(raw.slice(TICKET_NOTE_PREFIX.length), maps) ?? '');
}

// ── Roster ─────────────────────────────────────────────────────────────────

/**
 * Bundle user → local user. `is_self` rows fold onto SELF_ID no matter which
 * id the other device gave its owner; everyone else matches an existing
 * non-self roster row by name (trimmed, case-insensitive) or becomes a new
 * guest row — never a silent alias by raw id, which could weld two different
 * people together. Returns the distinct mapped non-self users.
 */
function mapRoster(store: DexieStore, users: BundleUser[], maps: IdMaps): LocalUser[] {
  const guestsByName = new Map<string, LocalUser>();
  for (const u of store.listUsers()) {
    maps.userRows.set(u.id, u);
    if (u.is_self === 1) continue;
    const key = nameKey(u.name);
    if (key && !guestsByName.has(key)) guestsByName.set(key, u);
  }
  const self = store.selfUser();
  maps.userRows.set(SELF_ID, self);

  const linked = new Map<number, LocalUser>();
  for (const u of users) {
    if (u.is_self === 1) {
      maps.users.set(u.id, SELF_ID);
      continue;
    }
    const key = nameKey(u.name);
    let mapped = key ? guestsByName.get(key) : undefined;
    if (!mapped) {
      mapped = {
        id: store.allocId('localUsers'),
        name: u.name,
        is_self: 0,
        email: `guest-${crypto.randomUUID()}@guests.invalid`,
      };
      store.put('localUsers', mapped);
      if (key) guestsByName.set(key, mapped);
    }
    maps.users.set(u.id, mapped.id);
    maps.userRows.set(mapped.id, mapped);
    linked.set(mapped.id, mapped);
  }
  return [...linked.values()];
}

/** One tripMembers row per mapped non-self user — the trip's roster. */
function linkMembers(store: DexieStore, tripId: number, users: LocalUser[]): void {
  for (const u of users) {
    if (u.id === SELF_ID) continue;
    store.addMemberRow(tripId, u);
  }
}

// ── Categories + tags ──────────────────────────────────────────────────────

/**
 * Bundle category → local category, matched by name (the seeded palette
 * collides by design — every device starts from the same ten). A new name
 * lands as a self-owned row so the place list's join resolves it.
 */
function mapCategories(store: DexieStore, bundle: ShareBundle, maps: IdMaps): void {
  const byName = new Map<string, Category>();
  for (const c of store.categoryRows()) {
    const key = nameKey(c.name);
    if (key && !byName.has(key)) byName.set(key, c);
  }
  for (const c of bundle.categories) {
    const key = nameKey(c.name);
    const existing = key ? byName.get(key) : undefined;
    if (existing) {
      maps.categories.set(c.id, existing.id);
      continue;
    }
    const row: Category = {
      id: store.allocId('categories'),
      name: c.name,
      color: c.color,
      icon: c.icon,
      user_id: SELF_ID,
      created_at: c.created_at ?? nowIso(),
    };
    store.put('categories', row);
    if (key) byName.set(key, row);
    maps.categories.set(c.id, row.id);
  }
}

/**
 * The embedded `place.tags[]` rows are the wire's place_tags join — foreign
 * tag ids that resolve nowhere locally. Recreate them the way tagsApi.create
 * does: match the self user's palette by name first, otherwise mint a fresh
 * self-owned tag so the embedded id points at a real row again.
 */
function remapPlaceTags(store: DexieStore, tags: unknown): Tag[] {
  if (!Array.isArray(tags)) return [];
  const byName = new Map<string, Tag>();
  for (const t of store.tagRows().values()) {
    if (t.user_id !== SELF_ID) continue;
    const key = nameKey(t.name);
    if (key && !byName.has(key)) byName.set(key, t);
  }
  const out: Tag[] = [];
  const seen = new Set<number>();
  for (const t of tags as Partial<Tag>[]) {
    if (!t || typeof t !== 'object') continue;
    const name = typeof t.name === 'string' ? t.name : null;
    const key = nameKey(name);
    if (!name || !key) continue;
    let row = byName.get(key);
    if (!row) {
      row = {
        id: store.allocId('tags'),
        user_id: SELF_ID,
        name,
        color: typeof t.color === 'string' && t.color ? t.color : '#10b981',
        created_at: nowIso(),
      };
      store.put('tags', row);
      byName.set(key, row);
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, user_id: row.user_id, name: row.name, color: row.color });
  }
  return out;
}

// ── Entity remaps ──────────────────────────────────────────────────────────

function importTrip(store: DexieStore, bundle: ShareBundle, tripId: number): void {
  const trip = { ...bundle.trip } as Record<string, unknown>;
  for (const field of TRIP_JOIN_FIELDS) delete trip[field];
  store.put('trips', {
    ...trip,
    id: tripId,
    user_id: SELF_ID,
  } as Trip);
}

function importPlaces(store: DexieStore, bundle: ShareBundle, maps: IdMaps, tripId: number): void {
  for (const p of bundle.places) {
    const id = store.allocId('places');
    maps.places.set(p.id, id);
    // The wire-written join fields are re-derived at read (`placeWire`) — the
    // flat category_* trio, the nested category object and the rating
    // aggregates would only go stale on the stored row.
    const {
      category_name: _cn,
      category_color: _cc,
      category_icon: _ci,
      category: _cat,
      ratings: _r,
      rating_avg: _ra,
      rating_count: _rc,
      ...cols
    } = p as BundlePlace & Record<string, unknown>;
    store.put('places', {
      ...cols,
      id,
      trip_id: tripId,
      category_id: mapId(maps.categories, p.category_id),
      tags: remapPlaceTags(store, p.tags),
    } as LocalPlace);
  }
}

function remapAssignment(
  store: DexieStore,
  a: BundleAssignment,
  maps: IdMaps,
  newDayId: number,
  orderIndex: number
): StoredAssignment | null {
  const newPlaceId = a.place_id != null ? maps.places.get(a.place_id) : undefined;
  // The wire's INNER JOIN drops a stop whose place is gone — so does import.
  if (newPlaceId === undefined) return null;
  const id = store.allocId('days.assignments');
  maps.assignments.set(a.id, id);

  // Dedupe by remapped user id — two bundle users can fold onto one local
  // user (name match / self), and the junction is UNIQUE(assignment_id,
  // user_id).
  const seen = new Set<number>();
  for (const p of a.participants ?? []) {
    const uid = mapId(maps.users, p.user_id);
    if (uid === null || seen.has(uid)) continue;
    seen.add(uid);
    store.put('assignmentParticipants', {
      id: store.allocId('assignmentParticipants'),
      assignment_id: id,
      user_id: uid,
    });
  }

  // `place`/`participants` are read-time joins (`assignmentWire` rebuilds them
  // from the places/junction rows) — only the bare server columns persist, the
  // shape `StoredAssignment` documents and every `api/local` writer stores.
  const { participants: _p, place: _pl, ...cols } = a;
  return {
    ...cols,
    id,
    day_id: newDayId,
    place_id: newPlaceId,
    order_index: orderIndex,
    // The wire shape carries end_day as a boolean; the stored convention is
    // SQLite 0/1 and `assignmentWire` reads `=== 1` — a raw `true` would read
    // false. Fold both shapes onto the stored one.
    end_day: a.end_day === true || a.end_day === 1 ? 1 : 0,
    accommodation_id: mapId(maps.accommodations, a.accommodation_id),
  } as StoredAssignment;
}

/**
 * Pass one — allocate every day id up front. Accommodations and reservations
 * both reference days, and assignments reference accommodations, so the map
 * has to be complete before either side writes.
 */
function allocDayIds(store: DexieStore, bundle: ShareBundle, maps: IdMaps): BundleDay[] {
  const sorted = [...bundle.days].sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0) || a.id - b.id);
  for (const d of sorted) maps.days.set(d.id, store.allocId('days'));
  return sorted;
}

/** Pass two — the day rows themselves, with their embeds remapped. */
function writeDays(store: DexieStore, sortedDays: BundleDay[], maps: IdMaps, tripId: number): void {
  let dayNumber = 0;
  for (const d of sortedDays) {
    dayNumber += 1;
    const dayId = maps.days.get(d.id)!;
    // sort_order is the wire's note ordering — renumber it dense in the
    // bundle's own (sort_order, created_at) order, same as the other order
    // columns, so a stale gap can't scramble the list.
    const notes: DayNote[] = [...(d.notes_items ?? [])]
      .map((n, i) => ({ n, i }))
      .sort(
        (a, b) =>
          (a.n.sort_order ?? 0) - (b.n.sort_order ?? 0) ||
          (a.n.created_at ?? '').localeCompare(b.n.created_at ?? '') ||
          a.i - b.i
      )
      .map(({ n }, i) => ({
        ...n,
        id: store.allocId('days.notes'),
        day_id: dayId,
        trip_id: tripId,
        sort_order: i,
      }));
    const vias: RoadtripVia[] = (d.vias ?? []).map((v) => ({
      ...v,
      id: store.allocId('days.vias'),
      day_id: dayId,
    }));
    const assignments: StoredAssignment[] = [];
    const ordered = [...(d.assignments ?? [])].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
    for (const a of ordered) {
      const row = remapAssignment(store, a, maps, dayId, assignments.length);
      if (row) assignments.push(row);
    }
    const { vias: _v, assignments: _a, notes_items: _n, ...cols } = d;
    store.put('days', {
      ...cols,
      id: dayId,
      trip_id: tripId,
      day_number: dayNumber,
      assignments,
      notes_items: notes,
      vias,
    } as unknown as DayRow);
  }
}

function importAccommodations(store: DexieStore, bundle: ShareBundle, maps: IdMaps, tripId: number): void {
  for (const a of bundle.accommodations) {
    const start = mapId(maps.days, a.start_day_id);
    const end = mapId(maps.days, a.end_day_id);
    // The day span is non-nullable — a stay without both ends has no shape
    // the readers understand (the server's copy path skipped the same way).
    if (start === null || end === null) continue;
    const id = store.allocId('accommodations');
    maps.accommodations.set(a.id, id);
    // place_* / reservation_title are read-time joins, rebuilt at read.
    const {
      place_name: _pn,
      place_address: _pa,
      place_image: _pi,
      place_lat: _plat,
      place_lng: _plng,
      reservation_title: _rt,
      ...cols
    } = a as typeof a & Record<string, unknown>;
    store.put('accommodations', {
      ...cols,
      id,
      trip_id: tripId,
      place_id: mapId(maps.places, a.place_id),
      start_day_id: start,
      end_day_id: end,
    });
  }
}

function importReservations(store: DexieStore, bundle: ShareBundle, maps: IdMaps, tripId: number): void {
  // Travelers have two candidate sources: the top-level junction array and,
  // on wire-shaped stored rows, the embedded `travelers` join. The junction is
  // the store of record — the embed is a stale-able echo a writer can leave
  // behind — so when the bundle carries junction rows at all they win
  // outright per reservation. The embed only serves a bundle that has no
  // junction data (a hand-authored or foreign one that never knew the table).
  const junctionIds = new Map<number, Set<number>>();
  for (const t of bundle.reservationTravelers) {
    const uid = mapId(maps.users, t.user_id);
    if (uid !== null) pushTo(junctionIds, t.reservation_id, uid);
  }
  const junctionIsAuthoritative = bundle.reservationTravelers.length > 0;

  for (const r of bundle.reservations) {
    const id = store.allocId('reservations');
    maps.reservations.set(r.id, id);

    const uids = new Set(junctionIds.get(r.id));
    if (!junctionIsAuthoritative) {
      for (const t of r.travelers ?? []) {
        const uid = mapId(maps.users, t.user_id);
        if (uid !== null) uids.add(uid);
      }
    }
    for (const uid of uids) {
      store.put('reservationTravelers', {
        id: store.allocId('reservationTravelers'),
        reservation_id: id,
        user_id: uid,
      });
    }

    const endpoints = (r.endpoints ?? []).map((e, i) => ({
      ...e,
      id: store.allocId('reservations.endpoints'),
      reservation_id: id,
      // sequence is the wire's order field — keep the stored value when set,
      // fall back to the array position a hand-authored bundle implies.
      sequence: e.sequence ?? i,
    })) as ReservationEndpoint[];

    const dayPositions: Record<string, number> = {};
    for (const [dayId, position] of Object.entries(r.day_positions ?? {})) {
      const mapped = maps.days.get(Number(dayId));
      if (mapped !== undefined) dayPositions[String(mapped)] = position;
    }

    // The read-time join fields are recomputed by reservationWire — keeping
    // the bundle's copies would freeze the exporter's values in place.
    const {
      day_number: _dn,
      place_name: _pn,
      accommodation_place_id: _ap,
      accommodation_name: _an,
      accommodation_start_day_id: _as,
      accommodation_end_day_id: _ae,
      endpoints: _e,
      travelers: _t,
      day_positions: _dp,
      ...cols
    } = r as BundleReservation & Record<string, unknown>;
    store.put('reservations', {
      ...cols,
      id,
      trip_id: tripId,
      day_id: mapId(maps.days, r.day_id),
      end_day_id: mapId(maps.days, r.end_day_id),
      place_id: mapId(maps.places, r.place_id),
      assignment_id: mapId(maps.assignments, r.assignment_id),
      accommodation_id: mapNumId(maps.accommodations, r.accommodation_id),
      // day_plan_position is a position value, not an id — verbatim. The map
      // keys are the day ids: remapped, dangling entries dropped; an emptied
      // map stores null, the shape the writers always use.
      day_positions: Object.keys(dayPositions).length > 0 ? dayPositions : null,
      // metadata.legs carry foreign dep/arr day ids — remapped inside the
      // JSON string.
      metadata: remapReservationMetadata(r.metadata, maps),
      // The external_*/sync columns mark linkage to a hosted sync account that
      // cannot exist on this device — a foreign external_owner_user_id would
      // alias a real local user. Nulled, the same columns the trip-copy path
      // drops (api/local/trips.ts).
      external_id: null,
      external_source: null,
      external_owner_user_id: null,
      external_synced_at: null,
      sync_enabled: 0,
      endpoints,
      // The travelers embed is not persisted — reservationWire rebuilds it
      // from the junction rows written above (same as the participants embed
      // on assignments).
    } as ReservationRow);
  }
}

function importBudget(store: DexieStore, bundle: ShareBundle, maps: IdMaps, tripId: number): void {
  // sort_order is scoped to the item's category group (the reorder route
  // indexes within the ids it is handed, and the wire sorts category-rank
  // then sort_order). Dense-renumber per category in the bundle's own order;
  // first-appearance order of the categories re-seeds budget_category_order —
  // it never travels in the bundle, so the exporter's group order is exactly
  // what ensureCategoryOrder's INSERT OR IGNORE appended as items were made.
  const perCategoryOrder = new Map<string, number>();
  // Sort by the bundle's own sort_order so the dense renumber preserves the
  // exporter's visual order (Dexie's toArray gave id order, which reordering
  // leaves behind).
  const sortedItems = [...bundle.budgetItems].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
  for (const b of sortedItems) {
    const id = store.allocId('budgetItems');
    const sortOrder = perCategoryOrder.get(b.category) ?? 0;
    perCategoryOrder.set(b.category, sortOrder + 1);
    store.ensureCategoryOrder(tripId, b.category);
    const members = (b.members ?? []).flatMap((m) => {
      const uid = mapId(maps.users, m.user_id);
      if (uid === null) return [];
      return [
        {
          ...m,
          user_id: uid,
          budget_item_id: id,
          username: userName(maps, uid),
          avatar: null,
          avatar_url: null,
        },
      ];
    });
    const payers = (b.payers ?? []).flatMap((p) => {
      const uid = mapId(maps.users, p.user_id);
      if (uid === null) return [];
      return [
        {
          ...p,
          user_id: uid,
          budget_item_id: id,
          username: userName(maps, uid),
          avatar: null,
          avatar_url: null,
        },
      ];
    });
    store.put('budgetItems', {
      ...b,
      id,
      trip_id: tripId,
      sort_order: sortOrder,
      reservation_id: mapId(maps.reservations, b.reservation_id),
      place_id: mapId(maps.places, b.place_id),
      paid_by_user_id: mapId(maps.users, b.paid_by_user_id),
      // The receipt split embeds foreign user ids — remap inside the JSON
      // string (and its pre-migration `TICKETJSON:` note smuggle) or an
      // itemized share lands on whoever holds that id locally.
      ticket_json: remapTicketJson(b.ticket_json, maps),
      note: remapTicketNote(b.note, maps),
      members,
      payers,
    } as BudgetItem);
  }

  for (const s of bundle.budgetSettlements) {
    const from = mapId(maps.users, s.from_user_id);
    const to = mapId(maps.users, s.to_user_id);
    // A settlement between people this bundle never names is dead debt — the
    // join in settlementJoined would drop it anyway (the server's ON DELETE
    // cascade did the same).
    if (from === null || to === null) continue;
    store.put('budgetSettlements', {
      ...s,
      id: store.allocId('budgetSettlements'),
      trip_id: tripId,
      from_user_id: from,
      to_user_id: to,
      created_by_user_id: mapId(maps.users, s.created_by_user_id),
      from_username: userName(maps, from),
      to_username: userName(maps, to),
      // Avatar fields are dead joins — the wire emits nulls for all of them.
      from_avatar: null,
      to_avatar: null,
      from_avatar_url: null,
      to_avatar_url: null,
    });
  }
}

function importPacking(store: DexieStore, bundle: ShareBundle, maps: IdMaps, tripId: number): void {
  const sortedBags = [...bundle.packingBags].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
  let bagOrder = 0;
  for (const bag of sortedBags) {
    const id = store.allocId('packingBags');
    maps.bags.set(bag.id, id);
    const owner = mapId(maps.users, bag.user_id);
    const memberIds = new Set<number>();
    for (const m of bag.members ?? []) {
      const uid = mapId(maps.users, m.user_id);
      if (uid === null || memberIds.has(uid)) continue;
      memberIds.add(uid);
      // Natural compound PK only — the row carries no surrogate id.
      const row: PackingBagMemberRow = { bag_id: id, user_id: uid };
      store.put('packingBagMembers', row);
    }
    // members/total_weight_grams are the wire's joins — rebuilt from the
    // junction rows and the item weights at read.
    const { members: _m, total_weight_grams: _w, ...cols } = bag;
    store.put('packingBags', {
      ...cols,
      id,
      trip_id: tripId,
      sort_order: bagOrder++,
      user_id: owner,
      assigned_username: owner !== null ? userName(maps, owner) : null,
    } as PackingBag);
  }

  const sortedItems = [...bundle.packingItems].sort(
    (a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id
  );
  let itemOrder = 0;
  for (const p of sortedItems) {
    const id = store.allocId('packingItems');
    const owner = mapId(maps.users, p.owner_id);
    // A restricted item with no owner is invisible to everyone — the privacy
    // check only opens it for its owner and named recipients. Handing it to
    // the importer keeps the row reachable; a common item's owner is display
    // only and can honestly be null.
    const ownerId = owner ?? ((p.is_private ?? 0) ? SELF_ID : null);
    const recipients = (p.recipients ?? []).flatMap((r) => {
      const uid = mapId(maps.users, r.user_id);
      return uid === null ? [] : [{ user_id: uid, username: userName(maps, uid) }];
    });
    const contributors = (p.contributors ?? []).flatMap((c) => {
      const uid = mapId(maps.users, c.user_id);
      return uid === null ? [] : [{ ...c, user_id: uid, username: userName(maps, uid) }];
    });
    store.put('packingItems', {
      ...p,
      id,
      trip_id: tripId,
      sort_order: itemOrder++,
      bag_id: mapId(maps.bags, p.bag_id),
      owner_id: ownerId,
      owner_username: ownerId !== null ? userName(maps, ownerId) : null,
      recipients,
      contributors,
    } as PackingItem);
  }
}

function importTodos(store: DexieStore, bundle: ShareBundle, maps: IdMaps, tripId: number): void {
  const sorted = [...bundle.todoItems].sort(
    (a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id - b.id
  );
  let order = 0;
  for (const t of sorted) {
    store.put('todoItems', {
      ...t,
      id: store.allocId('todoItems'),
      trip_id: tripId,
      sort_order: order++,
      assigned_user_id: mapId(maps.users, t.assigned_user_id),
    } as TodoItem);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Persist `bundle` as a new local trip and return its id. One `withStore`
 * transaction — everything lands or nothing does.
 */
export function saveBundle(bundle: ShareBundle): Promise<number> {
  return withStore((store) => {
    const maps: IdMaps = {
      users: new Map(),
      days: new Map(),
      places: new Map(),
      categories: new Map(),
      assignments: new Map(),
      accommodations: new Map(),
      reservations: new Map(),
      bags: new Map(),
      userRows: new Map(),
    };
    const tripId = store.allocId('trips');
    const linkedUsers = mapRoster(store, bundle.users, maps);
    linkMembers(store, tripId, linkedUsers);
    mapCategories(store, bundle, maps);
    importTrip(store, bundle, tripId);
    importPlaces(store, bundle, maps, tripId);
    // Days allocate before stays (stays need day ids) but write after them
    // (their embedded stops carry accommodation_id).
    const sortedDays = allocDayIds(store, bundle, maps);
    importAccommodations(store, bundle, maps, tripId);
    writeDays(store, sortedDays, maps, tripId);
    importReservations(store, bundle, maps, tripId);
    importBudget(store, bundle, maps, tripId);
    importPacking(store, bundle, maps, tripId);
    importTodos(store, bundle, maps, tripId);
    return tripId;
  });
}
