import { describe, it, expect, beforeEach } from 'vitest';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildReservation, buildTrip } from '../../helpers/factories';
import { db } from '../../../src/db/panelmintDb';
import type { LocalUser, Reservation } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

/** A stored reservation row — the wire `Reservation` plus the embedded
 *  collections `reservationWire` reads back (endpoints, day_positions). */
const storedReservation = (over: Partial<Reservation> = {}): Reservation => ({
  endpoints: [],
  day_positions: null,
  ingest_state: 'live',
  ...buildReservation(over),
});

beforeEach(async () => {
  resetAllStores();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
  await db.trips.put(buildTrip({ id: 1 }));
});

describe('reservationsSlice', () => {
  describe('loadReservations', () => {
    it('FE-RESERV-001: loadReservations fetches and replaces reservations', async () => {
      seedStore(useTripStore, { reservations: [] });

      const reservation = storedReservation({ trip_id: 1 });
      await db.reservations.put(reservation);

      await useTripStore.getState().loadReservations(1);

      expect(useTripStore.getState().reservations).toHaveLength(1);
      expect(useTripStore.getState().reservations[0].id).toBe(reservation.id);
    });
  });

  describe('addReservation', () => {
    it('FE-RESERV-002: addReservation prepends to reservations array', async () => {
      const existing = storedReservation({ trip_id: 1, title: 'Existing' });
      await db.reservations.put(existing);
      seedStore(useTripStore, { reservations: [existing] });

      const result = await useTripStore.getState().addReservation(1, {
        title: 'New Hotel',
        type: 'hotel',
        status: 'pending',
      });

      expect(result.title).toBe('New Hotel');
      const reservations = useTripStore.getState().reservations;
      expect(reservations).toHaveLength(2);
      // addReservation prepends
      expect(reservations[0].title).toBe('New Hotel');
    });

    it('FE-RESERV-003: addReservation on failure throws', async () => {
      // Trip 99 is not in the database — the access guard's 404 rejects.
      await expect(
        useTripStore.getState().addReservation(99, { title: 'Fail' })
      ).rejects.toThrow();
    });
  });

  describe('updateReservation', () => {
    it('FE-RESERV-004: updateReservation replaces item in array by id', async () => {
      const reservation = storedReservation({ id: 10, trip_id: 1, title: 'Old', status: 'pending' });
      await db.reservations.put(reservation);
      seedStore(useTripStore, { reservations: [reservation] });

      const result = await useTripStore.getState().updateReservation(1, 10, { title: 'Updated Hotel' });

      expect(result.title).toBe('Updated Hotel');
      expect(useTripStore.getState().reservations[0].title).toBe('Updated Hotel');
    });
  });

  describe('toggleReservationStatus', () => {
    it('FE-RESERV-005: toggleReservationStatus flips confirmed to pending optimistically', async () => {
      const reservation = storedReservation({ id: 10, trip_id: 1, status: 'confirmed' });
      await db.reservations.put(reservation);
      seedStore(useTripStore, { reservations: [reservation] });

      await useTripStore.getState().toggleReservationStatus(1, 10);

      expect(useTripStore.getState().reservations[0].status).toBe('pending');
    });

    it('FE-RESERV-006: toggleReservationStatus flips pending to confirmed optimistically', async () => {
      const reservation = storedReservation({ id: 10, trip_id: 1, status: 'pending' });
      await db.reservations.put(reservation);
      seedStore(useTripStore, { reservations: [reservation] });

      await useTripStore.getState().toggleReservationStatus(1, 10);

      expect(useTripStore.getState().reservations[0].status).toBe('confirmed');
    });

    it('FE-RESERV-007: toggleReservationStatus rolls back and surfaces the error on API failure', async () => {
      const reservation = storedReservation({ id: 10, trip_id: 1, status: 'confirmed' });
      // The row exists in state only — the local update 404s.
      seedStore(useTripStore, { reservations: [reservation] });

      // Rolls back the optimistic toggle AND rejects, so the caller's catch can
      // show a toast (previously the failure was swallowed and the toast never fired).
      await expect(useTripStore.getState().toggleReservationStatus(1, 10)).rejects.toThrow();

      expect(useTripStore.getState().reservations[0].status).toBe('confirmed');
    });

    it('FE-RESERV-008: toggleReservationStatus does nothing if reservation not found', async () => {
      seedStore(useTripStore, { reservations: [] });

      // Should not throw
      await useTripStore.getState().toggleReservationStatus(1, 999);

      expect(useTripStore.getState().reservations).toHaveLength(0);
    });
  });

  describe('deleteReservation', () => {
    it('FE-RESERV-009: deleteReservation removes from reservations after API success', async () => {
      const r1 = storedReservation({ id: 10, trip_id: 1 });
      const r2 = storedReservation({ id: 20, trip_id: 1 });
      await db.reservations.bulkPut([r1, r2]);
      seedStore(useTripStore, { reservations: [r1, r2] });

      await useTripStore.getState().deleteReservation(1, 10);

      const reservations = useTripStore.getState().reservations;
      expect(reservations).toHaveLength(1);
      expect(reservations[0].id).toBe(20);
    });

    it('FE-RESERV-010: deleteReservation on failure throws (no optimistic, server-first)', async () => {
      const reservation = storedReservation({ id: 10, trip_id: 1 });
      // In state only — the local delete reports the row missing.
      seedStore(useTripStore, { reservations: [reservation] });

      await expect(useTripStore.getState().deleteReservation(1, 10)).rejects.toThrow();

      // Still in state since server-first (only removes after success)
      expect(useTripStore.getState().reservations).toHaveLength(1);
    });
  });
});
