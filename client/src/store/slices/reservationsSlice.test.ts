// FE-STORE-RESERVATIONS-001 to FE-STORE-RESERVATIONS-003
import 'fake-indexeddb/auto';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildReservation, buildTrip } from '../../../tests/helpers/factories';
import { useTripStore } from '../tripStore';
import { db } from '../../db/panelmintDb';
import { reservationsApi } from '../../api/client';
import { LocalApiError } from '../../api/local/helpers';
import type { LocalTripMember } from '../../db/panelmintDb';

beforeEach(async () => {
  resetAllStores();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  await db.trips.put(buildTrip({ id: 1 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reservationsSlice', () => {
  it('FE-STORE-RESERVATIONS-001: setReservationTravelers patches travelers on matching reservation', async () => {
    const reservation = buildReservation({ id: 5, trip_id: 1, travelers: [] });
    await db.reservations.put(reservation);
    seedStore(useTripStore, { reservations: [reservation] });

    await useTripStore.getState().setReservationTravelers(1, 5, [1]);
    const stored = useTripStore.getState().reservations.find(r => r.id === 5);
    expect(stored?.travelers).toHaveLength(1);
    expect(stored?.travelers?.[0].user_id).toBe(1);
  });

  it('FE-STORE-RESERVATIONS-002: setReservationTravelers throws on API error', async () => {
    const reservation = buildReservation({ id: 6, trip_id: 1 });
    await db.reservations.put(reservation);
    seedStore(useTripStore, { reservations: [reservation] });
    vi.spyOn(reservationsApi, 'setTravelers').mockRejectedValue(new LocalApiError(403, 'forbidden'));

    await expect(useTripStore.getState().setReservationTravelers(1, 6, [1])).rejects.toThrow();
  });

  it('FE-STORE-RESERVATIONS-003: setReservationTravelers leaves other reservations untouched', async () => {
    const a = buildReservation({ id: 7, trip_id: 1, travelers: [] });
    const b = buildReservation({ id: 8, trip_id: 1, travelers: [] });
    await db.reservations.bulkPut([a, b]);
    seedStore(useTripStore, { reservations: [a, b] });
    // Bob is a roster member — the adapter's assignable filter keeps him.
    await db.localUsers.put({ id: 2, name: 'bob', is_self: 0 });
    await db.tripMembers.put({
      tripId: 1, id: 2, username: 'bob', role: 'member',
      added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
    } as LocalTripMember);

    await useTripStore.getState().setReservationTravelers(1, 7, [2]);
    expect(useTripStore.getState().reservations.find(r => r.id === 8)?.travelers).toEqual([]);
  });
});
