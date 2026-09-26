import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { BookingExpenseRequest } from '../../../../src/components/Planner/BookingCostsSection.types'
import type { ExpensePrefill } from '../../../../src/components/Budget/CostsPanel'
import type { MTripShellApi, TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import type { BudgetItem, Trip } from '../../../../src/types'
import { useAuthStore } from '../../../../src/store/authStore'
import { useSettingsStore } from '../../../../src/store/settingsStore'
import { useTripStore } from '../../../../src/store/tripStore'
import { buildPlanner, buildShell } from '../../../helpers/mobileTrip'
import { resetAllStores, seedStore } from '../../../helpers/store'
import { fireEvent, render, screen, waitFor } from '../../../helpers/render'

// FE-MOB-SHOST-001 to FE-MOB-SHOST-029
//
// Every child sheet is stubbed: this file is about the host — which sheet is
// mounted for which shell.sheet id, and how the host's own callbacks wire the
// planner, the trip store and the booking-linked expense editor together.

interface StubProps { shell: MTripShellApi; planner: TripPlanner }

/** Sheets that route on shell.sheet themselves — the stub reports what it saw. */
function selfRouted(testid: string) {
  return ({ planner, shell }: StubProps) => (
    <div data-testid={testid} data-sheet={shell.sheet?.id ?? 'none'} data-trip={planner.tripId} />
  )
}

vi.mock('../../../../src/mobile/screens/trip/sheets/MPlaceSheet', () => ({ default: selfRouted('stub-place') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MDaySheet', () => ({ default: selfRouted('stub-day') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MDaysSheet', () => ({ default: selfRouted('stub-days') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MAccommodationSheet', () => ({ default: selfRouted('stub-accommodation') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MTransportSheet', () => ({ default: selfRouted('stub-transport') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MBrowseActionsSheet', () => ({ default: selfRouted('stub-bract') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MMehrSheet', () => ({ default: selfRouted('stub-mehr') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MExportSheet', () => ({ default: selfRouted('stub-export') }))
vi.mock('../../../../src/mobile/screens/trip/sheets/MNoteSheet', () => ({
  default: ({ open, payload, onClose }: { open: boolean; payload?: { dayId?: number }; onClose: () => void }) => (
    <div data-testid="stub-note" data-open={String(open)} data-day={payload?.dayId ?? 'none'}>
      <button type="button" onClick={onClose}>close note</button>
    </div>
  ),
}))

vi.mock('../../../../src/mobile/screens/trip/sheets/MPlaceEditSheet', () => ({
  default: ({ planner }: StubProps) => <div data-testid="stub-placeedit" data-trip={planner.tripId} />,
}))

vi.mock('../../../../src/mobile/screens/trip/sheets/MReservationSheet', () => ({
  default: ({ onOpenExpense }: { onOpenExpense: (req: BookingExpenseRequest) => void }) => (
    <div data-testid="stub-reservation">
      <button type="button" onClick={() => onOpenExpense({ editItem: { id: 99, name: 'Ticket' } as BudgetItem })}>
        expense edit
      </button>
      <button type="button" onClick={() => onOpenExpense({})}>expense noop</button>
    </div>
  ),
}))

vi.mock('../../../../src/mobile/screens/trip/sheets/MTransportFormSheet', () => ({
  default: ({ onOpenExpense }: { onOpenExpense: (req: BookingExpenseRequest) => void }) => (
    <div data-testid="stub-transportform">
      <button type="button" onClick={() => onOpenExpense({ prefill: { name: 'Shinkansen', amount: 120 } })}>
        expense prefill
      </button>
    </div>
  ),
}))

vi.mock('../../../../src/mobile/screens/trip/sheets/MCostSheet', () => ({
  default: ({ tripId, base, me, editing, prefill, onClose, onSaved }: {
    tripId: number; base: string; me: number
    editing: BudgetItem | null; prefill?: ExpensePrefill
    onClose: () => void; onSaved: () => void
  }) => (
    <div
      data-testid="stub-cost"
      data-trip={tripId}
      data-base={base}
      data-me={me}
      data-editing={editing?.id ?? 'none'}
      data-prefill={prefill?.name ?? 'none'}
    >
      <button type="button" onClick={onClose}>close cost</button>
      <button type="button" onClick={onSaved}>save cost</button>
    </div>
  ),
}))

vi.mock('../../../../src/mobile/screens/settings/MConfirmSheet', () => ({
  default: ({ open, title, message, onClose, onConfirm }: {
    open: boolean; title: string; message: ReactNode; onClose: () => void; onConfirm?: () => void
  }) =>
    open ? (
      <div data-testid="stub-confirm" data-title={title}>
        <span>{message}</span>
        <button type="button" onClick={onConfirm}>confirm delete</button>
        <button type="button" onClick={onClose}>cancel delete</button>
      </div>
    ) : null,
}))

vi.mock('../../../../src/components/Trips/TripFormModal', () => ({
  default: ({ isOpen, onClose, onSave, trip }: {
    isOpen: boolean; onClose: () => void
    onSave: (data: Record<string, unknown>) => Promise<void>
    trip?: Trip | null
  }) => (
    <div data-testid="stub-tripform" data-open={String(isOpen)} data-title={trip?.title ?? 'none'}>
      <button type="button" onClick={() => void onSave({ title: 'Japan 2027' })}>save trip</button>
      <button type="button" onClick={onClose}>close trip form</button>
    </div>
  ),
}))

import MTripSheets from '../../../../src/mobile/screens/trip/sheets/MTripSheets'

function renderHost(plannerOverrides: Partial<TripPlanner> = {}, shellOverrides: Partial<MTripShellApi> = {}) {
  const planner = buildPlanner(plannerOverrides)
  const shell = buildShell(shellOverrides)
  render(<MTripSheets planner={planner} shell={shell} />)
  return { planner, shell }
}

describe('MTripSheets', () => {
  beforeEach(() => {
    resetAllStores()
    seedStore(useAuthStore, { user: { id: 7, username: 'maurice', email: 'm@example.com' } })
  })

  it('FE-MOB-SHOST-001: mounts every sheet of the host with the same planner and shell', () => {
    renderHost({}, { sheet: null })
    for (const id of ['stub-place', 'stub-day', 'stub-days', 'stub-accommodation', 'stub-transport',
      'stub-bract', 'stub-mehr', 'stub-export', 'stub-note', 'stub-placeedit',
      'stub-reservation', 'stub-transportform', 'stub-tripform']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByTestId('stub-day')).toHaveAttribute('data-sheet', 'none')
    expect(screen.getByTestId('stub-placeedit')).toHaveAttribute('data-trip', '1')
  })

  it.each([
    ['day', 'stub-day'],
    ['days', 'stub-days'],
    ['accommodation', 'stub-accommodation'],
    ['transport', 'stub-transport'],
    ['bract', 'stub-bract'],
    ['mehr', 'stub-mehr'],
    ['export', 'stub-export'],
  ])('FE-MOB-SHOST-002: forwards the "%s" sheet id to %s', (id, testid) => {
    renderHost({}, { sheet: { id } })
    expect(screen.getByTestId(testid)).toHaveAttribute('data-sheet', id)
  })

  it.each([
    ['note', 'stub-note'],
    ['tripedit', 'stub-tripform'],
  ])('FE-MOB-SHOST-003: opens only %s for its own id', (id, testid) => {
    renderHost({}, { sheet: { id } })
    const hostRouted = ['stub-note', 'stub-tripform']
    for (const other of hostRouted) {
      expect(screen.getByTestId(other)).toHaveAttribute('data-open', String(other === testid))
    }
  })

  it('FE-MOB-SHOST-004: hands the note payload to the note sheet and only for that id', () => {
    renderHost({}, { sheet: { id: 'note', payload: { dayId: 4 } } })
    expect(screen.getByTestId('stub-note')).toHaveAttribute('data-day', '4')
  })

  it('FE-MOB-SHOST-005: withholds the payload while a different sheet is open', () => {
    renderHost({}, { sheet: { id: 'day', payload: { dayId: 4 } } })
    expect(screen.getByTestId('stub-note')).toHaveAttribute('data-day', 'none')
  })

  it('FE-MOB-SHOST-006: the note sheet closes through the shell', () => {
    const { shell } = renderHost({}, { sheet: { id: 'note' } })
    fireEvent.click(screen.getByText('close note'))
    expect(shell.closeSheet).toHaveBeenCalledTimes(1)
  })

  it('FE-MOB-SHOST-007: saving the trip form updates the trip and toasts', async () => {
    const { planner } = renderHost({}, { sheet: { id: 'tripedit' } })
    fireEvent.click(screen.getByText('save trip'))
    await waitFor(() => expect(planner.tripActions.updateTrip).toHaveBeenCalledWith(1, { title: 'Japan 2027' }))
    expect(planner.toast.success).toHaveBeenCalledWith('trip.toast.tripUpdated')
  })



  it('FE-MOB-SHOST-010: the trip form closes through the shell', () => {
    const { shell } = renderHost({}, { sheet: { id: 'tripedit' } })
    fireEvent.click(screen.getByText('close trip form'))
    expect(shell.closeSheet).toHaveBeenCalledTimes(1)
  })



  it('FE-MOB-SHOST-020: a booking opens the expense editor for its linked item and closes again', () => {
    renderHost()
    expect(screen.queryByTestId('stub-cost')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('expense noop'))
    expect(screen.queryByTestId('stub-cost')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('expense edit'))
    const cost = screen.getByTestId('stub-cost')
    expect(cost).toHaveAttribute('data-editing', '99')
    expect(cost).toHaveAttribute('data-prefill', 'none')
    expect(cost).toHaveAttribute('data-me', '7')
    expect(cost).toHaveAttribute('data-trip', '1')

    fireEvent.click(screen.getByText('close cost'))
    expect(screen.queryByTestId('stub-cost')).not.toBeInTheDocument()
  })

  it('FE-MOB-SHOST-021: a transport prefill opens a new expense and reloads the budget on save', () => {
    const loadBudgetItems = vi.fn()
    seedStore(useTripStore, { loadBudgetItems })
    renderHost()
    fireEvent.click(screen.getByText('expense prefill'))
    const cost = screen.getByTestId('stub-cost')
    expect(cost).toHaveAttribute('data-editing', 'none')
    expect(cost).toHaveAttribute('data-prefill', 'Shinkansen')

    fireEvent.click(screen.getByText('save cost'))
    expect(loadBudgetItems).toHaveBeenCalledWith(1)
    expect(screen.queryByTestId('stub-cost')).not.toBeInTheDocument()
  })

  it('FE-MOB-SHOST-022: the expense base currency prefers the display setting, then the trip', () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'jpy' } })
    renderHost()
    fireEvent.click(screen.getByText('expense edit'))
    expect(screen.getByTestId('stub-cost')).toHaveAttribute('data-base', 'JPY')
  })

  it('FE-MOB-SHOST-023: falls back to the trip currency and finally to EUR', () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: '' } })
    const { planner } = renderHost()
    fireEvent.click(screen.getByText('expense edit'))
    expect(screen.getByTestId('stub-cost')).toHaveAttribute('data-base', 'EUR')

    const noCurrency = { ...planner.trip, currency: '' } as unknown as Trip
    render(<MTripSheets planner={buildPlanner({ trip: noCurrency })} shell={buildShell()} />)
    fireEvent.click(screen.getAllByText('expense edit')[1])
    expect(screen.getAllByTestId('stub-cost')[1]).toHaveAttribute('data-base', 'EUR')
  })

  it('FE-MOB-SHOST-024: an anonymous session pays as user -1', () => {
    seedStore(useAuthStore, { user: null })
    renderHost()
    fireEvent.click(screen.getByText('expense edit'))
    expect(screen.getByTestId('stub-cost')).toHaveAttribute('data-me', '-1')
  })

  it('FE-MOB-SHOST-025: the delete-place confirm runs the planner confirmation and disarms', () => {
    const { planner } = renderHost({ deletePlaceId: 101 })
    expect(screen.getByTestId('stub-confirm')).toHaveAttribute('data-title', 'common.delete')
    expect(screen.getByText('trip.confirm.deletePlace')).toBeInTheDocument()

    fireEvent.click(screen.getByText('confirm delete'))
    expect(planner.confirmDeletePlace).toHaveBeenCalledTimes(1)
    expect(planner.setDeletePlaceId).toHaveBeenCalledWith(null)
  })

  it('FE-MOB-SHOST-029: a night booked at the place is said before the yes, and only then', () => {
    // The server takes the night down with the place, and the booking and the
    // expense with the night. The planner builds the sentence; the sheet has to
    // show it under the question.
    const note = 'The booking at Hotel Okura and its expense go with it.'
    renderHost({ deletePlaceId: 101, deletePlaceNote: note })

    const confirm = screen.getByTestId('stub-confirm')
    expect(confirm).toHaveTextContent('trip.confirm.deletePlace')
    expect(screen.getByText(note)).toBeInTheDocument()
  })

  it('FE-MOB-SHOST-026: cancelling the confirm only disarms the flag', () => {
    const { planner } = renderHost({ deletePlaceId: 101 })
    fireEvent.click(screen.getByText('cancel delete'))
    expect(planner.confirmDeletePlace).not.toHaveBeenCalled()
    expect(planner.setDeletePlaceId).toHaveBeenCalledWith(null)
  })

  it('FE-MOB-SHOST-027: the place edit sheet owns the confirm while its own form is open', () => {
    renderHost({ deletePlaceId: 101, showPlaceForm: true })
    expect(screen.queryByTestId('stub-confirm')).not.toBeInTheDocument()
  })

})
