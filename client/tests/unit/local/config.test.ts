/**
 * Tests for the local `configApi` — static answers replacing
 * `GET /api/config` (`getPublicConfig`) and `GET /api/auth/app-config`
 * (`getAppConfig`, the Task A7 list). The pin that matters most: the static
 * payload must not drift from the constants `authStore` exposes to the same
 * readers.
 */
import { describe, expect, it } from 'vitest';
import { configApi } from '../../../src/api/local/config';
import { useAuthStore } from '../../../src/store/authStore';

describe('configApi.getPublicConfig', () => {
  it('answers the server default-language payload', async () => {
    await expect(configApi.getPublicConfig()).resolves.toEqual({ defaultLanguage: 'en' });
  });
});

describe('configApi.getAppConfig', () => {
  it('returns the static local payload (Task A7 list)', async () => {
    const cfg = await configApi.getAppConfig();
    expect(cfg).toMatchObject({
      allow_registration: false,
      oidc_only_mode: false,
      password_login: false,
      password_registration: false,
      oidc_login: false,
      oidc_registration: false,
      passkey_login: false,
      passkey_configured: false,
      has_users: true,
      setup_complete: true,
      has_maps_key: false,
      has_amap_key: false,
      places_provider: 'openstreetmap',
      oidc_configured: false,
      require_mfa: false,
      managed: false,
      demo_mode: false,
      trip_reminders_enabled: true,
      places_photos_enabled: false,
      places_autocomplete_enabled: true,
      places_details_enabled: true,
      places_enrich_enabled: true,
      place_shadow_enabled: false,
    });
    expect(cfg.version).toBe(useAuthStore.getState().appVersion);
    expect(cfg.is_prerelease).toBe(cfg.version.includes('-pre.'));
    expect(cfg.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(typeof cfg.dev_mode).toBe('boolean');
  });

  it('stays aligned with the authStore statics the readers actually consume', async () => {
    const cfg = await configApi.getAppConfig();
    const s = useAuthStore.getState();
    expect(cfg.places_provider).toBe(s.placesProvider);
    expect(cfg.has_maps_key).toBe(s.hasMapsKey);
    expect(cfg.has_amap_key).toBe(s.hasAmapKey);
    expect(cfg.managed).toBe(s.managed);
    expect(cfg.demo_mode).toBe(s.demoMode);
    expect(cfg.is_prerelease).toBe(s.isPrerelease);
    expect(cfg.version).toBe(s.appVersion);
    expect(cfg.timezone).toBe(s.serverTimezone);
    expect(cfg.require_mfa).toBe(s.appRequireMfa);
    expect(cfg.trip_reminders_enabled).toBe(s.tripRemindersEnabled);
    expect(cfg.places_photos_enabled).toBe(s.placesPhotosEnabled);
    expect(cfg.places_autocomplete_enabled).toBe(s.placesAutocompleteEnabled);
    expect(cfg.places_details_enabled).toBe(s.placesDetailsEnabled);
    expect(cfg.places_enrich_enabled).toBe(s.placesEnrichEnabled);
    expect(cfg.place_shadow_enabled).toBe(s.placeShadowEnabled);
  });
});
