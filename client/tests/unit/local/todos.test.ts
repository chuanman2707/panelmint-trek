/**
 * Parity tests for the local `todoApi` — the adapter that replaced
 * `apiClient.*('/trips/:id/todos*', …)` over the real Dexie `panelmint`
 * database (fake-indexeddb). Pins the envelopes ({items}/{item}/
 * {success:true}/{assignees}), the create column defaults, the presence-
 * sentinel update protocol, sort_order append/reorder semantics, the
 * trip-scoped 'Trip not found'/'Item not found' 404s and the roster filter
 * on category assignees. There is no HTTP layer — a stubbed fetch proves it.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { todoApi } from '../../../src/api/local/todos';
import { db } from '../../../src/db/panelmintDb';
import type { LocalTripMember } from '../../../src/db/panelmintDb';
import { buildTrip, buildTodoItem } from '../../helpers/factories';
import type { LocalUser } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const seedTrip = (over = {}) => db.trips.put(buildTrip({ id: 1, user_id: 1, ...over }));

async function seedMember(id: number, name: string) {
  await db.localUsers.put({ id, name, is_self: 0 });
  await db.tripMembers.put({
    tripId: 1, id, username: name, role: 'member',
    added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: false,
  } as LocalTripMember);
}

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('todoApi — no HTTP', () => {
  it('performs zero fetch traffic across the whole surface', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await seedTrip();
    const { item } = await todoApi.create(1, { name: 'Book ferry' });
    await todoApi.list(1);
    await todoApi.update(1, item.id, { checked: true });
    await todoApi.reorder(1, [item.id]);
    await todoApi.getCategoryAssignees(1);
    await todoApi.setCategoryAssignees(1, 'Prep', []);
    await todoApi.delete(1, item.id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('todoApi.list', () => {
  it('returns {items} ordered by sort_order, created_at', async () => {
    await seedTrip();
    await db.todoItems.bulkPut([
      buildTodoItem({ id: 2, trip_id: 1, sort_order: 1, name: 'B' }),
      buildTodoItem({ id: 1, trip_id: 1, sort_order: 0, name: 'A' }),
      buildTodoItem({ id: 9, trip_id: 2, sort_order: 0, name: 'Foreign' }),
    ]);

    const { items } = await todoApi.list(1);
    expect(items.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('accepts a string trip id and 404s an unreachable trip', async () => {
    await seedTrip();
    await expect(todoApi.list('1')).resolves.toEqual({ items: [] });
    const err = await fail(todoApi.list(999));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('todoApi.create', () => {
  it('writes the column defaults: unchecked, null optionals, priority 0', async () => {
    await seedTrip();
    const { item } = await todoApi.create(1, { name: 'Book ferry' });
    expect(item).toMatchObject({
      trip_id: 1, name: 'Book ferry', checked: 0, category: null,
      due_date: null, description: null, assigned_user_id: null, priority: 0,
    });
    expect(await db.todoItems.get(item.id)).toMatchObject({ name: 'Book ferry' });
  });

  it('stores the optional columns when given and appends sort_order', async () => {
    await seedTrip();
    await db.todoItems.put(buildTodoItem({ id: 4, trip_id: 1, sort_order: 3 }));
    const { item } = await todoApi.create(1, {
      name: 'Visa', category: 'Docs', due_date: '2026-04-01',
      description: 'Embassy', assigned_user_id: 1, priority: 2,
    });
    expect(item).toMatchObject({
      category: 'Docs', due_date: '2026-04-01', description: 'Embassy',
      assigned_user_id: 1, priority: 2, sort_order: 4,
    });
  });

  it('400s a missing name through the zod parse', async () => {
    await seedTrip();
    const err = await fail(todoApi.create(1, {} as never));
    expect(err.response.status).toBe(400);
  });
});

describe('todoApi.update', () => {
  it('follows the presence protocol: absent keys keep, present null clears', async () => {
    await seedTrip();
    await db.todoItems.put(buildTodoItem({
      id: 3, trip_id: 1, name: 'Ferry', category: 'Bookings',
      due_date: '2026-04-01', description: 'Deck seat', assigned_user_id: 1, priority: 2,
    }));

    const { item } = await todoApi.update(1, 3, {
      due_date: null, description: null, assigned_user_id: null, priority: 0,
    });
    expect(item).toMatchObject({
      name: 'Ferry', category: 'Bookings',
      due_date: null, description: null, assigned_user_id: null, priority: 0,
    });
    expect((await db.todoItems.get(3))!.description).toBeNull();
  });

  it('keeps name/category on a falsy value and stores checked as 0/1', async () => {
    await seedTrip();
    await db.todoItems.put(buildTodoItem({ id: 3, trip_id: 1, name: 'Ferry', category: 'Bookings', checked: 0 }));

    // name/category are `data.x || null` COALESCE columns — the schema also
    // rejects an explicit null, so an absent key is the only way to keep them.
    const { item } = await todoApi.update(1, 3, { checked: true });
    expect(item.checked).toBe(1);
    expect(item.name).toBe('Ferry');
    expect(item.category).toBe('Bookings');
  });

  it('404s a missing row or a row of another trip', async () => {
    await seedTrip();
    await db.todoItems.put(buildTodoItem({ id: 8, trip_id: 2 }));
    for (const id of [8, 77]) {
      const err = await fail(todoApi.update(1, id, { name: 'x' }));
      expect(err.response.status).toBe(404);
      expect(err.response.data.error).toBe('Item not found');
    }
  });
});

describe('todoApi.delete', () => {
  it('removes the row and answers {success:true}', async () => {
    await seedTrip();
    await db.todoItems.put(buildTodoItem({ id: 3, trip_id: 1 }));
    await expect(todoApi.delete(1, 3)).resolves.toEqual({ success: true });
    expect(await db.todoItems.get(3)).toBeUndefined();
  });

  it('404s a missing row', async () => {
    await seedTrip();
    const err = await fail(todoApi.delete(1, 3));
    expect(err.response.data.error).toBe('Item not found');
  });
});

describe('todoApi.reorder', () => {
  it('writes sort_order per listed id and silently skips foreign ids', async () => {
    await seedTrip();
    await db.trips.put(buildTrip({ id: 2, user_id: 1 }));
    await db.todoItems.bulkPut([
      buildTodoItem({ id: 1, trip_id: 1, sort_order: 0 }),
      buildTodoItem({ id: 2, trip_id: 1, sort_order: 1 }),
      buildTodoItem({ id: 3, trip_id: 2, sort_order: 7 }),
    ]);

    await expect(todoApi.reorder(1, [2, 999, 1, 3])).resolves.toEqual({ success: true });
    expect((await db.todoItems.get(2))!.sort_order).toBe(0);
    expect((await db.todoItems.get(1))!.sort_order).toBe(2);
    expect((await db.todoItems.get(3))!.sort_order).toBe(7);
  });
});

describe('todoApi category assignees', () => {
  it('groups junction rows by category in the GET record', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.todoCategoryAssignees.bulkPut([
      { id: 1, trip_id: 1, category_name: 'Prep', user_id: 1 },
      { id: 2, trip_id: 1, category_name: 'Prep', user_id: 2 },
      { id: 3, trip_id: 2, category_name: 'Prep', user_id: 1 },
    ]);

    const { assignees } = await todoApi.getCategoryAssignees(1);
    expect(assignees.Prep.map((a) => a.user_id).sort()).toEqual([1, 2]);
    expect(assignees.Prep[1].username).toBe('Alice');
  });

  it('rewrites one category, filters off-roster ids and survives path chars', async () => {
    await seedTrip();
    await seedMember(2, 'Alice');
    await db.todoCategoryAssignees.put({ id: 1, trip_id: 1, category_name: 'Docs', user_id: 1 });

    const { assignees } = await todoApi.setCategoryAssignees(1, 'Food & Drinks', [2, 99]);
    expect(assignees).toEqual([{ user_id: 2, username: 'Alice', avatar: null }]);
    expect((await db.todoCategoryAssignees.toArray()).filter(r => r.category_name === 'Docs')).toHaveLength(1);

    const { assignees: slash } = await todoApi.setCategoryAssignees(1, 'A/B', [1]);
    expect(slash).toEqual([{ user_id: 1, username: 'Me', avatar: null }]);
  });
});
