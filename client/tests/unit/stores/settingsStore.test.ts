import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '../../../src/store/settingsStore';
import { resetAllStores } from '../../helpers/store';
import { db } from '../../../src/db/panelmintDb';

// The `settings` Dexie table is the system of record now — there is no server
// round-trip, so these tests seed and read back IndexedDB rows directly.
// fake-indexeddb is installed globally by tests/setup.ts.

beforeEach(async () => {
  resetAllStores();
  await db.settings.clear();
});

describe('settingsStore', () => {
  describe('FE-SETTINGS-001: loadSettings()', () => {
    it('reads stored rows and updates the store', async () => {
      await db.settings.bulkPut([
        { key: 'default_currency', value: 'EUR' },
        { key: 'language', value: 'de' },
      ]);

      await useSettingsStore.getState().loadSettings();
      const state = useSettingsStore.getState();

      expect(state.settings.default_currency).toBe('EUR');
      expect(state.settings.language).toBe('de');
      expect(state.isLoaded).toBe(true);
    });
  });

  describe('FE-SETTINGS-002: updateSetting() optimistic update', () => {
    it('immediately updates local state before the write resolves', async () => {
      // The store's set() is called synchronously before the first await (the
      // Dexie put) so state is visible without needing to await the full action.
      const promise = useSettingsStore.getState().updateSetting('default_currency', 'GBP');

      // Check optimistic state — no await needed here
      expect(useSettingsStore.getState().settings.default_currency).toBe('GBP');

      // Let the write finish to avoid dangling promises
      await promise;
      expect(await db.settings.get('default_currency')).toEqual({ key: 'default_currency', value: 'GBP' });
    });
  });

  describe('FE-SETTINGS-003: updateSetting() throws on write failure', () => {
    it('rejects when the Dexie write fails', async () => {
      const spy = vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('disk gone'));

      // The store optimistically sets, then throws — the revert is a throw
      await expect(
        useSettingsStore.getState().updateSetting('default_currency', 'GBP')
      ).rejects.toThrow();

      spy.mockRestore();
    });
  });

  describe('FE-SETTINGS-004: Language change', () => {
    it('updates language field and localStorage', async () => {
      await useSettingsStore.getState().updateSetting('language', 'fr');

      const state = useSettingsStore.getState();
      expect(state.settings.language).toBe('fr');
      expect(localStorage.getItem('app_language')).toBe('fr');
      expect(await db.settings.get('language')).toEqual({ key: 'language', value: 'fr' });
    });
  });

  describe('FE-SETTINGS-005: loadSettings failure', () => {
    it('leaves isLoaded false on a read failure so the load is retried (#1618)', async () => {
      const spy = vi.spyOn(db.settings, 'toArray').mockRejectedValueOnce(new Error('db blocked'));

      await useSettingsStore.getState().loadSettings();

      // A transient failure must NOT be treated as "loaded" — otherwise the store
      // stays on built-in DEFAULT_SETTINGS (wrong currency/units) for the whole
      // session with no retry. isLoaded stays false so the next load retries.
      expect(useSettingsStore.getState().isLoaded).toBe(false);
      spy.mockRestore();
    });

    it('recovers on a later retry after an initial failure (#1618)', async () => {
      const spy = vi.spyOn(db.settings, 'toArray').mockRejectedValueOnce(new Error('db blocked'));
      await useSettingsStore.getState().loadSettings();
      expect(useSettingsStore.getState().isLoaded).toBe(false);
      spy.mockRestore();

      await db.settings.put({ key: 'default_currency', value: 'EUR' });
      await useSettingsStore.getState().loadSettings();

      const state = useSettingsStore.getState();
      expect(state.isLoaded).toBe(true);
      expect(state.settings.default_currency).toBe('EUR');
    });
  });

  describe('FE-STORE-SETTINGS-006: setLanguageLocal updates state and localStorage', () => {
    it('sets language in state and localStorage without a write', () => {
      useSettingsStore.getState().setLanguageLocal('ja');

      const state = useSettingsStore.getState();
      expect(state.settings.language).toBe('ja');
      expect(localStorage.getItem('app_language')).toBe('ja');
    });
  });

  describe('FE-STORE-SETTINGS-007: setLanguageLocal without prior localStorage value', () => {
    it('writes to localStorage even when no prior value exists', () => {
      localStorage.clear();

      useSettingsStore.getState().setLanguageLocal('ko');

      const state = useSettingsStore.getState();
      expect(state.settings.language).toBe('ko');
      expect(localStorage.getItem('app_language')).toBe('ko');
    });
  });

  describe('FE-STORE-SETTINGS-008: updateSettings bulk update', () => {
    it('updates multiple settings keys and persists every one', async () => {
      await useSettingsStore.getState().updateSettings({ dark_mode: true, default_currency: 'JPY' });

      const state = useSettingsStore.getState();
      expect(state.settings.dark_mode).toBe(true);
      expect(state.settings.default_currency).toBe('JPY');
      expect(await db.settings.get('dark_mode')).toEqual({ key: 'dark_mode', value: true });
      expect(await db.settings.get('default_currency')).toEqual({ key: 'default_currency', value: 'JPY' });
    });
  });

  describe('FE-STORE-SETTINGS-009: updateSettings optimistic update', () => {
    it('updates state synchronously before the write resolves', async () => {
      const promise = useSettingsStore.getState().updateSettings({ dark_mode: true });

      expect(useSettingsStore.getState().settings.dark_mode).toBe(true);

      await promise;
    });
  });

  describe('FE-STORE-SETTINGS-010: updateSettings write failure throws', () => {
    it('rejects when the Dexie bulk write fails', async () => {
      const spy = vi.spyOn(db.settings, 'bulkPut').mockRejectedValueOnce(new Error('disk gone'));

      await expect(
        useSettingsStore.getState().updateSettings({ dark_mode: true })
      ).rejects.toThrow();

      spy.mockRestore();
    });
  });

  describe('FE-STORE-SETTINGS-011: updateSetting non-language key does not write to localStorage', () => {
    it('does not modify app_language in localStorage', async () => {
      const before = localStorage.getItem('app_language');

      await useSettingsStore.getState().updateSetting('dark_mode', true);

      expect(localStorage.getItem('app_language')).toBe(before);
    });
  });

  describe('FE-STORE-SETTINGS-012: loadSettings merges stored values with defaults', () => {
    it('preserves default keys not present in the table', async () => {
      await db.settings.put({ key: 'dark_mode', value: true });

      await useSettingsStore.getState().loadSettings();

      const state = useSettingsStore.getState();
      expect(state.settings.dark_mode).toBe(true);
      expect(state.settings.language).toBe('en');
      // No display currency of their own: Costs then follows each trip's own currency
      // rather than forcing every trip through one code.
      expect(state.settings.default_currency).toBe('');
    });
  });

  describe('FE-STORE-SETTINGS-013: updateSetting for time_format', () => {
    it('updates time_format in state', async () => {
      await useSettingsStore.getState().updateSetting('time_format', '24h');

      expect(useSettingsStore.getState().settings.time_format).toBe('24h');
    });
  });

  describe('FE-STORE-SETTINGS-015: setLanguageTransient updates state without touching localStorage', () => {
    it('sets language in state but does not write to localStorage', () => {
      localStorage.clear();

      useSettingsStore.getState().setLanguageTransient('fr');

      expect(useSettingsStore.getState().settings.language).toBe('fr');
      expect(localStorage.getItem('app_language')).toBeNull();
    });
  });

  describe('FE-STORE-SETTINGS-016: setLanguageTransient rejects unsupported language code', () => {
    it('leaves state unchanged for an unknown code', () => {
      const before = useSettingsStore.getState().settings.language;

      useSettingsStore.getState().setLanguageTransient('xx');

      expect(useSettingsStore.getState().settings.language).toBe(before);
    });
  });

  describe('FE-STORE-SETTINGS-017: setLanguageTransient does not overwrite an explicit localStorage choice', () => {
    it('localStorage remains unchanged after a transient set', () => {
      localStorage.setItem('app_language', 'de');

      useSettingsStore.getState().setLanguageTransient('es');

      expect(localStorage.getItem('app_language')).toBe('de');
    });
  });

  describe('FE-STORE-SETTINGS-014: updateSetting write failure leaves optimistic state', () => {
    it('throws on write failure but keeps the optimistic state', async () => {
      const spy = vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('disk gone'));

      await expect(
        useSettingsStore.getState().updateSetting('default_currency', 'EUR')
      ).rejects.toThrow();

      expect(useSettingsStore.getState().settings.default_currency).toBe('EUR');
      spy.mockRestore();
    });
  });

  describe('FE-STORE-SETTINGS-018: loadSettings normalizes a legacy OSM tile template (#1733)', () => {
    it('rewrites the retired {s}.tile.openstreetmap.org host on read', async () => {
      await db.settings.put({
        key: 'map_tile_url',
        value: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      });

      await useSettingsStore.getState().loadSettings();

      // d.tile.openstreetmap.org no longer resolves, so a template stored before
      // OSM dropped sharding must not reach the map or the tile prefetcher.
      expect(useSettingsStore.getState().settings.map_tile_url).toBe(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      );
    });

    it('leaves a custom template from another provider untouched', async () => {
      const url = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
      await db.settings.put({ key: 'map_tile_url', value: url });

      await useSettingsStore.getState().loadSettings();

      expect(useSettingsStore.getState().settings.map_tile_url).toBe(url);
    });
  });

  describe('FE-STORE-SETTINGS-019: saving normalizes the tile template too (#1733)', () => {
    it('rewrites a hand-typed legacy host in updateSetting and persists the rewrite', async () => {
      await useSettingsStore
        .getState()
        .updateSetting('map_tile_url', 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');

      // Normalizing only on read would leave the dead host in the database and
      // hand it straight back on the next load.
      expect(useSettingsStore.getState().settings.map_tile_url).toBe(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      );
      expect(await db.settings.get('map_tile_url')).toEqual({
        key: 'map_tile_url',
        value: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      });
    });

    it('rewrites the template inside a bulk save and persists the rewrite', async () => {
      await useSettingsStore.getState().updateSettings({
        map_tile_url: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        dark_mode: true,
      });

      expect(useSettingsStore.getState().settings.map_tile_url).toBe(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      );
      expect(await db.settings.get('map_tile_url')).toEqual({
        key: 'map_tile_url',
        value: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      });
    });

    it('leaves other settings and other providers alone', async () => {
      await useSettingsStore.getState().updateSetting('default_currency', 'CHF');
      expect(useSettingsStore.getState().settings.default_currency).toBe('CHF');

      const carto = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
      await useSettingsStore.getState().updateSettings({ map_tile_url: carto });
      expect(useSettingsStore.getState().settings.map_tile_url).toBe(carto);
    });
  });
});
