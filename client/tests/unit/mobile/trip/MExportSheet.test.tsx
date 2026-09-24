import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MExportSheet from '../../../../src/mobile/screens/trip/sheets/MExportSheet'
import { downloadTripPDF } from '../../../../src/components/PDF/TripPDF'
import { useTripStore } from '../../../../src/store/tripStore'
import type { Day, DayNote } from '../../../../src/types'
import { buildPlanner, buildShell } from '../../../helpers/mobileTrip'
import { resetAllStores, seedStore } from '../../../helpers/store'
import { fireEvent, render, screen, waitFor } from '../../../helpers/render'

// FE-MOB-EXPSH-001 to FE-MOB-EXPSH-007
// This sheet reads its copy from useTranslation(), so the assertions are English.

vi.mock('../../../../src/components/PDF/TripPDF', () => ({ downloadTripPDF: vi.fn() }))

const DAYS = [{ id: 2, trip_id: 1, day_number: 1, date: '2026-05-01', title: null }] as unknown as Day[]

const NOTES: Record<string, DayNote[]> = {
  '2': [{ id: 41, day_id: 2, text: 'Pack the day bag' }] as unknown as DayNote[],
  '3': [{ id: 42, day_id: 3, text: 'Return the keys' }] as unknown as DayNote[],
}

function renderSheet(plannerOverrides: Record<string, unknown> = {}, sheetId: string | null = 'export') {
  const planner = buildPlanner({ days: DAYS, ...plannerOverrides })
  const shell = buildShell({ sheet: sheetId ? { id: sheetId } : null })
  const view = render(<MExportSheet planner={planner} shell={shell} />)
  return { ...view, planner, shell }
}

describe('MExportSheet', () => {
  beforeEach(() => {
    resetAllStores()
    seedStore(useTripStore, { dayNotes: NOTES })
    vi.mocked(downloadTripPDF).mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('FE-MOB-EXPSH-001: stays closed while another sheet id is active', () => {
    renderSheet({}, 'mehr')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('FE-MOB-EXPSH-002: the PDF export is the only row — the hosted ICS/GPX/feed formats are cut', () => {
    renderSheet()
    expect(screen.getByRole('dialog', { name: 'Export' })).toBeInTheDocument()
    expect(screen.getByText('PDF')).toBeInTheDocument()
    expect(screen.getByText('Export day plan as PDF')).toBeInTheDocument()
    for (const label of ['Download .ics', 'Subscribe to calendar', 'Auto-updates in your calendar app']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('FE-MOB-EXPSH-003: hands the planner slices and the flattened day notes to the PDF export', async () => {
    const { planner } = renderSheet({
      places: [{ id: 9, name: 'Fushimi Inari' }],
      categories: [{ id: 3, name: 'Sights' }],
      reservations: [{ id: 4, title: 'Ryokan' }],
    })
    fireEvent.click(screen.getByText('PDF'))

    await waitFor(() => expect(downloadTripPDF).toHaveBeenCalledTimes(1))
    const arg = vi.mocked(downloadTripPDF).mock.calls[0][0]
    expect(arg.trip).toBe(planner.trip)
    expect(arg.days).toBe(planner.days)
    expect(arg.places).toBe(planner.places)
    // The raw store, not the hook's filtered list: the export applies the plan's
    // own predicate, and the switch travels with it.
    expect(arg.assignments).toBe(planner.storedAssignments)
    expect(arg.showServiceStops).toBe(true)
    expect(arg.reservations).toBe(planner.reservations)
    expect(arg.categories).toBe(planner.categories)
    // dayNotes come out of the store keyed by day, flattened with a numeric day_id.
    expect(arg.dayNotes).toEqual([
      { id: 41, day_id: 2, text: 'Pack the day bag' },
      { id: 42, day_id: 3, text: 'Return the keys' },
    ])
    expect(typeof arg.t).toBe('function')
  })

  it('FE-MOB-EXPSH-004: shows the busy label and refuses a second export while one runs', async () => {
    let release: () => void = () => {}
    vi.mocked(downloadTripPDF).mockImplementation(() => new Promise<void>(res => { release = () => res() }))
    renderSheet()

    fireEvent.click(screen.getByText('PDF'))
    const busy = await screen.findByText('Loading...')
    fireEvent.click(busy)
    expect(downloadTripPDF).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect(screen.getByText('PDF')).toBeInTheDocument())
  })

  it('FE-MOB-EXPSH-005: reports a failing PDF export with the underlying message', async () => {
    vi.mocked(downloadTripPDF).mockRejectedValue(new Error('font missing'))
    const { planner } = renderSheet()
    fireEvent.click(screen.getByText('PDF'))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('Failed to export PDF: font missing'))
    // The busy flag is released in the finally branch.
    expect(screen.getByText('PDF')).toBeInTheDocument()
  })

  it('FE-MOB-EXPSH-006: stringifies a non-Error rejection in the toast', async () => {
    vi.mocked(downloadTripPDF).mockRejectedValue('renderer gone')
    const { planner } = renderSheet()
    fireEvent.click(screen.getByText('PDF'))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('Failed to export PDF: renderer gone'))
  })

  it('FE-MOB-EXPSH-007: does not export without a loaded trip', () => {
    renderSheet({ trip: null })
    fireEvent.click(screen.getByText('PDF'))
    expect(downloadTripPDF).not.toHaveBeenCalled()
  })

  it('FE-MOB-EXPSH-013: the header close hands the dismissal back to the shell', () => {
    const { shell } = renderSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(shell.closeSheet).toHaveBeenCalledTimes(1)
  })
})
