// FE-PLANNER-DPTRANSPORT-001 to FE-PLANNER-DPTRANSPORT-019
import { render, screen, fireEvent } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { useSettingsStore } from '../../store/settingsStore'
import { buildReservation } from '../../../tests/helpers/factories'
import { DayPlanSidebarTransportDetailModal } from './DayPlanSidebarTransportDetailModal'
import type { Reservation } from '../../types'

// `t` arrives as a prop here, so echoing the key (plus its params) keeps the
// assertions independent of the translation catalogue.
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}|${Object.values(params).join('|')}` : key

function makeProps(overrides: Partial<React.ComponentProps<typeof DayPlanSidebarTransportDetailModal>> = {}) {
  return {
    transportDetail: null as Reservation | null,
    setTransportDetail: vi.fn(),
    onEdit: vi.fn(),
    t,
    locale: 'en-US',
    timeFormat: '24h',
    ...overrides,
  }
}

const flight = () => buildReservation({
  id: 41,
  type: 'flight',
  title: 'BER → CDG',
  status: 'confirmed',
  reservation_time: '2025-06-15T08:30:00',
  reservation_end_time: '2025-06-15T10:05:00',
  confirmation_number: 'XY7Z9Q',
  location: 'Terminal 1',
  metadata: JSON.stringify({
    airline: 'Air France', flight_number: 'AF1235',
    departure_airport: 'BER', arrival_airport: 'CDG', seat: '14A',
  }),
} as Partial<Reservation>)

beforeEach(() => {
  resetAllStores()
  vi.clearAllMocks()
  seedStore(useSettingsStore, { settings: { time_format: '24h', blur_booking_codes: false } })
})

describe('DayPlanSidebarTransportDetailModal', () => {
  it('FE-PLANNER-DPTRANSPORT-001: renders nothing without a reservation', () => {
    const { container } = render(<DayPlanSidebarTransportDetailModal {...makeProps()} />)
    expect(container).toBeEmptyDOMElement()
    expect(document.body.textContent).toBe('')
  })

  it('FE-PLANNER-DPTRANSPORT-002: shows the title, date and time range in the header', () => {
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight() })} />)
    expect(screen.getByText('BER → CDG')).toBeInTheDocument()
    expect(screen.getByText(/Jun 15.*08:30 – 10:05/)).toBeInTheDocument()
  })

  it('FE-PLANNER-DPTRANSPORT-003: a confirmed booking shows the confirmed badge', () => {
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight() })} />)
    expect(screen.getByText('planner.resConfirmed')).toBeInTheDocument()
    expect(screen.queryByText('planner.resPending')).not.toBeInTheDocument()
  })

  it('FE-PLANNER-DPTRANSPORT-004: a pending booking shows the pending badge', () => {
    const res = { ...flight(), status: 'pending' } as Reservation
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: res })} />)
    expect(screen.getByText('planner.resPending')).toBeInTheDocument()
  })

  it('FE-PLANNER-DPTRANSPORT-005: flight metadata renders airline, number, route and seat', () => {
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight() })} />)
    expect(screen.getByText('Air France')).toBeInTheDocument()
    expect(screen.getByText('AF1235')).toBeInTheDocument()
    expect(screen.getByText('BER')).toBeInTheDocument()
    expect(screen.getByText('CDG')).toBeInTheDocument()
    expect(screen.getByText('14A')).toBeInTheDocument()
    expect(screen.getByText('XY7Z9Q')).toBeInTheDocument()
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
  })

  it('FE-PLANNER-DPTRANSPORT-006: train metadata renders number, platform and seat', () => {
    const res = buildReservation({
      id: 42, type: 'train', title: 'ICE 599', status: 'confirmed',
      metadata: { train_number: 'ICE 599', platform: '7', seat: '31' },
    } as unknown as Partial<Reservation>)
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: res })} />)
    expect(screen.getByText('reservations.meta.trainNumber')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getByText('31')).toBeInTheDocument()
  })

  it('FE-PLANNER-DPTRANSPORT-007: a booking with no metadata and no codes renders no detail grid', () => {
    const res = buildReservation({ id: 43, type: 'other', title: 'Something', metadata: null } as Partial<Reservation>)
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: res })} />)
    expect(screen.getByText('Something')).toBeInTheDocument()
    expect(screen.queryByText('reservations.confirmationCode')).not.toBeInTheDocument()
  })

  it('FE-PLANNER-DPTRANSPORT-008: the confirmation code is blurred when the setting is on', () => {
    seedStore(useSettingsStore, { settings: { time_format: '24h', blur_booking_codes: true } })
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight() })} />)
    const code = screen.getByText('XY7Z9Q')
    expect(code).toHaveStyle({ filter: 'blur(5px)' })
    // The location is not sensitive, so it stays readable.
    expect(screen.getByText('Terminal 1')).toHaveStyle({ filter: 'none' })
  })

  it('FE-PLANNER-DPTRANSPORT-009: hovering and clicking a blurred code reveals and re-hides it', () => {
    seedStore(useSettingsStore, { settings: { time_format: '24h', blur_booking_codes: true } })
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight() })} />)
    const code = screen.getByText('XY7Z9Q')
    fireEvent.mouseEnter(code)
    expect(code.style.filter).toBe('none')
    fireEvent.mouseLeave(code)
    expect(code.style.filter).toBe('blur(5px)')
    fireEvent.click(code)
    expect(code.style.filter).toBe('none')
    fireEvent.click(code)
    expect(code.style.filter).toBe('blur(5px)')
  })

  it('FE-PLANNER-DPTRANSPORT-010: an unblurred field ignores hover and click', () => {
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight() })} />)
    const code = screen.getByText('XY7Z9Q')
    fireEvent.mouseEnter(code)
    fireEvent.click(code)
    expect(code.style.filter).toBe('none')
  })

  it('FE-PLANNER-DPTRANSPORT-013: notes render as markdown', () => {
    const res = { ...flight(), notes: 'Bring **passport**' } as Reservation
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: res })} />)
    expect(screen.getByText('reservations.notes')).toBeInTheDocument()
    expect(screen.getByText('passport').tagName).toBe('STRONG')
  })

  it('FE-PLANNER-DPTRANSPORT-016: the edit action hands the reservation back to the caller', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const res = flight()
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: res, onEdit })} />)
    await user.click(screen.getByRole('button', { name: /common\.edit/ }))
    expect(onEdit).toHaveBeenCalledWith(res)
  })

  it('FE-PLANNER-DPTRANSPORT-017: without onEdit only the close action is offered', async () => {
    const user = userEvent.setup()
    const setTransportDetail = vi.fn()
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight(), onEdit: undefined, setTransportDetail })} />)
    expect(screen.queryByRole('button', { name: /common\.edit/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'common.close' }))
    expect(setTransportDetail).toHaveBeenCalledWith(null)
  })

  it('FE-PLANNER-DPTRANSPORT-019: a segment with its own booking code gets its own blurred field (#1943)', () => {
    seedStore(useSettingsStore, { settings: { time_format: '24h', blur_booking_codes: true } })
    const res = buildReservation({
      id: 42, type: 'flight', title: 'BER → CDG → JFK', status: 'confirmed',
      reservation_time: '2025-06-15T08:30:00',
      confirmation_number: 'XY7Z9Q',
      metadata: JSON.stringify({
        legs: [
          { from: 'BER', to: 'CDG', confirmation_number: 'ABC123' },
          { from: 'CDG', to: 'JFK' },
        ],
      }),
    } as Partial<Reservation>)
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: res })} />)

    expect(screen.getByText('BER → CDG')).toBeInTheDocument()
    expect(screen.getByText('ABC123')).toHaveStyle({ filter: 'blur(5px)' })
    // The booking's own reference keeps its own field, a code-less segment adds none.
    expect(screen.getByText('XY7Z9Q')).toBeInTheDocument()
    expect(screen.queryByText('CDG → JFK')).not.toBeInTheDocument()
  })

  it('FE-PLANNER-DPTRANSPORT-018: clicking the backdrop closes, clicking the card does not', async () => {
    const user = userEvent.setup()
    const setTransportDetail = vi.fn()
    render(<DayPlanSidebarTransportDetailModal {...makeProps({ transportDetail: flight(), setTransportDetail })} />)
    const card = screen.getByText('BER → CDG').closest('div.bg-surface-card')!
    await user.click(card)
    expect(setTransportDetail).not.toHaveBeenCalled()
    await user.click(card.parentElement!)
    expect(setTransportDetail).toHaveBeenCalledWith(null)
  })
})
