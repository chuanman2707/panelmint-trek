// FE-PLANNER-EXPORTMODAL-001 to FE-PLANNER-EXPORTMODAL-006
import { render, screen, waitFor } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { downloadTripPDF } from '../PDF/TripPDF'
import { buildDay, buildDayNote, buildTrip } from '../../../tests/helpers/factories'
import { TripExportModal } from './TripExportModal'

vi.mock('../PDF/TripPDF', () => ({ downloadTripPDF: vi.fn().mockResolvedValue(undefined) }))

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}|${Object.values(params).join('|')}` : key

const trip = buildTrip({ id: 1, title: 'Roadtrip' })

function makeToast() {
  return {
    success: vi.fn((_m: string) => {}),
    error: vi.fn((_m: string) => {}),
    warning: vi.fn((_m: string) => {}),
    info: vi.fn((_m: string) => {}),
  }
}

function makeProps(overrides: Partial<React.ComponentProps<typeof TripExportModal>> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    tripId: 1,
    trip,
    days: [],
    places: [],
    categories: [],
    assignments: {},
    reservations: [],
    dayNotes: {},
    t,
    locale: 'en-US',
    toast: makeToast(),
    ...overrides,
  } as React.ComponentProps<typeof TripExportModal>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TripExportModal', () => {
  it('FE-PLANNER-EXPORTMODAL-001: closed, it renders nothing', () => {
    render(<TripExportModal {...makeProps({ isOpen: false })} />)
    expect(screen.queryByText('dayplan.export')).not.toBeInTheDocument()
  })

  it('FE-PLANNER-EXPORTMODAL-002: open, the PDF export is the only section — the hosted ICS/GPX/feed formats are cut', () => {
    render(<TripExportModal {...makeProps()} />)
    expect(screen.getByText('dayplan.exportDocument')).toBeInTheDocument()
    expect(screen.getByText('dayplan.pdf')).toBeInTheDocument()
    for (const label of ['dayplan.exportCalendar', 'mobileTrip.icsDownload', 'mobileTrip.icsSubscribe',
      'dayplan.gpxAll', 'dayplan.gpxPlaces', 'dayplan.gpxDays']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('FE-PLANNER-EXPORTMODAL-003: the PDF row exports the trip with the day notes flattened', async () => {
    const user = userEvent.setup()
    const days = [buildDay({ id: 10, title: 'Day 1' })]
    const dayNotes = { '10': [buildDayNote({ id: 1, text: 'Bring cash' })] }
    render(<TripExportModal {...makeProps({ days, dayNotes })} />)
    await user.click(screen.getByText('dayplan.pdf'))
    await waitFor(() => expect(downloadTripPDF).toHaveBeenCalledTimes(1))
    expect(vi.mocked(downloadTripPDF).mock.calls[0][0]).toMatchObject({
      trip, days, showServiceStops: true,
      dayNotes: [expect.objectContaining({ id: 1, text: 'Bring cash', day_id: 10 })],
    })
  })

  it('FE-PLANNER-EXPORTMODAL-004: a finished PDF export closes the dialog', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<TripExportModal {...makeProps({ onClose })} />)
    await user.click(screen.getByText('dayplan.pdf'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('FE-PLANNER-EXPORTMODAL-005: a failing PDF export toasts the error and keeps the dialog open', async () => {
    const user = userEvent.setup()
    vi.mocked(downloadTripPDF).mockRejectedValueOnce(new Error('font missing'))
    const toast = makeToast()
    const onClose = vi.fn()
    render(<TripExportModal {...makeProps({ toast, onClose })} />)
    await user.click(screen.getByText('dayplan.pdf'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('dayplan.pdfError: font missing'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('FE-PLANNER-EXPORTMODAL-006: an aborted PDF export without an Error still reaches the toast', async () => {
    const user = userEvent.setup()
    vi.mocked(downloadTripPDF).mockRejectedValueOnce('boom')
    const toast = makeToast()
    render(<TripExportModal {...makeProps({ toast })} />)
    await user.click(screen.getByText('dayplan.pdf'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('dayplan.pdfError: boom'))
  })
})
