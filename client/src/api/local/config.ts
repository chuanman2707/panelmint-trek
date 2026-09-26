/**
 * `configApi` — the local implementation. Static answers for the two config
 * reads the hosted server had:
 *
 *  - `getPublicConfig()` — `GET /api/config`, the unauthenticated bootstrap the
 *    login page read for `defaultLanguage`. The server resolved
 *    `DEFAULT_LANGUAGE` to the canonical supported code or 'en'
 *    (app-config/derive.ts resolveDefaultLanguage); the local app's default is
 *    'en' (`store/settingsDefaults.ts`), so the answer is a constant.
 *  - `getAppConfig()` — was `authApi.getAppConfig` (`GET /api/auth/app-config`).
 *    Locally every flag is a constant; the values are the Task A7 list — the
 *    same statics `authStore` exposes to the ~200 readers that used to consume
 *    this endpoint. Nothing here depends on auth: there is one local user and
 *    she is always "logged in".
 *
 * The payload keeps the server's snake_case keys so any surviving reader of the
 * old shape (settings/about screens, `utils/placeSource`) sees the same fields.
 */
import type { PublicConfig } from '@trek/shared';

/**
 * The `/api/auth/app-config` response, local-static edition. Server keys kept
 * verbatim; values are the Task A7 constants (mirroring authStore's static
 * surface — they cannot be shared imports because adapters stay below the
 * store layer, so the two lists are pinned together by config.test.ts).
 */
export interface AppConfig {
  allow_registration: boolean;
  oidc_only_mode: boolean;
  password_login: boolean;
  password_registration: boolean;
  oidc_login: boolean;
  oidc_registration: boolean;
  passkey_login: boolean;
  passkey_configured: boolean;
  has_users: boolean;
  setup_complete: boolean;
  version: string;
  is_prerelease: boolean;
  has_maps_key: boolean;
  has_amap_key: boolean;
  places_provider: string;
  oidc_configured: boolean;
  require_mfa: boolean;
  timezone: string;
  trip_reminders_enabled: boolean;
  places_autocomplete_enabled: boolean;
  places_details_enabled: boolean;
  places_enrich_enabled: boolean;
  dev_mode: boolean;
}

const VERSION = typeof __TREK_UI_VERSION__ === 'string' ? __TREK_UI_VERSION__ : '';

export const configApi = {
  getPublicConfig: async (): Promise<PublicConfig> => ({ defaultLanguage: 'en' }),

  getAppConfig: async (): Promise<AppConfig> => ({
    // No accounts exist — every auth toggle is off.
    allow_registration: false,
    oidc_only_mode: false,
    password_login: false,
    password_registration: false,
    oidc_login: false,
    oidc_registration: false,
    passkey_login: false,
    passkey_configured: false,
    // The seeded self profile means first-run setup is always complete.
    has_users: true,
    setup_complete: true,
    version: VERSION,
    is_prerelease: VERSION.includes('-pre.'),
    // No Google/Amap keys exist locally — places run on Photon/OpenStreetMap.
    has_maps_key: false,
    has_amap_key: false,
    // 'openstreetmap' keeps Google out of the keyed slot in utils/placeSource.
    places_provider: 'openstreetmap',
    oidc_configured: false,
    require_mfa: false,
    // Was the server's TZ; locally the browser's clock is the truth.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // On — the default-false flag used to kill the reminder UI (#A7 note).
    trip_reminders_enabled: true,
    places_autocomplete_enabled: true,
    places_details_enabled: true,
    // Wikimedia enrichment is a keyless browser-direct call — stays on.
    places_enrich_enabled: true,
    dev_mode: import.meta.env.DEV === true,
  }),
};
