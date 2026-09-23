/**
 * `tripsApi` — the local implementation. Same method list and envelopes as the
 * axios version in api/client.ts, backed by `DexieStore` over the `panelmint`
 * database instead of HTTP.
 *
 * Server parity notes (server/src/nest/trips/ + trip-members/ +
 * trip-read-model/):
 *  - create/update run the same zod contracts the global pipe did, then the
 *    same controller-level checks ('End date must be after start date'), then
 *    the ported `generateDays` diff (ported/generate-days.ts) with the
 *    `date_shift_mode` follow-up (`restampReservationDates` for 'shift_all',
 *    `resyncReservationDays` + `resyncAccommodationDays` for the default
 *    'keep_bookings').
 *  - list/get/active return the TRIP_SELECT enrichment (day_count,
 *    place_count, is_owner, owner_username, shared_count); access is
 *    "self owns it or self is a member" — the local roster's only account is
 *    self, so every stored trip is owned, and member rows are guests.
 *  - Members/guests keep the trip-members service semantics: guests are
 *    roster rows (`localUsers` with is_self=0) linked through `tripMembers`;
 *    `addMember` resolves a roster entry by name; ownership cannot transfer to
 *    a guest, so locally it can never succeed — the guard chain is kept.
 *  - copy() duplicates the sub-tree the server duplicated — including its
 *    gaps: reservation endpoints, travelers and day_positions were never
 *    copied server-side, so the local copy drops them too (the embedded
 *    arrays simply don't get written on the new rows).
 *  - bundle() aggregates the same sub-collections the offline bundle did;
 *    `files` is `[]` — the files feature is cut by the design doc.
 *  - uploadCover stores the image inline as a data: URL — there is no
 *    /uploads store locally. searchCoverImages returns an empty photo list
 *    (Unsplash is a hosted-only integration; the cover-search UI is being
 *    stripped per the design doc, and an empty list renders as "no results"
 *    rather than an error).
 */
import {
  MAX_TRIP_DAYS,
  tripAddMemberRequestSchema,
  tripCopyRequestSchema,
  tripCreateGuestRequestSchema,
  tripCreateRequestSchema,
  tripRenameGuestRequestSchema,
  tripTransferOwnershipRequestSchema,
  tripUpdateRequestSchema,
  type ActiveTripResponse,
  type TripCopyRequest,
  type TripCreateRequest,
  type TripMember,
  type TripUpdateRequest,
} from '@trek/shared';
import type {
  Accommodation,
  BudgetItem,
  Day,
  PackingBag,
  PackingItem,
  Reservation,
  TodoItem,
  Trip,
  TripFile,
} from '../../types';
import type { LocalPlace } from '../../db/panelmintDb';
import type { PlaceWire } from './dexieStore';
import { db } from '../../db/panelmintDb';
import { fetchExchangeRates } from '../../hooks/useExchangeRates';
import { apiError, badRequest, LocalApiError, notFound, numId, nowIso, parseBody } from './helpers';
import {
  DexieStore,
  SELF_ID,
  withStore,
  type DayRow,
  type ReservationRow,
  type StoredAssignment,
} from './dexieStore';
import { addDays, DayReorderError, restampReservationDates, resyncAccommodationDays } from './ported/day-ops';
import { assertTripSpan, computeDayDiff, planDayRegeneration } from './ported/generate-days';
import { resyncReservationDays, ReservationValidationError } from './ported/reservation-cascade';

const MAX_COVER_SIZE = 20 * 1024 * 1024;
const COVER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

/** The photo shape the Unsplash search returned; the local search always
 *  emits an empty list (the integration is hosted-only). */
interface CoverSearchPhoto {
  id: string;
  url: string;
  thumb: string;
  description?: string | null;
  photographer?: string | null;
  link?: string | null;
}

/** The server's listMembers envelope — `owner` is null only when the trip's
 *  owner row is missing, the way the server join read NULL. */
interface TripMembersResponse {
  owner: TripMember | null;
  members: TripMember[];
  current_user_id: number;
}

/** The offline bundle aggregate (server TripReadModelService.bundle). */
export interface TripBundle {
  trip: Trip;
  days: Day[];
  places: PlaceWire[];
  packingItems: PackingItem[];
  todoItems: TodoItem[];
  budgetItems: BudgetItem[];
  reservations: Reservation[];
  files: TripFile[];
  accommodations: Accommodation[];
  members: TripMember[];
}

/** Port/domain errors → the HTTP status the controllers mapped them to. */
function mapDomainErrors(err: unknown): never {
  if (err instanceof DayReorderError || err instanceof ReservationValidationError) {
    throw badRequest(err.message);
  }
  if (err instanceof Error && err.name === 'DayRangeError') {
    throw badRequest(err.message);
  }
  throw err;
}

/** The trip row, scoped: exists AND reachable by self, else the same 404 the
 *  TripAccessGuard / get() produced. */
function requireTrip(store: DexieStore, id: number | string): Trip {
  const tid = numId(id);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return trip;
}

/** The ported generateDays + follow-up, run inside the caller's transaction —
 *  verbatim the server's update() block (snapshot → diff → restamp/reanchor). */
function regenerateDays(
  store: DexieStore,
  tripId: number,
  start: string | null,
  end: string | null,
  dayCount: number | undefined,
  mode: 'keep_bookings' | 'shift_all' | undefined,
): void {
  const existing = store.daysOfTrip(tripId);
  const plan = planDayRegeneration(
    { id: tripId, start_date: start, end_date: end },
    existing,
    mode ?? 'keep_bookings',
    { dayCount, contentDayIds: store.contentDayIds(tripId) },
  );
  store.applyDayDiff(plan.diff);
  if (plan.followUp === 'restamp') {
    restampReservationDates(store, tripId, plan.prevDateByDayId, plan.newDateByDayId);
  } else if (plan.followUp === 'reanchor') {
    resyncReservationDays(store, tripId);
    resyncAccommodationDays(store, tripId, plan.prevDateByDayId);
  }
}

/** File → data: URL without FileReader (works in jsdom and the browser). */
async function fileToDataUrl(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const b of buf) binary += String.fromCharCode(b);
  return `data:${file.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

/** The server's cover fileFilter, mirrored on the stored File. Multer ran as
 *  an interceptor — BEFORE the handler's access check — and its rejections
 *  mapped through the exception filter: a plain Error → 500 'Internal server
 *  error', LIMIT_FILE_SIZE → 413 'File too large'. */
function checkCoverFile(file: File): void {
  const ext = `.${(file.name.split('.').pop() ?? '').toLowerCase()}`;
  const typeOk = file.type.startsWith('image/') && !file.type.includes('svg');
  if (!typeOk || !COVER_EXTENSIONS.includes(ext)) {
    throw apiError(500, 'Internal server error');
  }
  if (file.size > MAX_COVER_SIZE) {
    throw apiError(413, 'File too large');
  }
}

export const tripsApi = {
  list: (params?: Record<string, unknown>): Promise<{ trips: Trip[] }> =>
    withStore((store) => {
      // Controller: `archived === '1' ? 1 : 0` — every list is one flag's rows.
      const archived = params?.archived === 1 || params?.archived === '1' ? 1 : 0;
      const accessible = store.accessibleTripIds();
      const trips = [...store.tripsMap().values()]
        .filter((t) => accessible.has(t.id) && (t.is_archived ?? 0) === archived)
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id - a.id)
        .map((t) => store.tripSelect(t));
      return { trips };
    }),

  create: (data: TripCreateRequest): Promise<{ trip: Trip }> =>
    withStore((store) => {
      try {
        const body = parseBody(tripCreateRequestSchema, data);
        // Controller: infer the missing endpoint before the service sees it.
        let start = body.start_date || null;
        let end = body.end_date || null;
        if (start && !end) end = addDays(start, 6);
        else if (!start && end) start = addDays(end, -6);
        if (start && end && new Date(end) < new Date(start)) {
          throw badRequest('End date must be after start date');
        }
        const dayCount = body.day_count
          ? Math.min(Math.max(Number(body.day_count) || 7, 1), MAX_TRIP_DAYS)
          : undefined;
        // Service.create re-asserts the range (the ported assertTripSpan).
        assertTripSpan(start, end);
        const reminderDays =
          body.reminder_days !== undefined
            ? Number(body.reminder_days) >= 0 && Number(body.reminder_days) <= 30
              ? Number(body.reminder_days)
              : 3
            : 3;

        const id = store.allocId('trips');
        store.putTrip({
          id,
          user_id: SELF_ID,
          title: body.title,
          description: body.description || null,
          start_date: start,
          end_date: end,
          currency: body.currency || store.defaultCurrency(),
          cover_image: null,
          is_archived: 0,
          reminder_days: reminderDays,
          created_at: nowIso(),
          updated_at: nowIso(),
        } as Trip);
        // generateDays on an empty trip — the row diff only, no bookings yet.
        const diff = computeDayDiff(
          { id, start_date: start, end_date: end },
          [],
          'keep_bookings',
          { dayCount },
        );
        store.applyDayDiff(diff);
        return { trip: store.tripSelect(store.tripRaw(id)!) };
      } catch (err) {
        mapDomainErrors(err);
      }
    }),

  get: (id: number | string): Promise<{ trip: Trip }> =>
    withStore((store) => ({ trip: store.tripSelect(requireTrip(store, id)) })),

  active: (): Promise<ActiveTripResponse> =>
    withStore((store) => {
      const today = new Date().toISOString().slice(0, 10);
      const accessible = store.accessibleTripIds();
      const ranked = [...store.tripsMap().values()]
        .filter((t) => accessible.has(t.id) && (t.is_archived ?? 0) === 0)
        .map((t) => ({
          trip: t,
          relevance:
            t.start_date != null && t.end_date != null && t.start_date <= today && t.end_date >= today
              ? 0
              : t.start_date != null && t.start_date >= today
                ? 1
                : 2,
        }))
        .sort(
          (a, b) =>
            a.relevance - b.relevance ||
            (a.relevance < 2
              ? (a.trip.start_date ?? '').localeCompare(b.trip.start_date ?? '')
              : (b.trip.start_date ?? '').localeCompare(a.trip.start_date ?? '')),
        );
      const t = ranked[0]?.trip;
      return {
        trip: t
          ? { id: t.id, title: t.title, start_date: t.start_date ?? null, end_date: t.end_date ?? null }
          : null,
      };
    }),

  update: async (id: number | string, data: TripUpdateRequest): Promise<{ trip: Trip }> => {
    // A currency switch re-anchors the budget to fresh FX rates, and the fetch
    // must resolve BEFORE the rw transaction — a non-Dexie await inside
    // `withStore` would let Dexie auto-commit early (the uploadCover rule).
    // fetchExchangeRates never rejects; null rates produce the same "not
    // frozen" pins the server wrote when Frankfurter was unreachable.
    const requested =
      typeof data?.currency === 'string' && data.currency.trim()
        ? data.currency.trim().toUpperCase()
        : '';
    let rates: Record<string, number> | undefined;
    if (requested) {
      const existingId = numId(id);
      const existing = Number.isFinite(existingId) ? await db.trips.get(existingId) : undefined;
      if (existing && (existing.currency || 'EUR').toUpperCase() !== requested) {
        rates = (await fetchExchangeRates(requested)) ?? undefined;
      }
    }
    return withStore((store) => {
      try {
        // The update route carried no trip guard — its DTO pipe ran before the
        // in-handler canAccessTrip, so a bad body on an unreachable trip was a
        // 400, not a 404.
        const body = parseBody(tripUpdateRequestSchema, data);
        const trip = requireTrip(store, id);
        // Per-field permission checks ran in this order on the controller —
        // trip_edit/trip_archive/trip_cover_upload all default to owner-level,
        // so locally they fire only for a member-reached trip (self owns the
        // rest outright).
        if (trip.user_id !== SELF_ID) {
          if (body.is_archived !== undefined) {
            throw apiError(403, 'No permission to archive/unarchive this trip');
          }
          if (body.cover_image !== undefined) {
            throw apiError(403, 'No permission to change cover image');
          }
          const editFields = [
            'title',
            'description',
            'start_date',
            'end_date',
            'currency',
            'reminder_days',
            'day_count',
          ] as const;
          if (editFields.some((f) => body[f] !== undefined)) {
            throw apiError(403, 'No permission to edit this trip');
          }
        }
        // resolveRange — checked before anything is written (a refused range
        // must not leave the budget rebased).
        const { start_date, end_date } = body;
        if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
          throw badRequest('End date must be after start date');
        }
        const newStart = start_date !== undefined ? start_date : trip.start_date;
        const newEnd = end_date !== undefined ? end_date : trip.end_date;
        const dayCount = body.day_count
          ? Math.min(Math.max(Number(body.day_count) || 7, 1), MAX_TRIP_DAYS)
          : undefined;
        const regenerate =
          newStart !== trip.start_date || newEnd !== trip.end_date || dayCount !== undefined;
        if (regenerate && newStart && newEnd) assertTripSpan(newStart, newEnd);

        // Re-anchor the budget while the outgoing currency is still on the row.
        store.rebaseTripCurrency(trip.id, body.currency, rates);

        const oldReminder = trip.reminder_days ?? 3;
        const newReminder =
          body.reminder_days !== undefined
            ? Number(body.reminder_days) >= 0 && Number(body.reminder_days) <= 30
              ? Number(body.reminder_days)
              : oldReminder
            : oldReminder;
        Object.assign(trip, {
          title: body.title || trip.title,
          description: body.description !== undefined ? body.description : trip.description,
          start_date: newStart || null,
          end_date: newEnd || null,
          currency: body.currency || trip.currency,
          is_archived:
            body.is_archived !== undefined ? (body.is_archived ? 1 : 0) : (trip.is_archived ?? 0),
          cover_image: body.cover_image !== undefined ? body.cover_image : trip.cover_image,
          reminder_days: newReminder,
          updated_at: nowIso(),
        });
        store.putTrip(trip);

        if (regenerate) {
          regenerateDays(store, trip.id, newStart || null, newEnd || null, dayCount, body.date_shift_mode);
        }
        return { trip: store.tripSelect(store.tripRaw(trip.id)!) };
      } catch (err) {
        mapDomainErrors(err);
      }
    });
  },

  delete: (id: number | string): Promise<{ success: true }> =>
    withStore((store) => {
      const trip = requireTrip(store, id);
      // trip_delete is an owner action the permission check enforced — locally
      // self is the only owner, so a non-owned trip can only be a member row.
      if (trip.user_id !== SELF_ID) throw apiError(403, 'No permission to delete this trip');
      store.deleteTripCascade(trip.id);
      return { success: true as const };
    }),

  /**
   * Local cover upload: no /uploads store exists, so the file is kept inline
   * as a data: URL — the same field the hosted version filled with the
   * uploaded file's path. The file checks mirror the multer filter.
   */
  uploadCover: async (id: number | string, formData: FormData): Promise<{ cover_image: string | null }> => {
    const file = formData.get('cover');
    // fileFilter/limit ran while multer parsed the upload — before the
    // handler's access check — so type/size rejections fire first here too.
    if (file instanceof File) checkCoverFile(file);
    // Read the bytes BEFORE opening the transaction — a non-Dexie await inside
    // `withStore` would let Dexie auto-commit early.
    const dataUrl = file instanceof File ? await fileToDataUrl(file) : null;
    return withStore((store) => {
      const trip = requireTrip(store, id);
      // trip_cover_upload is owner-level by default — the cover route's own
      // wording, distinct from update()'s 'No permission to change cover image'.
      if (trip.user_id !== SELF_ID) {
        throw apiError(403, 'No permission to change the cover image');
      }
      // 'No image uploaded' fired inside the handler, after the access 404.
      if (!file) throw badRequest('No image uploaded');
      trip.cover_image = dataUrl;
      trip.updated_at = nowIso();
      store.putTrip(trip);
      return { cover_image: dataUrl };
    });
  },

  // Unsplash search was a hosted integration; the cover-search UI is being
  // stripped. An empty result set is the graceful local answer — the modal
  // renders "no results" instead of an error.
  searchCoverImages: (_query: string): Promise<{ photos: CoverSearchPhoto[] }> =>
    Promise.resolve({ photos: [] }),

  archive: (id: number | string) => tripsApi.update(id, { is_archived: true }),
  unarchive: (id: number | string) => tripsApi.update(id, { is_archived: false }),

  getMembers: (id: number | string): Promise<TripMembersResponse> =>
    withStore((store) => {
      const trip = requireTrip(store, id);
      return {
        owner: store.ownerWire(trip) ?? null,
        members: store.memberRows(trip.id).map((m) => store.memberWire(m, trip.user_id)),
        current_user_id: SELF_ID,
      };
    }),

  addMember: (id: number | string, identifier: string): Promise<{ member: TripMember }> =>
    withStore((store) => {
      // The DTO pipe ran before the handler's access check — a malformed body
      // 400s even on an unreachable trip.
      parseBody(tripAddMemberRequestSchema, { identifier });
      const trip = requireTrip(store, id);
      // member_manage is an owner power locally; the server's collaborator
      // path produced 'No permission to manage members'.
      if (trip.user_id !== SELF_ID) throw apiError(403, 'No permission to manage members');
      // tripAddMemberRequestSchema passes '' through; the service rejects it.
      if (!identifier) throw badRequest('Email or username required');
      const name = identifier.trim();
      // The server query excluded guests (is_guest = 0) — locally that leaves
      // only self, the one roster row that can hold a "real" account.
      const found = store.listUsers().find((u) => u.name === name && u.is_self === 1);
      if (!found) throw notFound('User');
      if (found.id === trip.user_id) throw badRequest('Trip owner is already a member');
      if (store.memberRow(trip.id, found.id)) throw badRequest('User already has access');
      store.addMemberRow(trip.id, found, SELF_ID);
      return {
        member: {
          id: found.id,
          username: found.name,
          email: found.email,
          avatar: null,
          role: 'member',
          avatar_url: null,
        },
      };
    }),

  removeMember: (id: number | string, userId: number): Promise<{ success: true }> =>
    withStore((store) => {
      const trip = requireTrip(store, id);
      // Anyone may remove themselves; removing somebody else needed
      // member_manage — owner-only locally.
      if (userId !== SELF_ID && trip.user_id !== SELF_ID) {
        throw apiError(403, 'No permission to remove members');
      }
      store.removeMemberRow(trip.id, userId);
      return { success: true as const };
    }),

  transferOwnership: (id: number | string, newOwnerId: number): Promise<{ success: true }> =>
    withStore((store) => {
      // TripOwnerGuard ran before the body pipe: unreachable → 404, not the
      // owner → the 403 message the route declared — THEN the DTO ran.
      const trip = requireTrip(store, id);
      if (trip.user_id !== SELF_ID) throw apiError(403, 'Only the owner can transfer ownership');
      parseBody(tripTransferOwnershipRequestSchema, { newOwnerId });
      if (newOwnerId === SELF_ID) throw badRequest('You already own this trip');
      const newOwner = store.user(newOwnerId);
      if (!newOwner) throw notFound('User');
      // Every non-self roster row is a guest — guests can never own a trip.
      if (newOwner.is_self !== 1) throw badRequest('Cannot transfer ownership to a guest');
      if (!store.memberRow(trip.id, newOwnerId)) {
        throw badRequest('New owner must be a trip member');
      }
      trip.user_id = newOwnerId;
      store.putTrip(trip);
      store.removeMemberRow(trip.id, newOwnerId);
      store.addMemberRow(trip.id, store.selfUser(), newOwnerId);
      return { success: true as const };
    }),

  createGuest: (id: number | string, name: string): Promise<{ member: TripMember }> =>
    withStore((store) => {
      // TripOwnerGuard: access 404, then the route's declared 403, THEN the
      // body pipe ran.
      const trip = requireTrip(store, id);
      if (trip.user_id !== SELF_ID) throw apiError(403, 'Only the owner can manage guests');
      parseBody(tripCreateGuestRequestSchema, { name });
      const display = (name || '').trim();
      if (!display) throw badRequest('Guest name is required');
      if (display.length > 50) throw badRequest('Guest name must be 50 characters or fewer');
      const guest = store.createGuest(trip.id, display, SELF_ID);
      return {
        member: {
          id: guest.id,
          username: display,
          email: guest.email,
          role: 'member',
          is_guest: true,
          avatar_url: null,
        },
      };
    }),

  renameGuest: (id: number | string, userId: number, name: string): Promise<{ success: true }> =>
    withStore((store) => {
      const trip = requireTrip(store, id);
      if (trip.user_id !== SELF_ID) throw apiError(403, 'Only the owner can manage guests');
      parseBody(tripRenameGuestRequestSchema, { name });
      const display = (name || '').trim();
      if (!display) throw badRequest('Guest name is required');
      if (display.length > 50) throw badRequest('Guest name must be 50 characters or fewer');
      if (!store.guestOfTrip(trip.id, userId)) throw notFound('Guest');
      const u = store.user(userId)!;
      u.name = display;
      store.put('localUsers', u);
      const m = store.memberRow(trip.id, userId);
      if (m) {
        m.username = display;
        store.put('tripMembers', m);
      }
      return { success: true as const };
    }),

  deleteGuest: (id: number | string, userId: number): Promise<{ success: true }> =>
    withStore((store) => {
      const trip = requireTrip(store, id);
      if (trip.user_id !== SELF_ID) throw apiError(403, 'Only the owner can manage guests');
      if (!store.guestOfTrip(trip.id, userId)) throw notFound('Guest');
      store.purgeUserData(userId);
      return { success: true as const };
    }),

  /**
   * Deep copy — the server's copy() table list, mapped onto the local row
   * shapes: days carry their embedded assignments/notes_items/vias; places
   * carry tags; reservations remap every reference but keep the server's
   * omission of endpoints/travelers/day_positions; budget members/payers ride
   * inside their item rows; packing filters and resets stay verbatim.
   */
  copy: (id: number | string, data?: TripCopyRequest): Promise<{ trip: Trip }> =>
    withStore((store) => {
      // No trip guard on the route — the DTO pipe ran before canAccessTrip.
      const body = parseBody(tripCopyRequestSchema, data ?? {});
      const src = requireTrip(store, id);
      try {
        return copyTrip(store, src, body.title);
      } catch (err) {
        if (err instanceof LocalApiError) throw err;
        // The controller wrapped any copy failure in a bare 500.
        throw apiError(500, 'Failed to copy trip');
      }
    }),

  /**
   * The offline bundle — the same aggregate the server's
   * TripReadModelService.bundle returned. `files` is `[]`: the attachments
   * feature is cut by the design doc. `members` is owner + roster rows.
   */
  bundle: (id: number | string): Promise<TripBundle> =>
    withStore((store) => {
      const trip = requireTrip(store, id);
      // enrichItems (server packingService): visibility filter for the viewer,
      // ORDER BY sort_order, created_at — then usernames resolved through the
      // roster JOINs (a dangling recipient/contributor row joined nothing and
      // dropped out, hence the filter).
      const resolveUser = (userId: number) => store.user(userId);
      const packingItems = store
        .packingItemsOfTrip(trip.id)
        .filter(
          (p) =>
            !p.is_private ||
            p.owner_id === SELF_ID ||
            (p.recipients ?? []).some((r) => r.user_id === SELF_ID),
        )
        .sort(
          (a, b) =>
            (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
            (a.created_at ?? '').localeCompare(b.created_at ?? '') ||
            a.id - b.id,
        )
        .map((p) => ({
          ...p,
          owner_username: p.owner_id != null ? (resolveUser(p.owner_id)?.name ?? null) : null,
          recipients: (p.recipients ?? [])
            .map((r) => {
              const u = resolveUser(r.user_id);
              return u ? { ...r, username: u.name } : null;
            })
            .filter((r): r is { user_id: number; username: string } => r !== null),
          contributors: (p.contributors ?? [])
            .map((c) => {
              const u = resolveUser(c.user_id);
              return u ? { ...c, username: u.name } : null;
            })
            .filter((c): c is { user_id: number; username: string; status: string } => c !== null),
        }));
      const owner = store.ownerWire(trip);
      const members = [
        owner,
        ...store.memberRows(trip.id).map((m) => store.memberWire(m, trip.user_id)),
      ].filter((m): m is TripMember => m !== undefined);
      return {
        trip: store.tripSelect(trip),
        days: store.listDaysWire(trip.id),
        places: store.listPlacesWire(trip.id),
        packingItems,
        // listItems ORDER BY sort_order, created_at — the local row has no
        // created_at, so the rowid order (id) is the tiebreak.
        todoItems: store
          .todoItemsOfTrip(trip.id)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id),
        budgetItems: store.listBudgetItemsWire(trip.id),
        reservations: store.listReservationsWire(trip.id),
        files: [],
        accommodations: store.listAccommodationsWire(trip.id),
        members,
      };
    }),
};

/**
 * `TripsService.copy` — duplicates the source trip's whole sub-tree into a new
 * trip owned by self, remapping every cross-link. The column lists mirror the
 * server's INSERTs, including its deliberate omissions:
 *  - days lose `default_transport_mode` (not in the copy INSERT);
 *  - assignments lose both leg transport modes and get `accommodation_id`
 *    restamped from the copied stays afterwards;
 *  - accommodations require a mapped place AND both mapped days (a null-place
 *    stay is skipped, matching `if (newPlaceId && newStartDay && newEndDay)`);
 *  - reservations keep ingest_state but drop every `external_*`/sync column;
 *  - budget items drop `place_id` and `receipts` (members/payers embedded on
 *    the row DO travel — the server copied their junction tables);
 *  - packing items keep the copier's restricted items, reset `checked`, lose
 *    `quantity` (the server's column list omits it — the copy reads back the
 *    DEFAULT 1) and lose recipients/contributors; to-dos lose their assignee;
 *  - places drop `source`/`updated_at` and bag copies drop `user_id`, matching
 *    the server's INSERT column lists exactly.
 */
function copyTrip(store: DexieStore, src: Trip, title?: string): { trip: Trip } {
  const newTripId = store.allocId('trips');
  store.putTrip({
    id: newTripId,
    user_id: SELF_ID,
    title: title || src.title,
    description: src.description ?? null,
    start_date: src.start_date ?? null,
    end_date: src.end_date ?? null,
    currency: src.currency,
    cover_image: src.cover_image ?? null,
    is_archived: 0,
    reminder_days: src.reminder_days ?? 3,
    created_at: nowIso(),
    updated_at: nowIso(),
  } as Trip);

  const dayMap = new Map<number, number>();
  const placeMap = new Map<number, number>();
  const assignmentMap = new Map<number, number>();
  const accomMap = new Map<number, number>();
  const reservationMap = new Map<number, number>();
  /** newAssignmentId → source accommodation_id, restamped once stays exist. */
  const pendingStayLinks = new Map<number, number>();

  for (const p of store.placesOfTrip(src.id)) {
    const newId = store.allocId('places');
    // The server's INSERT column list — `source`, `updated_at` and the local
    // `my_rating` fold do not travel; `tags` is the embedded place_tags link
    // the server re-inserted per copied place.
    store.put('places', {
      id: newId,
      trip_id: newTripId,
      name: p.name,
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
      website: p.website ?? null,
      phone: p.phone ?? null,
      transport_mode: p.transport_mode ?? null,
      osm_id: p.osm_id ?? null,
      amap_poi_id: p.amap_poi_id ?? null,
      route_geometry: p.route_geometry ?? null,
      route_color: p.route_color ?? null,
      stop_type: p.stop_type ?? null,
      fill_percent: p.fill_percent ?? null,
      tags: structuredClone(p.tags ?? []),
      created_at: nowIso(),
    } as LocalPlace);
    placeMap.set(p.id, newId);
  }

  for (const d of store.daysOfTrip(src.id)) {
    const newDayId = store.allocId('days');
    dayMap.set(d.id, newDayId);
    // day_notes copy whitelist: (day_id, trip_id, text, time, icon,
    // sort_order) — `color` and the old created_at do not travel.
    const notes = (d.notes_items ?? []).map((n) => ({
      id: store.allocId('days.notes'),
      day_id: newDayId,
      trip_id: newTripId,
      text: n.text,
      time: n.time ?? null,
      icon: n.icon ?? null,
      sort_order: n.sort_order,
      created_at: nowIso(),
    }));
    // roadtrip_vias copy whitelist: (day_id, after_order_index, sequence, lat,
    // lng) — the embedded row's day_id must be restamped to the copy's day.
    const vias = (d.vias ?? []).map((v) => ({
      id: store.allocId('days.vias'),
      day_id: newDayId,
      after_order_index: v.after_order_index,
      sequence: v.sequence,
      lat: v.lat,
      lng: v.lng,
      created_at: nowIso(),
    }));
    const assignments: StoredAssignment[] = [];
    for (const a of (d.assignments ?? []) as unknown as StoredAssignment[]) {
      const newPlaceId = placeMap.get(a.place_id);
      // Server: `if (newDayId && newPlaceId)` — the day is always mapped here.
      if (newPlaceId === undefined) continue;
      const newId = store.allocId('days.assignments');
      assignmentMap.set(a.id, newId);
      if (a.accommodation_id != null) pendingStayLinks.set(newId, a.accommodation_id);
      assignments.push({
        id: newId,
        day_id: newDayId,
        place_id: newPlaceId,
        order_index: a.order_index,
        notes: a.notes,
        reservation_status: a.reservation_status,
        reservation_notes: a.reservation_notes,
        reservation_datetime: a.reservation_datetime,
        assignment_time: a.assignment_time,
        assignment_end_time: a.assignment_end_time,
        end_day: a.end_day ?? 0,
        accommodation_id: null,
        leg_transport_mode: null,
        incoming_leg_transport_mode: null,
        created_at: nowIso(),
      });
    }
    store.put('days', {
      id: newDayId,
      trip_id: newTripId,
      day_number: d.day_number,
      date: d.date ?? null,
      title: d.title ?? null,
      notes: d.notes ?? null,
      default_transport_mode: null,
      assignments,
      notes_items: notes,
      vias,
    } as unknown as DayRow);
  }

  for (const a of store.accommodationsOfTrip(src.id)) {
    const newPlaceId = a.place_id != null ? placeMap.get(a.place_id) : undefined;
    const newStart = dayMap.get(a.start_day_id);
    const newEnd = dayMap.get(a.end_day_id);
    if (newPlaceId === undefined || newStart === undefined || newEnd === undefined) continue;
    const newId = store.allocId('accommodations');
    store.put('accommodations', {
      id: newId,
      trip_id: newTripId,
      place_id: newPlaceId,
      start_day_id: newStart,
      end_day_id: newEnd,
      check_in: a.check_in ?? null,
      check_in_end: a.check_in_end ?? null,
      check_out: a.check_out ?? null,
      confirmation: a.confirmation ?? null,
      notes: a.notes ?? null,
      created_at: nowIso(),
    } as Accommodation);
    accomMap.set(a.id, newId);
  }

  // A booked night's stop carries the booking that put it there — restamp the
  // copied stops' accommodation_id from accomMap (the server's UPDATE after
  // the stay copy).
  for (const d of store.daysOfTrip(newTripId)) {
    let touched = false;
    for (const a of (d.assignments ?? []) as unknown as StoredAssignment[]) {
      const oldAccom = pendingStayLinks.get(a.id);
      if (oldAccom === undefined) continue;
      const mapped = accomMap.get(oldAccom);
      if (mapped !== undefined) {
        a.accommodation_id = mapped;
        touched = true;
      }
    }
    if (touched) store.put('days', d);
  }

  // assignment_participants ride on the copied assignment ids.
  for (const p of store.assignmentParticipantRows()) {
    const newAssignmentId = assignmentMap.get(p.assignment_id);
    if (newAssignmentId !== undefined) {
      store.put('assignmentParticipants', {
        id: store.allocId('assignmentParticipants'),
        assignment_id: newAssignmentId,
        user_id: p.user_id,
      });
    }
  }

  for (const r of store.reservationsOfTrip(src.id)) {
    const newId = store.allocId('reservations');
    // Server INSERT whitelist (trip_id, day_id, end_day_id, place_id,
    // assignment_id, accommodation_id, title, reservation_time,
    // reservation_end_time, location, confirmation_number, notes, url, status,
    // type, metadata, day_plan_position, needs_review, ingest_state) — the
    // external_*/sync columns and the joined/wire fields do not travel, and
    // neither do the embedded endpoints/day_positions/travelers (the server
    // had no copy loop for those tables).
    store.put('reservations', {
      id: newId,
      trip_id: newTripId,
      day_id: r.day_id != null ? (dayMap.get(r.day_id) ?? null) : null,
      end_day_id: r.end_day_id != null ? (dayMap.get(r.end_day_id) ?? null) : null,
      place_id: r.place_id != null ? (placeMap.get(r.place_id) ?? null) : null,
      assignment_id: r.assignment_id != null ? (assignmentMap.get(r.assignment_id) ?? null) : null,
      accommodation_id:
        r.accommodation_id != null ? (accomMap.get(Number(r.accommodation_id)) ?? null) : null,
      title: r.title,
      reservation_time: r.reservation_time ?? null,
      reservation_end_time: r.reservation_end_time ?? null,
      location: r.location ?? null,
      confirmation_number: r.confirmation_number ?? null,
      notes: r.notes ?? null,
      url: r.url ?? null,
      status: r.status,
      type: r.type,
      metadata: r.metadata ?? null,
      day_plan_position: r.day_plan_position ?? null,
      needs_review: r.needs_review ?? 0,
      ingest_state: r.ingest_state ?? 'live',
      external_id: null,
      external_source: null,
      external_owner_user_id: null,
      external_synced_at: null,
      sync_enabled: 0,
      created_at: nowIso(),
    } as ReservationRow);
    reservationMap.set(r.id, newId);
  }

  // Server whitelist: (category, name, total_price, persons, days, note,
  // sort_order, reservation_id, currency, exchange_rate, expense_date,
  // ticket_json, paid_by_user_id) — place_id and the embedded receipts do not
  // travel. Members/payers DO: the server copied their junction rows, so the
  // embedded arrays ride along stripped to the junction columns (username is
  // a read-time join).
  for (const b of store.budgetItemsOfTrip(src.id)) {
    store.put('budgetItems', {
      id: store.allocId('budgetItems'),
      trip_id: newTripId,
      category: b.category,
      name: b.name,
      total_price: b.total_price,
      persons: b.persons ?? null,
      days: b.days ?? null,
      note: b.note ?? null,
      sort_order: b.sort_order,
      reservation_id: b.reservation_id != null ? (reservationMap.get(b.reservation_id) ?? null) : null,
      currency: b.currency ?? null,
      exchange_rate: b.exchange_rate ?? 1,
      expense_date: b.expense_date ?? null,
      ticket_json: b.ticket_json ?? null,
      paid_by_user_id: b.paid_by_user_id ?? null,
      place_id: null,
      members: (b.members ?? []).map((m) => ({ user_id: m.user_id, paid: m.paid ?? 0, amount: m.amount ?? null })),
      payers: (b.payers ?? []).map((p) => ({ user_id: p.user_id, amount: p.amount ?? 0 })),
      receipts: [],
      created_at: nowIso(),
    } as BudgetItem);
  }

  // Server whitelist: (name, color, weight_limit_grams, sort_order) — the
  // bag's user_id assignment and its member junction rows do not travel.
  const bagMap = new Map<number, number>();
  for (const bag of store.packingBagsOfTrip(src.id)) {
    const newId = store.allocId('packingBags');
    store.put('packingBags', {
      id: newId,
      trip_id: newTripId,
      name: bag.name,
      color: bag.color,
      weight_limit_grams: bag.weight_limit_grams ?? null,
      sort_order: bag.sort_order,
      user_id: null,
      created_at: nowIso(),
    } as PackingBag);
    bagMap.set(bag.id, newId);
  }

  // Common items plus the copier's own restricted ones — recipients and
  // contributors do not carry over (the server did not copy those rows).
  // Server whitelist drops `quantity` (the copy reads back DEFAULT 1) and the
  // old created_at.
  for (const p of store.packingItemsOfTrip(src.id)) {
    const isPrivate = p.is_private ? 1 : 0;
    if (isPrivate && p.owner_id !== SELF_ID) continue;
    store.put('packingItems', {
      id: store.allocId('packingItems'),
      trip_id: newTripId,
      name: p.name,
      checked: 0,
      category: p.category ?? null,
      sort_order: p.sort_order,
      weight_grams: p.weight_grams ?? null,
      bag_id: p.bag_id != null ? (bagMap.get(p.bag_id) ?? null) : null,
      is_private: isPrivate,
      owner_id: isPrivate ? SELF_ID : null,
      quantity: 1,
      recipients: [],
      contributors: [],
      created_at: nowIso(),
      updated_at: nowIso(),
    } as PackingItem);
  }

  for (const t of store.todoItemsOfTrip(src.id)) {
    store.put('todoItems', {
      ...structuredClone(t),
      id: store.allocId('todoItems'),
      trip_id: newTripId,
      checked: 0,
      assigned_user_id: null,
    });
  }

  return { trip: store.tripSelect(store.tripRaw(newTripId)!) };
}
