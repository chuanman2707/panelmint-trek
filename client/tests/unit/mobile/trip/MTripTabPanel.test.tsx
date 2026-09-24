import { describe, expect, it, vi } from 'vitest'
import MTripTabPanel from '../../../../src/mobile/screens/trip/tabs/MTripTabPanel'
import type { MTabScreenProps } from '../../../../src/mobile/screens/trip/tabs/tabModel'
import { buildPlanner, buildShell } from '../../../helpers/mobileTrip'
import { render, screen } from '../../../helpers/render'

// FE-MOB-TABPANEL-001 to FE-MOB-TABPANEL-010 — the dateien/collab/plugin routes are gone with the hosted tabs.

/** Each tab is stubbed so the routing itself is what gets asserted. */
function stub(name: string) {
  return function Stub({ planner, shell }: MTabScreenProps) {
    return <div data-testid={name} data-trip={String(planner.tripId)} data-tab={shell.trTab} />
  }
}

vi.mock('../../../../src/mobile/screens/trip/tabs/MTransportsTab', () => ({ default: stub('transports') }))
vi.mock('../../../../src/mobile/screens/trip/tabs/MBookingsTab', () => ({ default: stub('bookings') }))
vi.mock('../../../../src/mobile/screens/trip/tabs/MCostsTab', () => ({ default: stub('costs') }))
vi.mock('../../../../src/mobile/screens/trip/tabs/MListsTab', () => ({ default: stub('lists') }))

function renderTab(tab: string, plannerOverrides = {}) {
  const planner = buildPlanner(plannerOverrides)
  const shell = buildShell({ trTab: tab })
  return { ...render(<MTripTabPanel planner={planner} shell={shell} tab={tab} />), planner, shell }
}

describe('MTripTabPanel', () => {
  it('FE-MOB-TABPANEL-001: routes transports and hands both props down', () => {
    renderTab('transports')
    const panel = screen.getByTestId('transports')
    expect(panel).toHaveAttribute('data-trip', '1')
    expect(panel).toHaveAttribute('data-tab', 'transports')
    expect(screen.queryByTestId('bookings')).not.toBeInTheDocument()
  })

  it('FE-MOB-TABPANEL-002: routes buchungen to the bookings panel', () => {
    renderTab('buchungen')
    expect(screen.getByTestId('bookings')).toBeInTheDocument()
  })

  it('FE-MOB-TABPANEL-003: routes finanzplan to the costs panel', () => {
    renderTab('finanzplan')
    expect(screen.getByTestId('costs')).toBeInTheDocument()
  })

  it('FE-MOB-TABPANEL-006: routes listen to the lists panel', () => {
    renderTab('listen')
    expect(screen.getByTestId('lists')).toBeInTheDocument()
  })

  it('FE-MOB-TABPANEL-010: an unbuilt tab falls back to the empty scroll body', () => {
    const { container } = renderTab('plan')
    expect(container.querySelector('[data-testid]')).toBeNull()
    const body = container.querySelector('.overflow-y-auto') as HTMLElement
    expect(body).not.toBeNull()
    expect(body).toBeEmptyDOMElement()
  })
})
