/**
 * `daysApi` — the local implementation. Same method list and envelopes as the
 * axios version in api/client.ts (`{days}` / `{day}` / `{success: true}`),
 * backed by `DexieStore` over the `panelmint` database.
 *
 * Server parity notes (server/src/nest/days/):
 *  - TripAccessGuard 404s an unreachable trip with 'Trip not found'; a day id
 *    outside the trip 404s with 'Day not found' — kept verbatim.
 *  - `create` splits on `position`: with it, the ported `insertDay` (two-phase
 *    renumber, dates pinned to slots, trip end_date extended, bookings
 *    restamped, accommodation inversion refused); without it, the legacy
 *    append (`max(day_number)+1`, the caller's date/notes as sent).
 *  - `update` preserves the omitted columns (the server's presence sentinels:
 *    `'notes' in fields` → `notes || null`, `'title' in fields` →
 *    `title ?? null`), and returns the slimmer `getAssignmentsForDay`
 *    projection — no `notes_items`, no participants — the way the server did.
 *  - `updateTransport` writes only `default_transport_mode`.
 *  - `delete` is the bare row delete; the FK cascade (embedded assignments and
 *    notes die with the row, accommodations cascade, reservation day links go
 *    NULL) is `deleteDayCascade`.
 *  - `reorder` is the ported `reorderDays` — permutation check first, then the
 *    two-phase negative `day_number` renumber (the Dexie
 *    `&[trip_id+day_number]` unique index would otherwise collide), date
 *    restamp, inversion guard. `DayReorderError` → 400, same as the
 *    controller mapped it.
 */
import {
  dayCreateRequestSchema,
  dayReorderRequestSchema,
  dayTransportRequestSchema,
  dayUpdateRequestSchema,
  type DayCreateRequest,
  type DayUpdateRequest,
} from '@trek/shared';
import type { Day } from '../../types';
import { badRequest, notFound, numId, parseBody } from './helpers';
import { DexieStore, withStore } from './dexieStore';
import { DayReorderError, insertDay, reorderDays } from './ported/day-ops';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** `getDay(id, tripId)` — the row exists AND belongs to the trip, else the
 *  bespoke 'Day not found' 404. */
function requireDay(store: DexieStore, tripId: number, dayId: number | string): number {
  const did = numId(dayId);
  const day = Number.isFinite(did) ? store.dayRow(did) : undefined;
  if (!day || day.trip_id !== tripId) throw notFound('Day');
  return did;
}

/** `DayReorderError` → 400 — the controller's catch mapping, verbatim. */
function mapReorderError(err: unknown): never {
  if (err instanceof DayReorderError) throw badRequest(err.message);
  throw err;
}

export const daysApi = {
  list: (tripId: number | string): Promise<{ days: Day[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return { days: store.listDaysWire(tid) };
    }),

  create: (tripId: number | string, data: DayCreateRequest): Promise<{ day: Day }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(dayCreateRequestSchema, data);
      if (body.position !== undefined) {
        try {
          const { dayId } = insertDay(store, tid, body.position);
          // The server's insert() returned `{ ...day, assignments: [],
          // notes_items: [] }` — a bare row in both list fields.
          const row = store.dayRow(dayId)!;
          const { vias: _vias, ...rest } = row;
          return { day: { ...rest, assignments: [], notes_items: [] } as Day };
        } catch (err) {
          mapReorderError(err);
        }
      }
      // Legacy append: max(day_number) + 1, caller's date/notes verbatim.
      const days = store.daysOfTrip(tid);
      const dayNumber = days.reduce((m, d) => Math.max(m, d.day_number ?? 0), 0) + 1;
      const id = store.insertDay(tid, dayNumber, body.date || null);
      const row = store.dayRow(id)!;
      if (body.notes) {
        row.notes = body.notes;
        store.put('days', row);
      }
      const { vias: _vias, notes_items: _notes, ...rest } = row;
      return { day: { ...rest, assignments: [] } as Day };
    }),

  update: (tripId: number | string, dayId: number | string, data: DayUpdateRequest): Promise<{ day: Day }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      // The body pipe ran before the handler's day lookup — a bad body on a
      // missing day was a 400, not a 404.
      const body = parseBody(dayUpdateRequestSchema, data);
      const did = requireDay(store, tid, dayId);
      const row = store.dayRow(did)!;
      // Presence sentinels: an absent key keeps the stored column ('' notes
      // clear to null; '' title stays '' — the server's `||` vs `??` quirk).
      row.notes = 'notes' in body ? body.notes || null : (row.notes ?? null);
      row.title = 'title' in body ? (body.title ?? null) : (row.title ?? null);
      store.put('days', row);
      return { day: store.dayWireForUpdate(did)! };
    }),

  updateTransport: (tripId: number | string, dayId: number | string, mode: string | null): Promise<{ day: Day }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      // DayTransportDto ran before the handler's getDay — same 400-beats-404 order.
      const body = parseBody(dayTransportRequestSchema, { transport_mode: mode });
      const did = requireDay(store, tid, dayId);
      const row = store.dayRow(did)!;
      row.default_transport_mode = body.transport_mode ?? null;
      store.put('days', row);
      return { day: store.dayWireForUpdate(did)! };
    }),

  delete: (tripId: number | string, dayId: number | string): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const did = requireDay(store, tid, dayId);
      store.deleteDayCascade(did);
      return { success: true as const };
    }),

  reorder: (tripId: number | string, orderedIds: number[]): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      // The controller's explicit guard, verbatim — kept from the legacy
      // raw-body route, where no pipe stood in front of it.
      if (!Array.isArray(orderedIds)) throw badRequest('orderedIds must be an array');
      parseBody(dayReorderRequestSchema, { orderedIds });
      try {
        reorderDays(store, tid, orderedIds);
      } catch (err) {
        mapReorderError(err);
      }
      return { success: true as const };
    }),
};
