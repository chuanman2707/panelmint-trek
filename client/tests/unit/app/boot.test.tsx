import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { server } from '../../helpers/msw/server'
import { useAuthStore } from '../../../src/store/authStore'
import { resetAllStores } from '../../helpers/store'
import { db } from '../../../src/db/panelmintDb'
import App from '../../../src/App'

/**
 * PanelMint Local boots entirely off IndexedDB: no auth request, no app-config
 * fetch, no websocket. This file renders the real App with the real authStore —
 * bootLocal included — and fails if any of that reaches for the network.
 *
 * MSW intercepts fetch and XHR, so `request:start` sees every HTTP attempt
 * whether a handler exists or not. WebSocket is stubbed to a counter: jsdom's
 * own implementation would really dial, and "no socket" is the claim.
 */

vi.mock('../../../src/pages/DashboardPage', () => ({ default: () => <div>Dashboard</div> }))
vi.mock('../../../src/pages/TripPlannerPage', () => ({ default: () => <div>TripPlanner</div> }))
vi.mock('../../../src/pages/SettingsPage', () => ({ default: () => <div>Settings</div> }))

const requests: string[] = []
let sockets = 0

const onRequestStart = ({ request }: { request: Request }) => {
  requests.push(`${request.method} ${request.url}`)
}

class FakeWebSocket {
  constructor(public url: string) {
    sockets += 1
  }
  close() {}
}

beforeEach(async () => {
  resetAllStores()
  vi.clearAllMocks()
  requests.length = 0
  sockets = 0
  // Start from a truly empty database — the boot itself must do the seeding.
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  server.events.on('request:start', onRequestStart)
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  server.events.removeListener('request:start', onRequestStart)
  vi.unstubAllGlobals()
})

describe('App — local boot', () => {
  it('FE-BOOT-001: boots to the dashboard with the seeded self and no network', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )

    // The loading state is real here — bootLocal is the genuine Dexie bootstrap.
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())

    const auth = useAuthStore.getState()
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.isLoading).toBe(false)
    expect(auth.user?.id).toBe(1)
    expect(auth.user?.username).toBe('Me')

    // The self row came from bootstrapLocalData, not from a test fixture.
    const self = await db.localUsers.get(1)
    expect(self).toMatchObject({ id: 1, name: 'Me', is_self: 1 })
    expect(await db.localUsers.count()).toBe(1)
    expect((await db.settings.get('__bootstrapped'))?.value).toBe(true)

    // Give any fire-and-forget boot fetch a chance to surface.
    await new Promise(r => setTimeout(r, 50))
    expect(requests).toEqual([])
    expect(sockets).toBe(0)
  })

  it('FE-BOOT-002: a second boot reuses the seeded data instead of duplicating it', async () => {
    const first = render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())
    first.unmount()

    resetAllStores()
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument())

    expect(await db.localUsers.count()).toBe(1)
    expect(requests).toEqual([])
    expect(sockets).toBe(0)
  })
})
