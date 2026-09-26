// FE-PLANNER-EXPORTMODAL-001 to FE-PLANNER-EXPORTMODAL-003
import { render, screen, waitFor } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { TripExportModal } from './TripExportModal'

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

  it('FE-PLANNER-EXPORTMODAL-002: open, the export-file stub is the only row — the hosted formats and the PDF are cut', () => {
    render(<TripExportModal {...makeProps()} />)
    expect(screen.getByText('dayplan.exportDocument')).toBeInTheDocument()
    expect(screen.getByText('dayplan.exportFile')).toBeInTheDocument()
    for (const label of ['dayplan.pdf', 'dayplan.exportCalendar', 'mobileTrip.icsDownload', 'mobileTrip.icsSubscribe',
      'dayplan.gpxAll', 'dayplan.gpxPlaces', 'dayplan.gpxDays']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('FE-PLANNER-EXPORTMODAL-003: the file row is a stub until the Phase C codec lands — it explains instead of exporting', async () => {
    const user = userEvent.setup()
    const toast = makeToast()
    render(<TripExportModal {...makeProps({ toast })} />)
    await user.click(screen.getByText('dayplan.exportFile'))
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('dayplan.exportFileTooltip'))
  })
})
