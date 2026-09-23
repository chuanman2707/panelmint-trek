/**
 * Port of server/src/db/seeds.ts + server/src/db/document-provider-seed.ts.
 *
 * The row data is verbatim; the writes go through `LocalSeedStore` (INSERT OR
 * IGNORE semantics: an operator's rename or re-sort survives a re-seed). The
 * admin-account bootstrap stays a server concern — bcrypt, env reads and the
 * console banner have no browser equivalent — but its *decision* is pure and
 * ported as planAdminSeed/isOidcOnlyConfigured so a local client can answer
 * "would a server have created an admin here" the same way.
 *
 * Server behaviours preserved:
 *  - Categories are seeded only when the table is empty.
 *  - Addons, photo providers, photo provider fields, document providers and
 *    their fields are upserted INSERT-OR-IGNORE style.
 *  - Admin seeding skips when any user exists; skips under demo mode (the demo
 *    seeder takes username 'admin'); under OIDC-only it announces instead of
 *    creating; a partial ADMIN_EMAIL/ADMIN_PASSWORD pair falls back to the
 *    generated-password path.
 */

// ── Row data, verbatim ────────────────────────────────────────────────────────

export interface SeedCategory {
  name: string;
  color: string;
  icon: string;
}

export const SEED_CATEGORIES: SeedCategory[] = [
  { name: 'Hotel', color: '#3b82f6', icon: '🏨' },
  { name: 'Restaurant', color: '#ef4444', icon: '🍽️' },
  { name: 'Attraction', color: '#8b5cf6', icon: '🏛️' },
  { name: 'Shopping', color: '#f59e0b', icon: '🛍️' },
  { name: 'Transport', color: '#6b7280', icon: '🚌' },
  { name: 'Activity', color: '#10b981', icon: '🎯' },
  { name: 'Bar/Cafe', color: '#f97316', icon: '☕' },
  { name: 'Beach', color: '#06b6d4', icon: '🏖️' },
  { name: 'Nature', color: '#84cc16', icon: '🌿' },
  { name: 'Other', color: '#6366f1', icon: '📍' },
];

export interface SeedAddon {
  id: string;
  name: string;
  description: string;
  type: 'trip' | 'global' | 'integration';
  icon: string;
  enabled: 0 | 1;
  sort_order: number;
}

export const SEED_ADDONS: SeedAddon[] = [
  {
    id: 'packing',
    name: 'Lists',
    description: 'Packing lists and to-do tasks for your trips',
    type: 'trip',
    icon: 'ListChecks',
    enabled: 1,
    sort_order: 0,
  },
  {
    id: 'budget',
    name: 'Costs',
    description: 'Track and split trip expenses',
    type: 'trip',
    icon: 'Wallet',
    enabled: 1,
    sort_order: 1,
  },
  {
    id: 'documents',
    name: 'Documents',
    description: 'Store and manage travel documents',
    type: 'trip',
    icon: 'FileText',
    enabled: 1,
    sort_order: 2,
  },
  {
    id: 'vacay',
    name: 'Vacay',
    description: 'Personal vacation day planner with calendar view',
    type: 'global',
    icon: 'CalendarDays',
    enabled: 1,
    sort_order: 10,
  },
  {
    id: 'atlas',
    name: 'Atlas',
    description: 'World map of your visited countries with travel stats',
    type: 'global',
    icon: 'Globe',
    enabled: 1,
    sort_order: 11,
  },
  {
    id: 'mcp',
    name: 'MCP',
    description: 'Model Context Protocol for AI assistant integration',
    type: 'integration',
    icon: 'Terminal',
    enabled: 0,
    sort_order: 12,
  },
  {
    id: 'naver_list_import',
    name: 'Naver List Import',
    description: 'Import places from a shared Naver Maps list',
    type: 'integration',
    icon: 'Link2',
    enabled: 1,
    sort_order: 13,
  },
  {
    id: 'collab',
    name: 'Collab',
    description: 'Notes, polls, and live chat for trip collaboration',
    type: 'trip',
    icon: 'Users',
    enabled: 1,
    sort_order: 6,
  },
  {
    id: 'roadtrip',
    name: 'Road trip',
    description: 'Drives with stops along the route, driving times, and arrival times that update themselves',
    type: 'trip',
    icon: 'Route',
    enabled: 0,
    sort_order: 7,
  },
  {
    id: 'journey',
    name: 'Journey',
    description: 'Trip tracking & travel journal — check-ins, photos, daily stories',
    type: 'global',
    icon: 'Compass',
    enabled: 0,
    sort_order: 35,
  },
  {
    id: 'airtrail',
    name: 'AirTrail',
    description: 'Sync flights from your AirTrail instance',
    type: 'integration',
    icon: 'Plane',
    enabled: 0,
    sort_order: 14,
  },
  {
    id: 'dawarich',
    name: 'Dawarich',
    description:
      'Read visits and recorded routes from your Dawarich instance — suggested journal entries, places and countries you confirm yourself',
    type: 'integration',
    icon: 'Dawarich',
    enabled: 0,
    sort_order: 17,
  },
  {
    id: 'llm_parsing',
    name: 'AI Parsing',
    description: 'LLM fallback for booking imports kitinerary cannot read',
    type: 'integration',
    icon: 'Sparkles',
    enabled: 0,
    sort_order: 15,
  },
  {
    id: 'collections',
    name: 'Collections',
    description:
      'Personal place library — save places across trips into named lists, copy into any trip, share with others',
    type: 'global',
    icon: 'Bookmark',
    enabled: 0,
    sort_order: 16,
  },
];

export interface SeedPhotoProvider {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabled: 0 | 1;
  sort_order: number;
}

export const PHOTO_PROVIDER_SEEDS: SeedPhotoProvider[] = [
  { id: 'immich', name: 'Immich', description: 'Immich photo provider', icon: 'Image', enabled: 0, sort_order: 0 },
  {
    id: 'synologyphotos',
    name: 'Synology Photos',
    description: 'Synology Photos integration with separate account settings',
    icon: 'Image',
    enabled: 0,
    sort_order: 1,
  },
];

export interface SeedProviderField {
  provider_id: string;
  field_key: string;
  label: string;
  input_type: 'text' | 'url' | 'password' | 'checkbox';
  placeholder: string | null;
  hint: string | null;
  required: 0 | 1;
  secret: 0 | 1;
  sort_order: number;
}

export interface SeedPhotoProviderField extends SeedProviderField {
  settings_key: string | null;
  payload_key: string | null;
}

export const PHOTO_PROVIDER_FIELD_SEEDS: SeedPhotoProviderField[] = [
  {
    provider_id: 'immich',
    field_key: 'immich_url',
    label: 'providerUrl',
    input_type: 'url',
    placeholder: 'https://immich.example.com',
    hint: null,
    required: 1,
    secret: 0,
    settings_key: 'immich_url',
    payload_key: 'immich_url',
    sort_order: 0,
  },
  {
    provider_id: 'immich',
    field_key: 'immich_api_key',
    label: 'providerApiKey',
    input_type: 'password',
    placeholder: 'API Key',
    hint: null,
    required: 1,
    secret: 1,
    settings_key: null,
    payload_key: 'immich_api_key',
    sort_order: 1,
  },
  {
    provider_id: 'synologyphotos',
    field_key: 'synology_url',
    label: 'providerUrl',
    input_type: 'url',
    placeholder: 'https://synology.example.com/photo',
    hint: 'providerUrlHintSynology',
    required: 1,
    secret: 0,
    settings_key: 'synology_url',
    payload_key: 'synology_url',
    sort_order: 0,
  },
  {
    provider_id: 'synologyphotos',
    field_key: 'synology_username',
    label: 'providerUsername',
    input_type: 'text',
    placeholder: 'Username',
    hint: null,
    required: 1,
    secret: 0,
    settings_key: 'synology_username',
    payload_key: 'synology_username',
    sort_order: 1,
  },
  {
    provider_id: 'synologyphotos',
    field_key: 'synology_password',
    label: 'providerPassword',
    input_type: 'password',
    placeholder: 'Password',
    hint: null,
    required: 1,
    secret: 1,
    settings_key: null,
    payload_key: 'synology_password',
    sort_order: 2,
  },
  {
    provider_id: 'synologyphotos',
    field_key: 'synology_otp',
    label: 'providerOTP',
    input_type: 'text',
    placeholder: '123456',
    hint: null,
    required: 0,
    secret: 0,
    settings_key: null,
    payload_key: 'synology_otp',
    sort_order: 3,
  },
  {
    provider_id: 'synologyphotos',
    field_key: 'synology_skip_ssl',
    label: 'skipSSLVerification',
    input_type: 'checkbox',
    placeholder: null,
    hint: null,
    required: 0,
    secret: 0,
    settings_key: 'synology_skip_ssl',
    payload_key: 'synology_skip_ssl',
    sort_order: 4,
  },
];

export interface SeedDocumentProvider {
  id: string;
  name: string;
  description: string;
  icon: string;
  sort_order: number;
}

export const DOCUMENT_PROVIDER_SEEDS: SeedDocumentProvider[] = [
  {
    id: 'paperless',
    name: 'Paperless-ngx',
    description: 'Two-way document sync with a Paperless-ngx instance, scoped by tag',
    icon: 'FileText',
    sort_order: 0,
  },
  {
    id: 'papra',
    name: 'Papra',
    description: 'Two-way document sync with a Papra organisation, scoped by tag',
    icon: 'FileText',
    sort_order: 1,
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Two-way document sync with a Nextcloud folder over WebDAV',
    icon: 'Cloud',
    sort_order: 2,
  },
  {
    id: 'opencloud',
    name: 'OpenCloud',
    description: 'Two-way document sync with an OpenCloud space over WebDAV',
    icon: 'Cloud',
    sort_order: 3,
  },
  {
    id: 'synologydrive',
    name: 'Synology Drive',
    description: 'Two-way document sync with a folder on a Synology NAS',
    icon: 'HardDrive',
    sort_order: 4,
  },
];

/**
 * `allow_insecure_tls` defaults to 0 on every provider, unlike the Synology
 * photo provider, where skipping verification is the stored default.
 */
export const DOCUMENT_PROVIDER_FIELD_SEEDS: SeedProviderField[] = [
  // Paperless-ngx: token auth, tag scope.
  {
    provider_id: 'paperless',
    field_key: 'base_url',
    label: 'providerUrl',
    input_type: 'url',
    placeholder: 'https://paperless.example.com',
    hint: null,
    required: 1,
    secret: 0,
    sort_order: 0,
  },
  {
    provider_id: 'paperless',
    field_key: 'api_token',
    label: 'providerApiToken',
    input_type: 'password',
    placeholder: 'API token',
    hint: 'hintPaperlessToken',
    required: 1,
    secret: 1,
    sort_order: 1,
  },
  {
    provider_id: 'paperless',
    field_key: 'allow_insecure_tls',
    label: 'allowInsecureTls',
    input_type: 'checkbox',
    placeholder: null,
    hint: null,
    required: 0,
    secret: 0,
    sort_order: 2,
  },

  // Papra: bearer key, and an organisation the key must already belong to.
  {
    provider_id: 'papra',
    field_key: 'base_url',
    label: 'providerUrl',
    input_type: 'url',
    placeholder: 'https://papra.example.com',
    hint: null,
    required: 1,
    secret: 0,
    sort_order: 0,
  },
  {
    provider_id: 'papra',
    field_key: 'api_key',
    label: 'providerApiKey',
    input_type: 'password',
    placeholder: 'ppapi_…',
    hint: 'hintPapraKey',
    required: 1,
    secret: 1,
    sort_order: 1,
  },
  {
    provider_id: 'papra',
    field_key: 'organization_id',
    label: 'providerOrganization',
    input_type: 'text',
    placeholder: 'org_…',
    hint: 'hintPapraOrg',
    required: 1,
    secret: 0,
    sort_order: 2,
  },
  {
    provider_id: 'papra',
    field_key: 'allow_insecure_tls',
    label: 'allowInsecureTls',
    input_type: 'checkbox',
    placeholder: null,
    hint: null,
    required: 0,
    secret: 0,
    sort_order: 3,
  },

  // Nextcloud: an app password, never the account password.
  {
    provider_id: 'nextcloud',
    field_key: 'base_url',
    label: 'providerUrl',
    input_type: 'url',
    placeholder: 'https://cloud.example.com',
    hint: null,
    required: 1,
    secret: 0,
    sort_order: 0,
  },
  {
    provider_id: 'nextcloud',
    field_key: 'login_name',
    label: 'providerUsername',
    input_type: 'text',
    placeholder: 'username',
    hint: 'hintNextcloudLogin',
    required: 1,
    secret: 0,
    sort_order: 1,
  },
  {
    provider_id: 'nextcloud',
    field_key: 'app_password',
    label: 'providerAppPassword',
    input_type: 'password',
    placeholder: 'app password',
    hint: 'hintNextcloudAppPassword',
    required: 1,
    secret: 1,
    sort_order: 2,
  },
  {
    provider_id: 'nextcloud',
    field_key: 'base_path',
    label: 'providerBasePath',
    input_type: 'text',
    placeholder: '/TREK',
    hint: 'hintBasePath',
    required: 0,
    secret: 0,
    sort_order: 3,
  },
  {
    provider_id: 'nextcloud',
    field_key: 'allow_insecure_tls',
    label: 'allowInsecureTls',
    input_type: 'checkbox',
    placeholder: null,
    hint: null,
    required: 0,
    secret: 0,
    sort_order: 4,
  },

  // OpenCloud: auth-app token, spaces instead of folders.
  {
    provider_id: 'opencloud',
    field_key: 'base_url',
    label: 'providerUrl',
    input_type: 'url',
    placeholder: 'https://opencloud.example.com',
    hint: null,
    required: 1,
    secret: 0,
    sort_order: 0,
  },
  {
    provider_id: 'opencloud',
    field_key: 'username',
    label: 'providerUsername',
    input_type: 'text',
    placeholder: 'username',
    hint: null,
    required: 1,
    secret: 0,
    sort_order: 1,
  },
  {
    provider_id: 'opencloud',
    field_key: 'app_token',
    label: 'providerAppToken',
    input_type: 'password',
    placeholder: 'app token',
    hint: 'hintOpenCloudToken',
    required: 1,
    secret: 1,
    sort_order: 2,
  },
  {
    provider_id: 'opencloud',
    field_key: 'allow_insecure_tls',
    label: 'allowInsecureTls',
    input_type: 'checkbox',
    placeholder: null,
    hint: null,
    required: 0,
    secret: 0,
    sort_order: 3,
  },

  // Synology: DSM has no app tokens at all, so this is a real account.
  {
    provider_id: 'synologydrive',
    field_key: 'base_url',
    label: 'providerUrl',
    input_type: 'url',
    placeholder: 'https://nas.example.com:5001',
    hint: 'hintSynologyUrl',
    required: 1,
    secret: 0,
    sort_order: 0,
  },
  {
    provider_id: 'synologydrive',
    field_key: 'username',
    label: 'providerUsername',
    input_type: 'text',
    placeholder: 'username',
    hint: 'hintSynologyUser',
    required: 1,
    secret: 0,
    sort_order: 1,
  },
  {
    provider_id: 'synologydrive',
    field_key: 'password',
    label: 'providerPassword',
    input_type: 'password',
    placeholder: 'password',
    hint: null,
    required: 1,
    secret: 1,
    sort_order: 2,
  },
  {
    provider_id: 'synologydrive',
    field_key: 'otp_code',
    label: 'providerOTP',
    input_type: 'text',
    placeholder: '123456',
    hint: 'hintSynologyOtp',
    required: 0,
    secret: 1,
    sort_order: 3,
  },
  {
    provider_id: 'synologydrive',
    field_key: 'base_path',
    label: 'providerBasePath',
    input_type: 'text',
    placeholder: '/trek',
    hint: 'hintBasePath',
    required: 0,
    secret: 0,
    sort_order: 4,
  },
  {
    provider_id: 'synologydrive',
    field_key: 'allow_insecure_tls',
    label: 'allowInsecureTls',
    input_type: 'checkbox',
    placeholder: null,
    hint: null,
    required: 0,
    secret: 0,
    sort_order: 5,
  },
];

export const DOCUMENT_PROVIDER_SEED_IDS = DOCUMENT_PROVIDER_SEEDS.map((p) => p.id);

// ── Persistence seam + runner ─────────────────────────────────────────────────

/**
 * INSERT OR IGNORE semantics throughout: an operator's rename or re-sort of a
 * seeded row survives a re-seed (the server's whole point of `OR IGNORE`).
 */
export interface LocalSeedStore {
  countCategories(): number;
  insertCategory(row: SeedCategory): void;
  /** Upsert-by-id with ignore semantics: an existing row keeps the operator's edits. */
  upsertAddon(row: SeedAddon): void;
  upsertPhotoProvider(row: SeedPhotoProvider): void;
  upsertPhotoProviderField(row: SeedPhotoProviderField): void;
  upsertDocumentProvider(row: SeedDocumentProvider): void;
  upsertDocumentProviderField(row: SeedProviderField): void;
}

export interface SeedResult {
  categoriesInserted: number;
}

/**
 * The non-admin seeds: categories only when empty, providers/addons as
 * INSERT-OR-IGNORE upserts. Verbatim from seedCategories + seedAddons +
 * seedDocumentProviders.
 */
export function seedLocalDefaults(store: LocalSeedStore): SeedResult {
  let categoriesInserted = 0;
  if (store.countCategories() === 0) {
    for (const cat of SEED_CATEGORIES) {
      store.insertCategory(cat);
      categoriesInserted++;
    }
  }
  for (const a of SEED_ADDONS) store.upsertAddon(a);
  for (const p of PHOTO_PROVIDER_SEEDS) store.upsertPhotoProvider(p);
  for (const f of PHOTO_PROVIDER_FIELD_SEEDS) store.upsertPhotoProviderField(f);
  for (const p of DOCUMENT_PROVIDER_SEEDS) store.upsertDocumentProvider(p);
  for (const f of DOCUMENT_PROVIDER_FIELD_SEEDS) store.upsertDocumentProviderField(f);
  return { categoriesInserted };
}

// ── Admin bootstrap decision (pure; the bcrypt/env/banner stays server-side) ──

/** bcrypt cost factor the server uses for the seeded admin password. Kept as a
 *  constant so a local persistence layer that ever hashes a first-run admin
 *  uses the same cost. */
export const SEED_BCRYPT_COST = 12;

/** The server's isOidcOnlyConfigured, over plain inputs instead of readEnv(). */
export function isOidcOnlyConfigured(oidc: {
  only?: boolean;
  issuer?: string | null;
  clientId?: string | null;
}): boolean {
  if (!oidc.only) return false;
  return !!(oidc.issuer && oidc.clientId);
}

export type AdminSeedPlan =
  | { action: 'skip'; reason: 'users-exist' | 'demo-mode' | 'oidc-only' }
  | { action: 'create'; email: string; username: 'admin'; passwordProvided: boolean };

/**
 * What seedAdminAccount would do — the decision without the bcrypt hash, the
 * crypto.randomBytes password or the console banner, none of which a browser
 * port owns. `generatePassword` supplies the random password when the plan says
 * one is needed and none was configured.
 */
export function planAdminSeed(opts: {
  userCount: number;
  adminEmail?: string | null;
  adminPassword?: string | null;
  demoEnabled: boolean;
  oidc: { only?: boolean; issuer?: string | null; clientId?: string | null };
}): AdminSeedPlan {
  const envEmail = opts.adminEmail || null;
  const envPw = opts.adminPassword || null;

  if (opts.userCount > 0) {
    return { action: 'skip', reason: 'users-exist' };
  }
  if (opts.demoEnabled) {
    // Demo mode seeds its own admin (admin@trek.app) — creating one here first
    // would grab username 'admin' and break the demo seeder's UNIQUE constraint.
    return { action: 'skip', reason: 'demo-mode' };
  }
  if (isOidcOnlyConfigured(opts.oidc)) {
    return { action: 'skip', reason: 'oidc-only' };
  }
  if (envEmail && envPw) {
    return { action: 'create', email: envEmail, username: 'admin', passwordProvided: true };
  }
  // Partial config is an easy mistake: neither value is used and a generated
  // password is created instead.
  return { action: 'create', email: 'admin@trek.local', username: 'admin', passwordProvided: false };
}
