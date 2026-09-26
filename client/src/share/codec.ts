/**
 * Share codec v1 (design spec §9) — one PanelMint trip ⇄ a portable bundle.
 *
 * `encodeTrip` reads a trip's raw Dexie rows — never the `api/local/*` wire
 * emitters, which join display fields the stored rows don't carry — packs them
 * into the versioned `ShareBundle` envelope, deflates it
 * (`CompressionStream('deflate-raw')`) and base64url-encodes it for the
 * `/import?d=` link. `encodeToFile`/`decodeFromFile` carry the same envelope as
 * uncompressed JSON so the `.panelmint.json` export stays inspectable. When a
 * token grows past {@link SHARE_URL_MAX_CHARS} the caller falls back to the
 * file transport.
 *
 * Two junction tables have no envelope slot of their own and are embedded on
 * encode: `assignmentParticipants` lands on `days[].assignments[].participants`
 * and `packingBagMembers` on `packingBags[].members`, both in the wire shapes
 * the entity schemas already declare. `reservationTravelers` stays a top-level
 * array of raw junction rows; `users[]` is the trip's roster — the `localUsers`
 * rows the `tripMembers` link references, plus the trip owner so payer /
 * participant references to them never dangle.
 *
 * Values that only resolved against the old server — `/uploads/…` and `/api/…`
 * paths and inline `data:` blobs — are nulled on the way out: a shared trip can
 * never fetch them, and an inline cover would balloon the payload. The
 * trip-scoped tables with no envelope slot (`tripMembers`, the category
 * assignee tables, `budgetCategoryOrder`, `syncMeta`, `settings`, `tags`) are
 * deliberately not exported.
 */
import {
  accommodationSchema,
  assignmentParticipantSchema,
  assignmentPlaceSchema,
  budgetItemReceiptSchema,
  budgetItemSchema,
  budgetSettlementSchema,
  categorySchema,
  daySchema,
  packingBagSchema,
  packingItemSchema,
  placeSchema,
  reservationSchema,
  roadtripViaSchema,
  tripSchema,
} from '@trek/shared';
import { z } from 'zod';

import { db } from '../db/panelmintDb';
import type { AssignmentParticipant, LocalUser, PackingBagMember } from '../types';

/** The envelope version this build writes and reads. */
export const SHARE_FORMAT_VERSION = 1;

/**
 * Character ceiling for the URL transport (`/import?d=<token>`). Past it the
 * caller exports the file instead — browsers and share sheets start mangling
 * very long URLs.
 */
export const SHARE_URL_MAX_CHARS = 8000;

const ERR_NO_TRIP = 'Trip not found';
const ERR_ENCODE = 'This trip could not be exported — its data looks incomplete';
const ERR_BAD_LINK = "That share link doesn't look like a PanelMint trip — it may be truncated or corrupted";
const ERR_BAD_FILE = "This file isn't a PanelMint trip export";
const ERR_NEWER = 'This trip was shared by a newer version of PanelMint — update the app to open it';

/**
 * A stored `days.assignments[]` row. There is no assignments table — the row
 * embeds on its day — and the two writers disagree on shape: the ported
 * `api/local` code stores the server's bare columns (`end_day` is SQLite 0/1,
 * no `place`), while rows written through remoteEventHandler carry the wire
 * projection (`end_day` boolean, `place` embedded). The bundle keeps both
 * shapes verbatim plus the `participants` array filled from the
 * `assignmentParticipants` junction.
 */
const bundleAssignmentSchema = z.object({
  id: z.number(),
  day_id: z.number(),
  place_id: z.number(),
  order_index: z.number(),
  notes: z.string().nullable().optional(),
  reservation_status: z.string().nullable().optional(),
  reservation_notes: z.string().nullable().optional(),
  reservation_datetime: z.string().nullable().optional(),
  assignment_time: z.string().nullable().optional(),
  assignment_end_time: z.string().nullable().optional(),
  end_day: z.union([z.number(), z.boolean()]).optional(),
  accommodation_id: z.number().nullable().optional(),
  leg_transport_mode: z.string().nullable().optional(),
  incoming_leg_transport_mode: z.string().nullable().optional(),
  participants: z.array(assignmentParticipantSchema).optional(),
  place: assignmentPlaceSchema.nullable().optional(),
  created_at: z.string().optional(),
});

/** Stored day row — `daySchema` plus the embedded `vias` the wire schema omits
 *  and the stored-shape `assignments`. */
const bundleDaySchema = daySchema.extend({
  assignments: z.array(bundleAssignmentSchema).optional(),
  vias: z.array(roadtripViaSchema).optional(),
});

/** Stored place row — `placeSchema` plus the `my_rating` fold (the local
 *  replacement for the server's per-user place_ratings table) and the flat
 *  `category_*` join columns a wire-written row can carry. */
const bundlePlaceSchema = placeSchema.extend({
  my_rating: z.number().nullable().optional(),
  category_name: z.string().nullable().optional(),
  category_color: z.string().nullable().optional(),
  category_icon: z.string().nullable().optional(),
});

/** Budget item as stored — `members`/`payers`/`receipts` ride on the row. The
 *  receipt `url` is nulled on export when it pointed at the server, so the
 *  bundle keeps the row but drops the dead link. */
const bundleBudgetItemSchema = budgetItemSchema.extend({
  receipts: z.array(budgetItemReceiptSchema.extend({ url: z.string().nullable() })).optional(),
});

/** Stored settlement row plus the joined avatar fields a wire-written row can
 *  carry (`from_avatar`/`to_avatar` alongside the schema's `*_avatar_url`). */
const bundleSettlementSchema = budgetSettlementSchema.extend({
  from_avatar: z.string().nullable().optional(),
  to_avatar: z.string().nullable().optional(),
});

/** `todoItems` has no shared entity schema (todo.schema.ts carries requests
 *  only) — this mirrors the `TodoItem` row in src/types.ts. */
const bundleTodoItemSchema = z.object({
  id: z.number(),
  trip_id: z.number(),
  name: z.string(),
  category: z.string().nullable().optional(),
  checked: z.number().optional(),
  sort_order: z.number().optional(),
  due_date: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  assigned_user_id: z.number().nullable().optional(),
  priority: z.number().optional(),
  created_at: z.string().optional(),
});

/** A `localUsers` roster row (self + named guests). */
const bundleUserSchema = z.object({
  id: z.number(),
  name: z.string(),
  is_self: z.number().optional(),
  email: z.string().optional(),
});

/** A `reservation_travelers` junction row — travels raw, never embedded. */
const bundleTravelerRowSchema = z.object({
  id: z.number().optional(),
  reservation_id: z.number(),
  user_id: z.number(),
});

/**
 * The v1 envelope. Collections default to `[]` so a hand-authored or
 * future-trimmed bundle still decodes; keys outside the schema are stripped
 * (zod's default), which is what makes newer-version fields tolerable.
 */
export const shareBundleSchema = z.object({
  v: z.literal(SHARE_FORMAT_VERSION),
  exported_at: z.string().optional(),
  trip: tripSchema,
  days: z.array(bundleDaySchema).default([]),
  places: z.array(bundlePlaceSchema).default([]),
  reservations: z.array(reservationSchema).default([]),
  reservationTravelers: z.array(bundleTravelerRowSchema).default([]),
  accommodations: z.array(accommodationSchema).default([]),
  budgetItems: z.array(bundleBudgetItemSchema).default([]),
  budgetSettlements: z.array(bundleSettlementSchema).default([]),
  packingItems: z.array(packingItemSchema).default([]),
  packingBags: z.array(packingBagSchema).default([]),
  todoItems: z.array(bundleTodoItemSchema).default([]),
  categories: z.array(categorySchema).default([]),
  users: z.array(bundleUserSchema).default([]),
});

/** The decoded v1 envelope — the importer (`saveBundle` in remap.ts) consumes it. */
export type ShareBundle = z.infer<typeof shareBundleSchema>;

/**
 * `kind` marker of the export-all archive — one `.panelmint.json` carrying
 * every trip on the device. The elements are exactly what {@link encodeToFile}
 * writes for one trip, so the per-trip codec stays the single source of truth
 * (spec §9: same codec, different transport).
 */
export const SHARE_ARCHIVE_KIND = 'panelmint-archive';

export const shareArchiveSchema = z.object({
  v: z.literal(SHARE_FORMAT_VERSION),
  kind: z.literal(SHARE_ARCHIVE_KIND),
  exported_at: z.string().optional(),
  trips: z.array(shareBundleSchema),
});

/** The decoded archive envelope — the export-all backup file. */
export type ShareArchive = z.infer<typeof shareArchiveSchema>;

// ── Server-URL stripping ─────────────────────────────────────────────────────

/** `/uploads/…` and `/api/…` resolved against the dead server; `data:` blobs
 *  inline the file and would balloon the payload. Everything else — a real
 *  https link, a plain string — is portable and stays. */
function isDeadUrl(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith('/uploads/') || value.startsWith('/api/') || value.startsWith('data:'))
  );
}

type Row = Record<string, unknown>;

/** Null out the named fields of `row` where they hold a dead URL. */
function stripUrlFields<T extends object>(row: T, fields: readonly string[]): T {
  const rec = row as Row;
  let out: Row | null = null;
  for (const field of fields) {
    if (isDeadUrl(rec[field])) (out ??= { ...rec })[field] = null;
  }
  return (out ?? row) as T;
}

/** Null out `fields` inside every element of `row[listField]`. */
function stripListUrlFields<T extends object>(row: T, listField: string, fields: readonly string[]): T {
  const list = (row as Row)[listField];
  if (!Array.isArray(list)) return row;
  let changed = false;
  const next = list.map((item) => {
    const stripped = item !== null && typeof item === 'object' ? stripUrlFields(item as Row, fields) : item;
    if (stripped !== item) changed = true;
    return stripped;
  });
  return changed ? ({ ...(row as Row), [listField]: next } as T) : row;
}

/**
 * The URL-bearing fields across the exported entities (enumerated from the
 * entity schemas, per spec §9): cover/thumbnail images, member-shaped avatars,
 * link fields that would have resolved against the server, and the budget
 * receipt urls.
 */
function sanitizeDay<T extends object>(day: T): T {
  const assignments = (day as Row).assignments;
  if (!Array.isArray(assignments)) return day;
  let changed = false;
  const next = assignments.map((item) => {
    let out: Row = stripListUrlFields(item as Row, 'participants', ['avatar']);
    // `place` rides embedded on rows written through the wire shape.
    const place = out.place;
    if (place !== null && typeof place === 'object' && !Array.isArray(place)) {
      const stripped = stripUrlFields(place as Row, ['image_url', 'website']);
      if (stripped !== place) out = { ...out, place: stripped };
    }
    if (out !== item) changed = true;
    return out;
  });
  return changed ? ({ ...(day as Row), assignments: next } as T) : day;
}

function sanitizeReservation<T extends object>(row: T): T {
  let out = stripUrlFields(row, ['url']);
  out = stripListUrlFields(out, 'travelers', ['avatar', 'avatar_url']);
  return out;
}

function sanitizeBudgetItem<T extends object>(row: T): T {
  let out = stripListUrlFields(row, 'receipts', ['url']);
  out = stripListUrlFields(out, 'members', ['avatar', 'avatar_url']);
  out = stripListUrlFields(out, 'payers', ['avatar', 'avatar_url']);
  return out;
}

function sanitizeBag<T extends object>(row: T): T {
  return stripListUrlFields(row, 'members', ['avatar']);
}

// ── Encode ──────────────────────────────────────────────────────────────────

/**
 * Read `tripId`'s rows out of Dexie and pack them into the v1 envelope. The
 * junction embeds and the URL strip happen here; the result is run through
 * {@link shareBundleSchema} so the emitted bundle is always a valid, normalized
 * `ShareBundle` (dead columns like `feed_token` never leave the device).
 */
export async function buildBundle(tripId: number | string): Promise<ShareBundle> {
  const numericId = Number(tripId);
  // A non-numeric id is the local equivalent of the route param that matched
  // nothing — the same 'Trip not found' the api/local adapters answer.
  const trip = Number.isFinite(numericId) ? await db.trips.get(numericId) : undefined;
  if (!trip) throw new Error(ERR_NO_TRIP);

  const [
    days,
    places,
    reservations,
    accommodations,
    budgetItems,
    budgetSettlements,
    packingItems,
    packingBags,
    todoItems,
    categories,
    memberRows,
    roster,
  ] = await Promise.all([
    db.days.where('trip_id').equals(numericId).toArray(),
    db.places.where('trip_id').equals(numericId).toArray(),
    db.reservations.where('trip_id').equals(numericId).toArray(),
    db.accommodations.where('trip_id').equals(numericId).toArray(),
    db.budgetItems.where('trip_id').equals(numericId).toArray(),
    db.budgetSettlements.where('trip_id').equals(numericId).toArray(),
    db.packingItems.where('trip_id').equals(numericId).toArray(),
    db.packingBags.where('trip_id').equals(numericId).toArray(),
    db.todoItems.where('trip_id').equals(numericId).toArray(),
    db.categories.toArray(),
    db.tripMembers.where('tripId').equals(numericId).toArray(),
    db.localUsers.toArray(),
  ]);

  const usersById = new Map<number, LocalUser>(roster.map((u) => [u.id, u]));

  // Roster: the members' localUsers rows plus the trip owner — the owner is
  // part of the roster whether or not they hold a tripMembers row (trips.create
  // doesn't write one for self), and references like paid_by_user_id need it.
  const rosterIds = new Set<number>(memberRows.map((m) => m.id));
  rosterIds.add(trip.user_id);
  const users = [...rosterIds]
    .sort((a, b) => a - b)
    .flatMap((id) => {
      const u = usersById.get(id);
      return u ? [stripUrlFields(u, ['avatar', 'avatar_url'])] : [];
    });

  // `assignmentParticipants` junction → embedded `participants` wire rows, the
  // same projection the store's participantsOf produces ('Guest N' fallback).
  const participantsByAssignment = new Map<number, AssignmentParticipant[]>();
  const assignmentIds = days.flatMap((d) => (d.assignments ?? []).map((a) => a.id));
  const participantRows = assignmentIds.length
    ? await db.assignmentParticipants.where('assignment_id').anyOf(assignmentIds).toArray()
    : [];
  for (const p of participantRows) {
    const list = participantsByAssignment.get(p.assignment_id) ?? [];
    list.push({
      user_id: p.user_id,
      username: usersById.get(p.user_id)?.name ?? `Guest ${p.user_id}`,
      avatar: null,
    });
    participantsByAssignment.set(p.assignment_id, list);
  }

  // `packingBagMembers` junction → embedded `members` wire rows; a member whose
  // user row is gone drops, matching the INNER JOIN the wire emitters run.
  const membersByBag = new Map<number, PackingBagMember[]>();
  const bagIds = packingBags.map((b) => b.id);
  const bagMemberRows = bagIds.length ? await db.packingBagMembers.where('bag_id').anyOf(bagIds).toArray() : [];
  for (const m of bagMemberRows) {
    const u = usersById.get(m.user_id);
    if (!u) continue;
    const list = membersByBag.get(m.bag_id) ?? [];
    list.push({ user_id: m.user_id, username: u.name, avatar: null });
    membersByBag.set(m.bag_id, list);
  }

  const reservationIds = new Set(reservations.map((r) => r.id));
  const reservationTravelers = reservationIds.size
    ? await db.reservationTravelers
        .where('reservation_id')
        .anyOf([...reservationIds])
        .toArray()
    : [];

  const daysOut = [...days]
    .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0) || a.id - b.id)
    .map((day) =>
      sanitizeDay({
        ...(day as unknown as Row),
        assignments: (day.assignments ?? []).map(
          (a) =>
            ({
              ...(a as unknown as Row),
              participants: participantsByAssignment.get(a.id) ?? [],
            }) as Row
        ),
      })
    );

  const envelope = {
    v: SHARE_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    trip: stripUrlFields(trip, ['cover_image']),
    days: daysOut,
    places: places.map((p) => stripUrlFields(p, ['image_url', 'website'])),
    reservations: reservations.map(sanitizeReservation),
    reservationTravelers,
    accommodations: accommodations.map((a) => stripUrlFields(a, ['place_image'])),
    budgetItems: budgetItems.map(sanitizeBudgetItem),
    budgetSettlements: budgetSettlements.map((s) =>
      stripUrlFields(s, ['from_avatar', 'to_avatar', 'from_avatar_url', 'to_avatar_url'])
    ),
    packingItems,
    packingBags: packingBags.map((b) => sanitizeBag({ ...b, members: membersByBag.get(b.id) ?? [] })),
    todoItems,
    categories,
    users,
  };

  const parsed = shareBundleSchema.safeParse(envelope);
  if (!parsed.success) throw new Error(ERR_ENCODE);
  return parsed.data;
}

// ── Compression + base64url transport ────────────────────────────────────────

/** Push `data` through a web transform stream and collect the output. */
async function pumpTransform(data: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  // The write runs concurrently with the drain — a compression stream only
  // unblocks its writer once the readable side is being read.
  const pending = (async () => {
    await writer.write(data as BufferSource);
    await writer.close();
  })();
  pending.catch(() => {
    /* surfaced via `await pending` below — pre-registered so an early write
     * failure is not an unhandled rejection while we drain. */
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await pending;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Spread-friendly chunks: String.fromCharCode has a practical arg limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(token: string): Uint8Array {
  if (!BASE64URL_RE.test(token)) throw new Error('not base64url');
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * `tripId` → base64url(deflate-raw(JSON(bundle))) — the `/import?d=` token.
 * Compare the returned length against {@link SHARE_URL_MAX_CHARS} and fall back
 * to {@link encodeToFile} when it exceeds it.
 */
export async function encodeTrip(tripId: number | string): Promise<string> {
  const bundle = await buildBundle(tripId);
  const compressed = await pumpTransform(
    new TextEncoder().encode(JSON.stringify(bundle)),
    new CompressionStream('deflate-raw')
  );
  return bytesToBase64Url(compressed);
}

/** `?d=` token → the decoded bundle. Throws a friendly `Error` on anything
 *  malformed, and a specific one when the share came from a newer PanelMint. */
export async function decodeTrip(d: string): Promise<ShareBundle> {
  let json: string;
  try {
    const compressed = base64UrlToBytes(d.trim());
    const inflated = await pumpTransform(compressed, new DecompressionStream('deflate-raw'));
    json = new TextDecoder().decode(inflated);
  } catch {
    throw new Error(ERR_BAD_LINK);
  }
  return parseBundleJson(json, ERR_BAD_LINK);
}

/** `tripId` → pretty JSON string of the bundle — the `.panelmint.json` export. */
export async function encodeToFile(tripId: number | string): Promise<string> {
  return JSON.stringify(await buildBundle(tripId), null, 2);
}

/**
 * Every trip on the device → the pretty JSON of one {@link ShareArchive}
 * (Settings "Export all"). Archived trips ride along — a backup covers them
 * too. Each element of `trips` is the same bundle {@link encodeToFile} emits.
 */
export async function encodeAllToFile(): Promise<string> {
  const trips = await db.trips.toArray();
  const bundles: ShareBundle[] = [];
  for (const trip of trips) {
    bundles.push(await buildBundle(trip.id));
  }
  const archive: ShareArchive = {
    v: SHARE_FORMAT_VERSION,
    kind: SHARE_ARCHIVE_KIND,
    exported_at: new Date().toISOString(),
    trips: bundles,
  };
  return JSON.stringify(archive, null, 2);
}

/** `.panelmint.json` contents → the decoded bundle (same checks as the URL). */
export function decodeFromFile(json: string): ShareBundle {
  return parseBundleJson(json, ERR_BAD_FILE);
}

/**
 * `.panelmint.json` contents → every bundle it carries: one for a single-trip
 * export, N for a `panelmint-archive` backup (Settings "Import"). A `v` newer
 * than this build — on the envelope or on any bundled trip — answers the
 * specific "newer PanelMint" error, not the generic malformed one.
 */
export function decodeBundlesFromFile(json: string): ShareBundle[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(ERR_BAD_FILE);
  }
  checkFormatVersion(raw);
  if (raw !== null && typeof raw === 'object' && (raw as { kind?: unknown }).kind === SHARE_ARCHIVE_KIND) {
    const trips = (raw as { trips?: unknown }).trips;
    if (Array.isArray(trips)) for (const entry of trips) checkFormatVersion(entry);
    const parsed = shareArchiveSchema.safeParse(raw);
    if (!parsed.success) throw new Error(ERR_BAD_FILE);
    return parsed.data.trips;
  }
  return [parseBundleValue(raw, ERR_BAD_FILE)];
}

function parseBundleJson(json: string, malformedMessage: string): ShareBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(malformedMessage);
  }
  return parseBundleValue(raw, malformedMessage);
}

function parseBundleValue(raw: unknown, malformedMessage: string): ShareBundle {
  // Peek at `v` before the shape parse so a future bundle gets the specific
  // "newer PanelMint" error instead of the generic malformed one.
  checkFormatVersion(raw);
  const parsed = shareBundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(malformedMessage);
  return parsed.data;
}

function checkFormatVersion(raw: unknown): void {
  if (raw !== null && typeof raw === 'object') {
    const v = (raw as { v?: unknown }).v;
    if (typeof v === 'number' && v > SHARE_FORMAT_VERSION) throw new Error(ERR_NEWER);
  }
}
