// FE-COMP-TRIPFORM-001 to FE-COMP-TRIPFORM-084
import 'fake-indexeddb/auto';
import type { Mock } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import { delay } from 'msw';
import { act } from '@testing-library/react';
import { useAuthStore } from '../../store/authStore';
import { useTripStore } from '../../store/tripStore';
import { useSettingsStore } from '../../store/settingsStore';
import { usePermissionsStore } from '../../store/permissionsStore';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip } from '../../../tests/helpers/factories';
import type { Trip } from '../../types';
import { MAX_TRIP_DAYS } from '@trek/shared';
import TripFormModal from './TripFormModal';
import { db, type LocalTripMember } from '../../db/panelmintDb';
import { tripsApi } from '../../api/client';
import { LocalApiError } from '../../api/local/helpers';

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSave: vi.fn(),
  trip: null,
};

type AddToast = NonNullable<typeof window.__addToast>;
let addToast: Mock<AddToast>;

/** tripsApi is the local adapter now — member add/remove writes through
 * Dexie. Trips 1/5/99 cover every id the
 *  suite references; self's roster name is 'me' so the owner chip matches the
 *  old server fixtures. */
async function seedLocalData() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'me', is_self: 1 });
  await db.trips.bulkPut([buildTrip({ id: 1 }), buildTrip({ id: 5 }), buildTrip({ id: 99 })]);
}

/** The member picker's roster is the localUsers table — the old suite fed it
 *  through /api/auth/users over msw, but the local adapter reads Dexie. */
const seedRoster = (...names: { id: number; name: string }[]) =>
  db.localUsers.bulkPut(names.map(u => ({ id: u.id, name: u.name, is_self: 0 as const })));

beforeEach(async () => {
  resetAllStores();
  seedStore(useAuthStore, { user: buildUser(), isAuthenticated: true });
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) });
  await seedLocalData();
  addToast = vi.fn<AddToast>(() => 0);
  window.__addToast = addToast;
});

afterEach(() => {
  delete window.__addToast;
  vi.restoreAllMocks();
});


const submitNewTrip = async (user: ReturnType<typeof userEvent.setup>) => {
  const btn = screen.getAllByText('Create New Trip').find(el => el.closest('button'))!;
  await user.click(btn.closest('button')!);
};

describe('TripFormModal', () => {
  it('FE-COMP-TRIPFORM-001: renders without crashing', () => {
    render(<TripFormModal {...defaultProps} />);
    expect(document.body).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-002: shows Create New Trip title for new trip', () => {
    render(<TripFormModal {...defaultProps} trip={null} />);
    expect(screen.getAllByText('Create New Trip').length).toBeGreaterThan(0);
  });

  it('FE-COMP-TRIPFORM-003: shows Edit Trip title when editing', () => {
    const trip = buildTrip({ id: 1, title: 'Japan 2025' });
    render(<TripFormModal {...defaultProps} trip={trip} />);
    expect(screen.getByText('Edit Trip')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-004: shows trip title input field', () => {
    render(<TripFormModal {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Summer in Japan/i)).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-005: Cancel button is present', () => {
    render(<TripFormModal {...defaultProps} />);
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-006: clicking Cancel calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TripFormModal {...defaultProps} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('FE-COMP-TRIPFORM-007: Create New Trip submit button is present', () => {
    render(<TripFormModal {...defaultProps} trip={null} />);
    // Submit button text is "Create New Trip" for new trips
    const createBtns = screen.getAllByText('Create New Trip');
    expect(createBtns.length).toBeGreaterThan(0);
  });

  it('FE-COMP-TRIPFORM-008: Update button shown when editing', () => {
    const trip = buildTrip({ id: 1, title: 'Japan 2025' });
    render(<TripFormModal {...defaultProps} trip={trip} />);
    expect(screen.getByRole('button', { name: /Update/i })).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-009: submitting with empty title shows error', async () => {
    const user = userEvent.setup();
    render(<TripFormModal {...defaultProps} />);
    // Click submit without filling title
    const submitBtn = screen.getAllByText('Create New Trip').find(
      el => el.tagName === 'BUTTON' || el.closest('button')
    );
    if (submitBtn) {
      await user.click(submitBtn.closest('button') || submitBtn);
    }
    // Error: "Title is required"
    expect(await screen.findByText('Title is required')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-010: typing title and submitting calls onSave', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ trip: buildTrip({ id: 99 }) });
    render(<TripFormModal {...defaultProps} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Paris 2026');
    const submitBtns = screen.getAllByText('Create New Trip');
    const submitBtn = submitBtns.find(el => el.closest('button'));
    await user.click(submitBtn!.closest('button')!);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'Paris 2026' }));
  });

  it('FE-COMP-TRIPFORM-011: pre-fills title when editing trip', () => {
    const trip = buildTrip({ id: 1, title: 'Iceland Adventure' });
    render(<TripFormModal {...defaultProps} trip={trip} />);
    expect(screen.getByDisplayValue('Iceland Adventure')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-012: shows Title label', () => {
    render(<TripFormModal {...defaultProps} />);
    // dashboard.tripTitle = "Title"
    expect(screen.getByText('Title')).toBeInTheDocument();
  });


  it('FE-COMP-TRIPFORM-014: shows start and end date labels', () => {
    render(<TripFormModal {...defaultProps} />);
    // Uses CustomDatePicker with labels "Start Date" and "End Date"
    const startEls = screen.getAllByText('Start Date');
    const endEls = screen.getAllByText('End Date');
    expect(startEls.length).toBeGreaterThan(0);
    expect(endEls.length).toBeGreaterThan(0);
  });

  it('FE-COMP-TRIPFORM-015: renders date picker components for start and end', () => {
    const trip = buildTrip({ id: 1, title: 'Test Trip', start_date: '2026-06-01', end_date: '2026-06-15' });
    render(<TripFormModal {...defaultProps} trip={trip} />);
    // CustomDatePicker shows formatted dates as button text (locale-dependent)
    // Just verify labels and form render without error
    expect(screen.getByText('Start Date')).toBeInTheDocument();
    expect(screen.getByText('End Date')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-016: end-date validation shows error when end < start', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    // Trip with end_date before start_date; title is set so title validation passes
    const trip = buildTrip({ id: 1, title: 'Test Trip', start_date: '2026-06-15', end_date: '2026-06-01' } as any);
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);
    const updateBtn = screen.getByRole('button', { name: /Update/i });
    await user.click(updateBtn);
    await screen.findByText('End date must be after start date');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-COMP-TRIPFORM-017: day count field visible when no dates set', () => {
    render(<TripFormModal {...defaultProps} trip={null} />);
    expect(screen.getByText('Number of Days')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-018: day count hidden when trip has dates', () => {
    const trip = buildTrip({ id: 1, start_date: '2026-06-01', end_date: '2026-06-10' });
    render(<TripFormModal {...defaultProps} trip={trip} />);
    expect(screen.queryByText('Number of Days')).not.toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-019: reminder buttons visible when tripRemindersEnabled=true', async () => {
    seedStore(useAuthStore, { tripRemindersEnabled: true });
    render(<TripFormModal {...defaultProps} trip={null} />);
    expect(screen.getByRole('button', { name: 'None' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-020: reminder section shows disabled hint when tripRemindersEnabled=false', () => {
    seedStore(useAuthStore, { tripRemindersEnabled: false });
    render(<TripFormModal {...defaultProps} trip={null} />);
    expect(screen.getByText(/Trip reminders are disabled/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'None' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Custom' })).not.toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-021: custom reminder input appears and accepts value', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { tripRemindersEnabled: true });
    render(<TripFormModal {...defaultProps} trip={null} />);
    await user.click(screen.getByRole('button', { name: 'Custom' }));
    // custom reminder input has max=30
    const customInput = document.querySelector('input[max="30"]') as HTMLInputElement;
    expect(customInput).toBeInTheDocument();
    // Use fireEvent.change to set the value directly (avoids clamping from char-by-char typing)
    fireEvent.change(customInput, { target: { value: '14' } });
    expect(customInput.value).toBe('14');
  });

  it('FE-COMP-TRIPFORM-022: member selector not visible when editing existing trip', () => {
    const trip = buildTrip({ id: 1 });
    render(<TripFormModal {...defaultProps} trip={trip} />);
    expect(screen.queryByText('Travel buddies')).not.toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-023: member selector appears when creating and other users exist', async () => {
    await seedRoster({ id: 100, name: 'alice' });
    render(<TripFormModal {...defaultProps} trip={null} />);
    expect(await screen.findByText('Travel buddies')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-024: selecting a member adds a chip', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    await seedRoster({ id: 100, name: 'alice' });
    render(<TripFormModal {...defaultProps} trip={null} />);
    // Wait for member section to load
    await screen.findByText('Travel buddies');
    // Click the CustomSelect trigger (placeholder "Add member")
    const selectTrigger = screen.getByText('Add member').closest('button')!;
    await user.click(selectTrigger);
    // alice option appears in portal (document.body)
    const aliceOption = await screen.findByRole('button', { name: 'alice' });
    await user.click(aliceOption);
    // alice chip should now be in the member chip list
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-025: removing a member chip deselects them', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    await seedRoster({ id: 100, name: 'alice' });
    render(<TripFormModal {...defaultProps} trip={null} />);
    await screen.findByText('Travel buddies');
    // Select alice
    const selectTrigger = screen.getByText('Add member').closest('button')!;
    await user.click(selectTrigger);
    const aliceOption = await screen.findByRole('button', { name: 'alice' });
    await user.click(aliceOption);
    // alice chip is present
    const aliceChip = screen.getByText('alice');
    expect(aliceChip).toBeInTheDocument();
    // Click the chip to remove alice
    await user.click(aliceChip.closest('button')!);
    // alice chip should be gone
    await waitFor(() => expect(screen.queryByText('alice')).not.toBeInTheDocument());
  });


  it('FE-COMP-TRIPFORM-027: onSave error message is displayed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('Server error'));
    render(<TripFormModal {...defaultProps} onSave={onSave} trip={null} />);
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'My Trip');
    const submitBtns = screen.getAllByText('Create New Trip');
    const submitBtn = submitBtns.find(el => el.closest('button'))!;
    await user.click(submitBtn.closest('button')!);
    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-028: loading spinner shown while submitting', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockImplementation(() => new Promise(() => {}));
    render(<TripFormModal {...defaultProps} onSave={onSave} trip={null} />);
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'My Trip');
    const submitBtns = screen.getAllByText('Create New Trip');
    const submitBtn = submitBtns.find(el => el.closest('button'))!;
    await user.click(submitBtn.closest('button')!);
    await waitFor(() => expect(screen.getByText('Saving...')).toBeInTheDocument());
  });

  it('FE-COMP-TRIPFORM-029: clearing the day count leaves the field empty (no snap to 1)', () => {
    render(<TripFormModal {...defaultProps} trip={null} />);
    const dayInput = document.querySelector(`input[max="${MAX_TRIP_DAYS}"]`) as HTMLInputElement;
    expect(dayInput).toBeInTheDocument();
    expect(dayInput.value).toBe('7');
    fireEvent.change(dayInput, { target: { value: '' } });
    expect(dayInput.value).toBe('');
  });

  it('FE-COMP-TRIPFORM-030: empty day count blocks submit with an error', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'No-date Trip');
    const dayInput = document.querySelector(`input[max="${MAX_TRIP_DAYS}"]`) as HTMLInputElement;
    fireEvent.change(dayInput, { target: { value: '' } });
    const submitBtn = screen.getAllByText('Create New Trip').find(el => el.closest('button'))!;
    await user.click(submitBtn.closest('button')!);
    await screen.findByText('Number of days is required');
    expect(onSave).not.toHaveBeenCalled();
  });


  // The trip currency is the base every expense and settlement is netted against, and
  // until #1543 the only way to set it was the legacy Budget addon panel.
  it('FE-COMP-TRIPFORM-032: pre-fills the currency of the trip being edited', () => {
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, currency: 'RUB' })} />);
    expect(screen.getByText(/^RUB/)).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-033: defaults a new trip to EUR and sends the currency on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ trip: buildTrip({ id: 99 }) });
    render(<TripFormModal {...defaultProps} onSave={onSave} />);

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Moscow 2026');
    const submitBtn = screen.getAllByText('Create New Trip').find(el => el.closest('button'))!;
    await user.click(submitBtn.closest('button')!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ currency: 'EUR' }));
  });

  it('FE-COMP-TRIPFORM-033b: a new trip defaults to the user\'s default_currency (#1784)', async () => {
    seedStore(useSettingsStore, { settings: { ...useSettingsStore.getState().settings, default_currency: 'USD' } });
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ trip: buildTrip({ id: 99 }) });
    render(<TripFormModal {...defaultProps} onSave={onSave} />);

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'New York 2026');
    const submitBtn = screen.getAllByText('Create New Trip').find(el => el.closest('button'))!;
    await user.click(submitBtn.closest('button')!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ currency: 'USD' }));
  });

  // Changing the start of a dated trip must go through the date-shift choice step (#1288).
  const changeStartDate = async (user: ReturnType<typeof userEvent.setup>, iso: string) => {
    await user.click(screen.getAllByRole('button', { name: 'Enter date manually' })[0]);
    const input = screen.getByPlaceholderText('DD.MM.YYYY');
    fireEvent.change(input, { target: { value: iso } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  it('FE-COMP-TRIPFORM-035: changing the start date shows the choice step and saves with keep_bookings by default', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    const trip = buildTrip({ id: 1, title: 'Dated Trip', start_date: '2025-06-01', end_date: '2025-06-05' });
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);

    await changeStartDate(user, '2025-05-31');
    await user.click(screen.getByRole('button', { name: /Update/i }));

    // The choice step appears instead of saving right away.
    await screen.findByText('Keep bookings on their dates');
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Update/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      start_date: '2025-05-31',
      date_shift_mode: 'keep_bookings',
    }));
  });

  it('FE-COMP-TRIPFORM-036: picking "Shift everything" sends shift_all', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    const trip = buildTrip({ id: 1, title: 'Dated Trip', start_date: '2025-06-01', end_date: '2025-06-05' });
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);

    await changeStartDate(user, '2025-06-02');
    await user.click(screen.getByRole('button', { name: /Update/i }));
    await user.click(await screen.findByRole('radio', { name: /Shift everything/i }));
    await user.click(screen.getByRole('button', { name: /Update/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ date_shift_mode: 'shift_all' }));
  });

  it('FE-COMP-TRIPFORM-037: Back returns to the form without saving', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const trip = buildTrip({ id: 1, title: 'Dated Trip', start_date: '2025-06-01', end_date: '2025-06-05' });
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);

    await changeStartDate(user, '2025-05-30');
    await user.click(screen.getByRole('button', { name: /Update/i }));
    await screen.findByText('Keep bookings on their dates');

    await user.click(screen.getByRole('button', { name: /Back/i }));
    await waitFor(() => expect(screen.queryByText('Keep bookings on their dates')).not.toBeInTheDocument());
    expect(screen.getByDisplayValue('Dated Trip')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-COMP-TRIPFORM-038: an edit that keeps the dates saves directly without the choice step', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    const trip = buildTrip({ id: 1, title: 'Dated Trip', start_date: '2025-06-01', end_date: '2025-06-05' });
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: /Update/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(screen.queryByText('Keep bookings on their dates')).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith(expect.not.objectContaining({ date_shift_mode: expect.anything() }));
  });

  it('FE-COMP-TRIPFORM-034: picking a currency sends the new one on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, currency: 'EUR' })} onSave={onSave} />);

    await user.click(screen.getByText(/^EUR/));
    await user.click(await screen.findByText(/^USD/));

    await user.click(screen.getByText('Update').closest('button')!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ currency: 'USD' }));
  });

  // ── App config / prefill fallbacks ────────────────────────────────────────

  it('FE-COMP-TRIPFORM-039: flipping the local flag re-enables the reminder section', async () => {
    // The hosted build pulled this from /api/auth/app-config; locally the flag
    // lives on the auth store and the modal reacts to it live.
    seedStore(useAuthStore, { tripRemindersEnabled: false });
    render(<TripFormModal {...defaultProps} trip={null} />);
    expect(screen.getByText(/Trip reminders are disabled/i)).toBeInTheDocument();
    act(() => seedStore(useAuthStore, { tripRemindersEnabled: true }));
    await screen.findByRole('button', { name: 'Custom' });
    expect(useAuthStore.getState().tripRemindersEnabled).toBe(true);
  });

  it('FE-COMP-TRIPFORM-040: a roster holding only self hides the member section', async () => {
    // localUsers has self alone — nobody else can be picked, so the section
    // stays hidden (the old version fed an empty /api/auth/users payload).
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    render(<TripFormModal {...defaultProps} trip={null} />);
    await screen.findByText('Title');
    expect(screen.queryByText('Travel buddies')).not.toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-041: a trip with blank fields falls back to the form defaults', async () => {
    // getMembers(5) resolves locally off the seeded trip row.
    const bare = {
      ...buildTrip({ id: 5 }),
      title: '',
      description: null,
      start_date: null,
      end_date: null,
      currency: null,
      reminder_days: null,
      day_count: 0,
    } as unknown as Trip;
    render(<TripFormModal {...defaultProps} trip={bare} />);

    expect(screen.getByPlaceholderText(/Summer in Japan/i)).toHaveValue('');
    expect(screen.getByText(/^EUR/)).toBeInTheDocument();
    // No dates -> the day-count field appears and falls back to 7.
    expect(document.querySelector(`input[max="${MAX_TRIP_DAYS}"]`)).toHaveValue('7');
  });

  // ── Create follow-ups: members ──────────────────────────────────

  it('FE-COMP-TRIPFORM-042: a save handler that returns nothing still closes the modal', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSave = vi.fn(() => undefined);
    render(<TripFormModal {...defaultProps} onSave={onSave} onClose={onClose} />);
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Void Trip');
    await submitNewTrip(user);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('FE-COMP-TRIPFORM-043: selected members are attached to the freshly created trip', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    const identifiers: string[] = [];
    await seedRoster({ id: 100, name: 'alice' });
    // addMember is local — capture the identifier the modal passes.
    vi.spyOn(tripsApi, 'addMember').mockImplementation(async (_id, identifier) => {
      identifiers.push(identifier);
      return { member: { id: 100, username: identifier, avatar: null, avatar_url: null, role: 'member' } };
    });
    const onSave = vi.fn().mockResolvedValue({ trip: buildTrip({ id: 99 }) });
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    await screen.findByText('Travel buddies');
    await user.click(screen.getByText('Add member').closest('button')!);
    await user.click(await screen.findByRole('button', { name: 'alice' }));
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Group Trip');
    await submitNewTrip(user);

    await waitFor(() => expect(identifiers).toEqual(['alice']));
    expect(addToast).not.toHaveBeenCalled();
  });

  it('FE-COMP-TRIPFORM-044: a failing member add surfaces a toast but still closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    await seedRoster({ id: 100, name: 'alice' });
    vi.spyOn(tripsApi, 'addMember').mockRejectedValue(new LocalApiError(500, 'nope'));
    const onSave = vi.fn().mockResolvedValue({ trip: buildTrip({ id: 99 }) });
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} onClose={onClose} />);

    await screen.findByText('Travel buddies');
    await user.click(screen.getByText('Add member').closest('button')!);
    await user.click(await screen.findByRole('button', { name: 'alice' }));
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Group Trip');
    await submitNewTrip(user);

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Failed to add', 'error', undefined));
    expect(onClose).toHaveBeenCalled();
  });







  it('FE-COMP-TRIPFORM-064: without the edit permission the text fields are read-only', () => {
    seedStore(useAuthStore, { user: buildUser({ id: 7, role: 'user' }), isAuthenticated: true });
    seedStore(usePermissionsStore, { permissions: { trip_edit: 'admin' } });
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, user_id: 7, title: 'Locked', description: 'read only' })} />);

    const title = screen.getByPlaceholderText(/Summer in Japan/i);
    expect(title).toHaveAttribute('readonly');
    fireEvent.change(title, { target: { value: 'Hacked' } });
    expect(title).toHaveValue('Locked');

    const desc = screen.getByPlaceholderText(/What is this trip about/i);
    fireEvent.change(desc, { target: { value: 'Hacked' } });
    expect(desc).toHaveValue('read only');
  });

  // ── Dates, day count, currency, reminder ──────────────────────────────────

  it('FE-COMP-TRIPFORM-065: setting a start date without an end date mirrors it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Open Ended');
    await user.click(screen.getAllByRole('button', { name: 'Enter date manually' })[0]);
    const input = screen.getByPlaceholderText('DD.MM.YYYY');
    fireEvent.change(input, { target: { value: '2026-04-10' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The day-count field disappears once the trip is dated.
    await waitFor(() => expect(document.querySelector(`input[max="${MAX_TRIP_DAYS}"]`)).toBeNull());
    await submitNewTrip(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: '2026-04-10', end_date: '2026-04-10' })
    ));
  });

  it('FE-COMP-TRIPFORM-066: an end date set first survives a later, earlier start date', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Backwards');

    await user.click(screen.getAllByRole('button', { name: 'Enter date manually' })[1]);
    const endInput = screen.getByPlaceholderText('DD.MM.YYYY');
    fireEvent.change(endInput, { target: { value: '2026-03-01' } });
    fireEvent.keyDown(endInput, { key: 'Enter' });

    await user.click(screen.getAllByRole('button', { name: 'Enter date manually' })[0]);
    const startInput = screen.getByPlaceholderText('DD.MM.YYYY');
    fireEvent.change(startInput, { target: { value: '2026-01-01' } });
    fireEvent.keyDown(startInput, { key: 'Enter' });

    await submitNewTrip(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: '2026-01-01', end_date: '2026-03-01' })
    ));
  });

  it('FE-COMP-TRIPFORM-067: the day count is clamped to the 1..MAX_TRIP_DAYS range', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    const dayInput = document.querySelector(`input[max="${MAX_TRIP_DAYS}"]`) as HTMLInputElement;
    fireEvent.change(dayInput, { target: { value: String(MAX_TRIP_DAYS + 1) } });
    expect(dayInput.value).toBe(String(MAX_TRIP_DAYS));

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Long Trip');
    await submitNewTrip(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ day_count: MAX_TRIP_DAYS })));
  });

  it('FE-COMP-TRIPFORM-068: a currency without a known symbol is labelled with its code', () => {
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, currency: 'XTS' })} />);
    expect(screen.getByText('XTS (XTS)')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-069: a reminder preset is sent on save', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { tripRemindersEnabled: true });
    const onSave = vi.fn().mockResolvedValue({});
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Reminder Trip');
    await user.click(screen.getByRole('button', { name: '9 days' }));
    await submitNewTrip(user);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ reminder_days: 9 })));
  });

  it('FE-COMP-TRIPFORM-070: switching to a custom reminder seeds 7 and clamps an empty value to 1', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { tripRemindersEnabled: true });
    const onSave = vi.fn().mockResolvedValue({});
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    const custom = document.querySelector('input[max="30"]') as HTMLInputElement;
    expect(custom.value).toBe('7');

    fireEvent.change(custom, { target: { value: '' } });
    expect(custom.value).toBe('1');

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Custom Reminder');
    await submitNewTrip(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ reminder_days: 1 })));
  });

  it('FE-COMP-TRIPFORM-071: a trip with a custom reminder opens on the Custom tab', async () => {
    seedStore(useAuthStore, { user: buildUser({ id: 1 }), tripRemindersEnabled: true });
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, user_id: 1, reminder_days: 14 })} />);

    const custom = document.querySelector('input[max="30"]') as HTMLInputElement;
    expect(custom.value).toBe('14');
  });

  // ── Members while editing ─────────────────────────────────────────────────

  /** The member chips are `getMembers(1).members` — tripMembers rows joined to
   *  the localUsers roster. The picker options come from the same table. */
  const editMembersSeed = async (members: { id: number; username: string }[]) => {
    await seedRoster({ id: 100, name: 'alice' }, { id: 200, name: 'bob' });
    await db.tripMembers.bulkPut(members.map(m => ({
      tripId: 1, id: m.id, username: m.username, role: 'member',
      added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'me', is_guest: false,
    })) as LocalTripMember[]);
  };

  it('FE-COMP-TRIPFORM-072: clicking a member chip removes them, the own chip is inert', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    let removedId: number | null = null;
    await editMembersSeed([{ id: 1, username: 'me' }, { id: 100, username: 'alice' }]);
    // removeMember is local — record the userId and let the real row delete.
    const realRemove = tripsApi.removeMember.bind(tripsApi);
    vi.spyOn(tripsApi, 'removeMember').mockImplementation(async (id, userId) => {
      removedId = Number(userId);
      return realRemove(id, userId);
    });
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, title: 'Crew' })} />);

    const own = await screen.findByText('me');
    await user.click(own);
    expect(removedId).toBeNull();

    await user.click(screen.getByText('alice'));
    await waitFor(() => expect(removedId).toBe(100));
    // removedId flips inside the spy, before the awaited removeMember resolves
    // and the success toast fires — wait for it the way the error twin does.
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('alice removed', 'success', undefined));
    await waitFor(() => expect(screen.queryByText('alice')).not.toBeInTheDocument());
    expect(await db.tripMembers.get([1, 100])).toBeUndefined();
  });

  it('FE-COMP-TRIPFORM-073: a failing member removal keeps the chip', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    await editMembersSeed([{ id: 100, username: 'alice' }]);
    vi.spyOn(tripsApi, 'removeMember').mockRejectedValue(new LocalApiError(500, 'nope'));
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, title: 'Crew' })} />);

    await user.click(await screen.findByText('alice'));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Failed to remove', 'error', undefined));
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-074: picking a user while editing adds them straight away', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    let identifier: string | null = null;
    await editMembersSeed([{ id: 100, username: 'alice' }]);
    // The local adapter resolves identifiers against the roster (self-only) —
    // capture the identifier the modal hands it instead of writing a row.
    vi.spyOn(tripsApi, 'addMember').mockImplementation(async (_id, ident) => {
      identifier = ident;
      return { member: { id: 200, username: ident, avatar: null, avatar_url: null, role: 'member' } };
    });
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, title: 'Crew' })} />);

    await screen.findByText('alice');
    await user.click(screen.getByText('Add member').closest('button')!);
    // alice is already a member, so the option list offers only bob (her chip
    // outside the list is a button of its own — that is what removes her).
    const bobOption = await screen.findByRole('button', { name: 'bob' });
    expect(within(bobOption.parentElement!).queryByRole('button', { name: 'alice' })).toBeNull();
    await user.click(bobOption);

    await waitFor(() => expect(identifier).toBe('bob'));
    expect(addToast).toHaveBeenCalledWith('bob added', 'success', undefined);
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-075: a failing member add while editing shows an error', async () => {
    const user = userEvent.setup();
    seedStore(useAuthStore, { user: buildUser({ id: 1, username: 'me' }), isAuthenticated: true });
    await editMembersSeed([{ id: 100, username: 'alice' }]);
    vi.spyOn(tripsApi, 'addMember').mockRejectedValue(new LocalApiError(500, 'nope'));
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, title: 'Crew' })} />);

    await screen.findByText('alice');
    await user.click(screen.getByText('Add member').closest('button')!);
    await user.click(await screen.findByRole('button', { name: 'bob' }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Failed to add', 'error', undefined));
  });

  // ── Save error paths ──────────────────────────────────────────────────────

  it('FE-COMP-TRIPFORM-076: a non-Error rejection falls back to the generic save error', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue('boom');
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Broken');
    await submitNewTrip(user);

    expect(await screen.findByText('Failed to save')).toBeInTheDocument();
  });

  it('FE-COMP-TRIPFORM-077: a save error from the date-shift step is shown on that step', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error('Shift failed'));
    render(<TripFormModal {...defaultProps} trip={buildTrip({ id: 1, title: 'Dated', start_date: '2025-06-01', end_date: '2025-06-05' })} onSave={onSave} />);

    await changeStartDate(user, '2025-05-31');
    await user.click(screen.getByRole('button', { name: /Update/i }));
    await screen.findByText('Keep bookings on their dates');

    await user.click(screen.getByRole('button', { name: /Update/i }));

    await waitFor(() => expect(screen.getAllByText('Shift failed').length).toBeGreaterThan(0));
    expect(screen.getByText('Keep bookings on their dates')).toBeInTheDocument();
  });


  it('FE-COMP-TRIPFORM-079: a typed description is sent on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    render(<TripFormModal {...defaultProps} trip={null} onSave={onSave} />);

    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Described');
    await user.type(screen.getByPlaceholderText(/What is this trip about/i), '  Two weeks off  ');
    await submitNewTrip(user);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Two weeks off' })
    ));
  });


  // A slow first search must never overwrite the results of a newer one (#1277).


  it('FE-COMP-TRIPFORM-083: a closed modal fetches nothing until it is opened', async () => {
    // The trip planner keeps the modal mounted behind the page. Both roster and
    // members are local Dexie reads — the spies record the calls the way the
    // msw handlers did.
    const seen: string[] = [];
    const realToArray = db.localUsers.toArray.bind(db.localUsers);
    vi.spyOn(db.localUsers, 'toArray').mockImplementation(() => {
      seen.push('users');
      return realToArray();
    });
    const realGetMembers = tripsApi.getMembers.bind(tripsApi);
    vi.spyOn(tripsApi, 'getMembers').mockImplementation(async (id) => {
      seen.push('members');
      return realGetMembers(id);
    });
    const trip = buildTrip({ id: 5 });
    const { rerender } = render(<TripFormModal {...defaultProps} isOpen={false} trip={trip} />);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen).toEqual([]);

    rerender(<TripFormModal {...defaultProps} isOpen trip={trip} />);
    await waitFor(() => expect(seen).toContain('users'));
    expect(seen).toContain('members');
  });


  it('FE-COMP-TRIPFORM-085: a trip longer than a year is saved with its full range (#2403)', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    const trip = buildTrip({ id: 1, title: 'Gap year', start_date: '2025-01-26', end_date: '2026-01-28' });
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: /Update/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: '2025-01-26', end_date: '2026-01-28' })
    ));
  });

  it('FE-COMP-TRIPFORM-086: a range past MAX_TRIP_DAYS is refused before anything is sent', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const trip = buildTrip({ id: 1, title: 'Week', start_date: '2026-01-01', end_date: '2026-01-07' });
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);

    await user.click(screen.getAllByRole('button', { name: 'Enter date manually' })[1]);
    const endInput = screen.getByPlaceholderText('DD.MM.YYYY');
    fireEvent.change(endInput, { target: { value: '2036-01-01' } });
    fireEvent.keyDown(endInput, { key: 'Enter' });

    await user.click(screen.getByRole('button', { name: /Update/i }));
    await screen.findByText(`A trip can span at most ${MAX_TRIP_DAYS} days`);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-COMP-TRIPFORM-087: a trip stored with a longer range can still be renamed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({});
    const trip = buildTrip({ id: 1, title: 'Legacy', start_date: '2020-01-01', end_date: '2030-01-01' });
    render(<TripFormModal {...defaultProps} trip={trip} onSave={onSave} />);
    await user.clear(screen.getByPlaceholderText(/Summer in Japan/i));
    await user.type(screen.getByPlaceholderText(/Summer in Japan/i), 'Renamed');
    await user.click(screen.getByRole('button', { name: /Update/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Renamed', start_date: '2020-01-01', end_date: '2030-01-01' })
    ));
  });
});
