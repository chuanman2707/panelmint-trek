/**
 * `dayNotesApi` — the Dexie port of the hosted DayNotesController +
 * DayNotesService pair (server/src/nest/day-notes/). Envelopes unchanged:
 *
 *   GET         → { notes }
 *   POST        → { note }
 *   PUT :id     → { note }
 *   DELETE :id  → { success: true }
 *
 * There is no day_notes table locally — the rows embed on their day
 * (`days.notes_items`), the same shape remoteEventHandler and upsertDays
 * already write, and ids come from the shared `days.notes` allocator.
 *
 * Server parity notes:
 *  - Every route was trip-scoped; create additionally checked the day row
 *    belonged to the trip (404 'Day not found' before the text guard — the
 *    controller's order). update/delete look the note up by id + day + trip
 *    together: a note on another day answers 'Note not found', not 'Day not
 *    found' (getNote never checked the day separately).
 *  - create: `!body.text?.trim()` → 400 'Text required'; the column defaults
 *    were `time || null`, `icon || '📝'`, `sort_order ?? 9999`,
 *    `normalizeNoteColor(color)` — a colour off the palette stores null, not
 *    an error.
 *  - update rewrote every column with `fields.x !== undefined ? x : current`:
 *    an absent key keeps, a present one writes (text trimmed, colour
 *    normalized). No bodyKeys subtlety — a present-but-undefined field keeps.
 *  - list ordered `ORDER BY sort_order ASC, created_at ASC` — the same sort
 *    the day wire applies to notes_items.
 *  - The move the UI performs stays a create on the destination day plus a
 *    delete on the source (there never was an atomic move) — the slice owns
 *    that orchestration, unchanged.
 */
import {
  NOTE_COLORS,
  dayNoteCreateRequestSchema,
  dayNoteUpdateRequestSchema,
  type DayNoteCreateRequest,
  type DayNoteUpdateRequest,
} from '@trek/shared';
import type { DayNote } from '../../types';
import { DexieStore, withStore, type DayRow } from './dexieStore';
import { badRequest, detached, notFound, nowIso, numId, parseBody } from './helpers';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** `SELECT id FROM days WHERE id = ? AND trip_id = ?` or the create 404. */
function requireDay(store: DexieStore, tripId: number, dayId: number | string): DayRow {
  const day = store.dayRow(numId(dayId));
  if (!day || day.trip_id !== tripId) throw notFound('Day');
  return day;
}

/** `normalizeNoteColor` — only a palette colour reaches the column. */
function normalizeNoteColor(color: string | null | undefined): string | null {
  if (!color) return null;
  return (NOTE_COLORS as readonly string[]).includes(color) ? color : null;
}

/** `SELECT * ORDER BY sort_order ASC, created_at ASC` over the embedded rows. */
function sortedNotes(day: DayRow): DayNote[] {
  return detached(day.notes_items ?? []).sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.created_at ?? '').localeCompare(b.created_at ?? ''),
  );
}

/** `getNote` — id + day + trip together; a foreign note answers 'Note not
 *  found' exactly like the trip-scoped SELECT did. */
function findNote(day: DayRow | undefined, tripId: number, id: number | string): DayNote | undefined {
  const nid = numId(id);
  if (!day || day.trip_id !== tripId) return undefined;
  return (day.notes_items ?? []).find((n) => n.id === nid);
}

export const dayNotesApi = {
  list: (tripId: number | string, dayId: number | string): Promise<{ notes: DayNote[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      // The GET had no day-existence check — a missing or foreign day scopes
      // the SELECT to zero rows, not a 404.
      const day = store.dayRow(numId(dayId));
      return { notes: day && day.trip_id === tid ? sortedNotes(day) : [] };
    }),

  create: (
    tripId: number | string,
    dayId: number | string,
    data: DayNoteCreateRequest,
  ): Promise<{ note: DayNote }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(dayNoteCreateRequestSchema, data);
      // The controller checked the day row before the text guard.
      const day = requireDay(store, tid, dayId);
      if (!body.text?.trim()) throw badRequest('Text required');
      const note: DayNote = {
        id: store.allocId('days.notes'),
        day_id: day.id,
        trip_id: tid,
        text: body.text.trim(),
        time: body.time || null,
        icon: body.icon || '📝',
        sort_order: body.sort_order ?? 9999,
        color: normalizeNoteColor(body.color),
        created_at: nowIso(),
      };
      day.notes_items = [...(day.notes_items ?? []), note];
      store.put('days', day);
      return { note: detached(note) };
    }),

  update: (
    tripId: number | string,
    dayId: number | string,
    id: number,
    data: DayNoteUpdateRequest,
  ): Promise<{ note: DayNote }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(dayNoteUpdateRequestSchema, data);
      // getNote never resolved the day separately: a missing day fails the
      // note lookup the same way a missing note does — 'Note not found'.
      const day = store.dayRow(numId(dayId));
      const note = findNote(day, tid, id);
      if (!note) throw notFound('Note');
      // The service's `fields.x !== undefined ? x : current` — a present-but-
      // undefined key keeps the stored value, not the presence protocol.
      if (body.text !== undefined) note.text = body.text.trim();
      if (body.time !== undefined) note.time = body.time;
      if (body.icon !== undefined) note.icon = body.icon;
      if (body.sort_order !== undefined) note.sort_order = body.sort_order;
      if (body.color !== undefined) note.color = normalizeNoteColor(body.color);
      store.put('days', day);
      return { note: detached(note) };
    }),

  delete: (tripId: number | string, dayId: number | string, id: number): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const day = store.dayRow(numId(dayId));
      const note = findNote(day, tid, id);
      if (!note) throw notFound('Note');
      day.notes_items = (day.notes_items ?? []).filter((n) => n.id !== note.id);
      store.put('days', day);
      return { success: true as const };
    }),
};
