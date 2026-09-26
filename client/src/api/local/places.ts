/**
 * `placesApi` — the local implementation. Same method list and envelopes as the
 * axios version (`{ places }` / `{ place }` / `{ success: true }` /
 * `{ deleted, count }` / `{ updated, count }`), backed by `DexieStore` over the
 * `panelmint` database.
 *
 * Server parity notes (server/src/nest/places/):
 *  - The Zod pipe ran BEFORE the trip lookup on create/update/bulk routes, so a
 *    malformed body on a missing trip is a 400, not a 404. The in-handler
 *    guards (string lengths, route_color hex, image/website URL allow-lists)
 *    ran AFTER the trip 404 — both orders kept.
 *  - `create` inserts with the server's defaults verbatim: `transport_mode`
 *    'walking', `duration_minutes` 60, `?? null` on the numeric columns (0 is
 *    a legitimate coordinate/price/fill, `||` would swallow it), `|| null` on
 *    the string columns (empty means absent). `tags` are ids resolved against
 *    the tags table — off-roster ids dropped silently server-side; locally the
 *    whole tags table is the self user's, so existence is the check.
 *  - `update` keeps the COALESCE/presence split: `name`, `currency` and
 *    `transport_mode` are COALESCE writes (absent/falsy keeps the stored
 *    value); every other column is presence-keyed (`!== undefined` → write,
 *    including null clears); `tags` replaces the whole set only when the key
 *    is present. `route_geometry` was never in the UPDATE list server-side and
 *    still is not. The If-Match conflict protocol has no local caller (the
 *    axios surface never sent the header) — single-user local writes are
 *    unconditional.
 *  - `rate` maps onto the `my_rating` column (the local fold of the
 *    `place_ratings` table — one rater, one column). It never touches
 *    `updated_at`, exactly as the server kept votes out of the row's version.
 *  - `delete`/`bulkDelete` carry the server's cascade: embedded day
 *    assignments die with the place (FK CASCADE), stays at the place go
 *    through `deleteStay` (which releases the reservation/stop links the
 *    server's cancelStaysAt released), expenses linked by `place_id` are
 *    deleted (#1298), `reservations.place_id` is the FK's SET NULL.
 *  - The server-only surface is absent by design: `searchImage`,
 *    `uploadImage`, `importGpx`, `importMapFile`, `importGoogleList`,
 *    `importNaverList`. Callers were stripped with the methods; nothing here
 *    throws polite "removed" errors for routes that no longer exist at all.
 */
import {
  hexColorSchema,
  placeBulkDeleteRequestSchema,
  placeBulkUpdateRequestSchema,
  placeCreateRequestSchema,
  placeImageUrlSchema,
  placeRatingRequestSchema,
  placeUpdateRequestSchema,
  placeWebsiteSchema,
  type PlaceCreateRequest,
  type PlaceUpdateRequest,
} from '@trek/shared';
import type { RoadtripStopType } from '@trek/shared';
import type { Place, Tag } from '../../types';
import type { LocalPlace } from '../../db/panelmintDb';
import { badRequest, notFound, numId, nowIso, parseBody } from './helpers';
import { DexieStore, withStore } from './dexieStore';
import type { PlaceWire, StoredAssignment } from './dexieStore';

/**
 * Fields accepted when creating a place — the server's `PlaceCreateInput`.
 * The shared request schema is an open record (every field beyond `name` is
 * `unknown` to the compiler), so the parsed body is read through this narrow
 * interface, the same cast the controller's `body as never` performed.
 */
interface PlaceCreateInput {
  [key: string]: unknown;
  name: string; description?: string; lat?: number; lng?: number; address?: string;
  category_id?: number; price?: number; currency?: string;
  place_time?: string; end_time?: string;
  duration_minutes?: number; notes?: string; image_url?: string;
  google_place_id?: string; google_ftid?: string; osm_id?: string; amap_poi_id?: string;
  website?: string; phone?: string;
  stop_type?: RoadtripStopType | null; fill_percent?: number | null;
  transport_mode?: string; route_geometry?: string; route_color?: string; tags?: number[];
}

/** Fields accepted when patching a place — the server's `PlaceUpdateInput`
 *  (no `route_geometry`: it was never in the UPDATE list). */
interface PlaceUpdateInput {
  [key: string]: unknown;
  name?: string; description?: string; lat?: number; lng?: number; address?: string;
  category_id?: number; price?: number; currency?: string;
  place_time?: string; end_time?: string;
  duration_minutes?: number; notes?: string; image_url?: string;
  google_place_id?: string; google_ftid?: string; osm_id?: string; amap_poi_id?: string;
  website?: string; phone?: string;
  stop_type?: RoadtripStopType | null; fill_percent?: number | null;
  transport_mode?: string; route_color?: string | null; tags?: number[];
}

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** The place row exists AND belongs to the trip, else 'Place not found'. */
function requirePlace(store: DexieStore, tripId: number, placeId: number | string): LocalPlace {
  const pid = numId(placeId);
  const row = Number.isFinite(pid)
    ? store.placesOfTrip(tripId).find((p) => p.id === pid)
    : undefined;
  if (!row) throw notFound('Place');
  return row;
}

// ── The in-handler guards, verbatim from places.controller.ts ────────────────

const STRING_LIMITS: Record<string, number> = { name: 200, description: 2000, address: 500, notes: 2000 };

function validateLengths(body: Record<string, unknown>): void {
  for (const [field, max] of Object.entries(STRING_LIMITS)) {
    const value = body[field];
    if (value && typeof value === 'string' && value.length > max) {
      throw badRequest(`${field} must be ${max} characters or less`);
    }
  }
}

// route_color leaves the database for the map's track styling, and the update
// body is an open record that Zod does not police.
function validateRouteColor(body: Record<string, unknown>): void {
  const value = body.route_color;
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !hexColorSchema.safeParse(value).success) {
    throw badRequest('route_color must be a hex colour like #4f46e5');
  }
}

// Same reason as route_color: these two leave the database for a renderer that
// treats them as a URL — the thumbnail into marker HTML, the homepage into
// window.open — and the open record means the pipe never sees them.
function validateUrlFields(body: Record<string, unknown>): void {
  const image = body.image_url;
  if (image !== undefined && image !== null) {
    if (typeof image !== 'string' || !placeImageUrlSchema.safeParse(image).success) {
      throw badRequest('image_url must be an uploaded path, a photo-proxy path, an inline image or an https URL');
    }
  }
  const website = body.website;
  // '' is how the UI clears the field; treat it like an absent value.
  if (website !== undefined && website !== null && website !== '') {
    if (typeof website !== 'string' || !placeWebsiteSchema.safeParse(website).success) {
      throw badRequest('website must be an http or https URL');
    }
  }
}

/**
 * The subset of `tagIds` that exists. The server filtered to tags owned by a
 * trip-roster member; locally the tags table is the self user's alone, so
 * "known tag id" is the whole check — unknown ids still drop silently.
 */
function tagsKnown(store: DexieStore, tagIds: number[]): Tag[] {
  const known = store.tagRows();
  return [...new Set(tagIds)].map((id) => known.get(id)).filter((t): t is Tag => !!t);
}

/**
 * What a place delete took down with it — the ids the server put on the wire
 * (`reservation:deleted`/`budget:deleted` to every tab including the
 * deleter's). `accommodationIds` is the local addition: stays live in
 * page-local state no server event ever reached, so the caller nudges the
 * planner with `accommodations:refresh` when the list is non-empty.
 */
export interface PlaceDeleteCancelled {
  reservationIds: number[];
  budgetItemIds: number[];
  accommodationIds: number[];
}

const noCancelled = (): PlaceDeleteCancelled => ({ reservationIds: [], budgetItemIds: [], accommodationIds: [] });

/**
 * The server's place-delete cascade, local-table edition: embedded day
 * assignments die with the place; stays booked there go through the
 * accommodations-domain teardown (stay-linked reservations and their
 * `reservation_id`-linked expenses die FIRST — `deleteStay` would
 * `SET NULL accommodation_id` and orphan them); expenses linked by
 * `place_id` are deleted, not orphaned (#1298); `reservations` keep the
 * FK's SET NULL.
 */
function cascadePlaceDelete(store: DexieStore, tripId: number, placeId: number, into: PlaceDeleteCancelled): void {
  for (const day of store.daysOfTrip(tripId)) {
    const stored = (day.assignments ?? []) as unknown as StoredAssignment[];
    const kept = stored.filter((a) => a.place_id !== placeId);
    if (kept.length !== stored.length) {
      const deadIds = new Set(stored.filter((a) => a.place_id === placeId).map((a) => a.id));
      day.assignments = kept as unknown as typeof day.assignments;
      store.put('days', day);
      const participants = store.assignmentParticipantRows();
      for (const p of participants) {
        if (deadIds.has(p.assignment_id)) store.delete('assignmentParticipants', p.id);
      }
    }
  }
  for (const stay of store.accommodationsOfTrip(tripId)) {
    if (stay.place_id !== placeId) continue;
    // accommodations.deleteAccommodation parity: reservations linked by
    // accommodation_id and each one's linked budget item die with the stay.
    // Before deleteStay on purpose — it NULLs the link column.
    for (const r of store.reservationsOfTrip(tripId)) {
      if (r.accommodation_id == null || Number(r.accommodation_id) !== stay.id) continue;
      const linked = store.findLinkedBudgetItem(tripId, r.id);
      if (linked) {
        store.deleteBudgetItem(linked.id);
        into.budgetItemIds.push(linked.id);
      }
      store.deleteReservation(r.id);
      into.reservationIds.push(r.id);
    }
    store.deleteStay(stay.id, tripId);
    into.accommodationIds.push(stay.id);
  }
  for (const b of store.budgetItemsOfTrip(tripId)) {
    if (b.place_id === placeId) {
      store.deleteBudgetItem(b.id);
      into.budgetItemIds.push(b.id);
    }
  }
  for (const r of store.reservationsOfTrip(tripId)) {
    if (r.place_id === placeId) {
      r.place_id = null;
      store.put('reservations', r);
    }
  }
  store.delete('places', placeId);
}

/** LIKE '%term%' with `\`-escaped wildcards, over name/address/description. */
function matchesSearch(p: LocalPlace, term: string): boolean {
  const needle = term.toLowerCase();
  return [p.name, p.address, p.description].some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
  );
}

export const placesApi = {
  /**
   * `{ places }` — `listPlacesWire` already sorts `created_at DESC, id DESC`
   * the way the server's `ORDER BY p.created_at DESC` read. The query filters
   * (search / category / tag / assignment) are the controller's `@Query` set.
   */
  list: (
    tripId: number | string,
    params?: { search?: string; category?: string; tag?: string; assignment?: 'all' | 'unassigned' | 'assigned' },
  ): Promise<{ places: PlaceWire[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      let places = store.listPlacesWire(tid);

      if (params?.search) {
        // ESCAPE'd LIKE %term% over name/address/description — case-folded
        // `includes` is the local equivalent (LIKE is case-insensitive for
        // ASCII, and the LIKE-meta characters never arrive as wildcards).
        places = places.filter((p) => matchesSearch(p, params.search!));
      }
      if (params?.category) {
        const categoryId = numId(params.category);
        places = places.filter((p) => p.category_id === categoryId);
      }
      if (params?.tag) {
        const tagId = numId(params.tag);
        places = places.filter((p) => (p.tags ?? []).some((t) => t.id === tagId));
      }
      if (params?.assignment === 'unassigned' || params?.assignment === 'assigned') {
        const assigned = new Set<number>();
        for (const day of store.daysOfTrip(tid)) {
          for (const a of day.assignments ?? []) assigned.add(a.place_id);
        }
        places = places.filter((p) =>
          params.assignment === 'assigned' ? assigned.has(p.id) : !assigned.has(p.id),
        );
      }
      return { places };
    }),

  get: (tripId: number | string, id: number | string): Promise<{ place: PlaceWire }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const row = requirePlace(store, tid, id);
      return { place: store.placeWire(row) };
    }),

  create: (tripId: number | string, data: PlaceCreateRequest): Promise<{ place: Place }> =>
    withStore((store) => {
      // The pipe ran first on the server: a bad body on a missing trip was a
      // 400, and the in-handler guards sat between the trip 404 and the write.
      const body = parseBody(placeCreateRequestSchema, data) as PlaceCreateInput;
      const tid = requireTrip(store, tripId);
      validateLengths(body as Record<string, unknown>);
      validateRouteColor(body as Record<string, unknown>);
      validateUrlFields(body as Record<string, unknown>);

      const id = store.allocId('places');
      const row: LocalPlace = {
        id,
        trip_id: tid,
        name: body.name,
        description: body.description || null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        address: body.address || null,
        category_id: body.category_id || null,
        price: body.price ?? null,
        currency: body.currency || null,
        place_time: body.place_time || null,
        end_time: body.end_time || null,
        duration_minutes: body.duration_minutes ?? 60,
        notes: body.notes || null,
        image_url: body.image_url || null,
        google_place_id: body.google_place_id || null,
        google_ftid: body.google_ftid || null,
        osm_id: body.osm_id || null,
        amap_poi_id: body.amap_poi_id || null,
        website: body.website || null,
        phone: body.phone || null,
        transport_mode: body.transport_mode || 'walking',
        route_geometry: body.route_geometry || null,
        route_color: body.route_color || null,
        stop_type: body.stop_type ?? null,
        fill_percent: body.fill_percent ?? null,
        tags: tagsKnown(store, body.tags ?? []),
        my_rating: null,
        created_at: nowIso(),
        // The server column defaults CURRENT_TIMESTAMP — created and touched
        // once at insert.
        updated_at: nowIso(),
      };
      store.put('places', row);
      return { place: store.placeWire(store.placesOfTrip(tid).find((p) => p.id === id)!) as Place };
    }),

  update: (tripId: number | string, id: number | string, data: PlaceUpdateRequest): Promise<{ place: Place }> =>
    withStore((store) => {
      const body = parseBody(placeUpdateRequestSchema, data) as PlaceUpdateInput;
      const tid = requireTrip(store, tripId);
      validateLengths(body as Record<string, unknown>);
      validateRouteColor(body as Record<string, unknown>);
      validateUrlFields(body as Record<string, unknown>);
      const row = requirePlace(store, tid, id);

      // COALESCE columns: absent or falsy keeps the stored value.
      row.name = body.name || row.name;
      row.currency = body.currency || row.currency;
      row.transport_mode = body.transport_mode || row.transport_mode;
      // Presence-keyed columns: `!== undefined` writes, null clears.
      if (body.description !== undefined) row.description = body.description;
      if (body.lat !== undefined) row.lat = body.lat;
      if (body.lng !== undefined) row.lng = body.lng;
      if (body.address !== undefined) row.address = body.address;
      if (body.category_id !== undefined) row.category_id = body.category_id;
      if (body.price !== undefined) row.price = body.price;
      if (body.place_time !== undefined) row.place_time = body.place_time;
      if (body.end_time !== undefined) row.end_time = body.end_time;
      if (body.duration_minutes !== undefined) row.duration_minutes = body.duration_minutes;
      if (body.notes !== undefined) row.notes = body.notes;
      if (body.image_url !== undefined) row.image_url = body.image_url;
      if (body.google_place_id !== undefined) row.google_place_id = body.google_place_id;
      if (body.google_ftid !== undefined) row.google_ftid = body.google_ftid;
      if (body.osm_id !== undefined) row.osm_id = body.osm_id;
      if (body.amap_poi_id !== undefined) row.amap_poi_id = body.amap_poi_id;
      if (body.website !== undefined) row.website = body.website;
      if (body.phone !== undefined) row.phone = body.phone;
      // Deliberately not COALESCE: an explicit null is how the picker resets a
      // track back to its category colour (#776), and how a fuel stop becomes
      // an ordinary place again.
      if (body.route_color !== undefined) row.route_color = body.route_color;
      if (body.stop_type !== undefined) row.stop_type = body.stop_type;
      if (body.fill_percent !== undefined) row.fill_percent = body.fill_percent;
      if (body.tags !== undefined) row.tags = tagsKnown(store, body.tags);
      row.updated_at = nowIso();

      store.put('places', row);
      return { place: store.placeWire(row) as Place };
    }),

  delete: (tripId: number | string, id: number | string): Promise<{ success: true; cancelled: PlaceDeleteCancelled }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const row = requirePlace(store, tid, id);
      const cancelled = noCancelled();
      cascadePlaceDelete(store, tid, row.id, cancelled);
      return { success: true, cancelled };
    }),

  bulkDelete: (tripId: number | string, ids: number[]): Promise<{ deleted: number[]; count: number; cancelled: PlaceDeleteCancelled }> =>
    withStore((store) => {
      const body = parseBody(placeBulkDeleteRequestSchema, { ids });
      const tid = requireTrip(store, tripId);
      const cancelled = noCancelled();
      if (body.ids.length === 0) return { deleted: [], count: 0, cancelled };
      // Only ids that really belong to the trip delete — a foreign id is
      // skipped, never an error (the server's IN-scoped SELECT did the same).
      const owned = new Set(store.placesOfTrip(tid).map((p) => p.id));
      const deleted: number[] = [];
      for (const id of body.ids) {
        if (!owned.has(id)) continue;
        cascadePlaceDelete(store, tid, id, cancelled);
        deleted.push(id);
      }
      return { deleted, count: deleted.length, cancelled };
    }),

  bulkUpdate: (
    tripId: number | string,
    ids: number[],
    data: Omit<import('@trek/shared').PlaceBulkUpdateRequest, 'ids'>,
  ): Promise<{ updated: number[]; count: number }> =>
    withStore((store) => {
      const body = parseBody(placeBulkUpdateRequestSchema, { ids, ...data });
      const tid = requireTrip(store, tripId);
      if (body.ids.length === 0) return { updated: [], count: 0 };
      // `category_id` may be a number or null (null clears it), so key
      // presence — not truthiness — is what signals there's something to change.
      if (!('category_id' in body)) {
        throw badRequest('Provide at least one field to update');
      }
      const rows = store.placesOfTrip(tid);
      const owned = new Map(rows.map((p) => [p.id, p]));
      const updated: number[] = [];
      for (const id of body.ids) {
        const row = owned.get(id);
        if (!row) continue;
        row.category_id = body.category_id ?? null;
        row.updated_at = nowIso();
        store.put('places', row);
        updated.push(id);
      }
      return { updated, count: updated.length };
    }),

  /**
   * `{ place }` — set (1-5) or clear (null) the self user's vote. Never touches
   * `updated_at`: a vote must not version-bump the row. The wire projection
   * re-derives `ratings`/`rating_avg`/`rating_count` from `my_rating`.
   */
  rate: (tripId: number | string, id: number | string, rating: number | null): Promise<{ place: Place }> =>
    withStore((store) => {
      // The rating pipe ran before the trip lookup on the server — a bad
      // rating on a missing trip was a 400, not a 404.
      if (rating !== null) parseBody(placeRatingRequestSchema, { rating });
      const tid = requireTrip(store, tripId);
      const row = requirePlace(store, tid, id);
      row.my_rating = rating;
      store.put('places', row);
      return { place: store.placeWire(row) as Place };
    }),
};
