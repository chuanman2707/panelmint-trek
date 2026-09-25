/**
 * placesSlice tests — migrated off MSW. The slice's actions run through
 * `placeRepo`, which (online) calls the Dexie-backed `placesApi` adapter, so
 * each test seeds `panelmintDb` (trip row + place rows + the self local user)
 * instead of installing HTTP handlers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useTripStore } from '../../../src/store/tripStore';
import { resetAllStores, seedStore } from '../../helpers/store';
import { buildTrip, buildPlace, buildAssignment } from '../../helpers/factories';
import { db } from '../../../src/db/panelmintDb';
import type { LocalPlace } from '../../../src/db/panelmintDb';

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
}

async function seedTrip(id = 1) {
  await db.trips.put(buildTrip({ id }));
}

async function seedPlace(overrides: Partial<LocalPlace> = {}) {
  const place = buildPlace(overrides) as LocalPlace;
  await db.places.put(place);
  return place;
}

beforeEach(async () => {
  resetAllStores();
  await resetDb();
});

describe('placesSlice', () => {
  describe('addPlace', () => {
    it('FE-PLACES-001: addPlace calls API and prepends place to places array', async () => {
      await seedTrip(1);
      const existing = buildPlace({ trip_id: 1 });
      seedStore(useTripStore, { places: [existing] });

      const result = await useTripStore.getState().addPlace(1, { name: 'New Place' });

      expect(result.name).toBe('New Place');
      const places = useTripStore.getState().places;
      expect(places).toHaveLength(2);
      expect(places[0].name).toBe('New Place'); // prepended
    });

    it('FE-PLACES-002: addPlace on failure throws and places remain unchanged', async () => {
      const existing = buildPlace({ trip_id: 1 });
      seedStore(useTripStore, { places: [existing] });
      // Trip 1 is not seeded → the local adapter rejects with a 404, mirroring
      // the old server's failure response.
      await expect(useTripStore.getState().addPlace(1, { name: 'Fail' })).rejects.toThrow();
      expect(useTripStore.getState().places).toEqual([existing]);
    });
  });

  describe('updatePlace', () => {
    it('FE-PLACES-003: updatePlace calls API and updates place in array', async () => {
      await seedTrip(1);
      const place = await seedPlace({ id: 10, trip_id: 1, name: 'Old Name' });
      seedStore(useTripStore, { places: [place] });

      const result = await useTripStore.getState().updatePlace(1, 10, { name: 'New Name' });

      expect(result.name).toBe('New Name');
      const updated = useTripStore.getState().places.find(p => p.id === 10);
      expect(updated?.name).toBe('New Name');
    });

    it('FE-PLACES-004: updatePlace cascades to assignments map — assignment place field updated', async () => {
      await seedTrip(1);
      const place = await seedPlace({ id: 10, trip_id: 1, name: 'Old Place' });
      const assignment = buildAssignment({ id: 100, day_id: 1, place });
      seedStore(useTripStore, {
        places: [place],
        assignments: { '1': [assignment] },
      });

      await useTripStore.getState().updatePlace(1, 10, { name: 'Updated Place' });

      const updatedAssignments = useTripStore.getState().assignments['1'];
      expect(updatedAssignments[0].place.name).toBe('Updated Place');
    });
  });

  describe('updatePlacesMany', () => {
    it('FE-PLACES-008: applies the patch to every listed place and cascades to assignments', async () => {
      await seedTrip(1);
      const a = await seedPlace({ id: 10, trip_id: 1, category_id: 1 });
      const b = await seedPlace({ id: 20, trip_id: 1, category_id: 1 });
      const c = await seedPlace({ id: 30, trip_id: 1, category_id: 9 });
      const assignment = buildAssignment({ id: 100, day_id: 1, place: a });
      seedStore(useTripStore, { places: [a, b, c], assignments: { '1': [assignment] } });

      await useTripStore.getState().updatePlacesMany(1, [10, 20], { category_id: 5 });

      const places = useTripStore.getState().places;
      expect(places.find(p => p.id === 10)?.category_id).toBe(5);
      expect(places.find(p => p.id === 20)?.category_id).toBe(5);
      expect(places.find(p => p.id === 30)?.category_id).toBe(9); // untouched
      expect(useTripStore.getState().assignments['1'][0].place.category_id).toBe(5); // cascaded
    });

    it('FE-PLACES-009: no-ops on an empty id list without calling the API', async () => {
      const a = buildPlace({ id: 10, trip_id: 1, category_id: 1 });
      seedStore(useTripStore, { places: [a] });
      await useTripStore.getState().updatePlacesMany(1, [], { category_id: 5 });
      expect(useTripStore.getState().places[0].category_id).toBe(1);
    });
  });

  describe('deletePlace', () => {
    it('FE-PLACES-005: deletePlace removes place from places array', async () => {
      await seedTrip(1);
      const place1 = await seedPlace({ id: 10, trip_id: 1 });
      const place2 = await seedPlace({ id: 20, trip_id: 1 });
      seedStore(useTripStore, { places: [place1, place2], assignments: {} });

      await useTripStore.getState().deletePlace(1, 10);

      const places = useTripStore.getState().places;
      expect(places).toHaveLength(1);
      expect(places[0].id).toBe(20);
    });

    it('FE-PLACES-006: deletePlace cascades — assignments referencing the place are removed', async () => {
      await seedTrip(1);
      const place = await seedPlace({ id: 10, trip_id: 1 });
      const otherPlace = await seedPlace({ id: 20, trip_id: 1 });
      const assignmentWithPlace = buildAssignment({ id: 100, day_id: 1, place });
      const assignmentOther = buildAssignment({ id: 200, day_id: 1, place: otherPlace });

      seedStore(useTripStore, {
        places: [place, otherPlace],
        assignments: { '1': [assignmentWithPlace, assignmentOther] },
      });

      await useTripStore.getState().deletePlace(1, 10);

      const dayAssignments = useTripStore.getState().assignments['1'];
      expect(dayAssignments).toHaveLength(1);
      expect(dayAssignments[0].id).toBe(200);
    });
  });

  describe('refreshPlaces', () => {
    it('FE-PLACES-007: refreshPlaces re-fetches and replaces places array', async () => {
      await seedTrip(1);
      const stale = buildPlace({ id: 99, trip_id: 1, name: 'Stale' });
      seedStore(useTripStore, { places: [stale] });

      await seedPlace({ id: 5, trip_id: 1, name: 'Fresh' });

      await useTripStore.getState().refreshPlaces(1);

      const places = useTripStore.getState().places;
      expect(places).toHaveLength(1);
      expect(places[0].name).toBe('Fresh');
    });
  });
});
