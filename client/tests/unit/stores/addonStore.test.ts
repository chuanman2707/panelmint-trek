// FE-ADDON-001 to 004 — the static local addon set: packing and budget are always
// on, there is no server feed to fetch, and loadAddons() re-asserts the set.
import { describe, it, expect, beforeEach } from 'vitest';
import { useAddonStore } from '../../../src/store/addonStore';
import { resetAllStores } from '../../helpers/store';

beforeEach(() => {
  resetAllStores();
});

describe('addonStore', () => {
  describe('FE-ADDON-001: loadAddons()', () => {
    it('re-asserts the static addon set', async () => {
      await useAddonStore.getState().loadAddons();
      const state = useAddonStore.getState();

      expect(state.loaded).toBe(true);
      expect(state.addons.map(a => a.id)).toEqual(['packing', 'budget']);
      expect(state.addons.every(a => a.enabled)).toBe(true);
      expect(state.bagTracking).toBe(true);
    });

    it('restores the static set after a seed emptied it', async () => {
      useAddonStore.setState({ addons: [], bagTracking: false, loaded: false });
      await useAddonStore.getState().loadAddons();
      expect(useAddonStore.getState().addons).toHaveLength(2);
      expect(useAddonStore.getState().bagTracking).toBe(true);
    });
  });

  describe('FE-ADDON-002: isEnabled returns true for known addon', () => {
    it('returns true when addon is in the list and enabled', async () => {
      await useAddonStore.getState().loadAddons();
      expect(useAddonStore.getState().isEnabled('packing')).toBe(true);
      expect(useAddonStore.getState().isEnabled('budget')).toBe(true);
    });
  });

  describe('FE-ADDON-003: isEnabled returns false for unknown addon', () => {
    it('returns false when addon is not in the list', async () => {
      await useAddonStore.getState().loadAddons();
      expect(useAddonStore.getState().isEnabled('nonexistent')).toBe(false);
      // The cut hosted addons stay off.
      expect(useAddonStore.getState().isEnabled('documents')).toBe(false);
      expect(useAddonStore.getState().isEnabled('collab')).toBe(false);
    });
  });

  describe('FE-ADDON-004: no fetch happens', () => {
    it('loadAddons resolves without any network dependency', async () => {
      // There is no /api/addons handler in the local build — a fetch would have
      // surfaced as an msw unhandled-request warning, so a clean resolve is the
      // assertion.
      await expect(useAddonStore.getState().loadAddons()).resolves.toBeUndefined();
      expect(useAddonStore.getState().loaded).toBe(true);
    });
  });
});
