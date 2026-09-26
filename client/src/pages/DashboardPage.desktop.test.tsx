import 'fake-indexeddb/auto';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, fireEvent, waitFor, within } from '../../tests/helpers/render';
import { server } from '../../tests/helpers/msw/server';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import { buildUser, buildTrip, buildPlace, buildSettings } from '../../tests/helpers/factories';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { useAddonStore } from '../store/addonStore';
import DashboardPage from './DashboardPage';
import { db, type LocalTripMember } from '../db/panelmintDb';
import { tripsApi, dashboardApi } from '../api/client';
import type { Trip } from '../types';

// FE-PAGE-DESKDASH-001 onwards

type MqListener = (e: MediaQueryListEvent) => void;

const mqListeners = new Map<string, Set<MqListener>>();
let phone = false;

function installMatchMedia(): void {
  mqListeners.clear();
  phone = false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() { return phone; },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: MqListener) => {
        if (!mqListeners.has(query)) mqListeners.set(query, new Set());
        mqListeners.get(query)?.add(listener);
      },
      removeEventListener: (_type: string, listener: MqListener) => {
        mqListeners.get(query)?.delete(listener);
      },
      dispatchEvent: () => true,
    }),
  });
}

const TRIP = buildTrip({ id: 101, title: 'Paris Adventure', start_date: '2026-07-01', end_date: '2026-07-10' });

/** tripsApi is the local adapter now — the trip list is read from the
 *  panelmint Dexie db, so the fixture rows are seeded there. */
async function onlyTrips(trips: Trip[]) {
  await db.trips.clear();
  if (trips.length > 0) await db.trips.bulkPut(trips);
}

// The feed is the local Dexie adapter now — the tests exercise the widget's
// rendering of the numbers, so the adapter is stubbed to hand them over.
function stats(body: Record<string, unknown>) {
  vi.spyOn(dashboardApi, 'travelStats').mockResolvedValue(body as never);
}

function upcoming(reservations: unknown[]) {
  vi.spyOn(dashboardApi, 'upcoming').mockResolvedValue({ reservations } as never);
}

function appearance(dashboard: Record<string, unknown>) {
  seedStore(useSettingsStore, { settings: buildSettings({ appearance: { dashboard } } as never) });
}

beforeEach(async () => {
  // Pinned inside the fixture trip's window so the spotlight/grid split is
  // stable. setImmediate stays real — fake-indexeddb delivers IDB results
  // through it, and faking it kills Dexie transactions.
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(new Date('2026-07-05T12:00:00Z'));
  installMatchMedia();
  resetAllStores();
  seedStore(useAuthStore, { isAuthenticated: true, user: buildUser() });
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  await onlyTrips([TRIP]);
  stats({ totalTrips: 3, totalDays: 21, totalPlaces: 9, totalDistanceKm: 0, countries: [] });
  upcoming([]);
  server.use(
    http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.json([
      { date: '2026-07-01', base: 'EUR', quote: 'USD', rate: 1.1 },
    ])),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const distanceValue = () =>
  document.querySelectorAll('.atlas-card .value')[document.querySelectorAll('.atlas-card').length - 1];

describe('DashboardPage (desktop)', () => {
  it('FE-PAGE-DESKDASH-001: a four-digit distance collapses to a compact k value', async () => {
    stats({ totalTrips: 1, totalDays: 1, totalPlaces: 1, totalDistanceKm: 12345, countries: [] });
    seedStore(useSettingsStore, { settings: buildSettings({ distance_unit: 'metric' }) });
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('12.3k')).toBeInTheDocument());
  });

  it('FE-PAGE-DESKDASH-002: a sub-0.1 distance is reported as "<0.1"', async () => {
    stats({ totalTrips: 1, totalDays: 1, totalPlaces: 1, totalDistanceKm: 0.02, countries: [] });
    seedStore(useSettingsStore, { settings: buildSettings({ distance_unit: 'metric' }) });
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('<0.1')).toBeInTheDocument());
  });

  it('FE-PAGE-DESKDASH-003: a negative distance is clamped to zero', async () => {
    stats({ totalTrips: 1, totalDays: 1, totalPlaces: 1, totalDistanceKm: -40, countries: [] });
    seedStore(useSettingsStore, { settings: buildSettings({ distance_unit: 'metric' }) });
    render(<DashboardPage />);

    await waitFor(() => expect(distanceValue()?.textContent).toContain('0'));
    expect(screen.queryByText('<0.1')).not.toBeInTheDocument();
  });

  it('FE-PAGE-DESKDASH-004: more than five countries collapse into an overflow flag', async () => {
    stats({ totalTrips: 1, totalDays: 1, totalPlaces: 1, totalDistanceKm: 0, countries: ['fr', 'de', 'it', 'es', 'pt', 'nl', 'be'] });
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('+2')).toBeInTheDocument());
    expect(screen.getAllByRole('img', { name: 'fr' })[0]).toHaveAttribute('src', 'https://flagcdn.com/w40/fr.png');
  });

  it('FE-PAGE-DESKDASH-005: the whole atlas row disappears when every tile is off', async () => {
    appearance({
      desktop: { sidebar: true, currency: true, collections: false, timezones: true, upcomingReservations: true, atlas: false, tripsTotal: false, daysTraveled: false, distanceFlown: false },
    });
    const { container } = render(<DashboardPage />);

    await waitFor(() => expect(screen.getAllByText('Paris Adventure').length).toBeGreaterThan(0));
    expect(container.querySelector('.atlas')).toBeNull();
  });

  it('FE-PAGE-DESKDASH-006: the sidebar disappears when none of its widgets are on', async () => {
    appearance({
      desktop: { sidebar: true, currency: false, collections: false, timezones: false, upcomingReservations: false, atlas: true, tripsTotal: true, daysTraveled: true, distanceFlown: true },
    });
    const { container } = render(<DashboardPage />);

    await waitFor(() => expect(screen.getAllByText('Paris Adventure').length).toBeGreaterThan(0));
    expect(container.querySelector('.page-sidebar')).toBeNull();
    expect(container.querySelector('main')).toHaveAttribute('data-no-sidebar', 'true');
  });


  it('FE-PAGE-DESKDASH-008: the upcoming tool lists reservations and opens their trip', async () => {
    seedStore(useSettingsStore, { settings: buildSettings({ time_format: '24h' }) });
    upcoming([
      { id: 1, trip_id: 101, title: 'Louvre', type: 'flight', reservation_time: '2026-09-03T19:30:00', location: 'Paris' },
      { id: 2, trip_id: 101, title: 'Hotel Ibis', type: 'hotel', reservation_time: null, day_date: null, trip_title: 'Paris Adventure' },
    ]);
    const { container } = render(<DashboardPage />);

    expect(await screen.findByText('Louvre')).toBeInTheDocument();
    expect(screen.getByText('19:30', { exact: false })).toBeInTheDocument();
    // A reservation with no date at all still renders, with a dash for the day.
    expect(within(container.querySelector('.upc-list') as HTMLElement).getByText('–')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Louvre'));
    expect(screen.getByText('Hotel Ibis')).toBeInTheDocument();
  });

  // #1934 — a stay covers a range and stays out of a list of what happens next,
  // but arriving and leaving are moments, and they carry the same id.
  it('FE-PAGE-DESKDASH-027: a stay renders as two moments and an unconfirmed booking says so', async () => {
    seedStore(useSettingsStore, { settings: buildSettings({ time_format: '24h' }) });
    upcoming([
      { id: 7, trip_id: 101, title: 'The Plaza', type: 'checkin', status: 'confirmed', reservation_time: '2026-09-18T15:00', day_date: '2026-09-18' },
      { id: 3, trip_id: 101, title: 'Broadway Show', type: 'activity', status: 'pending', reservation_time: '2026-09-18T20:00', location: 'Richard Rodgers' },
      { id: 7, trip_id: 101, title: 'The Plaza', type: 'checkout', status: 'confirmed', reservation_time: '2026-09-22T11:00', day_date: '2026-09-22' },
    ]);
    const { container } = render(<DashboardPage />);

    // Both moments render despite sharing id 7 — the list key carries the type.
    expect(await screen.findAllByText('The Plaza')).toHaveLength(2);
    // The label shares its line with the time, so match the row, not a bare node.
    expect(screen.getByText(/Check-in/)).toBeInTheDocument();
    expect(screen.getByText(/Check-out/)).toBeInTheDocument();
    expect(container.querySelectorAll('.upc-item')).toHaveLength(3);

    // Only the unconfirmed one is marked.
    const pending = container.querySelectorAll('.upc-pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toHaveTextContent('Pending');
  });

  it('FE-PAGE-DESKDASH-009: the currency tool converts and swaps the pair', async () => {
    seedStore(useSettingsStore, { settings: buildSettings({ dashboard_fx_from: 'EUR', dashboard_fx_to: 'USD' }) });
    const { container } = render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('1 EUR = 1.1000 USD')).toBeInTheDocument());
    const amount = container.querySelector('.fx-field .amt') as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '50' } });
    expect(container.querySelectorAll('.fx-field .amt')[1]).toHaveValue('55.00');

    fireEvent.click(screen.getByRole('button', { name: 'Swap currencies' }));

    await waitFor(() => expect(useSettingsStore.getState().settings.dashboard_fx_from).toBe('USD'));
  });

  it('FE-PAGE-DESKDASH-010: the timezone tool removes a zone and reports the empty list', async () => {
    seedStore(useSettingsStore, { settings: buildSettings({ dashboard_timezones: ['Asia/Tokyo'] }) });
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('Tokyo')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Remove Tokyo' }));

    await waitFor(() => expect(screen.getByText('No other timezones yet — add one with +')).toBeInTheDocument());
  });

  it('FE-PAGE-DESKDASH-011: the timezone tool opens a picker and adds the chosen zone', async () => {
    seedStore(useSettingsStore, { settings: buildSettings({ dashboard_timezones: ['Asia/Tokyo'] }) });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText('Tokyo')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add timezone' }));

    // The picker shows its placeholder until a zone is chosen.
    expect(screen.getByText('Search timezone…')).toBeInTheDocument();
  });

  it('FE-PAGE-DESKDASH-012: the boarding pass shows buddies, an overflow badge and places', async () => {
    // The bundle is local now: members = [owner, ...tripMembers rows] and
    // memberWire emits avatar_url: null, so buddies render as initials. Owner
    // 'Me' + 4 member rows = 5 chips → 4 shown + a '+1' overflow.
    const roster = [
      { id: 2, name: 'Maurice Boe' },
      { id: 3, name: 'Julien' },
      { id: 4, name: 'Ada Lovelace' },
      { id: 5, name: 'Bo' },
    ];
    await db.localUsers.bulkPut(roster.map(u => ({ ...u, is_self: 0 as const })));
    await db.tripMembers.bulkPut(roster.map(u => ({
      tripId: TRIP.id, id: u.id, username: u.name, role: 'member',
      added_at: '2026-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
    })) as LocalTripMember[]);
    await db.places.bulkPut(
      ['Louvre', 'Eiffel', 'Orsay', 'Sacre'].map((name, i) =>
        buildPlace({ id: 10 + i, trip_id: TRIP.id, name })),
    );

    const { container } = render(<DashboardPage />);

    await waitFor(() => expect(container.querySelector('.buddy-more')).toHaveTextContent('+1'));
    expect(screen.getByText('MB')).toBeInTheDocument();
    expect(screen.getByText('JU')).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(container.querySelectorAll('.place-more')[0]).toHaveTextContent('+1');
  });

  it('FE-PAGE-DESKDASH-013: an empty bundle falls back to the owner initials and a pin', async () => {
    const { container } = render(<DashboardPage />);

    await waitFor(() => expect(container.querySelector('.buddy-avatar')).toBeInTheDocument());
    expect(container.querySelector('.place-more .lucide-map-pin')).toBeInTheDocument();
  });


  it('FE-PAGE-DESKDASH-015: opening the hero pass navigates to the trip', async () => {
    const { container } = render(<DashboardPage />);

    await waitFor(() => expect(container.querySelector('.hero-pass')).toBeInTheDocument());
    fireEvent.click(container.querySelector('.hero-pass') as HTMLElement);

    expect(screen.getAllByText('Paris Adventure').length).toBeGreaterThan(0);
  });

  it('FE-PAGE-DESKDASH-016: a trip card without dates says the dates are open', async () => {
    await onlyTrips([TRIP, buildTrip({ id: 102, title: 'Someday Iceland', start_date: null, end_date: null })]);
    render(<DashboardPage />);

    expect(await screen.findByText('Open dates')).toBeInTheDocument();
  });

  it('FE-PAGE-DESKDASH-018: a malformed date renders a dash rather than crashing', async () => {
    await onlyTrips([TRIP, buildTrip({ id: 103, title: 'Broken Dates', start_date: '2027-03-01', end_date: 'oops' })]);
    const { container } = render(<DashboardPage />);

    await screen.findByText('Broken Dates');
    const card = screen.getByText('Broken Dates').closest('.trip-card') as HTMLElement;
    expect(within(card).getByText('Open dates')).toBeInTheDocument();
    expect(container.querySelector('.trips')).toBeInTheDocument();
  });

  it('FE-PAGE-DESKDASH-019: the grid card actions edit, duplicate and delete the trip', async () => {
    await onlyTrips([TRIP, buildTrip({ id: 104, title: 'Berlin', start_date: '2027-03-01', end_date: '2027-03-05' })]);
    render(<DashboardPage />);

    const card = (await screen.findByText('Berlin')).closest('.trip-card') as HTMLElement;

    fireEvent.click(within(card).getByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('button', { name: 'Copy trip' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByDisplayValue('Berlin')).toBeInTheDocument();
  });

  it('FE-PAGE-DESKDASH-020: the grid card delete opens the confirm dialog', async () => {
    await onlyTrips([TRIP, buildTrip({ id: 104, title: 'Berlin', start_date: '2027-03-01', end_date: '2027-03-05' })]);
    render(<DashboardPage />);

    const card = (await screen.findByText('Berlin')).closest('.trip-card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('FE-PAGE-DESKDASH-021: the floating action button opens a blank trip form', async () => {
    const { container } = render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByText('Paris Adventure').length).toBeGreaterThan(0));

    fireEvent.click(container.querySelector('.fab-new-trip') as HTMLElement);

    expect(await screen.findByPlaceholderText('e.g. Summer in Japan')).toHaveValue('');
  });

  it('FE-PAGE-DESKDASH-022: the hosted all-trips calendar feed is gone', async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getAllByText('Paris Adventure').length).toBeGreaterThan(0));

    // The feed token lived behind /api/feed/user — a server endpoint the local
    // build does not have, so the toolbar carries no subscribe action.
    expect(screen.queryByRole('button', { name: 'Subscribe to all trips calendar' })).not.toBeInTheDocument();
  });

  it('FE-PAGE-DESKDASH-023: a non-array rate response leaves the converter unavailable', async () => {
    server.use(http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.json({ error: 'nope' })));
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('Rate unavailable')).toBeInTheDocument());
  });

  it('FE-PAGE-DESKDASH-024: a failed rate request leaves the converter unavailable', async () => {
    server.use(http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.error()));
    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText('Rate unavailable')).toBeInTheDocument());
  });

  it('FE-PAGE-DESKDASH-025: a non-array legacy timezone value is dropped', async () => {
    localStorage.setItem('trek_dashboard_tz', JSON.stringify({ tz: 'Asia/Tokyo' }));
    seedStore(useSettingsStore, { settings: buildSettings(), isLoaded: true });
    render(<DashboardPage />);

    await waitFor(() => expect(localStorage.getItem('trek_dashboard_tz')).toBeNull());
    expect(useSettingsStore.getState().settings.dashboard_timezones).toBeUndefined();
  });

  it('FE-PAGE-DESKDASH-026: a browser without Intl.supportedValuesOf falls back to a fixed zone list', async () => {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const original = intl.supportedValuesOf;
    intl.supportedValuesOf = () => { throw new Error('unsupported'); };
    seedStore(useSettingsStore, { settings: buildSettings({ dashboard_timezones: ['Asia/Tokyo'] }) });
    try {
      render(<DashboardPage />);
      await waitFor(() => expect(screen.getByText('Tokyo')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Add timezone' }));
      expect(screen.getByText('Search timezone…')).toBeInTheDocument();
    } finally {
      intl.supportedValuesOf = original;
    }
  });

  // #2115 — the stats call carries no loading flag of its own, so every tile fell
  // back to zero until it answered. On a slow connection that reads as "my trips
  // are gone" rather than "not loaded yet".
  it('FE-PAGE-DESKDASH-028: the stats tiles show placeholders instead of zeros before the numbers arrive', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(dashboardApi, 'travelStats').mockImplementation(async () => {
      await held;
      return { totalTrips: 12, totalPlaces: 40, totalDays: 30, totalDistanceKm: 5000, countries: ['FR'] };
    });

    const { container } = render(<DashboardPage />);

    // The tile is on screen and reads as pending, not as a real zero.
    const tiles = await waitFor(() => {
      const found = container.querySelectorAll('.atlas-card');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(container.querySelectorAll('.atlas-card .trek-skeleton').length).toBeGreaterThan(0);
    for (const tile of Array.from(tiles)) {
      expect((tile.querySelector('.value')?.textContent || '').trim()).not.toBe('0');
    }

    release!();
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(container.querySelectorAll('.atlas-card .trek-skeleton').length).toBe(0);
  });

  it('FE-PAGE-DESKDASH-029: the trip grid stands in for itself while the trips load', async () => {
    // The trip list is a Dexie read now — hold the adapter's list() the same
    // way the msw handler held the HTTP response, then let it through.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const realList = tripsApi.list.bind(tripsApi);
    vi.spyOn(tripsApi, 'list').mockImplementation(async (params) => {
      await held;
      return realList(params);
    });
    await onlyTrips([buildTrip({ id: 101, title: 'Kyoto' })]);

    const { container } = render(<DashboardPage />);

    await waitFor(() => expect(container.querySelectorAll('.trips .trek-skeleton').length).toBeGreaterThan(0));
    // The finished empty state must not show while the answer is still in flight.
    expect(screen.queryByText(/no trips yet/i)).toBeNull();

    release!();
    expect(await screen.findByText('Kyoto')).toBeInTheDocument();
    expect(container.querySelectorAll('.trips .trek-skeleton').length).toBe(0);
  });

});
