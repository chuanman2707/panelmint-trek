/**
 * Parity tests for the local `usersApi` — the guest roster surface that
 * replaced `tripsApi.createGuest/renameGuest/deleteGuest` over the real Dexie
 * `panelmint` database (fake-indexeddb). Pins the guard order (access 404 →
 * owner 403 → zod 400 → name 400s → 'Guest not found' 404), the member wire
 * `create` answers, the rename write-through, and `delete`'s ON DELETE
 * cascade set — no HTTP anywhere.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { usersApi } from '../../../src/api/local/users';
import { tripsApi } from '../../../src/api/local/trips';
import { db } from '../../../src/db/panelmintDb';
import type { LocalUser } from '../../../src/types';
import { buildTrip, buildPackingItem, buildTodoItem } from '../../helpers/factories';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const seedTrip = () => db.trips.put(buildTrip({ id: 1 }));

/** Catch the rejection as a LocalApiError-shaped value. */
const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('usersApi.list', () => {
  it('answers the trip\'s guest rows in membership order, self excluded', async () => {
    await seedTrip();
    const a = await usersApi.create(1, 'Anna');
    const b = await usersApi.create(1, 'Bram');
    const { users } = await usersApi.list(1);
    expect(users.map((u) => u.id)).toEqual([a.member.id, b.member.id]);
    expect(users.map((u) => u.name)).toEqual(['Anna', 'Bram']);
    expect(users.every((u) => u.is_self === 0)).toBe(true);
    // Self never appears on the guest roster.
    expect(users.some((u) => u.id === 1)).toBe(false);
  });

  it('scopes guests to their own trip', async () => {
    await db.trips.bulkPut([buildTrip({ id: 1 }), buildTrip({ id: 2 })]);
    await usersApi.create(1, 'Anna');
    expect((await usersApi.list(2)).users).toEqual([]);
    expect((await usersApi.list(1)).users).toHaveLength(1);
  });

  it('404s an unreachable trip', async () => {
    const err = await fail(usersApi.list(999));
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('usersApi.create', () => {
  beforeEach(seedTrip);

  it('stores a roster row + membership and returns the member wire', async () => {
    const { member } = await usersApi.create(1, '  Anna  ');
    expect(member.username).toBe('Anna');
    expect(member.is_guest).toBe(true);
    expect(member.role).toBe('member');
    expect(member.email).toMatch(/^guest-.+@guests\.invalid$/);
    const u = await db.localUsers.get(member.id);
    expect(u).toMatchObject({ name: 'Anna', is_self: 0 });
    const m = await db.tripMembers.get([1, member.id]);
    expect(m).toBeTruthy();
    const { members } = await tripsApi.getMembers(1);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: member.id, username: 'Anna', is_guest: true });
  });

  it('trims and rejects whitespace-only names', async () => {
    const err = await fail(usersApi.create(1, '   '));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('Guest name is required');
    // >50 chars fails the DTO (zod max 50) before the service message.
    const long = await fail(usersApi.create(1, 'x'.repeat(51)));
    expect(long.response.status).toBe(400);
  });

  it('404s a missing trip before the name checks', async () => {
    const err = await fail(usersApi.create(999, 'Anna'));
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('usersApi.rename', () => {
  beforeEach(seedTrip);

  it('renames the user row and its membership link; non-guest targets 404', async () => {
    const { member } = await usersApi.create(1, 'Anna');
    await usersApi.rename(1, member.id, 'Ana');
    expect((await db.localUsers.get(member.id))!.name).toBe('Ana');
    expect((await db.tripMembers.get([1, member.id]))!.username).toBe('Ana');
    const err = await fail(usersApi.rename(1, 1, 'X'));
    expect(err.response.data.error).toBe('Guest not found');
  });
});

describe('usersApi.delete', () => {
  beforeEach(seedTrip);

  it('purges the user, membership and junction links', async () => {
    const { member } = await usersApi.create(1, 'Anna');
    await db.reservationTravelers.put({ id: 90, reservation_id: 5, user_id: member.id });
    await db.assignmentParticipants.put({ id: 91, assignment_id: 5, user_id: member.id });
    await usersApi.delete(1, member.id);
    expect(await db.localUsers.get(member.id)).toBeUndefined();
    expect(await db.tripMembers.get([1, member.id])).toBeUndefined();
    expect(await db.reservationTravelers.get(90)).toBeUndefined();
    expect(await db.assignmentParticipants.get(91)).toBeUndefined();
    const err = await fail(usersApi.delete(1, member.id));
    expect(err.response.data.error).toBe('Guest not found');
  });

  it('runs the rest of the users-row ON DELETE set', async () => {
    const { member } = await usersApi.create(1, 'Anna');
    const uid = member.id;
    // from/to_user_id CASCADE — a settlement the guest sits on dies with it.
    await db.budgetSettlements.put({
      id: 61, trip_id: 1, from_user_id: uid, to_user_id: 1, amount: 10,
      created_at: '2025-01-01T00:00:00.000Z',
    } as never);
    await db.budgetSettlements.put({
      id: 62, trip_id: 1, from_user_id: 1, to_user_id: 1, amount: 5,
      created_at: '2025-01-01T00:00:00.000Z',
    } as never);
    // SET NULL columns.
    await db.todoItems.put(buildTodoItem({ id: 63, trip_id: 1, assigned_user_id: uid }));
    await db.packingItems.put(
      buildPackingItem({
        id: 64,
        trip_id: 1,
        owner_id: uid,
        recipients: [{ user_id: uid, username: 'Anna' }, { user_id: 1, username: 'Me' }],
        contributors: [{ user_id: uid, username: 'Anna', status: 'accepted' }],
      }),
    );
    await db.packingBags.put({ id: 65, trip_id: 1, name: 'Anna bag', user_id: uid } as never);
    await db.categories.put({ id: 66, name: 'Food', user_id: uid } as never);

    await usersApi.delete(1, uid);

    expect(await db.budgetSettlements.get(61)).toBeUndefined();
    expect(await db.budgetSettlements.get(62)).toBeDefined(); // uninvolved rows survive
    expect((await db.todoItems.get(63))!.assigned_user_id).toBeNull();
    const item = (await db.packingItems.get(64))!;
    expect(item.owner_id).toBeNull(); // a ghost-owned private item stays visible
    expect(item.recipients!.map((r) => r.user_id)).toEqual([1]);
    expect(item.contributors).toEqual([]);
    expect((await db.packingBags.get(65))!.user_id).toBeNull();
    expect((await db.categories.get(66))!.user_id).toBeNull();
  });

  it('removes the guest from budget items it split (the member junction + persons)', async () => {
    const { member } = await usersApi.create(1, 'Anna');
    const { member: bram } = await usersApi.create(1, 'Bram');
    const { item } = await (
      await import('../../../src/api/local/budget')
    ).budgetApi.create(1, { name: 'Dinner', total_price: 30, member_ids: [member.id, bram.id] });
    await usersApi.delete(1, member.id);
    const stored = (await db.budgetItems.get(item.id))!;
    expect(stored.members!.map((m) => m.user_id)).toEqual([bram.id]);
    expect(stored.persons).toBe(1);
  });
});
