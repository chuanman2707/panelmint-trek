/**
 * `tripMembersApi` — the roster-link read. The `tripMembers` table is the
 * trip→roster junction: each row links a `localUsers` roster entry (a guest,
 * or self on a foreign-owned trip) to a trip. The trip owner is NOT a link
 * row — ownership lives on `trips.user_id`.
 *
 * There was no `tripMembersApi` on the axios surface — member management rode
 * on `tripsApi` (`getMembers`/`addMember`/`removeMember`/guest CRUD, all kept
 * in `local/trips.ts`). This module is the standalone read the roster-aware
 * callers need without dragging the trip envelope out: which roster entries
 * are linked to this trip. Phase C's share codec reads the same link list to
 * build the bundle's `users[]` section.
 *
 * Server parity notes (server/src/nest/trip-members/ + services/tripService.ts
 * listMembers):
 *  - `GET /api/trips/:id/members` ran `canAccessTrip` first — an unreachable
 *    trip answers 404 `{error: 'Trip not found'}`; kept verbatim.
 *  - `members` is the junction rows joined to the roster, `ORDER BY
 *    added_at ASC` — the same rows `tripsApi.getMembers` returns in its
 *    `members` field (owner excluded; that field pair is its own envelope).
 */
import type { TripMember } from '../../types';
import { notFound, numId } from './helpers';
import { DexieStore, withStore } from './dexieStore';

/** The trip row, scoped: exists AND reachable by self, else the same 404 the
 *  TripAccessGuard produced. */
function requireTrip(store: DexieStore, id: number | string): number {
  const tid = numId(id);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

export const tripMembersApi = {
  /** The roster entries linked to a trip — wire `TripMember` rows (guest flag,
   *  role, invited_by) in link order, owner excluded. */
  list: (tripId: number | string): Promise<{ members: TripMember[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const trip = store.tripRaw(tid)!;
      return {
        members: store.memberRows(tid).map((m) => store.memberWire(m, trip.user_id)),
      };
    }),
};
