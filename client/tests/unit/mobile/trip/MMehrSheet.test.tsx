import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderOpen } from 'lucide-react'
import MMehrSheet from '../../../../src/mobile/screens/trip/sheets/MMehrSheet'
import type { MTripShellApi, TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import type { TripMember } from '../../../../src/types'
import { buildPlanner, buildShell } from '../../../helpers/mobileTrip'
import { resetAllStores } from '../../../helpers/store'
import { fireEvent, render, screen, within } from '../../../helpers/render'

// FE-MOB-MEHR-001 to FE-MOB-MEHR-014
//
// The sheet takes its copy from the real TranslationProvider, so the visible
// strings are asserted in English.

const TABS = [
  { id: 'plan', label: 'Plan', icon: FolderOpen },
  { id: 'transports', label: 'Transport', icon: FolderOpen },
  { id: 'buchungen', label: 'Bookings', icon: FolderOpen },
  { id: 'finanzplan', label: 'Budget', icon: FolderOpen },
  { id: 'listen', label: 'Lists', icon: FolderOpen },
]

/** A section outside the dock priority — exercises the generic overflow path. */
const EXTRA = { id: 'extra', label: 'Extra', icon: FolderOpen }

const MEMBERS = [
  { user_id: 1, username: 'maurice', role: 'owner' },
  { user_id: 2, username: 'julien', role: 'editor' },
  { user_id: 3, username: 'guest', role: 'viewer' },
] as unknown as TripMember[]

function renderSheet(plannerOverrides: Partial<TripPlanner> = {}, shellOverrides: Partial<MTripShellApi> = {}) {
  const planner = buildPlanner({
    TRIP_TABS: TABS as TripPlanner['TRIP_TABS'],
    tripMembers: MEMBERS,
    ...plannerOverrides,
  })
  const shell = buildShell({ sheet: { id: 'mehr' }, ...shellOverrides })
  render(<MMehrSheet planner={planner} shell={shell} />)
  return { planner, shell }
}

describe('MMehrSheet', () => {
  beforeEach(() => {
    resetAllStores()
  })

  it('FE-MOB-MEHR-001: stays closed while another sheet id is active', () => {
    renderSheet({}, { sheet: { id: 'days' } })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('FE-MOB-MEHR-002: opens as the "More" panel', () => {
    renderSheet()
    expect(screen.getByRole('dialog', { name: 'More' })).toBeInTheDocument()
  })

  it('FE-MOB-MEHR-003: only tiles the sections that are not in the dock', () => {
    renderSheet({ TRIP_TABS: [...TABS, EXTRA] as TripPlanner['TRIP_TABS'] })
    expect(screen.getByRole('button', { name: /Extra/ })).toBeInTheDocument()
    for (const dockLabel of ['Plan', 'Transport', 'Bookings', 'Budget', 'Lists']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${dockLabel}`) })).not.toBeInTheDocument()
    }
  })

  it('FE-MOB-MEHR-006: an overflow tile gets the neutral tint and no stat line', () => {
    renderSheet({
      TRIP_TABS: [...TABS, { id: 'todos', label: 'Trip To-Dos', icon: FolderOpen }] as TripPlanner['TRIP_TABS'],
    })
    const tile = screen.getByRole('button', { name: /Trip To-Dos/ })
    expect(tile.textContent).toBe('Trip To-Dos')
    expect(tile.querySelector('[style]')).toHaveStyle({ color: '#68686F' })
  })

  it('FE-MOB-MEHR-007: survives a tab entry without an icon component', () => {
    renderSheet({ TRIP_TABS: [{ id: 'bare', label: 'Bare Section', icon: undefined }] as unknown as TripPlanner['TRIP_TABS'] })
    const tile = screen.getByRole('button', { name: 'Bare Section' })
    expect(tile.querySelector('svg')).toBeNull()
  })

  it('FE-MOB-MEHR-008: opening a section closes the sheet and switches the trip tab', () => {
    const { shell } = renderSheet({ TRIP_TABS: [...TABS, EXTRA] as TripPlanner['TRIP_TABS'] })
    fireEvent.click(screen.getByRole('button', { name: /Extra/ }))
    expect(shell.closeSheet).toHaveBeenCalledTimes(1)
    expect(shell.setTrTab).toHaveBeenCalledWith('extra')
  })

  it('FE-MOB-MEHR-009: the action rows open the export and edit sheets', () => {
    // The share row went with the hosted members sheet — export and edit remain.
    const { shell } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Trip' }))
    expect(shell.openSheet).toHaveBeenNthCalledWith(1, 'export')
    expect(shell.openSheet).toHaveBeenNthCalledWith(2, 'tripedit')
  })

  it('FE-MOB-MEHR-010: drops the edit row without the trip_edit permission', () => {
    const { planner } = renderSheet({ can: vi.fn(() => false) })
    expect(planner.can).toHaveBeenCalledWith('trip_edit', planner.trip)
    expect(screen.queryByRole('button', { name: 'Edit Trip' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
  })

  it('FE-MOB-MEHR-011: renders only the action rows when every section sits in the dock', () => {
    renderSheet()
    const rows = screen.getByRole('button', { name: 'Export' }).parentElement
    expect(rows).not.toHaveClass('mt-2')
  })

  it('FE-MOB-MEHR-012: separates the action rows from the tile grid when both are present', () => {
    renderSheet({ TRIP_TABS: [...TABS, EXTRA] as TripPlanner['TRIP_TABS'] })
    const rows = screen.getByRole('button', { name: 'Export' }).parentElement
    expect(rows).toHaveClass('mt-2')
  })

  // Both sides read the same priority list (dockTabs.ts). They used to be two
  // hand-kept copies, and extending only one showed the same section in the dock AND
  // as a tile here.
  describe('the dock overflow', () => {
    it('FE-MOB-MEHR-013: a section outside the dock priority lands here', () => {
      renderSheet({ TRIP_TABS: [...TABS, EXTRA] as TripPlanner['TRIP_TABS'] })

      // The five dockable sections all get a seat; the extra one overflows.
      expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument()
      for (const dockLabel of ['Plan', 'Transport', 'Bookings', 'Budget', 'Lists']) {
        expect(screen.queryByRole('button', { name: new RegExp(`^${dockLabel}`) })).not.toBeInTheDocument()
      }
      // Exactly the one the dock could not seat, nothing shown twice.
      const grid = screen.getByRole('button', { name: 'Extra' }).parentElement
      expect(within(grid as HTMLElement).getAllByRole('button')).toHaveLength(1)
    })

    it('FE-MOB-MEHR-014: a dock with room seats every enabled section', () => {
      renderSheet({
        TRIP_TABS: TABS.filter(tab => tab.id !== 'finanzplan') as TripPlanner['TRIP_TABS'],
      })

      // Four sections fit beside the More button, so nothing overflows and the
      // sheet is the action rows alone.
      expect(screen.queryByRole('button', { name: 'Lists' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Export' }).parentElement).not.toHaveClass('mt-2')
    })
  })
})
