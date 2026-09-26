import { create } from 'zustand'
import type { Settings } from '../types'
import { getErrorMessage } from '../utils/apiError'
import { SUPPORTED_LANGUAGE_CODES } from '../i18n/supportedLanguages'
import { normalizeTileUrl, stripTileApiKey } from '../utils/tileUrl'
import { clearTileCache } from '../sync/tileCache'
import { rememberStartDestination } from '../utils/startDestination'
import { db } from '../db/panelmintDb'
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from './settingsDefaults'

// Re-exported so existing importers (DisplaySettingsTab, db/bootstrap seeds,
// tests) keep working — the constant lives in a leaf module so bootstrap does
// not drag this store's import graph into the boot path.
export { DEFAULT_SETTINGS }

interface SettingsState {
  settings: Settings
  isLoaded: boolean

  loadSettings: () => Promise<void>
  updateSetting: (key: keyof Settings, value: Settings[keyof Settings]) => Promise<void>
  setLanguageLocal: (lang: string) => void
  setLanguageTransient: (lang: string) => void
  updateSettings: (settingsObj: Partial<Settings>) => Promise<void>
}

// Returns true when the user has explicitly chosen a language (persisted in localStorage).
// Use this instead of reading localStorage directly so the key stays encapsulated here.
export const hasStoredLanguage = (): boolean =>
  typeof localStorage !== 'undefined' && !!localStorage.getItem('app_language')

// De-dupe concurrent loads: the startup triggers can fire more than one load at
// once — collapse them into a single read.
let _loadInFlight: Promise<void> | null = null

// Every tile consumer (planner map, journey map, tile prefetcher, the settings
// preview) reads the template from this store, so the retired
// {s}.tile.openstreetmap.org host is rewritten here — on the way in from the
// database and on the way out to it. Rewriting only on read would let a
// template typed by hand survive in the table until the next load put it back
// (#1733).
function withNormalizedTileUrl<T extends Partial<Settings>>(patch: T): T {
  if (typeof patch.map_tile_url !== 'string') return patch
  return { ...patch, map_tile_url: cleanTileTemplate(patch.map_tile_url) }
}

// A CARTO key pasted along with a full tile URL is dropped here: the key lives
// in its own setting and is appended at render time, so leaving it in the
// template would freeze it into the saved value and break on the next rotation.
function cleanTileTemplate(url: string): string {
  return stripTileApiKey(normalizeTileUrl(url))
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  isLoaded: false,

  loadSettings: async () => {
    if (_loadInFlight !== null) return _loadInFlight
    _loadInFlight = (async () => {
      try {
        const rows = await db.settings.toArray()
        // The table is a shared key/value store — it also carries the
        // bootstrap flag and whatever an older build once wrote — so only keys
        // the pruned Settings still owns are applied; the rest stay on disk
        // but out of state. SETTINGS_KEYS rather than DEFAULT_SETTINGS: four
        // living keys have no default by design and must still load.
        const stored: Record<string, unknown> = {}
        for (const row of rows) {
          if (Object.prototype.hasOwnProperty.call(SETTINGS_KEYS, row.key)) {
            stored[row.key] = row.value
          }
        }
        // Rewritten here so the Map settings input already shows the host that
        // still resolves, and persists it on the next save.
        const incoming = withNormalizedTileUrl(stored as Partial<Settings>)
        set((state) => ({
          settings: { ...state.settings, ...incoming },
          isLoaded: true,
        }))
        // The startup redirect runs before this ever resolves, so keep a mirror
        // it can read synchronously on the next launch.
        rememberStartDestination(incoming)
      } catch (err: unknown) {
        // Leave isLoaded false so a failed read is retried rather than
        // stranding the session on built-in defaults.
        console.error('Failed to load settings:', err)
      } finally {
        _loadInFlight = null
      }
    })()
    return _loadInFlight
  },

  updateSetting: async (key: keyof Settings, value: Settings[keyof Settings]) => {
    const next =
      key === 'map_tile_url' && typeof value === 'string' ? cleanTileTemplate(value) : value
    if (key === 'carto_api_key' && next !== get().settings.carto_api_key) void clearTileCache()
    set((state) => ({
      settings: { ...state.settings, [key]: next },
    }))
    if (key === 'language') localStorage.setItem('app_language', next as string)
    rememberStartDestination({ [key]: next } as Partial<Settings>)
    try {
      await db.settings.put({ key, value: next })
    } catch (err: unknown) {
      console.error('Failed to save setting:', err)
      throw new Error(getErrorMessage(err, 'Error saving setting'))
    }
  },

  setLanguageLocal: (lang: string) => {
    localStorage.setItem('app_language', lang)
    set((state) => ({ settings: { ...state.settings, language: lang } }))
  },

  // Applies a language for the current session without persisting to localStorage.
  // Used for automatic detection — only explicit user choices via the UI should
  // be persisted.
  setLanguageTransient: (lang: string) => {
    if (!SUPPORTED_LANGUAGE_CODES.includes(lang)) return
    set((state) => ({ settings: { ...state.settings, language: lang } }))
  },

  updateSettings: async (settingsObj: Partial<Settings>) => {
    const patch = withNormalizedTileUrl(settingsObj)
    // Cached tiles are keyed by their full URL, so a new key leaves the whole
    // offline cache stranded behind the old one.
    if ('carto_api_key' in patch && patch.carto_api_key !== get().settings.carto_api_key) {
      void clearTileCache()
    }
    set((state) => ({
      settings: { ...state.settings, ...patch },
    }))
    rememberStartDestination(patch)
    try {
      await db.settings.bulkPut(
        Object.entries(patch).map(([key, value]) => ({ key, value })),
      )
    } catch (err: unknown) {
      console.error('Failed to save settings:', err)
      throw new Error(getErrorMessage(err, 'Error saving settings'))
    }
  },
}))
