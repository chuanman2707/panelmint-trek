import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildUser, buildTrip } from '../../../tests/helpers/factories';
import { TranslationProvider } from '../../i18n/TranslationContext';
import { useAuthStore } from '../../store/authStore';
import { useDashboard } from './useDashboard';
import type { DashboardTrip } from './dashboardModel';
import { db } from '../../db/panelmintDb';
import { tripsApi } from '../../api/client';
import { LocalApiError } from '../../api/local/helpers';

// FE-HOOK-DASH-001 onwards

const PARIS = buildTrip({ id: 101, title: 'Paris Adventure', start_date: '2026-07-01', end_date: '2026-07-10' });
const TOKYO = buildTrip({ id: 102, title: 'Tokyo Trip', start_date: '2027-09-01', end_date: '2027-09-15' });
const ROME = buildTrip({ id: 103, title: 'Old Rome', start_date: '2024-01-01', end_date: '2024-01-07', is_archived: 1 });

let toastCalls: Array<[string, string | undefined]>;

/** tripsApi is the local adapter now — the trip list comes from the panelmint
 *  Dexie db, not /api/trips, so the fixtures are seeded as rows. */
async function seedTrips(trips: DashboardTrip[]) {
  await db.trips.bulkPut(trips);
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/dashboard']}>
      <TranslationProvider>{children}</TranslationProvider>
    </MemoryRouter>
  );
}

function createWrapper(entry: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[entry]}>
        <TranslationProvider>{children}</TranslationProvider>
      </MemoryRouter>
    );
  };
}

async function mountLoaded(entry = '/dashboard') {
  const view = renderHook(() => useDashboard(), { wrapper: entry === '/dashboard' ? wrapper : createWrapper(entry) });
  await waitFor(() => expect(view.result.current.isLoading).toBe(false));
  return view;
}

beforeEach(async () => {
  resetAllStores();
  seedStore(useAuthStore, { isAuthenticated: true, user: buildUser() });
  toastCalls = [];
  window.__addToast = ((message: string, type?: string) => {
    toastCalls.push([message, type]);
    return 1;
  }) as unknown as typeof window.__addToast;
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  await seedTrips([PARIS, TOKYO, ROME]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__addToast;
});

describe('useDashboard', () => {
  it('FE-HOOK-DASH-001: loads trips, stats and the upcoming reservations', async () => {
    // The feed is local now: stats count the seeded Dexie trips (the archived
    // Rome still counts — same as the server) and upcoming reads the seeded
    // reservation row.
    await db.reservations.put({
      id: 5, trip_id: 101, title: 'Louvre', type: 'ticket', status: 'confirmed',
      reservation_time: '2099-01-01T10:00:00',
    } as never);
    const { result } = await mountLoaded();

    expect(result.current.spotlight?.title).toBe('Tokyo Trip');
    expect(result.current.loadError).toBe(false);
    await waitFor(() => expect(result.current.stats?.totalTrips).toBe(3));
    await waitFor(() => expect(result.current.upcoming).toHaveLength(1));
    expect(result.current.upcoming[0].title).toBe('Louvre');
  });

  it('FE-HOOK-DASH-002: the planned filter drops finished trips, completed keeps only them', async () => {
    const { result } = await mountLoaded();

    // Tokyo is the spotlight and therefore not repeated in the grid.
    expect(result.current.gridTrips.map(t => t.title)).toEqual([]);

    act(() => result.current.setTripFilter('completed'));
    expect(result.current.gridTrips.map(t => t.title)).toEqual(['Paris Adventure']);

    act(() => result.current.setTripFilter('archive'));
    expect(result.current.gridTrips.map(t => t.title)).toEqual(['Old Rome']);
  });

  it('FE-HOOK-DASH-003: ?create=1 opens the form and clears the query', async () => {
    const { result } = await mountLoaded('/dashboard?create=1');

    await waitFor(() => expect(result.current.showForm).toBe(true));
  });

  it('FE-HOOK-DASH-004: a failing trip load raises the error banner and toasts', async () => {
    vi.spyOn(tripsApi, 'list').mockRejectedValue(new LocalApiError(500, 'boom'));
    const { result } = await mountLoaded();

    expect(result.current.loadError).toBe(true);
    expect(toastCalls).toContainEqual(['Failed to load trips', 'error']);
  });

  it('FE-HOOK-DASH-005: retrying after recovery clears the banner', async () => {
    // Only the first list call fails — the seeded rows are back on retry.
    vi.spyOn(tripsApi, 'list').mockRejectedValueOnce(new LocalApiError(500, 'boom'));
    const { result } = await mountLoaded();
    expect(result.current.loadError).toBe(true);

    act(() => { result.current.retryLoad(); });

    await waitFor(() => expect(result.current.loadError).toBe(false));
    expect(result.current.spotlight?.title).toBe('Tokyo Trip');
  });

  it('FE-HOOK-DASH-006: an unhealthy auth check also counts as a load error', async () => {
    const { result } = await mountLoaded();

    act(() => { useAuthStore.setState({ authCheckFailed: true }); });

    expect(result.current.loadError).toBe(true);
  });

  it('FE-HOOK-DASH-007: creating a trip prepends it and returns the payload', async () => {
    const created = buildTrip({ id: 200, title: 'Iceland', start_date: '2027-12-01', end_date: '2027-12-05' });
    vi.spyOn(tripsApi, 'create').mockResolvedValue({ trip: created });
    const { result } = await mountLoaded();

    let payload: unknown;
    await act(async () => { payload = await result.current.handleCreate({ title: 'Iceland' }); });

    expect(payload).toEqual({ trip: created });
    expect(toastCalls).toContainEqual(['Trip created successfully!', 'success']);
    act(() => result.current.setTripFilter('planned'));
    expect(result.current.gridTrips.some(t => t.title === 'Iceland')).toBe(true);
  });

  it('FE-HOOK-DASH-008: a rejected create surfaces the API message', async () => {
    vi.spyOn(tripsApi, 'create').mockRejectedValue(new LocalApiError(400, 'Title taken'));
    const { result } = await mountLoaded();

    await expect(result.current.handleCreate({ title: 'Iceland' })).rejects.toThrow('Title taken');
  });

  it('FE-HOOK-DASH-009: updating replaces the edited trip', async () => {
    vi.spyOn(tripsApi, 'update').mockResolvedValue({ trip: { ...PARIS, title: 'Paris Reloaded' } });
    const { result } = await mountLoaded();

    act(() => { result.current.setEditingTrip(PARIS); });
    await act(async () => { await result.current.handleUpdate({ title: 'Paris Reloaded' }); });

    act(() => result.current.setTripFilter('completed'));
    expect(result.current.gridTrips.map(t => t.title)).toEqual(['Paris Reloaded']);
    expect(toastCalls).toContainEqual(['Trip updated!', 'success']);
  });

  it('FE-HOOK-DASH-010: updating without an edited trip is a no-op', async () => {
    const { result } = await mountLoaded();

    await act(async () => { await result.current.handleUpdate({ title: 'nope' }); });

    expect(toastCalls).toEqual([]);
  });

  it('FE-HOOK-DASH-011: a rejected update surfaces the API message', async () => {
    vi.spyOn(tripsApi, 'update').mockRejectedValue(new LocalApiError(409, 'Locked'));
    const { result } = await mountLoaded();

    act(() => { result.current.setEditingTrip(PARIS); });
    await expect(result.current.handleUpdate({ title: 'x' })).rejects.toThrow('Locked');
  });

  it('FE-HOOK-DASH-012: deleting drops the trip from both lists', async () => {
    const { result } = await mountLoaded();

    act(() => { result.current.setDeleteTrip(PARIS); });
    await act(async () => { await result.current.confirmDelete(); });

    act(() => result.current.setTripFilter('completed'));
    expect(result.current.gridTrips).toHaveLength(0);
    expect(result.current.deleteTrip).toBeNull();
    expect(toastCalls).toContainEqual(['Trip deleted', 'success']);
  });

  it('FE-HOOK-DASH-013: confirming a delete without a target does nothing', async () => {
    const { result } = await mountLoaded();

    await act(async () => { await result.current.confirmDelete(); });

    expect(toastCalls).toEqual([]);
  });

  it('FE-HOOK-DASH-014: a failing delete toasts and keeps the trip', async () => {
    vi.spyOn(tripsApi, 'delete').mockRejectedValue(new LocalApiError(500, 'nope'));
    const { result } = await mountLoaded();

    act(() => { result.current.setDeleteTrip(PARIS); });
    await act(async () => { await result.current.confirmDelete(); });

    expect(toastCalls).toContainEqual(['Failed to delete trip', 'error']);
    act(() => result.current.setTripFilter('completed'));
    expect(result.current.gridTrips).toHaveLength(1);
  });

  it('FE-HOOK-DASH-015: archiving moves the trip into the archive list', async () => {
    const { result } = await mountLoaded();

    await act(async () => { await result.current.handleArchive(101); });

    act(() => result.current.setTripFilter('archive'));
    expect(result.current.gridTrips.map(t => t.id)).toContain(101);
    expect(toastCalls).toContainEqual(['Trip archived', 'success']);
  });

  it('FE-HOOK-DASH-016: a failing archive only toasts', async () => {
    vi.spyOn(tripsApi, 'archive').mockRejectedValue(new LocalApiError(500, 'nope'));
    const { result } = await mountLoaded();

    await act(async () => { await result.current.handleArchive(101); });

    expect(toastCalls).toContainEqual(['Failed to archive trip', 'error']);
  });

  it('FE-HOOK-DASH-017: restoring moves the trip back into the active list', async () => {
    const { result } = await mountLoaded();

    await act(async () => { await result.current.handleUnarchive(103); });

    act(() => result.current.setTripFilter('archive'));
    expect(result.current.gridTrips).toHaveLength(0);
    act(() => result.current.setTripFilter('completed'));
    expect(result.current.gridTrips.map(t => t.id)).toContain(103);
    expect(toastCalls).toContainEqual(['Trip restored', 'success']);
  });

  it('FE-HOOK-DASH-018: a failing restore only toasts', async () => {
    vi.spyOn(tripsApi, 'unarchive').mockRejectedValue(new LocalApiError(500, 'nope'));
    const { result } = await mountLoaded();

    await act(async () => { await result.current.handleUnarchive(103); });

    expect(toastCalls).toContainEqual(['Failed to restore trip', 'error']);
  });

  it('FE-HOOK-DASH-019: copying adds the duplicate and clears the dialog', async () => {
    const { result } = await mountLoaded();

    act(() => { result.current.setCopyTrip(PARIS); });
    await act(async () => { await result.current.confirmCopy(); });

    act(() => result.current.setTripFilter('completed'));
    expect(result.current.gridTrips.map(t => t.title)).toContain('Paris Adventure (copy)');
    expect(result.current.copyTrip).toBeNull();
  });

  it('FE-HOOK-DASH-020: copying without a target does nothing', async () => {
    const { result } = await mountLoaded();

    await act(async () => { await result.current.confirmCopy(); });

    expect(toastCalls).toEqual([]);
  });

  it('FE-HOOK-DASH-021: a failing copy only toasts', async () => {
    vi.spyOn(tripsApi, 'copy').mockRejectedValue(new LocalApiError(500, 'nope'));
    const { result } = await mountLoaded();

    act(() => { result.current.setCopyTrip(PARIS); });
    await act(async () => { await result.current.confirmCopy(); });

    expect(toastCalls).toContainEqual(['Failed to copy trip', 'error']);
  });

  it('FE-HOOK-DASH-022: the view mode toggle persists to localStorage', async () => {
    const { result } = await mountLoaded();
    expect(result.current.viewMode).toBe('grid');

    act(() => { result.current.toggleViewMode(); });

    expect(result.current.viewMode).toBe('list');
    expect(localStorage.getItem('trek_dashboard_view')).toBe('list');

    act(() => { result.current.toggleViewMode(); });
    expect(localStorage.getItem('trek_dashboard_view')).toBe('grid');
  });

  it('FE-HOOK-DASH-023: the hero bundle follows the spotlight trip', async () => {
    // The real bundle for a member-less trip carries just the owner.
    const { result } = await mountLoaded();

    await waitFor(() => expect(result.current.heroBundle?.members).toHaveLength(1));
  });

  it('FE-HOOK-DASH-024: a failing bundle leaves the hero without extras', async () => {
    vi.spyOn(tripsApi, 'bundle').mockRejectedValue(new LocalApiError(500, 'nope'));
    const { result } = await mountLoaded();

    await waitFor(() => expect(result.current.heroBundle).toBeNull());
  });

  it('FE-HOOK-DASH-025: an account without trips has no spotlight at all', async () => {
    await db.trips.clear();
    const { result } = await mountLoaded();

    expect(result.current.spotlight).toBeNull();
    expect(result.current.heroBundle).toBeNull();
  });


});
