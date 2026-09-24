import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { useAuthStore } from './store/authStore'
import { useSettingsStore } from './store/settingsStore'
import { resetAllStores } from '../tests/helpers/store'
import { buildUser, buildSettings, buildTrip } from '../tests/helpers/factories'
import { offlineDb } from './db/offlineDb'
import { db } from './db/panelmintDb'
import { tripsApi } from './api/client'
import { SETTINGS_WAIT_MS } from './utils/startDestination'
import App from './App'

// ── Mock page components ───────────────────────────────────────────────────────
vi.mock('./pages/DashboardPage', () => ({ default: () => <div>Dashboard</div> }))
vi.mock('./pages/TripPlannerPage', () => ({ default: () => <div>TripPlanner</div> }))
vi.mock('./pages/SettingsPage', () => ({ default: () => <div>Settings</div> }))

// ── Helpers ────────────────────────────────────────────────────────────────────

function renderApp(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>
  )
}

/**
 * Seeds authStore for a test and stubs `bootLocal` with a no-op so the real
 * Dexie bootstrap in the App mount effect cannot overwrite the seeded state.
 * Pass `bootLocal` in overrides to spy on the call instead.
 */
function seedAuth(overrides: Record<string, unknown> = {}) {
  useAuthStore.setState({
    isLoading: false,
    isAuthenticated: true,
    user: buildUser(),
    appRequireMfa: false,
    bootLocal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  })
}

beforeEach(async () => {
  resetAllStores()
  vi.clearAllMocks()
  document.documentElement.classList.remove('dark')
  // tripsApi.active() reads the panelmint database — start each test empty.
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── RootRedirect ───────────────────────────────────────────────────────────────

describe('RootRedirect', () => {
  it('FE-COMP-APP-002: / redirects to /dashboard by default', async () => {
    seedAuth()
    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })

  it('FE-COMP-APP-003: / shows loading spinner while the local boot is running', () => {
    seedAuth({ isLoading: true, bootLocal: vi.fn(() => new Promise<void>(() => {})) })
    renderApp('/')
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument()
  })
})

// ── RootRedirect — startup destination ────────────────────────────────────────

describe('RootRedirect — startup destination', () => {
  /** Seeds the trip the local active() lookup should pick, and returns the spy
   *  on it so a test can still assert whether it was asked at all. A trip must
   *  span today to outrank everything else under the ranking. */
  async function stubActiveTrip(trip: { id: number; title: string } | null) {
    const spy = vi.spyOn(tripsApi, 'active')
    if (trip) {
      const today = new Date().toISOString().slice(0, 10)
      await db.trips.put(buildTrip({ id: trip.id, title: trip.title, start_date: today, end_date: today }))
    }
    return spy
  }

  it('FE-COMP-APP-026: opens the active trip on the chosen tab', async () => {
    seedAuth()
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip', start_trip_tab: 'finanzplan' }),
    })
    await stubActiveTrip({ id: 42, title: 'Japan' })

    renderApp('/')
    await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
  })

  it('FE-COMP-APP-027: falls back to the dashboard when the user has no trip', async () => {
    seedAuth()
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip', start_trip_tab: 'finanzplan' }),
    })
    await stubActiveTrip(null)

    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })

  it('FE-COMP-APP-028: falls back to the dashboard when the lookup fails', async () => {
    seedAuth()
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip' }),
    })
    // tripsApi.active() throwing drops tripRepo onto the offlineDb fallback,
    // which is empty here — same dashboard outcome.
    vi.spyOn(tripsApi, 'active').mockRejectedValue(new Error('lookup failed'))

    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })

  it('FE-COMP-APP-028b: opens the cached active trip when the launch is offline', async () => {
    seedAuth()
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip' }),
    })
    const today = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    await offlineDb.trips.put(buildTrip({ id: 42, title: 'Japan', start_date: iso(today), end_date: iso(today) }))
    const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

    // navigator and the Dexie table are shared with every other test in the
    // file, so a failed assertion must not leave the rest of them offline.
    try {
      renderApp('/')
      await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
    } finally {
      if (onLine) Object.defineProperty(Navigator.prototype, 'onLine', onLine)
      delete (navigator as unknown as { onLine?: boolean }).onLine
      await offlineDb.trips.clear()
    }
  })

  // The whole point of the localStorage mirror: the default launch must not pay
  // for a lookup it doesn't need.
  it('FE-COMP-APP-029: never asks for the active trip when starting on the dashboard', async () => {
    seedAuth()
    useSettingsStore.setState({ isLoaded: true, settings: buildSettings({ start_page: 'dashboard' }) })
    const activeSpy = await stubActiveTrip({ id: 42, title: 'Japan' })

    renderApp('/')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
    expect(activeSpy).not.toHaveBeenCalled()
  })

  it('FE-COMP-APP-030: reads the preference from localStorage before settings have loaded', async () => {
    localStorage.setItem('trek_start_page', 'active_trip')
    localStorage.setItem('trek_start_trip_tab', 'finanzplan')
    seedAuth()
    // A never-resolving loadSettings keeps isLoaded false for the whole test —
    // otherwise the settings response can beat the Dexie lookup and the rerun
    // effect would pick the loaded start_page over the mirror it is testing.
    useSettingsStore.setState({ isLoaded: false, loadSettings: vi.fn(() => new Promise<void>(() => {})) })
    await stubActiveTrip({ id: 42, title: 'Japan' })

    renderApp('/')
    await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
  })
})

// ── Routes ─────────────────────────────────────────────────────────────────────

describe('App — routes', () => {
  it('FE-COMP-APP-004: /dashboard renders without any authentication ceremony', async () => {
    seedAuth()
    renderApp('/dashboard')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })

  it('FE-COMP-APP-005: /trips/42 renders without any authentication ceremony', async () => {
    seedAuth()
    renderApp('/trips/42')
    await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
  })

  it('FE-COMP-APP-014: unknown routes redirect to / which then lands on /dashboard', async () => {
    seedAuth()
    renderApp('/does-not-exist')
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
  })
})

// ── App — on-mount effects ─────────────────────────────────────────────────────

describe('App — on-mount effects', () => {
  it('FE-COMP-APP-015: bootLocal is called on mount', async () => {
    const bootLocal = vi.fn().mockResolvedValue(undefined)
    useAuthStore.setState({ isLoading: false, isAuthenticated: true, bootLocal })
    renderApp('/dashboard')
    expect(bootLocal).toHaveBeenCalled()
  })

  it('FE-COMP-APP-019: loadSettings is called once the local boot resolves', async () => {
    const loadSettings = vi.fn().mockResolvedValue(undefined)
    seedAuth()
    useSettingsStore.setState({ loadSettings })
    renderApp('/dashboard')
    await waitFor(() => expect(loadSettings).toHaveBeenCalled())
  })
})

// ── Dark mode effects ──────────────────────────────────────────────────────────

describe('Dark mode effects', () => {
  it('FE-COMP-APP-020: adds dark class to documentElement when dark_mode is true', async () => {
    seedAuth()
    useSettingsStore.setState({ settings: buildSettings({ dark_mode: true }) })
    renderApp('/dashboard')
    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    )
  })

  it('FE-COMP-APP-021: removes dark class when dark_mode is false', async () => {
    document.documentElement.classList.add('dark')
    seedAuth()
    useSettingsStore.setState({ settings: buildSettings({ dark_mode: false }) })
    renderApp('/dashboard')
    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    )
  })

  it('FE-COMP-APP-023: auto mode applies dark based on matchMedia result', async () => {
    // matchMedia stub returns matches: false by default (from setup.ts)
    seedAuth()
    useSettingsStore.setState({ settings: buildSettings({ dark_mode: 'auto' as any }) })
    renderApp('/dashboard')
    await waitFor(() =>
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    )
  })
})

// ── RootRedirect — preference not mirrored on this device ──────────────────────

describe('RootRedirect — preference not mirrored on this device', () => {
  it('FE-COMP-APP-031: honours the loaded setting when localStorage is empty', async () => {
    seedAuth()
    const today = new Date().toISOString().slice(0, 10)
    await db.trips.put(buildTrip({ id: 42, title: 'Japan', start_date: today, end_date: today }))
    useSettingsStore.setState({
      isLoaded: true,
      settings: buildSettings({ start_page: 'active_trip' }),
    })

    renderApp('/')
    await waitFor(() => expect(screen.getByText('TripPlanner')).toBeInTheDocument())
  })

  it('FE-COMP-APP-033: asks for the settings itself instead of waiting to be told', async () => {
    seedAuth()
    const loadSettings = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ isLoaded: false, loadSettings })

    renderApp('/')
    await waitFor(() => expect(loadSettings).toHaveBeenCalled())
  })

  it('FE-COMP-APP-032: gives up on the settings after the timeout and opens the dashboard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      seedAuth()
      // A never-resolving load: after SETTINGS_WAIT_MS the redirect stops
      // waiting and lands on the default destination.
      useSettingsStore.setState({ isLoaded: false, loadSettings: vi.fn(() => new Promise<void>(() => {})) })

      renderApp('/')
      await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument(), { timeout: SETTINGS_WAIT_MS + 2000 })
    } finally {
      vi.useRealTimers()
    }
  })
})
