/**
 * Parity tests for the local `tripMembersApi` — the roster-link read over
 * `db.tripMembers` (fake-indexeddb). Pins the trip-access 404, the
 * added_at-ASC member order, the roster join (username/email/is_guest from
 * `localUsers`), and the owner's absence from `members` (the link table never
 * carries the owner — `trips.user_id` does).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { tripMembersApi } from '../../../src/api/local/tripMembers';
import { db } from '../../../src/db/panelmintDb';
import type { LocalTripMember } from '../../../src/db/panelmintDb';
import { LocalApiError } from '../../../src/api/local/helpers';
import { buildTrip } from '../../helpers/factories';
import type { LocalUser } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };
const GUEST: LocalUser = { id: 2, name: 'Alex', is_self: 0, email: 'guest-abc@guests.invalid' };

function link(tripId: number, userId: number, over: Partial<LocalTripMember> = {}): LocalTripMember {
  return {
    tripId,
    id: userId,
    username: `user-${userId}`,
    role: 'member',
    added_at: '2025-01-01T00:00:00.000Z',
    invited_by_username: 'Me',
    is_guest: true,
    ...over,
  };
}

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('tripMembersApi.list', () => {
  it('returns the linked roster entries in wire shape', async () => {
    await db.trips.put(buildTrip({ id: 1, user_id: 1 }));
    await db.localUsers.put(GUEST);
    await db.tripMembers.put(link(1, 2));
    const { members } = await tripMembersApi.list(1);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      id: 2,
      username: 'Alex',
      email: 'guest-abc@guests.invalid',
      is_guest: true,
      role: 'member',
      invited_by_username: 'Me',
    });
  });

  it('orders by added_at like the server ORDER BY', async () => {
    await db.trips.put(buildTrip({ id: 1, user_id: 1 }));
    await db.localUsers.bulkPut([GUEST, { id: 3, name: 'Bo', is_self: 0 }]);
    await db.tripMembers.bulkPut([
      link(1, 3, { added_at: '2025-02-01T00:00:00.000Z' }),
      link(1, 2, { added_at: '2025-01-01T00:00:00.000Z' }),
    ]);
    const { members } = await tripMembersApi.list(1);
    expect(members.map((m) => m.id)).toEqual([2, 3]);
  });

  it('never includes the trip owner — the junction only links non-owners', async () => {
    await db.trips.put(buildTrip({ id: 1, user_id: 1 }));
    await db.tripMembers.put(link(1, 2));
    const { members } = await tripMembersApi.list(1);
    expect(members.map((m) => m.id)).not.toContain(1);
  });

  it('a trip with no links answers an empty list', async () => {
    await db.trips.put(buildTrip({ id: 1, user_id: 1 }));
    expect(await tripMembersApi.list(1)).toEqual({ members: [] });
  });

  it('an unknown or unreachable trip answers the guard\'s 404', async () => {
    // Not owned by self and no membership row for self → unreachable.
    await db.trips.put(buildTrip({ id: 1, user_id: 7 }));
    for (const id of [1, 99, 'abc']) {
      const err = await fail(tripMembersApi.list(id));
      expect(err).toBeInstanceOf(LocalApiError);
      expect(err.response.status).toBe(404);
      expect(err.response.data.error).toBe('Trip not found');
    }
  });

  it('a member-row for self makes a foreign trip reachable', async () => {
    await db.trips.put(buildTrip({ id: 1, user_id: 7 }));
    await db.localUsers.bulkPut([GUEST, { id: 7, name: 'Owner', is_self: 0 }]);
    await db.tripMembers.bulkPut([link(1, 1, { is_guest: false }), link(1, 2)]);
    const { members } = await tripMembersApi.list(1);
    // Self's own link row renders with role 'member' (ownerId is 7 — not a link row).
    expect(members.map((m) => m.id).sort()).toEqual([1, 2]);
  });
});
