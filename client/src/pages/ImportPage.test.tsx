// IMPORT-PAGE-001 to IMPORT-PAGE-005 — the /import page end to end over
// fake-indexeddb: a real encodeTrip token decodes to the preview, "Save to my
// device" runs saveBundle and navigates to the fresh trip, and the bad-input
// states fail visibly instead of hanging.
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import { Route, Routes, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen } from '../../tests/helpers/render';

import { buildDay, buildPlace, buildTrip } from '../../tests/helpers/factories';
import { resetAllStores } from '../../tests/helpers/store';
import { db } from '../db/panelmintDb';
import { encodeTrip } from '../share/codec';
import ImportPage from './ImportPage';

const SELF = { id: 1, name: 'Me', is_self: 1 as const };

type AddToast = NonNullable<typeof window.__addToast>;
let addToast: Mock<AddToast>;

function TripDest() {
  const { id } = useParams();
  return <div data-testid="trip-dest">{id}</div>;
}

function renderAt(entry: string) {
  return render(
    <Routes>
      <Route path="/import" element={<ImportPage />} />
      <Route path="/trips/:id" element={<TripDest />} />
      <Route path="/dashboard" element={<div>dashboard-dest</div>} />
    </Routes>,
    { initialEntries: [entry] }
  );
}

beforeEach(async () => {
  resetAllStores();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
  addToast = vi.fn<AddToast>(() => 0);
  window.__addToast = addToast;
});

afterEach(() => {
  delete window.__addToast;
  vi.restoreAllMocks();
});

describe('ImportPage', () => {
  it('IMPORT-PAGE-001 — a share link decodes to the preview and saves a fresh trip', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Japan Spring', description: 'cherry blossoms' }));
    await db.days.put(buildDay({ id: 2, trip_id: 1, day_number: 1 }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1, name: 'Shrine' }));
    const token = await encodeTrip(1);

    const user = userEvent.setup();
    renderAt(`/import?d=${token}`);

    // Preview: the bundle's real contents, not the local row.
    expect(await screen.findByRole('heading', { name: 'Japan Spring' })).toBeInTheDocument();
    expect(screen.getByText('cherry blossoms')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save to my device' }));

    const dest = await screen.findByTestId('trip-dest');
    const newId = Number(dest.textContent);
    expect(newId).not.toBe(1);
    expect(addToast).toHaveBeenCalledWith('Trip imported', 'success', undefined);

    // The import really persisted: a new trip row plus its remapped children.
    const trip = await db.trips.get(newId);
    expect(trip?.title).toBe('Japan Spring');
    expect(trip?.user_id).toBe(1);
    expect((await db.days.where('trip_id').equals(newId).first())!.id).not.toBe(2);
    expect(await db.places.where('trip_id').equals(newId).count()).toBe(1);
  });

  it('IMPORT-PAGE-002 — a second click mid-save cannot double-import', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Solo' }));
    const token = await encodeTrip(1);

    const user = userEvent.setup();
    renderAt(`/import?d=${token}`);
    const save = await screen.findByRole('button', { name: 'Save to my device' });
    await user.click(save);
    await user.click(save);

    await screen.findByTestId('trip-dest');
    expect(await db.trips.count()).toBe(2); // source + exactly one copy
  });

  it('IMPORT-PAGE-003 — no payload shows the no-data error, not a spinner', async () => {
    renderAt('/import');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This link does not carry a trip — ask for a fresh share link or the .panelmint.json file.'
    );
  });

  it('IMPORT-PAGE-004 — a ?src= pointing off-origin is refused without a fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderAt('/import?src=https%3A%2F%2Fevil.example%2Ftrip.json');
    expect(await screen.findByRole('alert')).toHaveTextContent('This import link is not valid.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('IMPORT-PAGE-005 — a corrupt token shows the friendly decode error', async () => {
    renderAt('/import?d=%%%');
    expect(await screen.findByRole('alert')).toHaveTextContent(/PanelMint trip/);
  });
});
