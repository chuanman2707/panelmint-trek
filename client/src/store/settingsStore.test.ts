import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore'
import { db } from '../db/panelmintDb'
import { clearTileCache } from '../sync/tileCache'

vi.mock('../sync/tileCache', () => ({
  clearTileCache: vi.fn().mockResolvedValue(undefined),
}))

const resetStore = () => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: false })
}

beforeEach(async () => {
  vi.clearAllMocks()
  localStorage.clear()
  await db.settings.clear()
  resetStore()
})

// DEFAULT_SETTINGS is what a brand-new device sees before the Dexie KV rows are
// read in (and the seed bootstrap writes exactly these). These guard against the
// original two regressions: unit defaults that mix measurement systems, and a
// store default that silently disagrees with DisplaySettingsTab's fallback.
describe('settings defaults', () => {
  it('SETTINGS-DEFAULTS-001: the shipped unit defaults belong to one consistent system', () => {
    expect(DEFAULT_SETTINGS.temperature_unit).toBe('celsius')
    expect(DEFAULT_SETTINGS.distance_unit).toBe('metric')
    expect(DEFAULT_SETTINGS.time_format).toBe('24h')
  })

  it('SETTINGS-DEFAULTS-002: the store initialises from DEFAULT_SETTINGS, the same constant DisplaySettingsTab falls back to, so the two cannot drift apart', () => {
    const settings = useSettingsStore.getState().settings
    expect(settings.temperature_unit).toBe(DEFAULT_SETTINGS.temperature_unit)
    expect(settings.distance_unit).toBe(DEFAULT_SETTINGS.distance_unit)
    expect(settings.time_format).toBe(DEFAULT_SETTINGS.time_format)
  })

  it('SETTINGS-DEFAULTS-003: no CARTO key is shipped, so the field starts empty instead of undefined', () => {
    expect(DEFAULT_SETTINGS.carto_api_key).toBe('')
  })
})

// The `settings` Dexie table is the system of record now — there is no server
// round-trip, so a write has to land in IndexedDB and a reload has to read it
// back out.
describe('Dexie-backed settings store', () => {
  it('SETTINGS-LOCAL-001: updateSetting persists the row and a fresh load reads it back', async () => {
    await useSettingsStore.getState().updateSetting('dark_mode', true)

    expect(await db.settings.get('dark_mode')).toEqual({ key: 'dark_mode', value: true })

    // Simulate a reload: drop the in-memory state, load from the table again.
    resetStore()
    await useSettingsStore.getState().loadSettings()

    const state = useSettingsStore.getState()
    expect(state.isLoaded).toBe(true)
    expect(state.settings.dark_mode).toBe(true)
  })

  it('SETTINGS-LOCAL-002: updateSettings writes every key of the patch', async () => {
    await useSettingsStore.getState().updateSettings({ dark_mode: true, default_currency: 'JPY' })

    expect(await db.settings.get('dark_mode')).toEqual({ key: 'dark_mode', value: true })
    expect(await db.settings.get('default_currency')).toEqual({ key: 'default_currency', value: 'JPY' })

    resetStore()
    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().settings.default_currency).toBe('JPY')
  })

  it('SETTINGS-LOCAL-003: rows for keys the pruned Settings no longer owns are ignored on load', async () => {
    // Stale writes from the hosted build (and the bootstrap flag that shares the
    // table) must not leak into state.
    await db.settings.bulkPut([
      { key: 'roadtrip_vehicle', value: 'electric' },
      { key: 'map_provider', value: 'mapbox-gl' },
      { key: 'llm_api_key', value: 'sk-stale' },
      { key: '__bootstrapped', value: true },
      { key: 'default_currency', value: 'EUR' },
    ])

    await useSettingsStore.getState().loadSettings()

    const settings = useSettingsStore.getState().settings as unknown as Record<string, unknown>
    expect(settings.default_currency).toBe('EUR')
    expect(settings.roadtrip_vehicle).toBeUndefined()
    expect(settings.map_provider).toBeUndefined()
    expect(settings.llm_api_key).toBeUndefined()
    expect(settings.__bootstrapped).toBeUndefined()
  })

  it('SETTINGS-LOCAL-003b: living keys with no default still round-trip — dashboard_timezones and blur_booking_codes are deliberately absent from DEFAULT_SETTINGS but must survive a reload', async () => {
    await useSettingsStore.getState().updateSetting('dashboard_timezones', ['Asia/Tokyo'])
    await useSettingsStore.getState().updateSetting('blur_booking_codes', true)

    // Simulate a reload: drop the in-memory state, load from the table again.
    resetStore()
    await useSettingsStore.getState().loadSettings()

    const settings = useSettingsStore.getState().settings
    expect(settings.dashboard_timezones).toEqual(['Asia/Tokyo'])
    expect(settings.blur_booking_codes).toBe(true)
  })

  it('SETTINGS-LOCAL-004: updateSetting is optimistic — state moves before the write resolves', async () => {
    const promise = useSettingsStore.getState().updateSetting('default_currency', 'GBP')
    expect(useSettingsStore.getState().settings.default_currency).toBe('GBP')
    await promise
  })

  it('SETTINGS-LOCAL-005: a failed Dexie write throws and keeps the optimistic state', async () => {
    const spy = vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('disk gone'))
    await expect(
      useSettingsStore.getState().updateSetting('default_currency', 'EUR'),
    ).rejects.toThrow('disk gone')
    expect(useSettingsStore.getState().settings.default_currency).toBe('EUR')
    spy.mockRestore()
  })

  it('SETTINGS-LOCAL-006: a failed Dexie read leaves isLoaded false so the load can be retried', async () => {
    const spy = vi.spyOn(db.settings, 'toArray').mockRejectedValueOnce(new Error('db blocked'))
    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().isLoaded).toBe(false)
    spy.mockRestore()

    await db.settings.put({ key: 'default_currency', value: 'CHF' })
    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().isLoaded).toBe(true)
    expect(useSettingsStore.getState().settings.default_currency).toBe('CHF')
  })
})

// The CARTO key lives in its own setting and is appended at render time (#2054).
// Two things have to hold on the way into the KV table: the key never gets
// frozen into the saved template, and a key change invalidates the tile cache,
// which is keyed by the full URL.
describe('settings tile template hygiene', () => {
  it('SETTINGS-TILE-001: a key pasted into the template is stripped before the template is stored', async () => {
    await useSettingsStore.getState().updateSetting(
      'map_tile_url',
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=pasted-secret',
    )
    const stored = useSettingsStore.getState().settings.map_tile_url
    expect(stored).toBe('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png')
    expect(stored).not.toContain('pasted-secret')
    expect(await db.settings.get('map_tile_url')).toEqual({ key: 'map_tile_url', value: stored })
  })

  it('SETTINGS-TILE-002: a bulk save strips the key and normalizes the retired OSM shard host', async () => {
    await useSettingsStore.getState().updateSettings({
      map_tile_url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png?key=pasted-secret',
    })
    const stored = useSettingsStore.getState().settings.map_tile_url
    expect(stored).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png')
    expect(await db.settings.get('map_tile_url')).toEqual({ key: 'map_tile_url', value: stored })
  })

  it('SETTINGS-TILE-003: changing the CARTO key drops the tile cache', async () => {
    await useSettingsStore.getState().updateSetting('carto_api_key', 'fresh-key')
    expect(clearTileCache).toHaveBeenCalledTimes(1)
  })

  it('SETTINGS-TILE-004: re-saving the same key leaves the cache alone', async () => {
    await useSettingsStore.getState().updateSetting('carto_api_key', 'fresh-key')
    vi.mocked(clearTileCache).mockClear()
    await useSettingsStore.getState().updateSetting('carto_api_key', 'fresh-key')
    expect(clearTileCache).not.toHaveBeenCalled()
  })

  it('SETTINGS-TILE-005: a bulk save clears the cache only when the key actually moves', async () => {
    await useSettingsStore.getState().updateSettings({ carto_api_key: 'fresh-key' })
    expect(clearTileCache).toHaveBeenCalledTimes(1)

    vi.mocked(clearTileCache).mockClear()
    await useSettingsStore.getState().updateSettings({ map_tile_url: '' })
    expect(clearTileCache).not.toHaveBeenCalled()
  })

  it('SETTINGS-TILE-006: a stored legacy OSM shard host is normalized on load', async () => {
    await db.settings.put({ key: 'map_tile_url', value: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' })
    await useSettingsStore.getState().loadSettings()
    expect(useSettingsStore.getState().settings.map_tile_url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png')
  })
})

describe('language', () => {
  it('SETTINGS-LANG-001: updateSetting mirrors an explicit choice into localStorage', async () => {
    await useSettingsStore.getState().updateSetting('language', 'fr')
    expect(useSettingsStore.getState().settings.language).toBe('fr')
    expect(localStorage.getItem('app_language')).toBe('fr')
    expect(await db.settings.get('language')).toEqual({ key: 'language', value: 'fr' })
  })

  it('SETTINGS-LANG-002: a non-language key never touches the mirror', async () => {
    localStorage.setItem('app_language', 'de')
    await useSettingsStore.getState().updateSetting('dark_mode', true)
    expect(localStorage.getItem('app_language')).toBe('de')
  })
})
