import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../../helpers/render';
import MNewTripSheet from '../../../../src/mobile/screens/dashboard/MNewTripSheet';
import { useAuthStore } from '../../../../src/store/authStore';
import { usePermissionsStore } from '../../../../src/store/permissionsStore';
import { useSettingsStore } from '../../../../src/store/settingsStore';
import { buildUser } from '../../../helpers/factories';
import type { DashboardTrip } from '../../../../src/pages/dashboard/dashboardModel';
import { MAX_TRIP_DAYS, type TripCreateRequest } from '@trek/shared';

// FE-MOB-NTSH-001 onwards

// The real pickers own a lot of unrelated calendar/portal behaviour; plain
// controls keep this suite on the sheet's own logic.
vi.mock('../../../../src/components/shared/CustomDateTimePicker', () => ({
  CustomDatePicker: ({ value, onChange, placeholder }: {
    value: string; onChange: (v: string) => void; placeholder: string
  }) => <input aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} />,
}));

vi.mock('../../../../src/components/shared/CustomSelect', () => ({
  default: ({ value, onChange, disabled }: {
    value: string; onChange: (v: string) => void; disabled?: boolean
  }) => (
    <select aria-label="currency" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="EUR">EUR</option>
      <option value="USD">USD</option>
    </select>
  ),
}));

function buildDashTrip(over: Partial<DashboardTrip> = {}): DashboardTrip {
  return {
    id: 42, user_id: 1, title: 'Japan 2026', currency: 'EUR', is_archived: 0,
    start_date: '2026-05-01', end_date: '2026-05-08',
    description: 'cherry blossoms', cover_image: '/uploads/covers/a.jpg',
    ...over,
  } as unknown as DashboardTrip;
}

let toastCalls: Array<[string, string | undefined]>;

beforeEach(() => {
  toastCalls = [];
  window.__addToast = ((message: string, type?: string) => {
    toastCalls.push([message, type]);
    return 1;
  }) as unknown as typeof window.__addToast;
  useAuthStore.setState({ isAuthenticated: true, user: buildUser({ id: 1, role: 'user' }) });
  usePermissionsStore.setState({ permissions: {} });
});

afterEach(() => {
  delete window.__addToast;
  useSettingsStore.setState(s => ({ settings: { ...s.settings, default_currency: '' } }));
  vi.restoreAllMocks();
});

describe('MNewTripSheet', () => {
  it('FE-MOB-NTSH-001: create mode shows the empty form plus the no-date hint', () => {
    render(<MNewTripSheet open trip={null} onClose={() => {}} onSave={() => {}} />);

    expect(screen.getByRole('dialog', { name: 'Create New Trip' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Summer in Japan')).toHaveValue('');
    expect(screen.getByText(/7 default days will be created/)).toBeInTheDocument();
  });

  it('FE-MOB-NTSH-001b: create mode defaults the currency to the user\'s default_currency (#1784)', () => {
    useSettingsStore.setState(s => ({ settings: { ...s.settings, default_currency: 'USD' } }));
    render(<MNewTripSheet open trip={null} onClose={() => {}} onSave={() => {}} />);

    expect(screen.getByLabelText('currency')).toHaveValue('USD');
  });

  it('FE-MOB-NTSH-002: edit mode preloads the trip and hides the no-date hint', () => {
    render(<MNewTripSheet open trip={buildDashTrip()} onClose={() => {}} onSave={() => {}} />);

    expect(screen.getByRole('dialog', { name: 'Edit Trip' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Summer in Japan')).toHaveValue('Japan 2026');
    expect(screen.getByPlaceholderText('What is this trip about?')).toHaveValue('cherry blossoms');
    expect(screen.getByLabelText('Start Date')).toHaveValue('2026-05-01');
    expect(screen.queryByText(/7 default days will be created/)).not.toBeInTheDocument();
  });

  it('FE-MOB-NTSH-003: an empty title blocks the save', () => {
    const onSave = vi.fn(async () => undefined);
    render(<MNewTripSheet open trip={null} onClose={() => {}} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create New Trip' }));

    expect(screen.getByText('Title is required')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-MOB-NTSH-004: an end date before the start blocks the save', () => {
    const onSave = vi.fn(async () => undefined);
    render(<MNewTripSheet open trip={null} onClose={() => {}} onSave={onSave} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Summer in Japan'), { target: { value: 'Iceland' } });
    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2026-06-10' } });
    fireEvent.change(screen.getByLabelText('End Date'), { target: { value: '2026-06-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create New Trip' }));

    expect(screen.getByText('End date must be after start date')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-MOB-NTSH-036: a range past MAX_TRIP_DAYS blocks the save (#2403)', () => {
    const onSave = vi.fn(async () => undefined);
    render(<MNewTripSheet open trip={null} onClose={() => {}} onSave={onSave} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Summer in Japan'), { target: { value: 'Decade' } });
    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('End Date'), { target: { value: '2036-01-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create New Trip' }));

    expect(screen.getByText(`A trip can span at most ${MAX_TRIP_DAYS} days`)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('FE-MOB-NTSH-005: a dateless create asks for the 7 default days and closes', async () => {
    const onSave = vi.fn(async (_data: TripCreateRequest) => undefined);
    const onClose = vi.fn();
    render(<MNewTripSheet open trip={null} onClose={onClose} onSave={onSave} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Summer in Japan'), { target: { value: '  Iceland  ' } });
    fireEvent.change(screen.getByPlaceholderText('What is this trip about?'), { target: { value: ' ring road ' } });
    fireEvent.change(screen.getByLabelText('currency'), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create New Trip' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      title: 'Iceland',
      description: 'ring road',
      start_date: null,
      end_date: null,
      currency: 'USD',
      day_count: 7,
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('FE-MOB-NTSH-006: moving the start keeps the trip length', () => {
    render(<MNewTripSheet open trip={buildDashTrip()} onClose={() => {}} onSave={() => {}} />);

    // 01.–08.05. is a 7-day span; shifting the start by a month keeps it.
    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2026-06-01' } });

    expect(screen.getByLabelText('End Date')).toHaveValue('2026-06-08');
  });

  it('FE-MOB-NTSH-007: a start without an end pulls the end date along', () => {
    render(<MNewTripSheet open trip={null} onClose={() => {}} onSave={() => {}} />);

    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2026-06-01' } });

    expect(screen.getByLabelText('End Date')).toHaveValue('2026-06-01');
  });

  it('FE-MOB-NTSH-008: a rejected save surfaces the error and keeps the sheet open', async () => {
    const onSave = vi.fn(async () => { throw new Error('Title already used'); });
    const onClose = vi.fn();
    render(<MNewTripSheet open trip={null} onClose={onClose} onSave={onSave} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Summer in Japan'), { target: { value: 'Iceland' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create New Trip' }));

    expect(await screen.findByText('Title already used')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });















  // The preview holds the whole picked file in memory until the url is released.




  it('FE-MOB-NTSH-025: archiving from the edit sheet runs the action and closes', () => {
    const onArchive = vi.fn();
    const onClose = vi.fn();
    render(<MNewTripSheet open trip={buildDashTrip()} onClose={onClose} onSave={() => {}} onArchive={onArchive} />);

    fireEvent.click(screen.getByText('Archive'));

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('FE-MOB-NTSH-026: an archived trip offers restore instead of archive', () => {
    render(
      <MNewTripSheet open trip={buildDashTrip({ is_archived: 1 })} onClose={() => {}} onSave={() => {}} onArchive={() => {}} />,
    );

    expect(screen.getByText('Restore')).toBeInTheDocument();
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  });

  it('FE-MOB-NTSH-027: without trip_edit the text fields are read-only', () => {
    usePermissionsStore.setState({ permissions: { trip_edit: 'trip_owner' } });
    render(<MNewTripSheet open trip={buildDashTrip({ user_id: 999 })} onClose={() => {}} onSave={() => {}} />);

    const title = screen.getByPlaceholderText('e.g. Summer in Japan');
    expect(title).toHaveAttribute('readonly');
    fireEvent.change(title, { target: { value: 'hijacked' } });
    expect(title).toHaveValue('Japan 2026');
    expect(screen.getByLabelText('currency')).toBeDisabled();
  });






  it('FE-MOB-NTSH-029: the cancel actions close without saving', () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => undefined);
    render(<MNewTripSheet open trip={null} onClose={onClose} onSave={onSave} />);

    // Both the header X and the footer button carry the cancel label.
    const cancels = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancels).toHaveLength(2);
    cancels.forEach(btn => fireEvent.click(btn));

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });
});
