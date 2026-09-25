/**
 * `usersApi` — the guest roster. The hosted app's guest endpoints lived on
 * the trips router (`POST /api/trips/:id/guests`, `PUT .../guests/:userId`,
 * `DELETE .../guests/:userId`) and rode on `tripsApi` as createGuest /
 * renameGuest / deleteGuest; the roster is its own domain here.
 *
 * A guest is a `localUsers` row with `is_self !== 1` plus its `tripMembers`
 * link — guests are always created in the context of one trip, so every
 * method is trip-scoped. Everything the hosted routes enforced is kept
 * verbatim:
 *  - TripAccessGuard first — an unreachable trip answers 404 'Trip not found'.
 *  - TripOwnerGuard next — only the owner manages guests ('Only the owner can
 *    manage guests', 403), THEN the body pipe ran.
 *  - 'Guest name is required' / 'Guest name must be 50 characters or fewer'
 *    after the Zod pipe, then 'Guest not found' on a user id that isn't a
 *    guest of this trip.
 *  - `create` answers `{ member }` in the listMembers row shape, with the
 *    generated `guest-*@guests.invalid` email the server assigned.
 *  - `delete` cascades the guest out of every junction (budget splits and
 *    payers, settlements on either end, reservation travelers, assignment
 *    participants, todo/packing references, bags, category assignees, the
 *    membership link, the user row) — `DexieStore.purgeUserData`.
 */
import { tripCreateGuestRequestSchema, tripRenameGuestRequestSchema } from '@trek/shared';
import type { LocalUser, TripMember } from '../../types';
import { apiError, badRequest, notFound, numId, parseBody } from './helpers';
import { DexieStore, SELF_ID, withStore } from './dexieStore';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, id: number | string): number {
  const tid = numId(id);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** TripOwnerGuard: the guest routes were owner-only. Runs before the DTO
 *  pipe, like the route's guard chain did. */
function requireOwnedTrip(store: DexieStore, id: number | string) {
  const tid = requireTrip(store, id);
  const trip = store.tripRaw(tid)!;
  if (trip.user_id !== SELF_ID) throw apiError(403, 'Only the owner can manage guests');
  return trip;
}

/** The shared guest-name validation — Zod pipe first, then the service's
 *  trim/length checks, producing the same 400 strings. */
function validateGuestName(name: string): string {
  const display = (name || '').trim();
  if (!display) throw badRequest('Guest name is required');
  if (display.length > 50) throw badRequest('Guest name must be 50 characters or fewer');
  return display;
}

export const usersApi = {
  /**
   * The trip's guest roster — the `localUsers` rows linked to the trip that
   * aren't self, in membership order. (No hosted route exposed exactly this;
   * the server's `GET /api/users` listed real accounts, which guests are not.
   * What callers need locally is the roster they can hand to the split/member
   * pickers.)
   */
  list: (tripId: number | string): Promise<{ users: LocalUser[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const users: LocalUser[] = [];
      for (const m of store.memberRows(tid)) {
        const u = store.user(m.id);
        if (u && u.is_self !== 1) users.push(u);
      }
      return { users };
    }),

  /** POST /api/trips/:id/guests → { member } (was `tripsApi.createGuest`). */
  create: (tripId: number | string, name: string): Promise<{ member: TripMember }> =>
    withStore((store) => {
      const trip = requireOwnedTrip(store, tripId);
      parseBody(tripCreateGuestRequestSchema, { name });
      const display = validateGuestName(name);
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

  /** PUT /api/trips/:id/guests/:userId → { success: true } (was
   *  `tripsApi.renameGuest`). Renames the localUsers row and its membership
   *  link's denormalized username, like the server did. */
  rename: (tripId: number | string, userId: number, name: string): Promise<{ success: true }> =>
    withStore((store) => {
      const trip = requireOwnedTrip(store, tripId);
      parseBody(tripRenameGuestRequestSchema, { name });
      const display = validateGuestName(name);
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

  /** DELETE /api/trips/:id/guests/:userId → { success: true } (was
   *  `tripsApi.deleteGuest`). Cascade: `DexieStore.purgeUserData`. */
  delete: (tripId: number | string, userId: number): Promise<{ success: true }> =>
    withStore((store) => {
      const trip = requireOwnedTrip(store, tripId);
      if (!store.guestOfTrip(trip.id, userId)) throw notFound('Guest');
      store.purgeUserData(userId);
      return { success: true as const };
    }),
};
