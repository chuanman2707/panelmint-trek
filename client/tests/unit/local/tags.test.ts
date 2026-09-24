/**
 * Parity tests for the local `tagsApi` — the adapter that replaced
 * `apiClient.get('/tags', …)` over `db.tags` (fake-indexeddb). Pins the
 * server's bespoke bodies ('Tag name is required' 400, 'Tag not found' 404),
 * the '#10b981' default color, the COALESCE update semantics, the
 * self-scoping (`user_id = 1`), and the name-ASC ordering.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { tagsApi } from '../../../src/api/local/tags';
import { db } from '../../../src/db/panelmintDb';
import { LocalApiError } from '../../../src/api/local/helpers';
import { buildTag } from '../../helpers/factories';
import type { LocalUser } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('tagsApi.list', () => {
  it('returns { tags } ordered by name ascending, scoped to self', async () => {
    await db.tags.bulkPut([
      buildTag({ id: 1, name: 'Zebra', user_id: 1 }),
      buildTag({ id: 2, name: 'Beach', user_id: 1 }),
      buildTag({ id: 3, name: 'NotMine', user_id: 7 }),
    ]);
    const { tags } = await tagsApi.list();
    expect(tags.map((t) => t.name)).toEqual(['Beach', 'Zebra']);
  });

  it('an empty roster answers { tags: [] }', async () => {
    expect(await tagsApi.list()).toEqual({ tags: [] });
  });
});

describe('tagsApi.create', () => {
  it('creates the tag for self with the #10b981 default color', async () => {
    const { tag } = await tagsApi.create({ name: 'Beach' });
    expect(tag).toMatchObject({ user_id: 1, name: 'Beach', color: '#10b981' });
    expect(typeof tag.id).toBe('number');
    expect(tag.id).toBeGreaterThan(0);
    expect(await db.tags.get(tag.id)).toMatchObject({ name: 'Beach', user_id: 1 });
  });

  it('keeps a provided color', async () => {
    const { tag } = await tagsApi.create({ name: 'City', color: '#123456' });
    expect(tag.color).toBe('#123456');
  });

  it('a missing or empty name answers the bespoke 400', async () => {
    for (const body of [{}, { name: '' }, { name: null }, { color: '#fff' }]) {
      const err = await fail(tagsApi.create(body as never));
      expect(err).toBeInstanceOf(LocalApiError);
      expect(err.response.status).toBe(400);
      expect(err.response.data.error).toBe('Tag name is required');
    }
    expect(await db.tags.count()).toBe(0);
  });

  it('allocates ids past the highest stored row', async () => {
    await db.tags.put(buildTag({ id: 9, user_id: 1 }));
    const { tag } = await tagsApi.create({ name: 'Next' });
    expect(tag.id).toBe(10);
  });
});

describe('tagsApi.update', () => {
  it('COALESCEs — omitted fields keep the stored value', async () => {
    await db.tags.put(buildTag({ id: 1, name: 'Beach', color: '#123456', user_id: 1 }));
    const { tag } = await tagsApi.update(1, { name: 'Shore' });
    expect(tag).toMatchObject({ id: 1, name: 'Shore', color: '#123456' });
    // A falsy field is the SQL NULL → keeps the column.
    const { tag: again } = await tagsApi.update(1, { name: '', color: '#abcdef' });
    expect(again).toMatchObject({ name: 'Shore', color: '#abcdef' });
  });

  it('an unknown or foreign tag answers the 404', async () => {
    await db.tags.put(buildTag({ id: 2, name: 'Theirs', user_id: 7 }));
    for (const id of [99, 2, 'abc']) {
      const err = await fail(tagsApi.update(id as never, { name: 'x' }));
      expect(err).toBeInstanceOf(LocalApiError);
      expect(err.response.status).toBe(404);
      expect(err.response.data.error).toBe('Tag not found');
    }
    expect((await db.tags.get(2))!.name).toBe('Theirs');
  });
});

describe('tagsApi.delete', () => {
  it('removes the row and answers { success: true }', async () => {
    await db.tags.put(buildTag({ id: 1, user_id: 1 }));
    expect(await tagsApi.delete(1)).toEqual({ success: true });
    expect(await db.tags.get(1)).toBeUndefined();
  });

  it('unknown and foreign ids 404 without deleting', async () => {
    await db.tags.put(buildTag({ id: 2, user_id: 7 }));
    for (const id of [99, 2]) {
      const err = await fail(tagsApi.delete(id));
      expect(err.response.status).toBe(404);
      expect(err.response.data.error).toBe('Tag not found');
    }
    expect(await db.tags.get(2)).toBeDefined();
  });
});
