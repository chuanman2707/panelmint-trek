import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAuthStore } from './store/authStore'
import { resetAllStores } from '../tests/helpers/store'
import { buildUser } from '../tests/helpers/factories'
import App from './App'

/**
 * The viewport decides which chunk gets fetched, so the switch lives in App.tsx
 * and no longer in the pages. This is that contract, for all three routes in one
 * place — it used to be five scattered spot checks, one per page test.
 *
 * A stub per screen keeps the test about one thing: below the breakpoint the M
 * root hangs off the route, and the desktop page is never rendered at all.
 */

const isPhone = vi.hoisted(() => ({ value: false }))
vi.mock('./mobile/useIsPhone', () => ({ useIsPhone: () => isPhone.value }))

vi.mock('./mobile/screens/dashboard/MDashboard', () => ({ default: () => <div>m-dashboard</div> }))
vi.mock('./mobile/screens/trip/MTripShell', () => ({ default: () => <div>m-trip</div> }))
vi.mock('./mobile/screens/settings/MSettings', () => ({ default: () => <div>m-settings</div> }))

vi.mock('./pages/DashboardPage', () => ({ default: () => <div>d-dashboard</div> }))
vi.mock('./pages/TripPlannerPage', () => ({ default: () => <div>d-trip</div> }))
vi.mock('./pages/SettingsPage', () => ({ default: () => <div>d-settings</div> }))

/** path, mobile marker, desktop marker */
const ROUTES: [string, string, string][] = [
  ['/dashboard', 'm-dashboard', 'd-dashboard'],
  ['/trips/1', 'm-trip', 'd-trip'],
  ['/settings', 'm-settings', 'd-settings'],
]

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetAllStores()
  vi.clearAllMocks()
  isPhone.value = false
  // Local auth is seeded before routes render; the store starts authenticated.
  useAuthStore.setState({
    isLoading: false,
    isAuthenticated: true,
    user: buildUser(),
    bootLocal: vi.fn().mockResolvedValue(undefined),
  })
})

describe('App — viewport routing', () => {
  it.each(ROUTES)(
    'FE-COMP-APPVP-001: %s renders the mobile screen below the breakpoint',
    async (path, mobile, desktop) => {
      isPhone.value = true
      renderAt(path)

      expect(await screen.findByText(mobile)).toBeInTheDocument()
      expect(screen.queryByText(desktop)).not.toBeInTheDocument()
    }
  )

  it.each(ROUTES)(
    'FE-COMP-APPVP-002: %s renders the desktop page above the breakpoint',
    async (path, mobile, desktop) => {
      renderAt(path)

      expect(await screen.findByText(desktop)).toBeInTheDocument()
      expect(screen.queryByText(mobile)).not.toBeInTheDocument()
    }
  )
})
