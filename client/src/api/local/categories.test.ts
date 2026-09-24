/**
 * `categoriesApi` — the frozen local palette. `list` keeps the server's
 * `ORDER BY name` read; `get` answers the same 404; every mutation refuses
 * with the 403 the admin gate produced — locally permanent, since there is
 * no admin to satisfy it.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { categoriesApi } from './categories';
import { db } from '../../db/panelmintDb';
import { LocalApiError } from './helpers';
import { buildCategory } from '../../../tests/helpers/factories';

beforeEach(async () => {
  await db.categories.clear();
});

describe('categoriesApi.list', () => {
  it('FE-LOCAL-CAT-001: returns { categories } sorted by name', async () => {
    await db.categories.bulkPut([
      buildCategory({ id: 2, name: 'Museums' }),
      buildCategory({ id: 1, name: 'Food' }),
      buildCategory({ id: 3, name: 'Bars' }),
    ]);
    const { categories } = await categoriesApi.list();
    expect(categories.map(c => c.name)).toEqual(['Bars', 'Food', 'Museums']);
  });

  it('FE-LOCAL-CAT-002: an empty table answers { categories: [] }', async () => {
    expect(await categoriesApi.list()).toEqual({ categories: [] });
  });

  it('FE-LOCAL-CAT-003: rows come back detached from Dexie storage', async () => {
    await db.categories.put(buildCategory({ id: 1, name: 'Food' }));
    const { categories } = await categoriesApi.list();
    (categories[0] as { name: string }).name = 'Mutated';
    expect((await db.categories.get(1))!.name).toBe('Food');
  });
});

describe('categoriesApi.get', () => {
  it('FE-LOCAL-CAT-004: returns { category } by id', async () => {
    await db.categories.put(buildCategory({ id: 7, name: 'Museums' }));
    const { category } = await categoriesApi.get(7);
    expect(category.name).toBe('Museums');
  });

  it('FE-LOCAL-CAT-005: unknown and non-numeric ids are the same 404', async () => {
    for (const id of [999, 'abc']) {
      try {
        await categoriesApi.get(id);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(LocalApiError);
        expect((err as LocalApiError).status).toBe(404);
      }
    }
  });
});

describe('categoriesApi mutations — frozen palette', () => {
  it('FE-LOCAL-CAT-006: create/update/delete all refuse with a 403', async () => {
    await db.categories.put(buildCategory({ id: 1, name: 'Food' }));
    for (const call of [
      () => categoriesApi.create({ name: 'New' }),
      () => categoriesApi.update(1, { name: 'Renamed' }),
      () => categoriesApi.delete(1),
    ]) {
      try {
        await call();
        expect.unreachable();
      } catch (err) {
        expect((err as LocalApiError).status).toBe(403);
        expect((err as LocalApiError).response?.status).toBe(403);
      }
    }
    expect((await db.categories.get(1))!.name).toBe('Food');
  });
});
