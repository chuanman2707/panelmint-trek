// FE-PLANNER-EXPORTMODAL-001 to FE-PLANNER-EXPORTMODAL-004
import { render, screen, waitFor } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { TripExportModal } from './TripExportModal'
import { downloadTripFile } from '../../share/actions'

vi.mock('../../share/actions', () => ({
  downloadTripFile: vi.fn(async () => {}),
}))

const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}|${Object.values(params).join('|')}` : key

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
    tripTitle: 'Summer',
    t,
    toast: makeToast(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TripExportModal', () => {
  it('FE-PLANNER-EXPORTMODAL-001: closed, it renders nothing', () => {
    render(<TripExportModal {...makeProps({ isOpen: false })} />)
    expect(screen.queryByText('dayplan.export')).not.toBeInTheDocument()
  })

  it('FE-PLANNER-EXPORTMODAL-002: open, the export-file row is the only one — the hosted formats and the PDF are cut', () => {
    render(<TripExportModal {...makeProps()} />)
    expect(screen.getByText('dayplan.exportDocument')).toBeInTheDocument()
    expect(screen.getByText('dayplan.exportFile')).toBeInTheDocument()
    for (const label of ['dayplan.pdf', 'dayplan.exportCalendar', 'mobileTrip.icsDownload', 'mobileTrip.icsSubscribe',
      'dayplan.gpxAll', 'dayplan.gpxPlaces', 'dayplan.gpxDays']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('FE-PLANNER-EXPORTMODAL-003: the file row runs the codec export, toasts and closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const toast = makeToast()
    render(<TripExportModal {...makeProps({ toast, onClose, tripId: 7, tripTitle: 'Road' })} />)
    await user.click(screen.getByText('dayplan.exportFile'))
    await waitFor(() => expect(downloadTripFile).toHaveBeenCalledWith(7, 'Road'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('dayplan.exportFileDone'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('FE-PLANNER-EXPORTMODAL-004: a failed export toasts the error and stays open', async () => {
    vi.mocked(downloadTripFile).mockRejectedValueOnce(new Error('boom'))
    const user = userEvent.setup()
    const onClose = vi.fn()
    const toast = makeToast()
    render(<TripExportModal {...makeProps({ toast, onClose })} />)
    await user.click(screen.getByText('dayplan.exportFile'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'))
    expect(onClose).not.toHaveBeenCalled()
  })
})
