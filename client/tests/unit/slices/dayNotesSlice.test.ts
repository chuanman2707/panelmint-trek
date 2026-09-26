import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useTripStore } from '../../../src/store/tripStore';
import { seedStore } from '../../helpers/store';
import { buildDay, buildDayNote, buildTrip } from '../../helpers/factories';
import { db } from '../../../src/db/panelmintDb';
import { dayNotesApi } from '../../../src/api/client';
import { LocalApiError } from '../../../src/api/local/helpers';
import type { DayRow } from '../../../src/api/local/dexieStore';
import type { DayNote } from '../../../src/types';

/** Clean panelmint db + the self roster row. */
async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
}

/** Trip 1 plus day rows (ids given), each embedding the given notes. */
async function seedTripWithDays(dayIds: number[], notesByDay: Record<number, DayNote[]> = {}) {
  await db.trips.put(buildTrip({ id: 1 }));
  await db.days.bulkPut(dayIds.map((id) => ({
    ...buildDay({ id, trip_id: 1 }),
    notes_items: notesByDay[id] ?? [],
    vias: [],
  })) as DayRow[]);
}

beforeEach(resetDb);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dayNotesSlice', () => {
  describe('addDayNote', () => {
    it('FE-DAYNOTES-001: addDayNote inserts a temp note and replaces it with the stored one', async () => {
      seedStore(useTripStore, { dayNotes: { '1': [] } });
      await seedTripWithDays([1]);

      const result = await useTripStore.getState().addDayNote(1, 1, { text: 'New note', sort_order: 0 });

      // The local adapter allocates the real id from the days.notes counter.
      expect(result.id).toBeGreaterThan(0);
      expect(result.text).toBe('New note');
      const notes = useTripStore.getState().dayNotes['1'];
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe(result.id);
      // And it landed embedded on the day row.
      const day = (await db.days.get(1)) as DayRow;
      expect(day.notes_items).toEqual([expect.objectContaining({ id: result.id })]);
    });

    it('FE-DAYNOTES-002: addDayNote on failure rolls back — temp note removed', async () => {
      seedStore(useTripStore, { dayNotes: { '1': [] } });
      await seedTripWithDays([2]); // day 1 does not exist — create 404s 'Day not found'

      await expect(
        useTripStore.getState().addDayNote(1, 1, { text: 'Fail note', sort_order: 0 })
      ).rejects.toThrow('Day not found');

      expect(useTripStore.getState().dayNotes['1']).toHaveLength(0);
    });
  });

  describe('updateDayNote', () => {
    it('FE-DAYNOTES-003: updateDayNote replaces note in map by id', async () => {
      const note = buildDayNote({ id: 10, day_id: 1, text: 'Old text' });
      seedStore(useTripStore, { dayNotes: { '1': [note] } });
      await seedTripWithDays([1], { 1: [note] });

      const result = await useTripStore.getState().updateDayNote(1, 1, 10, { text: 'Updated text' });

      expect(result.text).toBe('Updated text');
      expect(useTripStore.getState().dayNotes['1'][0].text).toBe('Updated text');
      const day = (await db.days.get(1)) as DayRow;
      expect(day.notes_items?.[0].text).toBe('Updated text');
    });
  });

  describe('deleteDayNote', () => {
    it('FE-DAYNOTES-004: deleteDayNote optimistically removes note, restores on failure', async () => {
      const note = buildDayNote({ id: 10, day_id: 1 });
      seedStore(useTripStore, { dayNotes: { '1': [note] } });
      // Trip + day exist but the note does not — 'Note not found' rejects.
      await seedTripWithDays([1]);

      await expect(useTripStore.getState().deleteDayNote(1, 1, 10)).rejects.toThrow('Note not found');

      // Rolled back
      expect(useTripStore.getState().dayNotes['1']).toHaveLength(1);
      expect(useTripStore.getState().dayNotes['1'][0].id).toBe(10);
    });

    it('FE-DAYNOTES-004b: deleteDayNote success removes note from correct day', async () => {
      const note1 = buildDayNote({ id: 10, day_id: 1 });
      const note2 = buildDayNote({ id: 20, day_id: 1 });
      seedStore(useTripStore, { dayNotes: { '1': [note1, note2] } });
      await seedTripWithDays([1], { 1: [note1, note2] });

      await useTripStore.getState().deleteDayNote(1, 1, 10);

      const notes = useTripStore.getState().dayNotes['1'];
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe(20);
      const day = (await db.days.get(1)) as DayRow;
      expect(day.notes_items?.map((n) => n.id)).toEqual([20]);
    });
  });

  describe('moveDayNote', () => {
    it('FE-DAYNOTES-005: moveDayNote removes from source, adds to target (create+delete)', async () => {
      const note = buildDayNote({ id: 10, day_id: 1, text: 'Move me' });
      seedStore(useTripStore, { dayNotes: { '1': [note], '2': [] } });
      await seedTripWithDays([1, 2], { 1: [note] });

      await useTripStore.getState().moveDayNote(1, 1, 2, 10);

      expect(useTripStore.getState().dayNotes['1']).toHaveLength(0);
      const moved = useTripStore.getState().dayNotes['2'];
      expect(moved).toHaveLength(1);
      expect(moved[0].text).toBe('Move me');
      expect(moved[0].day_id).toBe(2);
      // The embedded rows moved too — no copy left on the source day.
      const day1 = (await db.days.get(1)) as DayRow;
      const day2 = (await db.days.get(2)) as DayRow;
      expect(day1.notes_items).toEqual([]);
      expect(day2.notes_items).toEqual([expect.objectContaining({ text: 'Move me' })]);
    });

    it('FE-DAYNOTES-006: moveDayNote rolls back to source day on failure', async () => {
      const note = buildDayNote({ id: 10, day_id: 1, text: 'Move me' });
      seedStore(useTripStore, { dayNotes: { '1': [note], '2': [] } });
      // No day 2 — the create half of the move 404s before anything deletes.
      await seedTripWithDays([1], { 1: [note] });

      await expect(useTripStore.getState().moveDayNote(1, 1, 2, 10)).rejects.toThrow('Day not found');

      // The create is the first half of the move, so a failure there must leave
      // the note where it was instead of deleting it out from under the user.
      expect(useTripStore.getState().dayNotes['1']).toHaveLength(1);
      expect(useTripStore.getState().dayNotes['1'][0].id).toBe(10);
      const day1 = (await db.days.get(1)) as DayRow;
      expect(day1.notes_items).toHaveLength(1);
    });

    it('FE-DAYNOTES-006b: moveDayNote removes the copy again when the source delete fails', async () => {
      const note = buildDayNote({ id: 10, day_id: 1, text: 'Move me' });
      seedStore(useTripStore, { dayNotes: { '1': [note], '2': [] } });
      await seedTripWithDays([1, 2], { 1: [note] });

      // The first delete call (the source) fails; the cleanup delete on the
      // target passes through to the real adapter and must drop the copy.
      const orig = dayNotesApi.delete.bind(dayNotesApi);
      const deletedFromTarget: number[] = [];
      let calls = 0;
      vi.spyOn(dayNotesApi, 'delete').mockImplementation((tripId, dayId, id) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new LocalApiError(500, 'Source delete failed'));
        deletedFromTarget.push(Number(id));
        return orig(tripId, dayId, id);
      });

      await expect(useTripStore.getState().moveDayNote(1, 1, 2, 10)).rejects.toThrow('Source delete failed');

      const day1 = (await db.days.get(1)) as DayRow;
      const day2 = (await db.days.get(2)) as DayRow;
      expect(deletedFromTarget).toHaveLength(1);
      expect(day1.notes_items).toHaveLength(1); // source note survives
      expect(day2.notes_items).toEqual([]); // the copy was cleaned up
      expect(useTripStore.getState().dayNotes['1']).toHaveLength(1);
      expect(useTripStore.getState().dayNotes['2']).toHaveLength(0);
    });
  });

  describe('updateDayNotes', () => {
    it('FE-DAYNOTES-007: updateDayNotes persists notes text and updates days array', async () => {
      const day = buildDay({ id: 1, trip_id: 1, notes: null });
      // daysApi is the local adapter — update lands on the seeded row.
      await db.trips.put(buildTrip({ id: 1 }));
      await db.days.put({ ...day, vias: [] } as DayRow);
      seedStore(useTripStore, { days: [day] });

      await useTripStore.getState().updateDayNotes(1, 1, 'My travel notes');

      const updatedDay = useTripStore.getState().days.find(d => d.id === 1);
      expect(updatedDay?.notes).toBe('My travel notes');
    });
  });

  describe('updateDayTitle', () => {
    it('FE-DAYNOTES-008: updateDayTitle persists title and updates days array', async () => {
      const day = buildDay({ id: 1, trip_id: 1, title: null });
      await db.trips.put(buildTrip({ id: 1 }));
      await db.days.put({ ...day, vias: [] } as DayRow);
      seedStore(useTripStore, { days: [day] });

      await useTripStore.getState().updateDayTitle(1, 1, 'Day at the Beach');

      const updatedDay = useTripStore.getState().days.find(d => d.id === 1);
      expect(updatedDay?.title).toBe('Day at the Beach');
    });
  });
});
