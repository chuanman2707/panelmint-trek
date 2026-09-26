// focusRefresh — the multi-tab refocus re-read (spec §17): a second tab's edits
// share the Dexie database but not this store, so the open trip is re-read when
// the tab regains visibility.
import 'fake-indexeddb/auto';
import { resetAllStores } from '../../tests/helpers/store';
import { buildDay, buildTrip } from '../../tests/helpers/factories';
import { db } from '../db/panelmintDb';
import type { DayRow } from '../api/local/dexieStore';
import { tripRepo } from '../repo/tripRepo';
import { useTripStore } from './tripStore';
import { installFocusRefresh, uninstallFocusRefresh } from './focusRefresh';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

async function seedTrip(): Promise<void> {
  await db.trips.put(buildTrip({ id: 1, title: 'Before' }));
  await db.days.bulkPut([{ ...buildDay({ id: 1, trip_id: 1, day_number: 1 }), vias: [] } as DayRow]);
}

beforeEach(async () => {
  resetAllStores();
  uninstallFocusRefresh();
  setVisibility('visible');
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
});

afterEach(() => {
  uninstallFocusRefresh();
  vi.restoreAllMocks();
});

describe('installFocusRefresh', () => {
  it('re-reads the open trip when the tab regains visibility', async () => {
    await seedTrip();
    await useTripStore.getState().loadTrip(1);
    installFocusRefresh();

    // The "other tab" edits land in Dexie behind this tab's back.
    await db.trips.update(1, { title: 'After' });
    await db.days.put({ ...buildDay({ id: 1, trip_id: 1, day_number: 1, notes_items: [] }), vias: [] } as DayRow);

    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(useTripStore.getState().trip?.title).toBe('After'));
  });

  it('does nothing while the tab stays hidden', async () => {
    await seedTrip();
    await useTripStore.getState().loadTrip(1);
    installFocusRefresh();
    const getSpy = vi.spyOn(tripRepo, 'get');

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('does nothing when no trip is open', async () => {
    installFocusRefresh();
    const getSpy = vi.spyOn(tripRepo, 'get');

    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('is idempotent — a second install does not stack a listener', async () => {
    await seedTrip();
    await useTripStore.getState().loadTrip(1);
    installFocusRefresh();
    installFocusRefresh();
    const getSpy = vi.spyOn(tripRepo, 'get');

    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(getSpy).toHaveBeenCalledTimes(1));
  });
});
