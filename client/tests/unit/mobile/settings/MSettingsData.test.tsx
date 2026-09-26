/**
 * FE-MOB-SETDATA-001 onwards — the mobile twin of Settings ▸ Data. Markup-only
 * over the shared useDataSettings hook: the three rows render, export reports
 * an empty library without downloading, the import row opens the file picker
 * and a picked bundle saves through saveBundle.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from '../../../helpers/render';
import { resetAllStores } from '../../../helpers/store';
import { downloadAllTripsFile } from '../../../../src/share/actions';
import { saveBundle } from '../../../../src/share/remap';
import MSettingsData from '../../../../src/mobile/screens/settings/MSettingsData';

vi.mock('../../../../src/share/actions', () => ({
  downloadAllTripsFile: vi.fn(),
}));
vi.mock('../../../../src/share/remap', () => ({ saveBundle: vi.fn() }));

type AddToast = NonNullable<typeof window.__addToast>;
let addToast: Mock<AddToast>;

const bundleJson = (title: string) =>
  JSON.stringify({
    v: 1,
    trip: { id: 900, user_id: 55, title, currency: 'EUR', is_archived: 0, reminder_days: 7 },
  });

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  vi.mocked(saveBundle).mockResolvedValue(1);
  addToast = vi.fn<AddToast>(() => 0);
  window.__addToast = addToast;
});

afterEach(() => {
  delete window.__addToast;
});

describe('MSettingsData', () => {
  it('FE-MOB-SETDATA-001: renders the backup card with export, import and sample rows', () => {
    render(<MSettingsData />);
    expect(screen.getByText('Backup & restore')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export all trips/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import from file/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sample trip/i })).toBeInTheDocument();
  });

  it('FE-MOB-SETDATA-002: export on an empty library toasts "empty" — nothing downloads', async () => {
    vi.mocked(downloadAllTripsFile).mockResolvedValue('empty');
    const user = userEvent.setup();
    render(<MSettingsData />);

    await user.click(screen.getByRole('button', { name: /export all trips/i }));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('There are no trips to export yet', 'info', undefined)
    );
    expect(downloadAllTripsFile).toHaveBeenCalledTimes(1);
  });

  it('FE-MOB-SETDATA-003: export success toasts the backup landing', async () => {
    vi.mocked(downloadAllTripsFile).mockResolvedValue('downloaded');
    const user = userEvent.setup();
    render(<MSettingsData />);

    await user.click(screen.getByRole('button', { name: /export all trips/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('Backup downloaded', 'success', undefined));
  });

  it('FE-MOB-SETDATA-004: the import row opens the picker and a picked file saves through saveBundle', async () => {
    const user = userEvent.setup();
    render(<MSettingsData />);
    const input = screen.getByTestId('data-import-file') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await user.click(screen.getByRole('button', { name: /import from file/i }));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(input, {
      target: {
        files: [new File([bundleJson('Lisbon weekend')], 'lisbon.panelmint.json', { type: 'application/json' })],
      },
    });

    await waitFor(() => expect(saveBundle).toHaveBeenCalledTimes(1));
    expect(addToast).toHaveBeenCalledWith('1 trips imported', 'success', undefined);
    expect(input.value).toBe('');
  });
});
