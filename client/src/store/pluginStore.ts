import { create } from 'zustand'

const PLUGIN_SESSION_NAMESPACE = 'trek:plugin-session:'

/**
 * Drops every plugin's session state, whatever user or trip it belonged to.
 */
export function clearAllPluginSessions() {
  const keysToRemove: string[] = []
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const storageKey = sessionStorage.key(i)
    if (storageKey?.startsWith(PLUGIN_SESSION_NAMESPACE)) keysToRemove.push(storageKey)
  }
  keysToRemove.forEach((storageKey) => sessionStorage.removeItem(storageKey))
}

/**
 * Active plugins the client renders (#plugins, M3). Page plugins become nav
 * entries + a full-page iframe route; widget plugins mount on the dashboard.
 * Cloned from addonStore — plugins have their own feed and lifecycle, so they
 * don't overload the addon store.
 */
export interface ActivePlugin {
  id: string
  name: string
  type: 'integration' | 'page' | 'widget' | 'trip-page'
  icon: string | null
  slot?: 'sidebar' | 'hero' | 'place-detail' | 'day-detail' | 'reservation-detail'
  /** How a trip-page plugin sits in the planner tab bar: which core tabs it
   * replaces while active ('plan' never — enforced server-side) and its
   * preferred 0-based tab index. */
  tripPage?: { replaces?: string[]; position?: number }
  /** The plugin ships a settings.html the user-settings page frames. */
  settingsUi?: true
  /** Routing profiles the planner's route toggle offers (routeProvider hook;
   * the server only sends these when the hook permission is granted). */
  routeProfiles?: Array<{ id: string; label: string; icon?: string }>
  /** The plugin holds the geolocation:read grant — its frames may ask the host
   * for the browser position over the bridge. */
  geolocation?: true
}

interface PluginState {
  plugins: ActivePlugin[]
  loaded: boolean
  loadPlugins: () => Promise<void>
  getById: (id: string) => ActivePlugin | undefined
  pages: () => ActivePlugin[]
  widgets: () => ActivePlugin[]
  heroWidgets: () => ActivePlugin[]
  tripPages: () => ActivePlugin[]
  placeDetailWidgets: () => ActivePlugin[]
  routeProviders: () => ActivePlugin[]
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  loaded: false,

  // Plugins are cut for the local build — there is no plugin service to ask.
  // The store stays so the contribution surfaces keep reading an empty list.
  loadPlugins: async () => {
    set({ plugins: [], loaded: true })
  },

  getById: (id) => get().plugins.find((p) => p.id === id),
  pages: () => get().plugins.filter((p) => p.type === 'page'),
  widgets: () => get().plugins.filter((p) => p.type === 'widget' && p.slot !== 'hero' && p.slot !== 'place-detail' && p.slot !== 'day-detail' && p.slot !== 'reservation-detail'),
  heroWidgets: () => get().plugins.filter((p) => p.type === 'widget' && p.slot === 'hero'),
  tripPages: () => get().plugins.filter((p) => p.type === 'trip-page'),
  placeDetailWidgets: () => get().plugins.filter((p) => p.type === 'widget' && p.slot === 'place-detail'),
  routeProviders: () => get().plugins.filter((p) => !!p.routeProfiles?.length),
}))
