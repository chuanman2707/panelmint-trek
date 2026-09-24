// FE-STORE-PLUGIN-001 to 006 — the local stub: there is no plugin service, so the
// store always reports an empty, loaded plugin list.
import { usePluginStore, clearAllPluginSessions } from './pluginStore';

const initial = usePluginStore.getState();

beforeEach(() => {
  usePluginStore.setState(initial, true);
  sessionStorage.clear();
});

describe('pluginStore', () => {
  it('FE-STORE-PLUGIN-001: loadPlugins resolves loaded with an empty list', async () => {
    await usePluginStore.getState().loadPlugins();

    const s = usePluginStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.plugins).toEqual([]);
    expect(s.pages()).toEqual([]);
    expect(s.widgets()).toEqual([]);
    expect(s.tripPages()).toEqual([]);
    expect(s.getById('anything')).toBeUndefined();
  });

  it('FE-STORE-PLUGIN-002: a plugin id nothing registered resolves nowhere', async () => {
    await usePluginStore.getState().loadPlugins();
    const s = usePluginStore.getState();
    expect(s.getById('nope')).toBeUndefined();
    expect(s.routeProviders()).toEqual([]);
    expect(s.heroWidgets()).toEqual([]);
    expect(s.placeDetailWidgets()).toEqual([]);
  });

  it('FE-STORE-PLUGIN-003: loading twice keeps the store settled and empty', async () => {
    await usePluginStore.getState().loadPlugins();
    await usePluginStore.getState().loadPlugins();
    expect(usePluginStore.getState().plugins).toEqual([]);
    expect(usePluginStore.getState().loaded).toBe(true);
  });

  it('FE-STORE-PLUGIN-004: clearAllPluginSessions drops every namespaced key', () => {
    sessionStorage.setItem('trek:plugin-session:7:active:plugin:filters', '["flight"]');
    sessionStorage.setItem('trek:plugin-session:7:disabled:plugin:filters', '["hotel"]');
    sessionStorage.setItem('trek:plugin-session:7:disabled:trip:42:view', '"table"');
    sessionStorage.setItem('trek_session', 'app-session');

    clearAllPluginSessions();

    expect(sessionStorage.getItem('trek:plugin-session:7:active:plugin:filters')).toBeNull();
    expect(sessionStorage.getItem('trek:plugin-session:7:disabled:plugin:filters')).toBeNull();
    expect(sessionStorage.getItem('trek:plugin-session:7:disabled:trip:42:view')).toBeNull();
    // Keys outside the plugin namespace are left alone.
    expect(sessionStorage.getItem('trek_session')).toBe('app-session');
  });

  it('FE-STORE-PLUGIN-005: clearAllPluginSessions on an empty store is a no-op', () => {
    sessionStorage.setItem('unrelated', 'value');
    expect(() => clearAllPluginSessions()).not.toThrow();
    expect(sessionStorage.getItem('unrelated')).toBe('value');
  });

  it('FE-STORE-PLUGIN-006: loadPlugins leaves session storage untouched', async () => {
    sessionStorage.setItem('trek:plugin-session:7:active:plugin:filters', '["flight"]');
    await usePluginStore.getState().loadPlugins();
    expect(sessionStorage.getItem('trek:plugin-session:7:active:plugin:filters')).toBe('["flight"]');
    expect(usePluginStore.getState().plugins).toEqual([]);
  });
});
