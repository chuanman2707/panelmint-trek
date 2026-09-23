import type { Settings } from '../types'
import { DEFAULT_APPEARANCE } from '@trek/shared'
import { DEFAULT_START_PAGE, DEFAULT_START_TRIP_TAB } from '../utils/startDestination'

// The effective defaults for a fresh device. There is no server-side settings
// row any more — the `panelmint` Dexie `settings` table is seeded from this
// object on first launch (db/bootstrap.ts) and every read merges over it.
//
// Kept in a leaf module of its own so the bootstrapper can seed the table
// without pulling in the store (and, through it, the API client and the old
// per-user offline cache). Keep it internally consistent — one measurement
// system, not °F alongside kilometres — and note that DisplaySettingsTab
// imports these same values for its fallbacks, so the store default and the UI
// fallback can't drift apart again.
export const DEFAULT_SETTINGS: Settings = {
  map_tile_url: '',
  // Empty = the public routing hosts TREK ships with.
  routing_base_url: '',
  // Empty = the public Valhalla, unless routing_base_url names an own router, in which
  // case no second engine is asked at all. See valhallaBase().
  valhalla_base_url: '',
  dark_mode: false,
  // Empty = no personal display currency, so Costs falls back to the trip's own.
  default_currency: '',
  // The explicit in-app choice mirrored to localStorage, then English. With no
  // account and no server there is nothing else to fall back on.
  language: localStorage.getItem('app_language') || 'en',
  temperature_unit: 'celsius',
  distance_unit: 'metric',
  time_format: '24h',
  show_place_description: false,
  optimize_from_accommodation: true,
  map_base_layer: 'default',
  map_poi_pill_enabled: true,
  carto_api_key: '',
  dashboard_fx_from: 'EUR',
  dashboard_fx_to: 'USD',
  start_page: DEFAULT_START_PAGE,
  start_trip_tab: DEFAULT_START_TRIP_TAB,
  appearance: DEFAULT_APPEARANCE,
  // dashboard_timezones is intentionally left unset so the widget can tell "never
  // chosen" (fall back to home + defaults) from an explicitly emptied list.
}

/**
 * Every key the `settings` KV table is allowed to hand to the store. This is NOT
 * `Object.keys(DEFAULT_SETTINGS)`: four living keys deliberately have no default
 * (`dashboard_timezones`, `blur_booking_codes`, `map_booking_labels`,
 * `map_always_show_routes`), and an allowlist derived from the defaults would
 * drop their rows on every load — saved fine, silently reverted next session.
 *
 * Typed as `Record<keyof Settings, true>` so tsc fails on a missing AND on an
 * extra key — the list can never drift from the interface again.
 */
export const SETTINGS_KEYS: Record<keyof Settings, true> = {
  map_tile_url: true,
  routing_base_url: true,
  valhalla_base_url: true,
  dark_mode: true,
  default_currency: true,
  language: true,
  temperature_unit: true,
  distance_unit: true,
  time_format: true,
  show_place_description: true,
  blur_booking_codes: true,
  map_booking_labels: true,
  map_poi_pill_enabled: true,
  map_always_show_routes: true,
  optimize_from_accommodation: true,
  map_base_layer: true,
  carto_api_key: true,
  dashboard_fx_from: true,
  dashboard_fx_to: true,
  dashboard_timezones: true,
  start_page: true,
  start_trip_tab: true,
  appearance: true,
}
