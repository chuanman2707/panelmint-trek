// FE-TSLICE-NOTES-001 to FE-TSLICE-NOTES-012 (error paths and empty-map paths of the day-notes slice)
//
// dayNotesApi/daysApi are the Dexie-backed local adapters — there is no HTTP
// layer to mock. Happy paths seed trips/days (notes embed on
// days.notes_items); failure paths use vi.spyOn for adapter errors or omit
// the row that produced the 404.
import 'fake-indexeddb/auto';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { buildDay, buildDayNote, buildTrip } from '../../../tests/helpers/factories';
import { useTripStore } from '../tripStore';
import { db } from '../../db/panelmintDb';
import { daysApi, dayNotesApi } from '../../api/client';
import { LocalApiError } from '../../api/local/helpers';
import type { DayRow } from '../../api/local/dexieStore';
import type { DayNote } from '../../types';

/** Trip 1 plus day rows (ids given), each embedding the given notes. */
async function seedTripWithDays(dayIds: number[], notesByDay: Record<number, DayNote[]> = {}) {
  await db.trips.put(buildTrip({ id: 1 }));
  await db.days.bulkPut(dayIds.map((id) => ({
    ...buildDay({ id, trip_id: 1 }),
    notes_items: notesByDay[id] ?? [],
    vias: [],
  })) as DayRow[]);
}

beforeEach(async () => {
  resetAllStores();
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dayNotesSlice', () => {
  it('FE-TSLICE-NOTES-001: updateDayNotes throws the adapter message and leaves the day untouched', async () => {
    seedStore(useTripStore, { days: [buildDay({ id: 1, trip_id: 1, notes: 'original' })] });
    vi.spyOn(daysApi, 'update').mockRejectedValue(new LocalApiError(422, 'Notes too long'));

    await expect(useTripStore.getState().updateDayNotes(1, 1, 'x'.repeat(10))).rejects.toThrow('Notes too long');
    expect(useTripStore.getState().days[0].notes).toBe('original');
  });

  it('FE-TSLICE-NOTES-002: updateDayTitle throws the adapter message and leaves the title untouched', async () => {
    seedStore(useTripStore, { days: [buildDay({ id: 1, trip_id: 1, title: 'Day one' })] });
    vi.spyOn(daysApi, 'update').mockRejectedValue(new LocalApiError(422, 'Title rejected'));

    await expect(useTripStore.getState().updateDayTitle(1, 1, 'New title')).rejects.toThrow('Title rejected');
    expect(useTripStore.getState().days[0].title).toBe('Day one');
  });

  it('FE-TSLICE-NOTES-003: updateDayNotes matches the day by numeric id even for a string dayId', async () => {
    // daysApi is the local adapter — the update lands on the seeded rows.
    await seedTripWithDays([1, 2]);
    seedStore(useTripStore, {
      days: [buildDay({ id: 1, trip_id: 1 }), buildDay({ id: 2, trip_id: 1 })],
    });

    await useTripStore.getState().updateDayNotes(1, '2', 'Beach day');

    expect(useTripStore.getState().days[0].notes).toBeNull();
    expect(useTripStore.getState().days[1].notes).toBe('Beach day');
  });

  it('FE-TSLICE-NOTES-004: updateDayNote throws the adapter message and keeps the stored note', async () => {
    const note = buildDayNote({ id: 10, day_id: 1, text: 'Original' });
    seedStore(useTripStore, { dayNotes: { '1': [note] } });
    vi.spyOn(dayNotesApi, 'update').mockRejectedValue(new LocalApiError(403, 'Note is locked'));

    await expect(
      useTripStore.getState().updateDayNote(1, 1, 10, { text: 'Changed' }),
    ).rejects.toThrow('Note is locked');
    expect(useTripStore.getState().dayNotes['1'][0].text).toBe('Original');
  });

  it('FE-TSLICE-NOTES-011: moving a note to another day keeps everything it carries (#1629)', async () => {
    const note = buildDayNote({ id: 10, day_id: 1, text: 'Ferry tickets', time: 'book **early**', icon: 'Ticket' });
    // buildDayNote predates note colours, so the field is set on the fixture.
    (note as unknown as { color: string }).color = '#dc2626';
    seedStore(useTripStore, { dayNotes: { '1': [note], '2': [] } });
    await seedTripWithDays([1, 2], { 1: [note] });

    await useTripStore.getState().moveDayNote(1, 1, 2, 10);

    // A move is a delete plus a create, so every field has to be re-sent — the
    // colour was the one that went missing.
    const moved = useTripStore.getState().dayNotes['2'][0];
    expect(moved).toMatchObject({
      text: 'Ferry tickets',
      time: 'book **early**',
      icon: 'Ticket',
      color: '#dc2626',
    });
    expect(useTripStore.getState().dayNotes['1']).toHaveLength(0);
    const day2 = (await db.days.get(2)) as DayRow;
    expect(day2.notes_items?.[0]).toMatchObject({ text: 'Ferry tickets', color: '#dc2626' });
  });

  it('FE-TSLICE-NOTES-012: a note without a colour moves without inventing one', async () => {
    const note = buildDayNote({ id: 10, day_id: 1, text: 'Lunch' });
    seedStore(useTripStore, { dayNotes: { '1': [note], '2': [] } });
    await seedTripWithDays([1, 2], { 1: [note] });

    await useTripStore.getState().moveDayNote(1, 1, 2, 10);

    expect(useTripStore.getState().dayNotes['2'][0].color).toBeNull();
  });

  it('FE-TSLICE-NOTES-005: moveDayNote is a no-op when the note is not on the source day', async () => {
    const note = buildDayNote({ id: 10, day_id: 1 });
    seedStore(useTripStore, { dayNotes: { '1': [note], '2': [] } });
    await seedTripWithDays([1, 2], { 1: [note] });

    await useTripStore.getState().moveDayNote(1, 1, 2, 999);

    expect(useTripStore.getState().dayNotes['1']).toHaveLength(1);
    expect(useTripStore.getState().dayNotes['2']).toHaveLength(0);
    // The store early-returns before touching the adapter — the row is intact.
    const day1 = (await db.days.get(1)) as DayRow;
    expect(day1.notes_items).toHaveLength(1);
  });

  it('FE-TSLICE-NOTES-007: addDayNote seeds a fresh list for a day with no notes yet', async () => {
    seedStore(useTripStore, { dayNotes: {} });
    await seedTripWithDays([4]);

    const created = await useTripStore.getState().addDayNote(1, 4, { text: 'Check-in 15:00' });

    expect(created.id).toBeGreaterThan(0);
    expect(created.text).toBe('Check-in 15:00');
    expect(useTripStore.getState().dayNotes['4'].map(n => n.id)).toEqual([created.id]);
  });

  it('FE-TSLICE-NOTES-008: addDayNote rolls the temp note back out of a fresh list on failure', async () => {
    seedStore(useTripStore, { dayNotes: {} });
    await seedTripWithDays([1]); // day 4 does not exist — create 404s 'Day not found'

    await expect(useTripStore.getState().addDayNote(1, 4, { text: 'nope' })).rejects.toThrow('Day not found');
    expect(useTripStore.getState().dayNotes['4']).toEqual([]);
  });

  it('FE-TSLICE-NOTES-009: moveDayNote creates the target day list when it does not exist yet', async () => {
    const note = buildDayNote({ id: 10, day_id: 1, text: 'Ferry' });
    seedStore(useTripStore, { dayNotes: { '1': [note] } });
    await seedTripWithDays([1, 5], { 1: [note] });

    await useTripStore.getState().moveDayNote(1, 1, 5, 10);

    expect(useTripStore.getState().dayNotes['1']).toEqual([]);
    const moved = useTripStore.getState().dayNotes['5'];
    expect(moved.map(n => n.text)).toEqual(['Ferry']);
    expect(moved[0].id).not.toBe(10);
  });

  it('FE-TSLICE-NOTES-006: moveDayNote carries text, time and icon over to the target day', async () => {
    const note = buildDayNote({ id: 10, day_id: 1, text: 'Ferry', time: '08:15', icon: '⛴️' });
    seedStore(useTripStore, { dayNotes: { '1': [note], '2': [] } });
    await seedTripWithDays([1, 2], { 1: [note] });

    await useTripStore.getState().moveDayNote(1, 1, 2, 10, 3);

    const moved = useTripStore.getState().dayNotes['2'][0];
    expect(moved).toMatchObject({ text: 'Ferry', time: '08:15', icon: '⛴️', sort_order: 3 });
    expect(useTripStore.getState().dayNotes['1']).toHaveLength(0);
  });
});
