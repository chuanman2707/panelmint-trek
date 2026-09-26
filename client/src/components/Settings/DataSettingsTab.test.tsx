/**
 * FE-COMP-DATA-001 onwards — the Settings ▸ Data backup surface. "Export all"
 * packs every trip into the panelmint-archive `.panelmint.json` via
 * downloadAllTripsFile (spy on the real implementation so codec → downloadBlob
 * is exercised end to end), "Import from file" decodes a single trip file or
 * an archive and saves each bundle through saveBundle, and the sample row
 * navigates to the bundled Nha Trang itinerary's /import preview.
 */
import 'fake-indexeddb/auto';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '../../../tests/helpers/render';
import { Route, Routes } from 'react-router';
import { db } from '../../db/panelmintDb';
import { buildTrip } from '../../../tests/helpers/factories';
import { resetAllStores } from '../../../tests/helpers/store';
import { downloadAllTripsFile } from '../../share/actions';
import { saveBundle } from '../../share/remap';
import { downloadBlob } from '../../utils/fileDownload';
import DataSettingsTab from './DataSettingsTab';

vi.mock('../../share/remap', () => ({ saveBundle: vi.fn() }));
vi.mock('../../utils/fileDownload', () => ({ downloadBlob: vi.fn() }));
// Keep the real downloadAllTripsFile under a spy — the codec/db chain runs for
// real against fake-indexeddb, only the browser download itself is stubbed.
vi.mock('../../share/actions', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../share/actions')>();
  return { ...mod, downloadAllTripsFile: vi.fn(mod.downloadAllTripsFile) };
});

type AddToast = NonNullable<typeof window.__addToast>;
let addToast: Mock<AddToast>;

const SELF = { id: 1, name: 'Me', is_self: 1 as const };

/** A minimal valid single-trip .panelmint.json payload. */
const bundleJson = (title: string) =>
  JSON.stringify({
    v: 1,
    trip: { id: 900, user_id: 55, title, currency: 'EUR', is_archived: 0, reminder_days: 7 },
  });

/** An export-all archive carrying one bundle per listed title. */
const archiveJson = (...titles: string[]) =>
  JSON.stringify({
    v: 1,
    kind: 'panelmint-archive',
    exported_at: '2025-05-01T08:00:00.000Z',
    trips: titles.map((title) => JSON.parse(bundleJson(title))),
  });

const pick = (input: HTMLInputElement, name: string, contents: string) =>
  fireEvent.change(input, {
    target: { files: [new File([contents], name, { type: 'application/json' })] },
  });

beforeEach(async () => {
  resetAllStores();
  vi.clearAllMocks();
  vi.mocked(saveBundle).mockResolvedValue(1);
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
  addToast = vi.fn<AddToast>(() => 0);
  window.__addToast = addToast;
});

afterEach(() => {
  delete window.__addToast;
});

const importInput = () => screen.getByTestId('data-import-file') as HTMLInputElement;

describe('DataSettingsTab', () => {
  it('FE-COMP-DATA-001: renders the backup section with its three actions', () => {
    render(<DataSettingsTab />);
    expect(screen.getByText('Backup & restore')).toBeInTheDocument();
    expect(screen.getByText('Export all trips')).toBeInTheDocument();
    expect(screen.getByText('Import from file')).toBeInTheDocument();
    expect(screen.getByText('Sample trip')).toBeInTheDocument();
  });

  it('FE-COMP-DATA-002: export-all downloads panelmint-backup-<date>.panelmint.json holding the archive', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'One trip' }));
    const user = userEvent.setup();
    render(<DataSettingsTab />);

    await user.click(screen.getByRole('button', { name: /export all trips/i }));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadAllTripsFile).toHaveBeenCalledTimes(1);
    const [blob, name] = vi.mocked(downloadBlob).mock.calls[0] as [Blob, string];
    expect(name).toMatch(/^panelmint-backup-\d{4}-\d{2}-\d{2}\.panelmint\.json$/);
    const archive = JSON.parse(await blob.text()) as {
      kind: string;
      v: number;
      trips: { trip: { title: string } }[];
    };
    expect(archive.kind).toBe('panelmint-archive');
    expect(archive.v).toBe(1);
    expect(archive.trips.map((t) => t.trip.title)).toEqual(['One trip']);
    expect(addToast).toHaveBeenCalledWith('Backup downloaded', 'success', undefined);
  });

  it('FE-COMP-DATA-003: export with no trips toasts "empty" and downloads nothing', async () => {
    const user = userEvent.setup();
    render(<DataSettingsTab />);

    await user.click(screen.getByRole('button', { name: /export all trips/i }));

    await waitFor(() => expect(downloadAllTripsFile).toHaveBeenCalledTimes(1));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('There are no trips to export yet', 'info', undefined);
  });

  it('FE-COMP-DATA-004: an export failure surfaces the thrown message', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    vi.mocked(downloadAllTripsFile).mockRejectedValueOnce(new Error('quota exceeded'));
    const user = userEvent.setup();
    render(<DataSettingsTab />);

    await user.click(screen.getByRole('button', { name: /export all trips/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith('quota exceeded', 'error', undefined));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('FE-COMP-DATA-005: the import row opens the file picker', async () => {
    const user = userEvent.setup();
    render(<DataSettingsTab />);
    const clickSpy = vi.spyOn(importInput(), 'click');

    await user.click(screen.getByRole('button', { name: /import from file/i }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('FE-COMP-DATA-006: a single-trip file saves one bundle and reports the count', async () => {
    render(<DataSettingsTab />);
    const input = importInput();

    pick(input, 'lisbon.panelmint.json', bundleJson('Lisbon weekend'));

    await waitFor(() => expect(saveBundle).toHaveBeenCalledTimes(1));
    expect(saveBundle).toHaveBeenCalledWith(
      expect.objectContaining({ trip: expect.objectContaining({ title: 'Lisbon weekend' }) })
    );
    expect(addToast).toHaveBeenCalledWith('1 trips imported', 'success', undefined);
    // The pick is cleared — choosing the same file again still fires change.
    expect(input.value).toBe('');
  });

  it('FE-COMP-DATA-007: an archive file saves every member bundle', async () => {
    render(<DataSettingsTab />);

    pick(importInput(), 'backup.panelmint.json', archiveJson('Lisbon', 'Kyoto'));

    await waitFor(() => expect(saveBundle).toHaveBeenCalledTimes(2));
    expect(addToast).toHaveBeenCalledWith('2 trips imported', 'success', undefined);
  });

  it('FE-COMP-DATA-008: a mid-import failure reports how many trips already saved', async () => {
    vi.mocked(saveBundle).mockReset();
    vi.mocked(saveBundle)
      .mockResolvedValueOnce(11)
      .mockRejectedValueOnce(new Error('disk full'));
    render(<DataSettingsTab />);

    pick(importInput(), 'backup.panelmint.json', archiveJson('Lisbon', 'Kyoto', 'Oslo'));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Import stopped — 1 trips were saved before it failed', 'error', undefined)
    );
    expect(saveBundle).toHaveBeenCalledTimes(2);
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining('imported'), 'success', undefined);
  });

  it('FE-COMP-DATA-009: a file that is not a PanelMint export gets the codec error, no saves', async () => {
    render(<DataSettingsTab />);

    pick(importInput(), 'random.json', '{definitely not a bundle');

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringContaining('PanelMint'), 'error', undefined)
    );
    expect(saveBundle).not.toHaveBeenCalled();
  });

  it('FE-COMP-DATA-010: the sample row navigates to the bundled itinerary import preview', async () => {
    const user = userEvent.setup();
    render(
      <Routes>
        <Route path="/" element={<DataSettingsTab />} />
        <Route path="/import" element={<div data-testid="import-dest" />} />
      </Routes>
    );

    await user.click(screen.getByRole('button', { name: /sample trip/i }));

    await screen.findByTestId('import-dest');
  });
});
