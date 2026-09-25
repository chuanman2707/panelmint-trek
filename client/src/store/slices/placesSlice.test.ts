// FE-TSLICE-PLACE-001 to FE-TSLICE-PLACE-015 (ratings, bulk ops, error paths)
//
// placesApi is the Dexie-backed local adapter now, so these pin slice logic at
// the module boundary: spies return/reject what the adapter would and the
// store's own behavior (pool updates, assignment pruning, error propagation)
// is what is under test.
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildAssignment, buildPlace } from '../../../tests/helpers/factories';
import { placesApi } from '../../api/client';
import { useTripStore } from '../tripStore';

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Rejection shaped like an axios error so getApiErrorMessage picks the server text. */
function apiError(message: string): unknown {
  return { response: { data: { error: message } } };
}

describe('placesSlice', () => {
  describe('ratePlace', () => {
    it('FE-TSLICE-PLACE-004: a numeric rating is PUT and the fresh average is applied', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { places: [place] });

      const rate = vi.spyOn(placesApi, 'rate')
        .mockResolvedValue({ place: { ...place, rating_avg: 4.5, rating_count: 2 } });

      const result = await useTripStore.getState().ratePlace(1, 10, 5);

      expect(rate).toHaveBeenCalledWith(1, 10, 5);
      expect(result.rating_avg).toBe(4.5);
      expect(useTripStore.getState().places[0].rating_count).toBe(2);
    });

    it('FE-TSLICE-PLACE-005: a null rating clears the vote', async () => {
      const place = buildPlace({ id: 10, trip_id: 1, rating_avg: 4 });
      seedStore(useTripStore, { places: [place] });

      const rate = vi.spyOn(placesApi, 'rate')
        .mockResolvedValue({ place: { ...place, rating_avg: null, rating_count: 0 } });

      await useTripStore.getState().ratePlace(1, 10, null);

      expect(rate).toHaveBeenCalledWith(1, 10, null);
      expect(useTripStore.getState().places[0].rating_avg).toBeNull();
    });

    it('FE-TSLICE-PLACE-006: throws with the server message when rating fails', async () => {
      seedStore(useTripStore, { places: [buildPlace({ id: 10, trip_id: 1 })] });
      vi.spyOn(placesApi, 'rate').mockRejectedValue(apiError('Rating out of range'));

      await expect(useTripStore.getState().ratePlace(1, 10, 9)).rejects.toThrow('Rating out of range');
    });
  });

  describe('deletePlace', () => {
    it('FE-TSLICE-PLACE-007: rethrows the server message and keeps the pool intact', async () => {
      const place = buildPlace({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { places: [place] });
      vi.spyOn(placesApi, 'delete').mockRejectedValue(apiError('Place is locked'));

      await expect(useTripStore.getState().deletePlace(1, 10)).rejects.toThrow('Place is locked');
      expect(useTripStore.getState().places).toHaveLength(1);
    });
  });

  describe('deletePlacesMany', () => {
    it('FE-TSLICE-PLACE-008: removes every listed place and prunes their assignments', async () => {
      const a = buildPlace({ id: 10, trip_id: 1 });
      const b = buildPlace({ id: 20, trip_id: 1 });
      const keep = buildPlace({ id: 30, trip_id: 1 });
      seedStore(useTripStore, {
        places: [a, b, keep],
        assignments: {
          '1': [buildAssignment({ id: 100, day_id: 1, place: a }), buildAssignment({ id: 101, day_id: 1, place: keep })],
          '2': [buildAssignment({ id: 200, day_id: 2, place: keep })],
        },
      });

      const bulkDelete = vi.spyOn(placesApi, 'bulkDelete')
        .mockResolvedValue({ deleted: [10, 20], count: 2, cancelled: { reservationIds: [], budgetItemIds: [], accommodationIds: [] } });

      await useTripStore.getState().deletePlacesMany(1, [10, 20]);

      expect(bulkDelete).toHaveBeenCalledWith(1, [10, 20]);
      expect(useTripStore.getState().places.map(p => p.id)).toEqual([30]);
      expect(useTripStore.getState().assignments['1'].map(x => x.id)).toEqual([101]);
      // Day 2 held no deleted place, so it is untouched.
      expect(useTripStore.getState().assignments['2']).toHaveLength(1);
    });

    it('FE-TSLICE-PLACE-009: an empty id list is a no-op and issues no request', async () => {
      const a = buildPlace({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { places: [a] });
      const bulkDelete = vi.spyOn(placesApi, 'bulkDelete');

      await useTripStore.getState().deletePlacesMany(1, []);

      expect(bulkDelete).not.toHaveBeenCalled();
      expect(useTripStore.getState().places).toHaveLength(1);
    });

    it('FE-TSLICE-PLACE-010: throws and keeps the pool when the bulk delete fails', async () => {
      const a = buildPlace({ id: 10, trip_id: 1 });
      seedStore(useTripStore, { places: [a] });
      vi.spyOn(placesApi, 'bulkDelete').mockRejectedValue(apiError('Bulk delete refused'));

      await expect(useTripStore.getState().deletePlacesMany(1, [10])).rejects.toThrow('Bulk delete refused');
      expect(useTripStore.getState().places).toHaveLength(1);
    });
  });

  describe('updatePlacesMany', () => {
    it('FE-TSLICE-PLACE-011: leaves the days it does not touch alone', async () => {
      const a = buildPlace({ id: 10, trip_id: 1, category_id: 1 });
      const other = buildPlace({ id: 20, trip_id: 1, category_id: 1 });
      seedStore(useTripStore, {
        places: [a, other],
        assignments: { '9': [buildAssignment({ id: 900, day_id: 9, place: other })] },
      });
      const before = useTripStore.getState().assignments;

      vi.spyOn(placesApi, 'bulkUpdate').mockResolvedValue({ updated: [10], count: 1 });

      await useTripStore.getState().updatePlacesMany(1, [10], { category_id: 7 });

      expect(useTripStore.getState().places.find(p => p.id === 10)?.category_id).toBe(7);
      expect(useTripStore.getState().assignments).toBe(before);
    });

    it('FE-TSLICE-PLACE-012: throws with the server message when the bulk update fails', async () => {
      const a = buildPlace({ id: 10, trip_id: 1, category_id: 1 });
      seedStore(useTripStore, { places: [a] });
      vi.spyOn(placesApi, 'bulkUpdate').mockRejectedValue(apiError('Unknown category'));

      await expect(
        useTripStore.getState().updatePlacesMany(1, [10], { category_id: 99 }),
      ).rejects.toThrow('Unknown category');
      expect(useTripStore.getState().places[0].category_id).toBe(1);
    });
  });

  describe('refreshPlaces', () => {
    it('FE-TSLICE-PLACE-013: swallows a failing list request and keeps the current pool', async () => {
      const stale = buildPlace({ id: 10, trip_id: 1, name: 'Stale' });
      seedStore(useTripStore, { places: [stale] });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(placesApi, 'list').mockRejectedValue(apiError('boom'));

      await expect(useTripStore.getState().refreshPlaces(1)).resolves.toBeUndefined();

      expect(useTripStore.getState().places[0].name).toBe('Stale');
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe('updatePlace', () => {
    it('FE-TSLICE-PLACE-015: throws the server message and leaves the pool untouched', async () => {
      const place = buildPlace({ id: 10, trip_id: 1, name: 'Louvre' });
      seedStore(useTripStore, { places: [place] });
      vi.spyOn(placesApi, 'update').mockRejectedValue(apiError('Place is locked'));

      await expect(
        useTripStore.getState().updatePlace(1, 10, { name: 'Orsay' }),
      ).rejects.toThrow('Place is locked');
      expect(useTripStore.getState().places[0].name).toBe('Louvre');
    });
  });

  describe('addPlace', () => {
    it('FE-TSLICE-PLACE-014: surfaces the server message on failure', async () => {
      vi.spyOn(placesApi, 'create').mockRejectedValue(apiError('Name required'));

      await expect(useTripStore.getState().addPlace(1, { name: '' })).rejects.toThrow('Name required');
    });
  });
});
