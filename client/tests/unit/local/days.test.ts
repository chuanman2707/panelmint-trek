/**
 * Parity tests for the local `daysApi` — the adapter that replaced
 * `apiClient.get('/trips/:id/days', …)` over the real Dexie `panelmint`
 * database (fake-indexeddb). Pins the server's envelopes ({days}/{day}/
 * {success:true}), the list vs update assignment projections, the presence
 * sentinels on update, the 'Day not found' 404, and — the reason the ported
 * algorithm exists — reorder/insert's two-phase renumber over Dexie's real
 * &[trip_id+day_number] unique index.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { daysApi } from '../../../src/api/local/days';
import { db } from '../../../src/db/panelmintDb';
import { withStore } from '../../../src/api/local/dexieStore';
import { buildTrip, buildDay, buildPlace, buildReservation } from '../../helpers/factories';
import type { LocalUser } from '../../../src/types';
import type { DayRow, StoredAssignment } from '../../../src/api/local/dexieStore';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const seedTrip = (over = {}) => db.trips.put(buildTrip({ id: 1, ...over }));

const storedAssignment = (over: Partial<StoredAssignment>): StoredAssignment => ({
  id: 500,
  day_id: 1,
  place_id: 1,
  order_index: 0,
  notes: null,
  reservation_status: 'none',
  reservation_notes: null,
  reservation_datetime: null,
  assignment_time: null,
  assignment_end_time: null,
  end_day: 0,
  accommodation_id: null,
  leg_transport_mode: null,
  incoming_leg_transport_mode: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ...over,
});

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('daysApi.list', () => {
  it('returns {days} ordered by day_number with hydrated assignments + notes', async () => {
    await seedTrip();
    const day = { vias: [], ...buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }) } as DayRow;
    day.assignments = [
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0 }),
    ] as never;
    day.notes_items = [{ id: 91, day_id: 11, text: 'note', time: null, icon: null, sort_order: 0 }] as never;
    await db.places.put(buildPlace({ id: 21, trip_id: 1, name: 'Cafe' }));
    await db.days.put(day);
    await db.days.put(buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }));

    const { days } = await daysApi.list(1);
    expect(days).toHaveLength(2);
    expect(days[0].id).toBe(11);
    expect(days[0].assignments).toHaveLength(1);
    // The list projection joins the place and carries fill_percent + times.
    expect(days[0].assignments[0].place.name).toBe('Cafe');
    expect(days[0].assignments[0]).toHaveProperty('place_id', 21);
    expect(days[0].assignments[0]).toHaveProperty('participants');
    expect(days[0].notes_items[0].text).toBe('note');
    // `vias` is a stored column, not part of the wire day.
    expect(days[0]).not.toHaveProperty('vias');
  });

  it('omits assignments whose place is gone (the server JOIN was inner)', async () => {
    await seedTrip();
    const day = { vias: [], ...buildDay({ id: 11, trip_id: 1, day_number: 1 }) } as DayRow;
    day.assignments = [storedAssignment({ id: 71, day_id: 11, place_id: 999 })] as never;
    await db.days.put(day);
    const { days } = await daysApi.list(1);
    expect(days[0].assignments).toEqual([]);
  });

  it('404s an unreachable trip', async () => {
    const err = await fail(daysApi.list(999));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('daysApi.create', () => {
  it('appends at max(day_number)+1 without a position, keeping the sent date', async () => {
    await seedTrip();
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
    ]);
    const { day } = await daysApi.create(1, { date: '2026-03-09', notes: 'scratch' });
    expect(day.day_number).toBe(3);
    expect(day.date).toBe('2026-03-09');
    // The server's append returned the row with assignments: [] — no notes_items key.
    expect(day.assignments).toEqual([]);
    expect(day.notes_items).toBeUndefined();
    // The append does NOT shift dates — day 2 keeps its own.
    expect((await db.days.get(12))!.date).toBe('2026-03-02');
  });

  it('inserts at position on a dated trip: re-pins dates and extends end_date', async () => {
    await seedTrip({ start_date: '2026-03-01', end_date: '2026-03-03' });
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
    ]);
    await db.reservations.put(
      buildReservation({ id: 9, trip_id: 1, day_id: 13, reservation_time: '2026-03-03T18:30' }),
    );
    const { day } = await daysApi.create(1, { position: 2 });
    const all = await db.days.where('trip_id').equals(1).sortBy('day_number');
    // Slots keep contiguous dates; the new day takes 03-02 and the rest shift.
    expect(all.map((d) => [d.id, d.day_number, d.date])).toEqual([
      [11, 1, '2026-03-01'],
      [day.id, 2, '2026-03-02'],
      [12, 3, '2026-03-03'],
      [13, 4, '2026-03-04'],
    ]);
    expect((await db.trips.get(1))!.end_date).toBe('2026-03-04');
    // The booking followed its day row to the new date (restamp, time kept).
    expect((await db.reservations.get(9))!.reservation_time).toBe('2026-03-04T18:30');
    // The insert response carries both empty arrays (server parity).
    expect(day.assignments).toEqual([]);
    expect(day.notes_items).toEqual([]);
  });

  it('runs the trip guard first, then the body pipe', async () => {
    await seedTrip();
    // Trip exists but the body is invalid → 400.
    const err = await fail(daysApi.create(1, { position: -1 }));
    expect(err.response.status).toBe(400);
    // Trip missing → the access 404 fires before the body is even read.
    const missing = await fail(daysApi.create(999, { position: -1 }));
    expect(missing.response.data.error).toBe('Trip not found');
  });
});

describe('daysApi.update', () => {
  beforeEach(async () => {
    await seedTrip();
    const day = { vias: [], ...buildDay({ id: 11, trip_id: 1, day_number: 1, notes: 'old', title: 'T' }) } as DayRow;
    day.assignments = [storedAssignment({ id: 71, day_id: 11, place_id: 21 })] as never;
    day.notes_items = [{ id: 91, day_id: 11, text: 'n', time: null, icon: null, sort_order: 0 }] as never;
    await db.places.put(buildPlace({ id: 21, trip_id: 1 }));
    await db.days.put(day);
  });

  it('applies presence sentinels: notes "" clears to null, absent title is kept', async () => {
    const { day } = await daysApi.update(1, 11, { notes: '' });
    expect(day.notes).toBeNull();
    expect(day.title).toBe('T');
    const stored = await db.days.get(11);
    expect(stored!.notes).toBeNull();
    expect(stored!.title).toBe('T');
  });

  it('returns the slim update projection — no notes_items, no place_id/times', async () => {
    const { day } = await daysApi.update(1, 11, { title: 'New' });
    expect(day.title).toBe('New');
    expect(day.notes_items).toBeUndefined();
    expect(day.assignments).toHaveLength(1);
    expect(day.assignments[0]).not.toHaveProperty('place_id');
    expect(day.assignments[0]).not.toHaveProperty('participants');
    expect(day.assignments[0].place.name).toBeTruthy();
  });

  it('404s a day outside the trip and a NaN id', async () => {
    const err = await fail(daysApi.update(1, 999, { notes: 'x' }));
    expect(err.response.data.error).toBe('Day not found');
    const nan = await fail(daysApi.update(1, 'abc', { notes: 'x' }));
    expect(nan.response.data.error).toBe('Day not found');
  });

  it('a malformed body beats the day 404 (the pipe ran first)', async () => {
    const err = await fail(daysApi.update(1, 999, { notes: 5 } as never));
    expect(err.response.status).toBe(400);
  });
});

describe('daysApi.updateTransport', () => {
  it('writes only default_transport_mode and returns the slim day', async () => {
    await seedTrip();
    await db.days.put(buildDay({ id: 11, trip_id: 1, day_number: 1, notes: 'keep' }));
    const { day } = await daysApi.updateTransport(1, 11, 'car');
    expect(day.default_transport_mode).toBe('car');
    expect(day.notes).toBe('keep');
    const cleared = await daysApi.updateTransport(1, 11, null);
    expect(cleared.day.default_transport_mode).toBeNull();
  });
});

describe('daysApi.delete', () => {
  it('deletes the row and cascades the FK set', async () => {
    await seedTrip();
    const day = { vias: [], ...buildDay({ id: 11, trip_id: 1, day_number: 1 }) } as DayRow;
    day.assignments = [storedAssignment({ id: 71, day_id: 11, place_id: 21 })] as never;
    await db.days.put(day);
    await db.days.put(buildDay({ id: 12, trip_id: 1, day_number: 2 }));
    await db.accommodations.put({
      id: 31, trip_id: 1, place_id: null, start_day_id: 11, end_day_id: 12,
      check_in: null, check_in_end: null, check_out: null, confirmation: null, notes: null,
    });
    await db.reservations.put(buildReservation({ id: 41, trip_id: 1, day_id: 11, end_day_id: 12 }));
    await db.assignmentParticipants.put({ id: 51, assignment_id: 71, user_id: 1 });

    expect(await daysApi.delete(1, 11)).toEqual({ success: true });
    expect(await db.days.get(11)).toBeUndefined();
    // Accommodation spanned the deleted day → cascade.
    expect(await db.accommodations.get(31)).toBeUndefined();
    // Reservation links go NULL, not deleted.
    const r = await db.reservations.get(41);
    expect(r!.day_id).toBeNull();
    expect(r!.end_day_id).toBe(12);
    // The day's participants died with the embedded assignment.
    expect(await db.assignmentParticipants.get(51)).toBeUndefined();
  });

  it('stay-delete legs: a surviving day hands the stay back and reservations unlink', async () => {
    await seedTrip();
    // Day 11 dies holding the stay's anchor; day 12 survives with a stop
    // booked into that stay, and a reservation points at it.
    const dying = { vias: [], ...buildDay({ id: 11, trip_id: 1, day_number: 1 }) } as DayRow;
    const surviving = { vias: [], ...buildDay({ id: 12, trip_id: 1, day_number: 2 }) } as DayRow;
    surviving.assignments = [
      storedAssignment({ id: 72, day_id: 12, place_id: 21, accommodation_id: 31 }),
    ] as never;
    await db.days.bulkPut([dying, surviving]);
    await db.places.put(buildPlace({ id: 21, trip_id: 1 }));
    await db.accommodations.put({
      id: 31, trip_id: 1, place_id: null, start_day_id: 11, end_day_id: 12,
      check_in: null, check_in_end: null, check_out: null, confirmation: null, notes: null,
    });
    await db.reservations.put(buildReservation({ id: 41, trip_id: 1, day_id: 12, accommodation_id: 31 }));

    await daysApi.delete(1, 11);

    expect(await db.accommodations.get(31)).toBeUndefined();
    // trg_release_stop_on_stay_delete — the surviving day's stop lets go.
    const day12 = (await db.days.get(12)) as DayRow;
    expect(day12.assignments?.[0]?.accommodation_id).toBeNull();
    // reservations.accommodation_id ON DELETE SET NULL.
    expect((await db.reservations.get(41))!.accommodation_id).toBeNull();
  });
});

describe('DexieStore stay seams', () => {
  const seedStay = () =>
    db.accommodations.put({
      id: 31, trip_id: 1, place_id: null, start_day_id: 11, end_day_id: 12,
      check_in: '15:00', check_in_end: '15:30', check_out: '11:00', confirmation: 'OLD', notes: null,
    });

  it('deleteStay releases referencing stops on every day and unlinks reservations', async () => {
    await seedTrip();
    const d11 = { vias: [], ...buildDay({ id: 11, trip_id: 1, day_number: 1 }) } as DayRow;
    const d12 = { vias: [], ...buildDay({ id: 12, trip_id: 1, day_number: 2 }) } as DayRow;
    d11.assignments = [storedAssignment({ id: 71, day_id: 11, place_id: 21, accommodation_id: 31 })] as never;
    d12.assignments = [storedAssignment({ id: 72, day_id: 12, place_id: 21, accommodation_id: 31 })] as never;
    await db.days.bulkPut([d11, d12]);
    await seedStay();
    await db.reservations.put(buildReservation({ id: 41, trip_id: 1, accommodation_id: 31 }));

    await withStore((s) => s.deleteStay(31, 1));

    expect(await db.accommodations.get(31)).toBeUndefined();
    for (const id of [11, 12]) {
      const d = (await db.days.get(id)) as DayRow;
      expect(d.assignments?.[0]?.accommodation_id).toBeNull();
    }
    expect((await db.reservations.get(41))!.accommodation_id).toBeNull();
  });

  it('stay/reservation sync overwrites on non-null input — COALESCE(?, col) binds incoming || null', async () => {
    await seedTrip();
    await seedStay();
    await db.reservations.put(
      buildReservation({ id: 41, trip_id: 1, accommodation_id: 31, confirmation_number: 'OLD' }),
    );
    await withStore((s) => {
      s.syncStayTimes(31, { check_in_time: '16:00' });
      s.syncStayConfirmation(31, 'NEW');
      s.updateReservationMeta(41, '{"check_in_time":"16:00"}', 'NEW');
    });
    // Non-null incoming values overwrite the stored columns.
    const a = (await db.accommodations.get(31))!;
    expect(a.check_in).toBe('16:00');
    expect(a.check_in_end).toBe('15:30'); // untouched fields keep their value
    expect(a.confirmation).toBe('NEW');
    expect((await db.reservations.get(41))!.confirmation_number).toBe('NEW');
    // …and a null/absent leg still preserves.
    await withStore((s) => {
      s.syncStayTimes(31, {});
      s.updateReservationMeta(41, '{}', null);
    });
    expect((await db.accommodations.get(31))!.check_in).toBe('16:00');
    expect((await db.reservations.get(41))!.confirmation_number).toBe('NEW');
  });
});

describe('daysApi.reorder', () => {
  beforeEach(async () => {
    await seedTrip({ start_date: '2026-03-01', end_date: '2026-03-03' });
    await db.days.bulkPut([
      buildDay({ id: 11, trip_id: 1, day_number: 1, date: '2026-03-01' }),
      buildDay({ id: 12, trip_id: 1, day_number: 2, date: '2026-03-02' }),
      buildDay({ id: 13, trip_id: 1, day_number: 3, date: '2026-03-03' }),
    ]);
  });

  it('rejects non-permutations with the server message', async () => {
    const err = await fail(daysApi.reorder(1, [11, 12]));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('orderedIds must be a permutation of the trip day ids.');
    const foreign = await fail(daysApi.reorder(1, [11, 12, 999]));
    expect(foreign.response.data.error).toBe('orderedIds must be a permutation of the trip day ids.');
  });

  it('re-pins dates to slots via the two-phase renumber — the unique index holds', async () => {
    expect(await daysApi.reorder(1, [13, 11, 12])).toEqual({ success: true });
    const all = await db.days.where('trip_id').equals(1).sortBy('day_number');
    expect(all.map((d) => [d.id, d.day_number, d.date])).toEqual([
      [13, 1, '2026-03-01'],
      [11, 2, '2026-03-02'],
      [12, 3, '2026-03-03'],
    ]);
  });

  it('restamps reservation dates on re-dated days, keeping the time', async () => {
    await db.reservations.put(
      buildReservation({ id: 9, trip_id: 1, day_id: 13, reservation_time: '2026-03-03T18:30' }),
    );
    await daysApi.reorder(1, [13, 11, 12]);
    // Day 13 moved to slot 1 → 2026-03-01.
    expect((await db.reservations.get(9))!.reservation_time).toBe('2026-03-01T18:30');
  });

  it('rolls back entirely when the reorder would invert a stay', async () => {
    await db.accommodations.put({
      id: 31, trip_id: 1, place_id: null, start_day_id: 11, end_day_id: 13,
      check_in: null, check_in_end: null, check_out: null, confirmation: null, notes: null,
    });
    // Move day 11 to the end: the stay's start would sit after its end.
    const err = await fail(daysApi.reorder(1, [12, 13, 11]));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('This move would make an accommodation end before it starts.');
    // Nothing was written — the checkpoint restore + tx abort is the port's safety.
    const all = await db.days.where('trip_id').equals(1).sortBy('day_number');
    expect(all.map((d) => d.id)).toEqual([11, 12, 13]);
  });

  it('keeps dateless reorders dateless', async () => {
    await db.trips.put(buildTrip({ id: 2, start_date: null, end_date: null }));
    await db.days.bulkPut([
      buildDay({ id: 21, trip_id: 2, day_number: 1, date: null }),
      buildDay({ id: 22, trip_id: 2, day_number: 2, date: null }),
    ]);
    await daysApi.reorder(2, [22, 21]);
    const all = await db.days.where('trip_id').equals(2).sortBy('day_number');
    expect(all.map((d) => [d.id, d.date])).toEqual([
      [22, null],
      [21, null],
    ]);
  });
});
