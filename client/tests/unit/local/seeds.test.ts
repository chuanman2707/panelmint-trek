/**
 * Parity tests for the extracted seed data.
 *
 * Server source: server/src/db/seeds.ts (categories, addons, photo providers,
 * admin bootstrap decision) and server/src/db/document-provider-seed.ts.
 * What the port preserves: stable ids, ordering, INSERT-OR-IGNORE semantics and
 * the admin-seed decision. What stays server-side: bcrypt hashing,
 * crypto.randomBytes, env reads and the console banner — asserted here only as
 * the *decision*, never the side effect.
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_PROVIDER_FIELD_SEEDS,
  DOCUMENT_PROVIDER_SEED_IDS,
  DOCUMENT_PROVIDER_SEEDS,
  isOidcOnlyConfigured,
  PHOTO_PROVIDER_FIELD_SEEDS,
  PHOTO_PROVIDER_SEEDS,
  planAdminSeed,
  SEED_ADDONS,
  SEED_CATEGORIES,
  seedLocalDefaults,
  type LocalSeedStore,
  type SeedCategory,
} from '../../../src/api/local/ported/seeds';

describe('seed definitions', () => {
  it('category names are unique and icon-bearing', () => {
    expect(SEED_CATEGORIES.length).toBeGreaterThan(0);
    expect(new Set(SEED_CATEGORIES.map((c) => c.name)).size).toBe(SEED_CATEGORIES.length);
    for (const c of SEED_CATEGORIES) {
      expect(c.icon).toBeTruthy();
      expect(c.color).toMatch(/^#/);
    }
  });

  it('addon ids are unique', () => {
    expect(new Set(SEED_ADDONS.map((a) => a.id)).size).toBe(SEED_ADDONS.length);
  });

  it('every provider field points at a declared provider', () => {
    const photoIds = new Set(PHOTO_PROVIDER_SEEDS.map((p) => p.id));
    for (const f of PHOTO_PROVIDER_FIELD_SEEDS) expect(photoIds.has(f.provider_id)).toBe(true);
    const docIds = new Set(DOCUMENT_PROVIDER_SEEDS.map((p) => p.id));
    for (const f of DOCUMENT_PROVIDER_FIELD_SEEDS) expect(docIds.has(f.provider_id)).toBe(true);
  });

  it('document provider seed ids match the provider list order', () => {
    expect(DOCUMENT_PROVIDER_SEED_IDS).toEqual(DOCUMENT_PROVIDER_SEEDS.map((p) => p.id));
  });
});

describe('seedLocalDefaults', () => {
  const makeStore = () => {
    const categories: SeedCategory[] = [];
    const addons: string[] = [];
    const photo: string[] = [];
    const doc: string[] = [];
    const store: LocalSeedStore = {
      countCategories: () => categories.length,
      insertCategory: (row) => {
        categories.push(row);
      },
      upsertAddon: (row) => {
        addons.push(row.id);
      },
      upsertPhotoProvider: (row) => {
        photo.push(row.id);
      },
      upsertPhotoProviderField: () => {},
      upsertDocumentProvider: (row) => {
        doc.push(row.id);
      },
      upsertDocumentProviderField: () => {},
    };
    return { store, categories, addons, photo, doc };
  };

  it('inserts categories only when the table is empty', () => {
    const { store, categories } = makeStore();
    expect(seedLocalDefaults(store).categoriesInserted).toBe(SEED_CATEGORIES.length);
    // A second run sees a non-empty table and inserts nothing.
    expect(seedLocalDefaults(store).categoriesInserted).toBe(0);
    expect(categories).toHaveLength(SEED_CATEGORIES.length);
  });

  it('upserts providers regardless of category state', () => {
    const { store, addons, photo, doc } = makeStore();
    seedLocalDefaults(store);
    seedLocalDefaults(store);
    expect(addons).toHaveLength(SEED_ADDONS.length * 2);
    expect(photo).toHaveLength(PHOTO_PROVIDER_SEEDS.length * 2);
    expect(doc).toHaveLength(DOCUMENT_PROVIDER_SEEDS.length * 2);
  });
});

describe('planAdminSeed', () => {
  const base = { userCount: 0, adminEmail: null, adminPassword: null, demoEnabled: false, oidc: { only: false } };

  it('skips when users already exist', () => {
    expect(planAdminSeed({ ...base, userCount: 1 })).toEqual({ action: 'skip', reason: 'users-exist' });
  });
  it('skips in demo mode (demo seeds its own admin)', () => {
    expect(planAdminSeed({ ...base, demoEnabled: true })).toEqual({ action: 'skip', reason: 'demo-mode' });
  });
  it('skips when OIDC-only auth is fully configured', () => {
    expect(planAdminSeed({ ...base, oidc: { only: true, issuer: 'https://idp', clientId: 'x' } })).toEqual({
      action: 'skip',
      reason: 'oidc-only',
    });
  });
  it('does NOT skip on partial OIDC config (only=true but no issuer)', () => {
    const plan = planAdminSeed({ ...base, oidc: { only: true } });
    expect(plan.action).toBe('create');
  });
  it('uses the configured email/password when both are set', () => {
    expect(planAdminSeed({ ...base, adminEmail: 'a@b.c', adminPassword: 'pw' })).toEqual({
      action: 'create',
      email: 'a@b.c',
      username: 'admin',
      passwordProvided: true,
    });
  });
  it('falls back to the generated-password plan on partial config', () => {
    expect(planAdminSeed({ ...base, adminEmail: 'a@b.c', adminPassword: null })).toEqual({
      action: 'create',
      email: 'admin@trek.local',
      username: 'admin',
      passwordProvided: false,
    });
  });
});

describe('isOidcOnlyConfigured', () => {
  it('requires only + issuer + clientId', () => {
    expect(isOidcOnlyConfigured({ only: true, issuer: 'x', clientId: 'y' })).toBe(true);
    expect(isOidcOnlyConfigured({ only: true, issuer: 'x' })).toBe(false);
    expect(isOidcOnlyConfigured({ only: false, issuer: 'x', clientId: 'y' })).toBe(false);
  });
});
