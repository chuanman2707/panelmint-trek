/**
 * Parity tests for the local `assignmentsApi` — the adapter that replaced the
 * axios object in api/client.ts, over the real Dexie `panelmint` database
 * (fake-indexeddb). Pins the server's envelopes ({assignments}/{assignment}/
 * {success: true}/{participants}), the two guard sets ('Day not found' on the
 * day-scoped routes vs the trip-scoped routes' lone 'Assignment not found'),
 * the roster-filtered participant rewrite, and — via the ported
 * assignment-time seam — the full updateTime response {assignment, reordered,
 * vias} with the chronological re-sort persisted into the embedded day rows.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { assignmentsApi } from '../../../src/api/local/assignments';
import { db } from '../../../src/db/panelmintDb';
import { buildTrip, buildDay, buildPlace } from '../../helpers/factories';
import type { LocalUser } from '../../../src/types';
import type { LocalTripMember } from '../../../src/db/panelmintDb';
import type { DayRow, StoredAssignment } from '../../../src/api/local/dexieStore';
import type { RoadtripVia } from '@trek/shared';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const seedTrip = (over = {}) => db.trips.put(buildTrip({ id: 1, ...over }));

const seedDay = async (id: number, assignments: StoredAssignment[], vias: RoadtripVia[] = []) => {
  const day = { vias, ...buildDay({ id, trip_id: 1, day_number: id }) } as DayRow;
  day.assignments = assignments as never;
  await db.days.put(day);
};

const storedAssignment = (over: Partial<StoredAssignment>): StoredAssignment => ({
  id: 500,
  day_id: 11,
  place_id: 21,
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

const storedDay = async (id: number): Promise<DayRow> => (await db.days.get(id)) as DayRow;

const member = async (userId: number, name: string) => {
  await db.localUsers.put({ id: userId, name, is_self: 0 });
  await db.tripMembers.put({
    tripId: 1, id: userId, username: name, role: 'member',
    added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
  } as LocalTripMember);
};

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

/** Trip 1 + day 11 carrying stop 71 on place 21 ('Cafe'). */
async function seedStop(over: Partial<StoredAssignment> = {}) {
  await seedTrip();
  await db.places.put(buildPlace({ id: 21, trip_id: 1, name: 'Cafe' }));
  await seedDay(11, [storedAssignment({ id: 71, day_id: 11, place_id: 21, ...over })]);
}

describe('assignmentsApi.list', () => {
  it('returns {assignments} in the place-joined wire shape, ordered by order_index', async () => {
    await seedTrip();
    await db.places.bulkPut([
      buildPlace({ id: 21, trip_id: 1, name: 'Cafe' }),
      buildPlace({ id: 22, trip_id: 1, name: 'Museum' }),
    ]);
    await seedDay(11, [
      storedAssignment({ id: 72, day_id: 11, place_id: 22, order_index: 1, assignment_time: '11:00' }),
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0, notes: 'first' }),
    ]);
    await db.assignmentParticipants.put({ id: 51, assignment_id: 71, user_id: 1 });

    const { assignments } = await assignmentsApi.list(1, 11);
    expect(assignments.map((a) => a.id)).toEqual([71, 72]);
    const first = assignments[0];
    expect(first).toMatchObject({ day_id: 11, place_id: 21, notes: 'first' });
    expect(first.place.name).toBe('Cafe');
    expect(first.participants).toEqual([{ user_id: 1, username: 'Me', avatar: null }]);
    // The list projection carries the times COALESCE over the place defaults.
    expect(assignments[1].place.place_time).toBe('11:00');
  });

  it('omits assignments whose place is gone (the server JOIN was inner)', async () => {
    await seedTrip();
    await seedDay(11, [storedAssignment({ id: 71, day_id: 11, place_id: 999 })]);
    const { assignments } = await assignmentsApi.list(1, 11);
    expect(assignments).toEqual([]);
  });

  it('404s an unreachable trip and a day outside the trip', async () => {
    const trip = await fail(assignmentsApi.list(999, 11));
    expect(trip.response.data.error).toBe('Trip not found');

    await seedTrip();
    await seedDay(11, []);
    const day = await fail(assignmentsApi.list(1, 999));
    expect(day.response.data.error).toBe('Day not found');
    // A day that exists but sits on another trip answers the same way.
    await db.trips.put(buildTrip({ id: 2 }));
    await db.days.put({ vias: [], ...buildDay({ id: 21, trip_id: 2, day_number: 1 }) } as DayRow);
    const foreign = await fail(assignmentsApi.list(1, 21));
    expect(foreign.response.data.error).toBe('Day not found');
  });
});

describe('assignmentsApi.create', () => {
  it('appends at max(order_index)+1 and returns the joined {assignment}', async () => {
    await seedStop();
    const { assignment } = await assignmentsApi.create(1, 11, { place_id: 21, notes: 'late lunch' });
    expect(assignment.order_index).toBe(1);
    expect(assignment.notes).toBe('late lunch');
    expect(assignment.place.name).toBe('Cafe');
    // Stored traveller-owned: no booking link, 'none' reservation, no times.
    const day = await storedDay(11);
    const created = day.assignments!.find((a) => a.id === assignment.id) as unknown as StoredAssignment;
    expect(created).toMatchObject({
      day_id: 11, place_id: 21, order_index: 1,
      reservation_status: 'none', accommodation_id: null,
      assignment_time: null, assignment_end_time: null,
    });
  });

  it('normalizes notes like the server ("" → null), and accepts a string place_id', async () => {
    await seedStop();
    const { assignment } = await assignmentsApi.create(1, 11, { place_id: '21', notes: '' });
    expect(assignment.place_id).toBe(21);
    expect(assignment.notes).toBeNull();
  });

  it('guards in order: trip → body pipe → day → place', async () => {
    const trip = await fail(assignmentsApi.create(999, 11, { place_id: 21 }));
    expect(trip.response.data.error).toBe('Trip not found');

    await seedStop();
    // A malformed body loses to the pipe before the day lookup ran…
    const malformed = await fail(assignmentsApi.create(1, 999, { place_id: 5, notes: 3 } as never));
    expect(malformed.response.status).toBe(400);
    // …but a valid body on a missing day is the day's 404.
    const day = await fail(assignmentsApi.create(1, 999, { place_id: 21 }));
    expect(day.response.data.error).toBe('Day not found');

    const missing = await fail(assignmentsApi.create(1, 11, { place_id: 999 }));
    expect(missing.response.data.error).toBe('Place not found');
    // A place on another trip is not this trip's place.
    await db.places.put(buildPlace({ id: 22, trip_id: 2 }));
    const foreign = await fail(assignmentsApi.create(1, 11, { place_id: 22 }));
    expect(foreign.response.data.error).toBe('Place not found');
    // The refused write touched nothing — the day still holds only its seed.
    expect((await storedDay(11)).assignments).toHaveLength(1);
  });
});

describe('assignmentsApi.delete', () => {
  it('deletes the row and its participant junction rows', async () => {
    await seedStop();
    await db.assignmentParticipants.put({ id: 51, assignment_id: 71, user_id: 1 });
    expect(await assignmentsApi.delete(1, 11, 71)).toEqual({ success: true });
    expect((await storedDay(11)).assignments).toEqual([]);
    expect(await db.assignmentParticipants.get(51)).toBeUndefined();
  });

  it('answers only "Assignment not found" — the delete route had one JOIN 404', async () => {
    await seedStop();
    // Wrong day, foreign-but-reachable trip and missing id all land on the
    // same string; even a day that does not exist never reaches 'Day not found'.
    await db.trips.put(buildTrip({ id: 2 }));
    for (const [t, d, id] of [[1, 999, 71], [2, 11, 71], [1, 11, 999]] as const) {
      const err = await fail(assignmentsApi.delete(t, d, id));
      expect(err.response.status).toBe(404);
      expect(err.response.data.error).toBe('Assignment not found');
    }
    expect((await storedDay(11)).assignments).toHaveLength(1);
  });
});

describe('assignmentsApi.reorder', () => {
  beforeEach(async () => {
    await seedTrip();
    await db.places.bulkPut([
      buildPlace({ id: 21, trip_id: 1 }),
      buildPlace({ id: 22, trip_id: 1 }),
      buildPlace({ id: 23, trip_id: 1 }),
    ]);
    await seedDay(11, [
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0 }),
      storedAssignment({ id: 72, day_id: 11, place_id: 22, order_index: 1 }),
      storedAssignment({ id: 73, day_id: 11, place_id: 23, order_index: 2 }),
    ]);
  });

  it('applies the listed order and returns {success: true}', async () => {
    expect(await assignmentsApi.reorder(1, 11, [73, 71, 72])).toEqual({ success: true });
    const day = await storedDay(11);
    expect(
      (day.assignments as unknown as StoredAssignment[])
        .slice()
        .sort((a, b) => a.order_index - b.order_index)
        .map((a) => a.id),
    ).toEqual([73, 71, 72]);
  });

  it('a foreign or nonexistent id is a silent no-op that still consumes its slot', async () => {
    // The route ran UPDATE … WHERE id=? AND day_id=? per listed id — no
    // permutation check, no 404.
    expect(await assignmentsApi.reorder(1, 11, [999, 73, 71, 72])).toEqual({ success: true });
    const day = (await storedDay(11)).assignments as unknown as StoredAssignment[];
    expect(day.find((a) => a.id === 73)!.order_index).toBe(1);
    expect(day.find((a) => a.id === 71)!.order_index).toBe(2);
    expect(day.find((a) => a.id === 72)!.order_index).toBe(3);
  });

  it('404s a day outside the trip', async () => {
    const err = await fail(assignmentsApi.reorder(1, 999, [71]));
    expect(err.response.data.error).toBe('Day not found');
  });
});

describe('assignmentsApi.move', () => {
  beforeEach(async () => {
    await seedStop();
    await seedDay(12, []);
  });

  it('moves the row to the target day at order_index ?? 0', async () => {
    const { assignment } = await assignmentsApi.move(1, 71, 12, null);
    expect(assignment.day_id).toBe(12);
    expect(assignment.order_index).toBe(0);
    expect((await storedDay(11)).assignments).toEqual([]);
    const moved = (await storedDay(12)).assignments![0] as unknown as StoredAssignment;
    expect(moved).toMatchObject({ id: 71, day_id: 12, place_id: 21 });
  });

  it('honours an explicit order_index', async () => {
    await db.days.put({ vias: [], ...buildDay({ id: 13, trip_id: 1, day_number: 3 }) } as DayRow);
    const { assignment } = await assignmentsApi.move(1, 71, 13, 2);
    expect(assignment.order_index).toBe(2);
  });

  it('404s "Assignment not found" and "Target day not found" on its own guard set', async () => {
    // Reachable but foreign: trip 2 exists (self-owned) yet holds no such stop.
    await db.trips.put(buildTrip({ id: 2 }));
    expect((await fail(assignmentsApi.move(1, 999, 12, null)))!.response.data.error).toBe('Assignment not found');
    expect((await fail(assignmentsApi.move(2, 71, 12, null)))!.response.data.error).toBe('Assignment not found');
    expect((await fail(assignmentsApi.move(1, 71, 999, null)))!.response.data.error).toBe('Target day not found');
  });
});

describe('assignmentsApi.update', () => {
  it('patches only the allowlisted columns — identity columns cannot move', async () => {
    await seedStop();
    const { assignment } = await assignmentsApi.update(1, 11, 71, {
      notes: 'edited',
      assignment_time: '10:00',
      leg_transport_mode: 'cycling',
      id: 999,
      day_id: 999,
      place_id: 999,
      bogus: 'kept off the row',
    });
    expect(assignment).toMatchObject({ id: 71, day_id: 11, place_id: 21, notes: 'edited' });
    const stored = (await storedDay(11)).assignments![0] as unknown as StoredAssignment;
    expect(stored.assignment_time).toBe('10:00');
    expect(stored.leg_transport_mode).toBe('cycling');
    expect(stored).not.toHaveProperty('bogus');
  });

  it('stores end_day as the server 0/1 flag', async () => {
    await seedStop();
    await assignmentsApi.update(1, 11, 71, { end_day: true });
    const stored = (await storedDay(11)).assignments![0] as unknown as StoredAssignment;
    expect(stored.end_day).toBe(1);
  });

  it('404s with the day-scoped messages', async () => {
    await seedStop();
    expect((await fail(assignmentsApi.update(1, 999, 71, {})))!.response.data.error).toBe('Day not found');
    expect((await fail(assignmentsApi.update(1, 11, 999, {})))!.response.data.error).toBe('Assignment not found');
  });
});

describe('assignmentsApi.updateTime', () => {
  it('persists the times and returns the full {assignment, reordered, vias} envelope', async () => {
    await seedStop();
    const res = await assignmentsApi.updateTime(1, 71, { place_time: '08:30', end_time: '10:00' });
    // One-stop day: nothing to re-sort, so the side channels are null, not absent.
    expect(res.reordered).toBeNull();
    expect(res.vias).toBeNull();
    expect(res.assignment).toMatchObject({
      id: 71, assignment_time: '08:30', assignment_end_time: '10:00',
    });
    expect(res.assignment.place.name).toBe('Cafe');
    const stored = (await storedDay(11)).assignments![0] as unknown as StoredAssignment;
    expect(stored.assignment_time).toBe('08:30');
    expect(stored.assignment_end_time).toBe('10:00');
  });

  it('a moved start re-sorts the day chronologically and reports orderedIds', async () => {
    await seedTrip();
    await db.places.bulkPut([
      buildPlace({ id: 21, trip_id: 1 }),
      buildPlace({ id: 22, trip_id: 1 }),
      buildPlace({ id: 23, trip_id: 1 }),
    ]);
    await seedDay(11, [
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0, assignment_time: '09:00' }),
      storedAssignment({ id: 72, day_id: 11, place_id: 22, order_index: 1, assignment_time: '11:00' }),
      storedAssignment({ id: 73, day_id: 11, place_id: 23, order_index: 2, assignment_time: '14:00' }),
    ]);

    const res = await assignmentsApi.updateTime(1, 73, { place_time: '08:00', end_time: null });
    expect(res.reordered).toEqual({ dayId: 11, orderedIds: [73, 71, 72] });
    const stored = (await storedDay(11)).assignments as unknown as StoredAssignment[];
    // Changed indices were rewritten from 0, the way a drag numbers a day.
    expect(stored.find((a) => a.id === 73)!.order_index).toBe(0);
    expect(stored.find((a) => a.id === 71)!.order_index).toBe(1);
    expect(stored.find((a) => a.id === 72)!.order_index).toBe(2);
  });

  it('effective time precedence: assignment override > place time > booking check-in', async () => {
    await seedTrip();
    await db.places.bulkPut([
      buildPlace({ id: 21, trip_id: 1, place_time: '09:00' }),
      buildPlace({ id: 22, trip_id: 1, place_time: '11:00' }),
      buildPlace({ id: 23, trip_id: 1, place_time: null }),
    ]);
    await db.accommodations.put({
      id: 31, trip_id: 1, place_id: null, start_day_id: 11, end_day_id: 11,
      check_in: '14:00', check_in_end: null, check_out: null, confirmation: null, notes: null,
    });
    await seedDay(11, [
      // Override wins over the place's own 09:00 → sorts at 18:00.
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0, assignment_time: '18:00' }),
      storedAssignment({ id: 72, day_id: 11, place_id: 22, order_index: 1 }),
      // No override and no place time → the night's check-in times it at 14:00.
      storedAssignment({ id: 73, day_id: 11, place_id: 23, order_index: 2, accommodation_id: 31 }),
    ]);

    const res = await assignmentsApi.updateTime(1, 72, { place_time: '19:00', end_time: null });
    expect(res.reordered?.orderedIds).toEqual([73, 71, 72]);
  });

  it('a booking-linked stop is timed by its check-in — resending it does not resort', async () => {
    await seedTrip();
    await db.places.put(buildPlace({ id: 21, trip_id: 1, place_time: null }));
    await db.accommodations.put({
      id: 31, trip_id: 1, place_id: null, start_day_id: 11, end_day_id: 11,
      check_in: '15:00', check_in_end: null, check_out: null, confirmation: null, notes: null,
    });
    await seedDay(11, [storedAssignment({ id: 71, day_id: 11, place_id: 21, accommodation_id: 31 })]);

    const res = await assignmentsApi.updateTime(1, 71, { place_time: '15:00', end_time: null });
    expect(res.reordered).toBeNull();
    // The write itself still lands — it is now an explicit override.
    expect(res.assignment.assignment_time).toBe('15:00');
  });

  it('an unreadable start sorts after every real time (the 99:99 sentinel)', async () => {
    await seedTrip();
    await db.places.bulkPut([buildPlace({ id: 21, trip_id: 1 }), buildPlace({ id: 22, trip_id: 1 })]);
    await seedDay(11, [
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0, assignment_time: 'morning' }),
      storedAssignment({ id: 72, day_id: 11, place_id: 22, order_index: 1, assignment_time: '09:00' }),
    ]);
    const res = await assignmentsApi.updateTime(1, 72, { place_time: '19:00', end_time: null });
    expect(res.reordered?.orderedIds).toEqual([72, 71]);
  });

  it('a start sent again as it stood leaves the day alone; so does an end alone', async () => {
    await seedStop({ assignment_time: '09:00' });
    const same = await assignmentsApi.updateTime(1, 71, { place_time: '09:00', end_time: null });
    expect(same.reordered).toBeNull();
    const endOnly = await assignmentsApi.updateTime(1, 71, { place_time: null, end_time: '10:30' });
    expect(endOnly.reordered).toBeNull();
    expect((await storedDay(11)).assignments![0]!.assignment_end_time).toBe('10:30');
  });

  it("'' clears the override without resorting (falsy is a clear, not a value)", async () => {
    await seedStop({ assignment_time: '09:00' });
    const res = await assignmentsApi.updateTime(1, 71, { place_time: '', end_time: '' } as never);
    expect(res.reordered).toBeNull();
    const stored = (await storedDay(11)).assignments![0] as unknown as StoredAssignment;
    expect(stored.assignment_time).toBeNull();
    expect(stored.assignment_end_time).toBeNull();
  });

  it('re-pins a via when the located stops it follows re-sort', async () => {
    await seedTrip();
    await db.places.bulkPut([21, 22, 23, 24].map((id) => buildPlace({ id, trip_id: 1 })));
    const via: RoadtripVia = { id: 50, day_id: 11, after_order_index: 0, sequence: 0, lat: 5, lng: 5 };
    await seedDay(11, [
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0, assignment_time: '09:00' }),
      storedAssignment({ id: 72, day_id: 11, place_id: 22, order_index: 1, assignment_time: '11:00' }),
      storedAssignment({ id: 73, day_id: 11, place_id: 23, order_index: 2, assignment_time: '14:00' }),
      storedAssignment({ id: 74, day_id: 11, place_id: 24, order_index: 3, assignment_time: '13:00' }),
    ], [via]);

    // 74 moves to the front: the via sat behind 71 and follows it to index 1.
    const res = await assignmentsApi.updateTime(1, 74, { place_time: '08:00', end_time: null });
    expect(res.reordered?.orderedIds).toEqual([74, 71, 72, 73]);
    expect(res.vias?.dayId).toBe(11);
    expect(res.vias?.vias.map((v) => [v.id, v.after_order_index])).toEqual([[50, 1]]);
    expect((await storedDay(11)).vias![0]!.after_order_index).toBe(1);
  });

  it('drops a via whose anchor became the last located stop', async () => {
    await seedTrip();
    await db.places.bulkPut([21, 22, 23].map((id) => buildPlace({ id, trip_id: 1 })));
    const via: RoadtripVia = { id: 51, day_id: 11, after_order_index: 0, sequence: 0, lat: 5, lng: 5 };
    await seedDay(11, [
      storedAssignment({ id: 71, day_id: 11, place_id: 21, order_index: 0, assignment_time: '09:00' }),
      storedAssignment({ id: 72, day_id: 11, place_id: 22, order_index: 1, assignment_time: '11:00' }),
      storedAssignment({ id: 73, day_id: 11, place_id: 23, order_index: 2, assignment_time: '14:00' }),
    ], [via]);

    const res = await assignmentsApi.updateTime(1, 71, { place_time: '20:00', end_time: null });
    expect(res.vias).toEqual({ dayId: 11, vias: [] });
    expect((await storedDay(11)).vias).toEqual([]);
  });

  it('404s "Assignment not found" on the trip-scoped guard', async () => {
    await seedStop();
    await db.trips.put(buildTrip({ id: 2 })); // reachable, but holds no stop 71
    expect((await fail(assignmentsApi.updateTime(1, 999, {})))!.response.data.error).toBe('Assignment not found');
    expect((await fail(assignmentsApi.updateTime(2, 71, {})))!.response.data.error).toBe('Assignment not found');
  });

  it('a malformed body loses to the pipe before the 404', async () => {
    await seedStop();
    const err = await fail(assignmentsApi.updateTime(1, 999, { place_time: 5 } as never));
    expect(err.response.status).toBe(400);
  });
});

describe('assignmentsApi.updateNotes', () => {
  it('writes the day-specific note; "" clears like null (#2163)', async () => {
    await seedStop();
    const { assignment } = await assignmentsApi.updateNotes(1, 71, { notes: 'Book the 10:00 entry' });
    expect(assignment.notes).toBe('Book the 10:00 entry');
    const cleared = await assignmentsApi.updateNotes(1, 71, { notes: '' });
    expect(cleared.assignment.notes).toBeNull();
    expect((await storedDay(11)).assignments![0]!.notes).toBeNull();
  });

  it('404s "Assignment not found"', async () => {
    await seedTrip();
    expect((await fail(assignmentsApi.updateNotes(1, 999, { notes: null })))!.response.data.error).toBe('Assignment not found');
  });
});

describe('assignmentsApi.updateTransport', () => {
  it('writes the outgoing leg by default and the incoming leg when asked (#1281)', async () => {
    await seedStop();
    const { assignment } = await assignmentsApi.updateTransport(1, 71, 'walking');
    expect(assignment.leg_transport_mode).toBe('walking');
    expect((await storedDay(11)).assignments![0]!.leg_transport_mode).toBe('walking');

    const incoming = await assignmentsApi.updateTransport(1, 71, 'cable_car', 'incoming');
    expect(incoming.assignment.incoming_leg_transport_mode).toBe('cable_car');
    expect((await storedDay(11)).assignments![0]!.incoming_leg_transport_mode).toBe('cable_car');

    const cleared = await assignmentsApi.updateTransport(1, 71, null);
    expect(cleared.assignment.leg_transport_mode).toBeNull();
    expect((await storedDay(11)).assignments![0]!.leg_transport_mode).toBeNull();
  });

  it('404s "Assignment not found"', async () => {
    await seedTrip();
    expect((await fail(assignmentsApi.updateTransport(1, 999, null)))!.response.data.error).toBe('Assignment not found');
  });
});

describe('assignmentsApi.setEndDay', () => {
  it('stores the 0/1 flag and returns the wire boolean', async () => {
    await seedStop();
    const { assignment } = await assignmentsApi.setEndDay(1, 71, { end_day: true });
    expect(assignment.end_day).toBe(true);
    expect((await storedDay(11)).assignments![0]!.end_day).toBe(1);
    const cleared = await assignmentsApi.setEndDay(1, 71, { end_day: false });
    expect(cleared.assignment.end_day).toBe(false);
    expect((await storedDay(11)).assignments![0]!.end_day).toBe(0);
  });

  it('404s "Assignment not found"', async () => {
    await seedTrip();
    expect((await fail(assignmentsApi.setEndDay(1, 999, { end_day: true })))!.response.data.error).toBe('Assignment not found');
  });
});

describe('assignment participants', () => {
  it('getParticipants returns the joined {participants} projection', async () => {
    await seedStop();
    await member(9, 'bob');
    await db.assignmentParticipants.bulkPut([
      { id: 51, assignment_id: 71, user_id: 1 },
      { id: 52, assignment_id: 71, user_id: 9 },
      // A junction row whose user row is gone keeps the server's 'Guest N' fallback.
      { id: 53, assignment_id: 71, user_id: 77 },
    ]);
    const { participants } = await assignmentsApi.getParticipants(1, 71);
    expect(participants).toEqual([
      { user_id: 1, username: 'Me', avatar: null },
      { user_id: 9, username: 'bob', avatar: null },
      { user_id: 77, username: 'Guest 77', avatar: null },
    ]);
  });

  it('setParticipants rewrites the junction, filtered to the trip roster', async () => {
    await seedStop();
    await member(9, 'bob');
    await db.assignmentParticipants.put({ id: 51, assignment_id: 71, user_id: 99 });

    const { participants } = await assignmentsApi.setParticipants(1, 71, [1, 9, 99]);
    // 99 is off-roster (not the owner, not a member) — dropped silently.
    expect(participants).toEqual([
      { user_id: 1, username: 'Me', avatar: null },
      { user_id: 9, username: 'bob', avatar: null },
    ]);
    const rows = await db.assignmentParticipants.where('assignment_id').equals(71).toArray();
    expect(rows.map((r) => r.user_id).sort()).toEqual([1, 9]);
  });

  it('setParticipants dedups like INSERT OR IGNORE into UNIQUE(assignment_id, user_id)', async () => {
    await seedStop();
    const { participants } = await assignmentsApi.setParticipants(1, 71, [1, 1, 1]);
    expect(participants).toEqual([{ user_id: 1, username: 'Me', avatar: null }]);
    expect(await db.assignmentParticipants.where('assignment_id').equals(71).count()).toBe(1);
  });

  it('404s "Assignment not found" on both routes', async () => {
    await seedTrip();
    expect((await fail(assignmentsApi.getParticipants(1, 999)))!.response.data.error).toBe('Assignment not found');
    expect((await fail(assignmentsApi.setParticipants(1, 999, [1])))!.response.data.error).toBe('Assignment not found');
  });
});
