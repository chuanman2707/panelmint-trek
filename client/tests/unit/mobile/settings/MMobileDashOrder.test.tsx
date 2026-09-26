// FE-MOB-SETDORD-001 onwards
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../../../helpers/render';
import { resetAllStores } from '../../../helpers/store';
import { DEFAULT_APPEARANCE, type AppearanceConfig, type MobileDashToken } from '@trek/shared';
import MMobileDashOrder from '../../../../src/mobile/screens/settings/MMobileDashOrder';

function buildCfg(over: Partial<AppearanceConfig['dashboard']> = {}): AppearanceConfig {
  return {
    ...DEFAULT_APPEARANCE,
    dashboard: { ...DEFAULT_APPEARANCE.dashboard, ...over },
  };
}

/** The label + badge wrapper of one block row. */
function blockRow(label: string): HTMLElement {
  return screen.getByText(label).parentElement!;
}

/** The visible block labels in DOM order. */
function rowLabels(): string[] {
  return screen.getAllByLabelText('Move up').map((btn) => {
    const row = btn.closest('div')!;
    return row.querySelector('span > span')!.textContent ?? '';
  });
}

describe('MMobileDashOrder', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('FE-MOB-SETDORD-001: renders the built-in order when nothing is stored', () => {
    render(<MMobileDashOrder cfg={buildCfg()} onChange={vi.fn()} />);

    expect(rowLabels()).toEqual(['Trips', 'Currency', 'Timezones', 'Upcoming reservations']);
  });

  it('FE-MOB-SETDORD-002: a stored order wins and missing tokens are appended', () => {
    render(<MMobileDashOrder cfg={buildCfg({ mobileOrder: ['timezones', 'trips'] })} onChange={vi.fn()} />);

    expect(rowLabels()).toEqual(['Timezones', 'Trips', 'Currency', 'Upcoming reservations']);
  });

  it('FE-MOB-SETDORD-002b: a stored retired token (collections) never renders', () => {
    render(<MMobileDashOrder cfg={buildCfg({ mobileOrder: ['trips', 'collections', 'timezones'] })} onChange={vi.fn()} />);

    expect(rowLabels()).toEqual(['Trips', 'Timezones', 'Currency', 'Upcoming reservations']);
  });

  it('FE-MOB-SETDORD-003: moving a block down emits the reordered token list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(order: MobileDashToken[]) => void>();
    render(<MMobileDashOrder cfg={buildCfg()} onChange={onChange} />);

    await user.click(screen.getAllByLabelText('Move down')[0]);
    expect(onChange).toHaveBeenCalledWith(['currency', 'trips', 'timezones', 'upcomingReservations']);
  });

  it('FE-MOB-SETDORD-004: moving a block up swaps it with its predecessor', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(order: MobileDashToken[]) => void>();
    render(<MMobileDashOrder cfg={buildCfg()} onChange={onChange} />);

    await user.click(screen.getAllByLabelText('Move up')[2]);
    expect(onChange).toHaveBeenCalledWith(['trips', 'timezones', 'currency', 'upcomingReservations']);
  });

  it('FE-MOB-SETDORD-005: the first row cannot move up and the last cannot move down', () => {
    render(<MMobileDashOrder cfg={buildCfg()} onChange={vi.fn()} />);

    const ups = screen.getAllByLabelText('Move up');
    const downs = screen.getAllByLabelText('Move down');
    expect(ups[0]).toBeDisabled();
    expect(ups[1]).not.toBeDisabled();
    expect(downs[downs.length - 1]).toBeDisabled();
    expect(downs[0]).not.toBeDisabled();
  });

  it('FE-MOB-SETDORD-006: a widget switched off is marked hidden, trips never is', () => {
    const cfg = buildCfg({
      mobile: { ...DEFAULT_APPEARANCE.dashboard.mobile, currency: false, timezones: false },
    });
    render(<MMobileDashOrder cfg={cfg} onChange={vi.fn()} />);

    expect(screen.getAllByText('Hidden')).toHaveLength(2);
    const tripsRow = blockRow('Trips');
    expect(tripsRow.textContent).not.toContain('Hidden');
  });

  it('FE-MOB-SETDORD-008: upcoming reservations follows its own mobile flag', () => {
    const cfg = buildCfg({
      mobile: { ...DEFAULT_APPEARANCE.dashboard.mobile, upcomingReservations: false },
    });
    render(<MMobileDashOrder cfg={cfg} onChange={vi.fn()} />);

    const row = blockRow('Upcoming reservations');
    expect(row.textContent).toContain('Hidden');
  });
});
