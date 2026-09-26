/**
 * Parity tests for the local `dayNotesApi` — the adapter that replaced
 * `apiClient.*('/trips/:id/days/:dayId/notes*', …)` over the real Dexie
 * `panelmint` database (fake-indexeddb). There is no day_notes table: the
 * rows embed on `days.notes_items`. Pins the envelopes ({notes}/{note}/
 * {success:true}), the create column defaults (icon '📝', sort_order 9999,
 * palette colour or null), the 'Day not found'-before-'Text required'
 * ordering, the absent-vs-present update protocol, the id+day+trip scoped
 * 'Note not found' 404 and the sort_order,created_at list ordering. No HTTP
 * — a stubbed fetch proves nothing leaves the page.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dayNotesApi } from '../../../src/api/local/notes';
import { db } from '../../../src/db/panelmintDb';
import { buildTrip, buildDay, buildDayNote } from '../../helpers/factories';
import type { DayRow } from '../../../src/api/local/dexieStore';
import type { LocalUser, DayNote } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const seedTrip = () => db.trips.put(buildTrip({ id: 1, user_id: 1 }));

const seedDay = (id: number, notes: DayNote[] = [], tripId = 1) =>
  db.days.put({ vias: [], ...buildDay({ id, trip_id: tripId }), notes_items: notes } as DayRow);

const note = (over: Partial<DayNote> = {}): DayNote =>
  ({ trip_id: 1, time: null, icon: '📝', sort_order: 0, color: null, created_at: '2025-01-01T00:00:00.000Z', ...buildDayNote(over), ...over });

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('dayNotesApi — no HTTP', () => {
  it('performs zero fetch traffic across the whole surface', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await seedTrip();
    await seedDay(1);
    const { note: n } = await dayNotesApi.create(1, 1, { text: 'Call hotel' });
    await dayNotesApi.list(1, 1);
    await dayNotesApi.update(1, 1, n.id, { text: 'Call hotel again' });
    await dayNotesApi.delete(1, 1, n.id);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('dayNotesApi.list', () => {
  it('returns {notes} ordered by sort_order, created_at', async () => {
    await seedTrip();
    await seedDay(1, [
      note({ id: 2, text: 'second', sort_order: 1 }),
      note({ id: 1, text: 'first', sort_order: 0 }),
      note({ id: 3, text: 'same-sort-newer', sort_order: 0, created_at: '2025-06-02T00:00:00.000Z' }),
    ]);

    const { notes } = await dayNotesApi.list(1, 1);
    expect(notes.map((n) => n.id)).toEqual([1, 3, 2]);
  });

  it('scopes to [] for a missing or foreign day instead of 404ing', async () => {
    await seedTrip();
    await seedDay(1, [note({ id: 1 })], /* tripId */ 2);
    await expect(dayNotesApi.list(1, 1)).resolves.toEqual({ notes: [] });
    await expect(dayNotesApi.list(1, 77)).resolves.toEqual({ notes: [] });
  });

  it('404s an unreachable trip', async () => {
    const err = await fail(dayNotesApi.list(999, 1));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('dayNotesApi.create', () => {
  it('embeds the note on the day with the column defaults', async () => {
    await seedTrip();
    await seedDay(1);
    const { note: n } = await dayNotesApi.create(1, 1, { text: '  Call hotel  ' });
    expect(n).toMatchObject({
      day_id: 1, trip_id: 1, text: 'Call hotel',
      time: null, icon: '📝', sort_order: 9999, color: null,
    });
    const day = (await db.days.get(1)) as DayRow;
    expect(day.notes_items).toEqual([expect.objectContaining({ id: n.id, text: 'Call hotel' })]);
  });

  it('normalizes the colour to the palette — an off-palette value stores null', async () => {
    await seedTrip();
    await seedDay(1);
    expect((await dayNotesApi.create(1, 1, { text: 'a', color: '#9333ea' })).note.color).toBe('#9333ea');
    expect((await dayNotesApi.create(1, 1, { text: 'b', color: '#fff' })).note.color).toBeNull();
  });

  it('checks the day before the text — a missing day 404s even on empty text', async () => {
    await seedTrip();
    const err = await fail(dayNotesApi.create(1, 99, { text: '   ' }));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Day not found');
  });

  it('400s blank text on an existing day', async () => {
    await seedTrip();
    await seedDay(1);
    const err = await fail(dayNotesApi.create(1, 1, { text: '   ' }));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('Text required');
  });

  it('stores the given time/icon/sort_order', async () => {
    await seedTrip();
    await seedDay(1);
    const { note: n } = await dayNotesApi.create(1, 1, { text: 'a', time: '09:00', icon: '⏰', sort_order: 2 });
    expect(n).toMatchObject({ time: '09:00', icon: '⏰', sort_order: 2 });
  });
});

describe('dayNotesApi.update', () => {
  it('writes present keys and keeps absent ones — including a present-but-undefined', async () => {
    await seedTrip();
    await seedDay(1, [note({ id: 5, text: 'old', time: '09:00', icon: '⏰' })]);

    const { note: n } = await dayNotesApi.update(1, 1, 5, { text: '  new  ' });
    expect(n).toMatchObject({ text: 'new', time: '09:00', icon: '⏰' });

    // `fields.x !== undefined ? x : current`: an explicit undefined keeps too.
    const { note: kept } = await dayNotesApi.update(1, 1, 5, { time: undefined });
    expect(kept.time).toBe('09:00');

    const { note: cleared } = await dayNotesApi.update(1, 1, 5, { time: null });
    expect(cleared.time).toBeNull();
  });

  it('404s a note on another day or trip as Note not found (not Day not found)', async () => {
    await seedTrip();
    await seedDay(1, [note({ id: 5 })]);
    await seedDay(2);
    const err = await fail(dayNotesApi.update(1, 2, 5, { text: 'x' }));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Note not found');
  });
});

describe('dayNotesApi.delete', () => {
  it('removes the note from the embedded array and answers {success:true}', async () => {
    await seedTrip();
    await seedDay(1, [note({ id: 5 }), note({ id: 6 })]);

    await expect(dayNotesApi.delete(1, 1, 5)).resolves.toEqual({ success: true });
    const day = (await db.days.get(1)) as DayRow;
    expect(day.notes_items.map((n) => n.id)).toEqual([6]);
  });

  it('404s a missing note id and a note of another day', async () => {
    await seedTrip();
    await seedDay(1, [note({ id: 5 })]);
    await seedDay(2, [note({ id: 5, day_id: 2 })]);
    for (const [dayId, id] of [[1, 77], [1, 999]] as const) {
      const err = await fail(dayNotesApi.delete(1, dayId, id));
      expect(err.response.status).toBe(404);
      expect(err.response.data.error).toBe('Note not found');
    }
    // id 5 on day 2 is fine — day-scoped lookup.
    await expect(dayNotesApi.delete(1, 2, 5)).resolves.toEqual({ success: true });
  });
});
