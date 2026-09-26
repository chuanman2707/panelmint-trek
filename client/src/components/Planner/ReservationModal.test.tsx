// FE-PLANNER-RESMODAL-001 to FE-PLANNER-RESMODAL-095
import 'fake-indexeddb/auto';
import { render, screen, waitFor, fireEvent, within } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { useAddonStore } from '../../store/addonStore';
import { db } from '../../db/panelmintDb';
import { reservationsApi, budgetApi } from '../../api/client';
import { LocalApiError } from '../../api/local/helpers';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import {
  buildUser,
  buildTrip,
  buildDay,
  buildPlace,
  buildAssignment,
  buildReservation,
} from '../../../tests/helpers/factories';
import { ReservationModal } from './ReservationModal';

import type { TripMember } from '../Budget/BudgetPanelMemberChips';

// Mock react-router useParams
vi.mock('react-router', async (importActual) => {
  const actual = await importActual<typeof import('react-router')>();
  return { ...actual, useParams: () => ({ id: '1' }) };
});

// Mock CustomDatePicker as a simple text input
vi.mock('../shared/CustomDateTimePicker', () => ({
  CustomDatePicker: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <input
      data-testid="date-picker"
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder ?? 'YYYY-MM-DD'}
    />
  ),
}));

// Mock CustomTimePicker as a simple text input
vi.mock('../shared/CustomTimePicker', () => ({
  default: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <input
      data-testid="time-picker"
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder ?? '00:00'}
    />
  ),
}));

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSave: vi.fn().mockResolvedValue(undefined),
  reservation: null,
  days: [],
  places: [],
  assignments: {},
  selectedDayId: null,
  accommodations: [],
};

beforeEach(async () => {
  resetAllStores();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }), budgetItems: [] });
  // addonStore: budget addon disabled
  vi.clearAllMocks();
  // setReservationTravelers runs the local adapter — seed the trip the
  // assignable roster reads (owner via trips.user_id covers alice/id 1).
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  await db.trips.put(buildTrip({ id: 1 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReservationModal', () => {
  // ── Rendering ──────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-001: renders without crashing', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-002: shows "New Reservation" title for new reservation', () => {
    render(<ReservationModal {...defaultProps} reservation={null} />);
    expect(screen.getByText(/New Reservation/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-003: shows "Edit Reservation" title when editing', () => {
    const res = buildReservation({ title: 'Nice Dinner', type: 'restaurant' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByText(/Edit Reservation/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-004: title input is required — onSave not called with empty title', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    const submitBtn = screen.getByRole('button', { name: /^Add$/i });
    await userEvent.click(submitBtn);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-PLANNER-RESMODAL-005: all 5 type buttons are visible (transport types removed)', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Accommodation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restaurant/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Event/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tour/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Other/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Flight$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Train$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Car$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cruise$/i })).not.toBeInTheDocument();
  });

  // ── Type selection ──────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-006: clicking Event type button activates it', async () => {
    render(<ReservationModal {...defaultProps} />);
    const eventBtn = screen.getByRole('button', { name: /Event/i });
    await userEvent.click(eventBtn);
    expect(eventBtn).toHaveClass('bg-[var(--text-primary)]');
  });

  it('FE-PLANNER-RESMODAL-008: hotel type shows check-in/check-out time fields', async () => {
    render(<ReservationModal {...defaultProps} />);
    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    const checkInLabels = screen.getAllByText(/Check-in/i);
    expect(checkInLabels.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Check-out/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-009: restaurant type shows location field', async () => {
    render(<ReservationModal {...defaultProps} />);
    await userEvent.click(screen.getByRole('button', { name: /Restaurant/i }));
    expect(screen.getByPlaceholderText(/Address, Airport/i)).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-010: hotel type hides assignment picker', async () => {
    const day = buildDay({ id: 1, title: 'Day 1' });
    const place = buildPlace({ name: 'Museum' });
    const assignment = buildAssignment({ id: 99, day_id: 1, place });
    render(
      <ReservationModal
        {...defaultProps}
        days={[day]}
        assignments={{ '1': [assignment] }}
      />
    );
    // Switch to hotel type
    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    expect(screen.queryByText(/Link to day assignment/i)).not.toBeInTheDocument();
  });

  // ── Form population from existing reservation ──────────────────────────────

  it('FE-PLANNER-RESMODAL-011: editing pre-fills title', () => {
    const res = buildReservation({ title: 'Paris Hotel', type: 'hotel', status: 'confirmed' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('Paris Hotel')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-012: editing pre-fills confirmation number', () => {
    const res = buildReservation({ confirmation_number: 'XYZ123' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('XYZ123')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-013: editing pre-fills notes', () => {
    const res = buildReservation({ notes: 'Breakfast included' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('Breakfast included')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-014: editing pre-fills type — restaurant type shows location field', () => {
    const res = buildReservation({ type: 'restaurant', location: 'Via Roma 1' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByDisplayValue('Via Roma 1')).toBeInTheDocument();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-015: end datetime before start shows error and blocks submit', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const addToast = vi.fn();
    window.__addToast = addToast;

    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    // Fill in the title
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'My Flight');

    // Set start date/time via the date-picker inputs (mocked as text inputs)
    // reservation_time is rendered as two separate pickers: date part and time part
    const datePickers = screen.getAllByTestId('date-picker');
    const timePickers = screen.getAllByTestId('time-picker');

    // First date picker = start date, second = end date
    fireEvent.change(datePickers[0], { target: { value: '2025-06-10' } });
    fireEvent.change(timePickers[0], { target: { value: '10:00' } });
    // End date before start date
    fireEvent.change(datePickers[1], { target: { value: '2025-06-09' } });
    fireEvent.change(timePickers[1], { target: { value: '09:00' } });

    // When isEndBeforeStart=true the submit button is disabled, so fire submit on the form directly.
    // The Save button now lives in the Modal's sticky footer (outside the <form>), so we query
    // the form by tag instead of walking up from the button.
    const form = document.querySelector('form')!;
    fireEvent.submit(form);

    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      expect.stringMatching(/End date\/time must be after start/i),
      'error',
      undefined,
    );

    delete window.__addToast;
  });

  // ── Submit flow ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-016: submitting valid restaurant booking calls onSave with correct shape', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Restaurant/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Le Jules Verne');

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Le Jules Verne', type: 'restaurant' })
    );
  });

  it('FE-PLANNER-RESMODAL-017: status confirmed — onSave called with status confirmed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Test Booking');

    // The status CustomSelect renders as a button for its trigger — check for "Pending" text and change it
    // CustomSelect renders a div/button with the current value label. We look for the status select area.
    // Since CustomSelect is not mocked, we find the select by its displayed value.
    // The easiest approach: render with a reservation that has status 'confirmed'
    const res = buildReservation({ status: 'confirmed', type: 'flight', title: 'My Booking' });
    const { unmount } = render(<ReservationModal {...defaultProps} reservation={res} onSave={onSave} />);
    const updateBtn = screen.getAllByRole('button', { name: /Update/i })[0];
    await userEvent.click(updateBtn);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed' })
    );
    unmount();
  });

  it('FE-PLANNER-RESMODAL-018: onClose NOT called after successful save (parent controls closing)', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onClose={onClose} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Test Booking');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    // The component does NOT call onClose after save — the parent controls that
    expect(onClose).not.toHaveBeenCalled();
  });

  it('FE-PLANNER-RESMODAL-019: save button is disabled while saving', async () => {
    let resolveOnSave: () => void;
    const onSave = vi.fn().mockReturnValue(
      new Promise<void>(resolve => { resolveOnSave = resolve; })
    );
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Test Booking');

    const submitBtn = screen.getByRole('button', { name: /^Add$/i });
    await userEvent.click(submitBtn);

    // While promise is pending, the button should be disabled
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Saving/i })).toBeDisabled();
    });

    // Cleanup
    resolveOnSave!();
  });

  // ── Assignment linking ──────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-020: assignment picker appears when days/assignments are populated (non-hotel)', () => {
    const day = buildDay({ id: 1, title: 'Day 1' });
    const place = buildPlace({ name: 'Museum' });
    const assignment = buildAssignment({ id: 99, day_id: 1, order_index: 0, place });

    render(
      <ReservationModal
        {...defaultProps}
        days={[day]}
        assignments={{ '1': [assignment] }}
      />
    );

    expect(screen.getByText(/Link to day assignment/i)).toBeInTheDocument();
  });




  it('FE-PLANNER-RESMODAL-023: Cancel button calls onClose', async () => {
    const onClose = vi.fn();
    render(<ReservationModal {...defaultProps} onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  // ── Budget addon ─────────────────────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-024: costs section (create expense) visible when budget addon is enabled', () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    render(<ReservationModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Create expense/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-025: create-expense saves the booking (no create_budget_entry) then opens the Costs editor', async () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    const onSave = vi.fn().mockResolvedValue({ id: 55 });
    const onOpenExpense = vi.fn();
    render(<ReservationModal {...defaultProps} onSave={onSave} onOpenExpense={onOpenExpense} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Hotel Paris');
    await userEvent.click(screen.getByRole('button', { name: /Create expense/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).not.toHaveBeenCalledWith(expect.objectContaining({ create_budget_entry: expect.anything() }));
    await waitFor(() =>
      expect(onOpenExpense).toHaveBeenCalledWith(
        expect.objectContaining({ prefill: expect.objectContaining({ reservationId: 55 }) })
      )
    );
  });

  it('FE-PLANNER-RESMODAL-026: linked expense summary shown for a booking with a linked cost', () => {
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      budgetItems: [
        { id: 7, trip_id: 1, name: 'Hotel deposit', total_price: 120, currency: 'EUR', category: 'accommodation', reservation_id: 9, members: [], payers: [], persons: 1, expense_date: null, paid_by_user_id: null },
      ],
    });
    render(<ReservationModal {...defaultProps} reservation={buildReservation({ id: 9, type: 'hotel', title: 'Hotel Paris' })} />);
    expect(screen.getByText('Hotel deposit')).toBeInTheDocument();
  });








  it('FE-PLANNER-RESMODAL-030: hotel type — saving calls onSave with correct hotel shape', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Grand Hotel');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Grand Hotel', type: 'hotel' })
    );
  });

  it('FE-PLANNER-RESMODAL-031: event type — saving calls onSave with event type', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Event/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Louvre Museum');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Louvre Museum', type: 'event' })
    );
  });

  it('FE-PLANNER-RESMODAL-031b: parking type — saving calls onSave with parking type (#1444)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Parking/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Airport Parking P1');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Airport Parking P1', type: 'parking' })
    );
  });

  it('FE-PLANNER-RESMODAL-032: edit mode — save button shows "Update"', () => {
    const res = buildReservation({ title: 'My Trip', type: 'other' });
    render(<ReservationModal {...defaultProps} reservation={res} />);
    expect(screen.getByRole('button', { name: /^Update$/i })).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-033: modal is closed when isOpen=false', () => {
    render(<ReservationModal {...defaultProps} isOpen={false} />);
    // When isOpen=false the Modal component should hide content
    expect(screen.queryByText(/New Reservation/i)).not.toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-034: location and confirmation number inputs are present', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Address, Airport/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/e\.g\. ABC12345/i)).toBeInTheDocument();
  });















  it('FE-PLANNER-RESMODAL-041: budget section not shown when addon disabled', () => {
    render(<ReservationModal {...defaultProps} />);
    expect(screen.queryByPlaceholderText('0.00')).not.toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-042: hotel type metadata saved with check-in time', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /Accommodation/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Grand Hotel');

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Grand Hotel', type: 'hotel' })
    );
  });



  it('FE-PLANNER-RESMODAL-045: tour type shows time pickers', async () => {
    render(<ReservationModal {...defaultProps} />);
    await userEvent.click(screen.getByRole('button', { name: /^Tour$/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId('time-picker').length).toBeGreaterThan(0);
    });
  });

  it('FE-PLANNER-RESMODAL-046: other type renders and saves correctly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: /^Other$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Misc item');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ type: 'other' })));
  });





  it('FE-PLANNER-RESMODAL-035: hotel type saves correctly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /^Accommodation$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Hotel Test');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hotel' })
    );
  });

  // ── Hotel day-range picker — non-monotonic IDs (issue #929) ───────────────
  // Mirrors DayDetailPanel-056/057 for the ReservationModal path.
  // ID layout: day_number 1-9 → IDs 17-25, day_number 10-16 → IDs 1-7.

  function buildNonMonotonicDaysRM() {
    return [
      buildDay({ id: 17, trip_id: 1, date: '2026-04-30', day_number: 1 }),
      buildDay({ id: 18, trip_id: 1, date: '2026-05-01', day_number: 2 }),
      buildDay({ id: 19, trip_id: 1, date: '2026-05-02', day_number: 3 }),
      buildDay({ id: 20, trip_id: 1, date: '2026-05-03', day_number: 4 }),
      buildDay({ id: 21, trip_id: 1, date: '2026-05-04', day_number: 5 }),
      buildDay({ id: 22, trip_id: 1, date: '2026-05-05', day_number: 6 }),
      buildDay({ id: 23, trip_id: 1, date: '2026-05-06', day_number: 7 }),
      buildDay({ id: 24, trip_id: 1, date: '2026-05-07', day_number: 8 }),
      buildDay({ id: 25, trip_id: 1, date: '2026-05-08', day_number: 9 }),
      buildDay({ id: 1,  trip_id: 1, date: '2026-05-09', day_number: 10 }),
      buildDay({ id: 2,  trip_id: 1, date: '2026-05-10', day_number: 11 }),
      buildDay({ id: 3,  trip_id: 1, date: '2026-05-11', day_number: 12 }),
      buildDay({ id: 4,  trip_id: 1, date: '2026-05-12', day_number: 13 }),
      buildDay({ id: 5,  trip_id: 1, date: '2026-05-13', day_number: 14 }),
      buildDay({ id: 6,  trip_id: 1, date: '2026-05-14', day_number: 15 }),
      buildDay({ id: 7,  trip_id: 1, date: '2026-05-15', day_number: 16 }),
    ] as any[];
  }

  it('FE-PLANNER-RESMODAL-050: non-monotonic IDs — end picker with low ID does not clobber start', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const days = buildNonMonotonicDaysRM();

    render(<ReservationModal {...defaultProps} onSave={onSave} days={days} />);

    // Switch to hotel type
    await userEvent.click(screen.getByRole('button', { name: /^Accommodation$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Overlap Hotel');

    // Open start picker (first "Select day" trigger) and select Day 1 (id=17)
    const startTrigger = () => screen.getAllByRole('button').filter(b => b.textContent?.includes('Select day') || b.textContent?.startsWith('Day '))[0];
    await userEvent.click(startTrigger());
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 1') && !b.textContent?.startsWith('Day 1 ') || b.textContent?.trim() === 'Day 1')!);

    // Open end picker and select Day 16 (id=7, low ID but last positionally)
    const endTrigger = () => screen.getAllByRole('button').filter(b => b.textContent?.includes('Select day') || /^Day \d+/.test(b.textContent?.trim() ?? ''))[1];
    await userEvent.click(endTrigger());
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 16'))!);

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    // start must stay id=17 (Day 1) — old Math.max would clobber it to id=7
    expect(saved.create_accommodation?.start_day_id).toBe(17);
    expect(saved.create_accommodation?.end_day_id).toBe(7);
  });

  it('FE-PLANNER-RESMODAL-051: non-monotonic IDs — start picker does not collapse end when start has high ID', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const days = buildNonMonotonicDaysRM();

    render(<ReservationModal {...defaultProps} onSave={onSave} days={days} />);

    await userEvent.click(screen.getByRole('button', { name: /^Accommodation$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Span Hotel');

    // Set end to Day 16 (id=7) first
    const endTrigger = () => screen.getAllByRole('button').filter(b => b.textContent?.includes('Select day') || /^Day \d+/.test(b.textContent?.trim() ?? ''))[1];
    await userEvent.click(endTrigger());
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 16'))!);

    // Set start to Day 9 (id=25, high ID but earlier by position than Day 16)
    // Old code: Math.max(25, 7) = 25 → end collapses to Day 9.
    // New code: position(id=25)=8 < position(id=7)=15 → end stays id=7.
    const startTrigger = () => screen.getAllByRole('button').filter(b => b.textContent?.includes('Select day') || /^Day \d+/.test(b.textContent?.trim() ?? ''))[0];
    await userEvent.click(startTrigger());
    await userEvent.click(screen.getAllByRole('button').find(b => b.textContent?.startsWith('Day 9'))!);

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    expect(saved.create_accommodation?.start_day_id).toBe(25); // Day 9
    expect(saved.create_accommodation?.end_day_id).toBe(7);    // Day 16 — must NOT have collapsed
  });

  it('FE-PLANNER-RESMODAL-052: hotel with no accommodation_id sends assignment_id as null (issue #934)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    // Hotel reservation with assignment_id set but no accommodation
    const res = buildReservation({
      id: 10, title: 'Stale Hotel', type: 'hotel', status: 'confirmed',
      accommodation_id: null, assignment_id: 99,
    } as any);

    render(<ReservationModal {...defaultProps} onSave={onSave} reservation={res} />);

    await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].assignment_id).toBeNull();
  });

  // ── Hotel address persistence (issue #1496) ─────────────────────────────────

  it('FE-PLANNER-RESMODAL-053: editing a hotel address sends the typed value even with a place linked', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const place = buildPlace({ id: 5, name: 'Grand Hotel', address: 'Old Street 1' });
    const days = [
      buildDay({ id: 1, trip_id: 1, date: '2026-05-01', day_number: 1 }),
      buildDay({ id: 2, trip_id: 1, date: '2026-05-02', day_number: 2 }),
    ];
    const res = buildReservation({
      id: 3, title: 'Grand Hotel', type: 'hotel', accommodation_id: 8,
    } as any);
    const acc = { id: 8, trip_id: 1, place_id: 5, start_day_id: 1, end_day_id: 2 } as any;

    render(
      <ReservationModal
        {...defaultProps}
        onSave={onSave}
        reservation={res}
        days={days}
        places={[place]}
        accommodations={[acc]}
      />
    );

    // Address field is pre-filled from the linked place
    const addressInput = screen.getByPlaceholderText(/Address, Airport/i);
    expect(addressInput).toHaveValue('Old Street 1');

    await userEvent.clear(addressInput);
    await userEvent.type(addressInput, 'New Street 2');
    await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    // The typed address must reach the save handler — before #1496 it was
    // dropped whenever a place was linked and the old address reappeared.
    expect(saved.location).toBe('New Street 2');
    expect(saved.create_accommodation?.address).toBe('New Street 2');
    expect(saved.create_accommodation?.place_id).toBe(5);
  });

  it('FE-PLANNER-RESMODAL-054: hotel address is kept in location when no days or place are set', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.click(screen.getByRole('button', { name: /^Accommodation$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Hotel Test');
    await userEvent.type(screen.getByPlaceholderText(/Address, Airport/i), 'Main Road 3');
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    // No day range → no accommodation, but the address must not be lost
    expect(saved.create_accommodation).toBeUndefined();
    expect(saved.location).toBe('Main Road 3');
  });

  const budgetEnabled = () =>
    seedStore(useAddonStore, {
      addons: [{ id: 'budget', name: 'Budget', type: 'budget', icon: '', enabled: true }],
      loaded: true,
    });

  const reviewDays = () => [
    buildDay({ id: 1, trip_id: 1, date: '2026-05-01' }),
    buildDay({ id: 2, trip_id: 1, date: '2026-05-02' }),
    buildDay({ id: 3, trip_id: 1, date: '2026-05-03' }),
  ];

  // ── Existing-reservation end date/time parsing ──────────────────────────────

  it('FE-PLANNER-RESMODAL-063: an ISO end timestamp is split into the end date and end time fields', () => {
    const res = buildReservation({
      id: 4, type: 'event', title: 'Concert',
      reservation_time: '2026-05-01T20:00:00', reservation_end_time: '2026-05-02T23:30:00',
    });
    render(<ReservationModal {...defaultProps} reservation={res} days={reviewDays()} />);
    const datePickers = screen.getAllByTestId('date-picker') as HTMLInputElement[];
    const timePickers = screen.getAllByTestId('time-picker') as HTMLInputElement[];
    expect(datePickers[1].value).toBe('2026-05-02');
    expect(timePickers[1].value).toBe('23:30');
  });

  it('FE-PLANNER-RESMODAL-064: a date-only end is treated as an all-day end with no time', () => {
    const res = buildReservation({
      id: 4, type: 'event', title: 'Festival',
      reservation_time: '2026-05-01T20:00:00', reservation_end_time: '2026-05-03',
    });
    render(<ReservationModal {...defaultProps} reservation={res} days={reviewDays()} />);
    const datePickers = screen.getAllByTestId('date-picker') as HTMLInputElement[];
    const timePickers = screen.getAllByTestId('time-picker') as HTMLInputElement[];
    expect(datePickers[1].value).toBe('2026-05-03');
    expect(timePickers[1].value).toBe('');
  });

  it('FE-PLANNER-RESMODAL-065: an end time without an end date is combined with the start date', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} days={reviewDays()} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Dinner');
    fireEvent.change(screen.getAllByTestId('date-picker')[0], { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getAllByTestId('time-picker')[0], { target: { value: '19:00' } });
    fireEvent.change(screen.getAllByTestId('time-picker')[1], { target: { value: '21:00' } });

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].reservation_end_time).toBe('2026-05-01T21:00');
  });

  it('FE-PLANNER-RESMODAL-066: typing only a start time dates it from the selected day', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const days = reviewDays();
    render(<ReservationModal {...defaultProps} onSave={onSave} days={days} selectedDayId={2} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Museum slot');
    fireEvent.change(screen.getAllByTestId('time-picker')[0], { target: { value: '10:15' } });

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].reservation_time).toBe('2026-05-02T10:15');
  });

  it('FE-PLANNER-RESMODAL-067: clearing the start date drops the time with it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} days={reviewDays()} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Loose booking');
    fireEvent.change(screen.getAllByTestId('date-picker')[0], { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getAllByTestId('time-picker')[0], { target: { value: '09:00' } });
    fireEvent.change(screen.getAllByTestId('date-picker')[0], { target: { value: '' } });

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].reservation_time).toBeNull();
  });

  // ── Assignment + place linking ──────────────────────────────────────────────

  it('FE-PLANNER-RESMODAL-068: picking a day assignment seeds the booking date from that day', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const day = buildDay({ id: 1, trip_id: 1, date: '2026-05-01', title: 'Arrival' });
    const museum = buildPlace({ id: 11, name: 'Museum', place_time: '09:00', end_time: '10:00' });
    const park = buildPlace({ id: 12, name: 'Park' });
    const assignments = {
      '1': [
        buildAssignment({ id: 202, day_id: 1, order_index: 1, place: park }),
        buildAssignment({ id: 201, day_id: 1, order_index: 0, place: museum }),
        // An assignment whose place was deleted must be skipped, not crash the list.
        { id: 203, day_id: 1, place_id: 0, order_index: 2, notes: null, place: null },
      ],
    };

    render(
      <ReservationModal
        {...defaultProps}
        onSave={onSave}
        days={[day]}
        assignments={assignments as unknown as typeof defaultProps.assignments}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Guided tour');
    await userEvent.click(screen.getByText('No link (standalone)'));
    // Ordered by order_index, so the museum is offered first with its time range.
    await userEvent.click(screen.getByRole('button', { name: /1\. Museum · 09:00 – 10:00/ }));

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0][0];
    expect(saved.assignment_id).toBe(201);
    expect(saved.reservation_time).toBe('2026-05-01');
  });

  it('FE-PLANNER-RESMODAL-069: linking a trip place fills the empty title and location from it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const place = buildPlace({ id: 15, name: 'Le Jules Verne', address: 'Champ de Mars' });
    render(<ReservationModal {...defaultProps} onSave={onSave} places={[place]} />);

    await userEvent.click(screen.getByRole('button', { name: /Restaurant/i }));
    await userEvent.click(screen.getByText('—'));
    await userEvent.click(screen.getByRole('button', { name: 'Le Jules Verne' }));

    expect(screen.getByDisplayValue('Le Jules Verne')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Champ de Mars')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].place_id).toBe(15);
  });

  it('FE-PLANNER-RESMODAL-070: picking a hotel place adopts its address into the hotel form', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const place = buildPlace({ id: 16, name: 'Grand Hotel', address: 'Bahnhofstrasse 1' });
    const days = reviewDays();
    render(<ReservationModal {...defaultProps} onSave={onSave} places={[place]} days={days} />);

    await userEvent.click(screen.getByRole('button', { name: /^Accommodation$/i }));
    await userEvent.click(screen.getByText('—'));
    await userEvent.click(screen.getByRole('button', { name: 'Grand Hotel' }));

    expect(screen.getByDisplayValue('Grand Hotel')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Bahnhofstrasse 1')).toBeInTheDocument();
  });

  it('FE-PLANNER-RESMODAL-071: url, notes and booking code are carried into the payload', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Boat trip');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. ABC12345/i), 'BT-77');
    await userEvent.type(screen.getByPlaceholderText(/Address, Airport/i), 'Pier 3');
    await userEvent.type(screen.getByPlaceholderText(/Notes/i), 'Bring sunscreen');
    await userEvent.type(screen.getByPlaceholderText(/https:\/\//i), 'https://boats.example');

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmation_number: 'BT-77',
        location: 'Pier 3',
        notes: 'Bring sunscreen',
        url: 'https://boats.example',
      }),
    );
  });

  // ── Travelers (#1517) ──────────────────────────────────────────────────────

  const tripMembers: TripMember[] = [
    { id: 1, username: 'alice', avatar_url: null },
    { id: 2, username: 'bob', avatar_url: null },
  ];

  it('FE-PLANNER-RESMODAL-072: toggling travelers persists them once the booking has an id', async () => {
    const onSave = vi.fn().mockResolvedValue({ id: 90 });
    // The traveler write is the local junction now — the persisted rows are
    // what the request body used to carry.
    await db.reservations.put(buildReservation({ id: 90, trip_id: 1 }));

    render(<ReservationModal {...defaultProps} onSave={onSave} tripMembers={tripMembers} />);
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Museum tour');
    await userEvent.click(screen.getByText('alice'));
    await userEvent.click(screen.getByText('bob'));
    // Toggling bob again removes him, so only alice is sent.
    await userEvent.click(screen.getByText('bob'));
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(async () => {
      const rows = await db.reservationTravelers.where('reservation_id').equals(90).toArray();
      expect(rows.map((r) => r.user_id)).toEqual([1]);
    });
  });

  it('FE-PLANNER-RESMODAL-073: an unchanged traveler list is not written back', async () => {
    const onSave = vi.fn().mockResolvedValue({ id: 91 });
    const setTravelers = vi.spyOn(reservationsApi, 'setTravelers');
    const res = buildReservation({ id: 91, type: 'event', title: 'Opera', travelers: [{ user_id: 1, username: 'alice' }] });
    await db.reservations.put(res);

    render(<ReservationModal {...defaultProps} onSave={onSave} reservation={res} tripMembers={tripMembers} />);
    await userEvent.click(screen.getByRole('button', { name: /^Update$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(setTravelers).not.toHaveBeenCalled();
  });

  it('FE-PLANNER-RESMODAL-074: a failing traveler write surfaces an error toast', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    const onSave = vi.fn().mockResolvedValue({ id: 92 });
    await db.reservations.put(buildReservation({ id: 92, trip_id: 1 }));
    vi.spyOn(reservationsApi, 'setTravelers').mockRejectedValue(new LocalApiError(500, 'nope'));

    render(<ReservationModal {...defaultProps} onSave={onSave} tripMembers={tripMembers} />);
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Boat trip');
    await userEvent.click(screen.getByText('alice'));
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), 'error', undefined));
    delete window.__addToast;
  });

  // ── Linked cost actions ─────────────────────────────────────────────────────

  function seedLinkedCost() {
    budgetEnabled();
    seedStore(useTripStore, {
      trip: buildTrip({ id: 1 }),
      budgetItems: [
        { id: 7, trip_id: 1, name: 'Hotel deposit', total_price: 120, currency: 'EUR', category: 'accommodation', reservation_id: 9, members: [], payers: [], persons: 1, expense_date: null, paid_by_user_id: null },
      ],
    });
  }

  it('FE-PLANNER-RESMODAL-075: editing the linked cost saves the booking first, then opens that item', async () => {
    seedLinkedCost();
    const onSave = vi.fn().mockResolvedValue({ id: 9 });
    const onOpenExpense = vi.fn();
    render(
      <ReservationModal
        {...defaultProps}
        onSave={onSave}
        onOpenExpense={onOpenExpense}
        reservation={buildReservation({ id: 9, type: 'hotel', title: 'Hotel Paris' })}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onOpenExpense).toHaveBeenCalledWith({ editItem: expect.objectContaining({ id: 7 }) });
  });

  it('FE-PLANNER-RESMODAL-076: removing the linked cost deletes it, and a failure shows a toast', async () => {
    const addToast = vi.fn();
    window.__addToast = addToast;
    seedLinkedCost();
    const deleted = vi.spyOn(budgetApi, 'delete').mockRejectedValue(new LocalApiError(500, 'nope'));
    render(
      <ReservationModal {...defaultProps} reservation={buildReservation({ id: 9, type: 'hotel', title: 'Hotel Paris' })} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Remove expense/i }));
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(1, 7));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), 'error', undefined));
    delete window.__addToast;
  });

  // ── File error paths ────────────────────────────────────────────────────────









  it('FE-PLANNER-RESMODAL-082: submitting the form with an empty title is a no-op', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(onSave).not.toHaveBeenCalled());
  });

  it('FE-PLANNER-RESMODAL-083: linking an assignment leaves an already-chosen date alone', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const day = buildDay({ id: 1, trip_id: 1, date: '2026-05-01', title: 'Arrival' });
    const museum = buildPlace({ id: 11, name: 'Museum' });
    render(
      <ReservationModal
        {...defaultProps}
        onSave={onSave}
        days={[day]}
        assignments={{ '1': [buildAssignment({ id: 201, day_id: 1, order_index: 0, place: museum })] }}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Guided tour');
    fireEvent.change(screen.getAllByTestId('date-picker')[0], { target: { value: '2026-05-02' } });
    await userEvent.click(screen.getByText('No link (standalone)'));
    await userEvent.click(screen.getByRole('button', { name: /1\. Museum/ }));

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].reservation_time).toBe('2026-05-02');
  });

  it('FE-PLANNER-RESMODAL-084: the status picker switches the booking to confirmed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Boat trip');
    await userEvent.click(screen.getByText('Pending'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmed' }));
    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].status).toBe('confirmed');
  });

  it('FE-PLANNER-RESMODAL-085: hotel check-in/check-out times land in the metadata and the accommodation', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const days = reviewDays();
    render(<ReservationModal {...defaultProps} onSave={onSave} days={days} />);

    await userEvent.click(screen.getByRole('button', { name: /^Accommodation$/i }));
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Grand Hotel');
    // Hotels hide the start/end rows, so these three pickers are check-in / until / check-out.
    const times = screen.getAllByTestId('time-picker');
    expect(times).toHaveLength(3);
    fireEvent.change(times[0], { target: { value: '15:00' } });
    fireEvent.change(times[1], { target: { value: '22:00' } });
    fireEvent.change(times[2], { target: { value: '11:00' } });

    await userEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].metadata).toEqual({
      check_in_time: '15:00', check_in_end_time: '22:00', check_out_time: '11:00',
    });
  });



  it('FE-PLANNER-RESMODAL-081: an accommodation that has not loaded yet leaves the hotel fields blank', () => {
    const res = buildReservation({ id: 15, title: 'Grand Hotel', type: 'hotel' });
    (res as unknown as { accommodation_id: number }).accommodation_id = 99;
    render(<ReservationModal {...defaultProps} reservation={res} days={reviewDays()} accommodations={[]} />);
    // Hotel place picker still shows its placeholder — no crash on the missing record.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  // A legacy or corrupted metadata column used to throw straight out of the open
  // effect and take the whole planner route down.
  it('FE-PLANNER-RESMODAL-087: unparseable metadata opens the modal with empty check-in times', () => {
    const res = buildReservation({ id: 17, title: 'Grand Hotel', type: 'hotel' });
    (res as unknown as { metadata: string }).metadata = '{not json';
    render(<ReservationModal {...defaultProps} reservation={res} days={reviewDays()} />);

    expect(screen.getByDisplayValue('Grand Hotel')).toBeInTheDocument();
    const times = screen.getAllByTestId('time-picker') as HTMLInputElement[];
    expect(times.map(i => i.value)).toEqual(['', '', '']);
  });

  // #2107 — a booking that lasts a whole day has no clock to compare, and filling the
  // missing one with midnight made the comparison read as inverted.
  it('FE-PLANNER-RESMODAL-089: the same start and end date with no times is accepted', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} days={reviewDays()} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Park permit');
    const datePickers = screen.getAllByTestId('date-picker');
    fireEvent.change(datePickers[0], { target: { value: '2026-05-02' } });
    fireEvent.change(datePickers[1], { target: { value: '2026-05-02' } });

    expect(screen.queryByText(/End date\/time must be after start/i)).toBeNull();
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it('FE-PLANNER-RESMODAL-090: an all-day booking is saved as bare dates on both ends', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ReservationModal {...defaultProps} onSave={onSave} days={reviewDays()} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Park permit');
    const datePickers = screen.getAllByTestId('date-picker');
    fireEvent.change(datePickers[0], { target: { value: '2026-05-02' } });
    fireEvent.change(datePickers[1], { target: { value: '2026-05-02' } });
    fireEvent.submit(document.querySelector('form')!);

    // The stored shape matters: the calendar export branches on whether the value
    // carries a clock, and a bare date is what makes it an all-day event.
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ reservation_time: '2026-05-02', reservation_end_time: '2026-05-02' }),
    ));
  });

  it('FE-PLANNER-RESMODAL-091: an end date before the start is still refused without times', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const addToast = vi.fn();
    window.__addToast = addToast;
    render(<ReservationModal {...defaultProps} onSave={onSave} days={reviewDays()} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Backwards');
    const datePickers = screen.getAllByTestId('date-picker');
    fireEvent.change(datePickers[0], { target: { value: '2026-05-02' } });
    fireEvent.change(datePickers[1], { target: { value: '2026-05-01' } });
    fireEvent.submit(document.querySelector('form')!);

    expect(onSave).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/End date\/time must be after start/i), 'error', undefined);
    delete window.__addToast;
  });

  it('FE-PLANNER-RESMODAL-092: a stored booking whose end is a bare date on the start day stays editable', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    // The shape the booking import and the mobile sheet both write. Nothing is typed
    // here: the row alone used to leave the save button dead.
    const res = buildReservation({
      id: 21, type: 'event', title: 'Day permit',
      reservation_time: '2026-05-02T10:00:00', reservation_end_time: '2026-05-02',
    });
    render(<ReservationModal {...defaultProps} reservation={res} onSave={onSave} days={reviewDays()} />);

    expect(screen.queryByText(/End date\/time must be after start/i)).toBeNull();
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });

  it('FE-PLANNER-RESMODAL-093: switching to hotel clears a date error the hidden panel cannot explain', async () => {
    render(<ReservationModal {...defaultProps} days={reviewDays()} />);

    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Lufthansa/i), 'Switched');
    const datePickers = screen.getAllByTestId('date-picker');
    const timePickers = screen.getAllByTestId('time-picker');
    fireEvent.change(datePickers[0], { target: { value: '2026-05-02' } });
    fireEvent.change(timePickers[0], { target: { value: '19:00' } });
    fireEvent.change(datePickers[1], { target: { value: '2026-05-01' } });
    expect(screen.getByText(/End date\/time must be after start/i)).toBeTruthy();
    // The footer button reads 'Add' while creating and 'Update' while editing.
    const save = () => Array.from(document.querySelectorAll('button'))
      .find(b => /^\s*(Add|Update)\s*$/.test(b.textContent || '')) as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    // The date panel is hidden for hotels, and the message sits inside it, so
    // asserting on the message proves nothing here. The save button is the part
    // that stayed dead with no visible reason.
    // The hotel type is labelled 'Accommodation' in the picker.
    const hotelBtn = Array.from(document.querySelectorAll('button'))
      .find(b => /^\s*Accommodation\s*$/.test(b.textContent || ''))!;
    fireEvent.click(hotelBtn);
    expect(save().disabled).toBe(false);
  });

  it('FE-PLANNER-RESMODAL-088: double-encoded metadata still fills the check-in times', () => {
    const res = buildReservation({ id: 18, title: 'Grand Hotel', type: 'hotel' });
    (res as unknown as { metadata: string }).metadata =
      JSON.stringify(JSON.stringify({ check_in_time: '16:00', check_out_time: '10:30' }));
    render(<ReservationModal {...defaultProps} reservation={res} days={reviewDays()} />);

    const times = screen.getAllByTestId('time-picker') as HTMLInputElement[];
    expect(times[0].value).toBe('16:00');
    expect(times[2].value).toBe('10:30');
  });
});
