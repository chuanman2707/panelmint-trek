/**
 * Parity tests for the local `accommodationsApi` — the adapter that replaced
 * the axios object in api/client.ts, over the real Dexie `panelmint` database
 * (fake-indexeddb).
 *
 * Source fixtures: server/tests/unit/nest/accommodations.service.test.ts —
 * DAY-SVC-019/020 (row + linked 'hotel' reservation), ACC-003 (every bad ref
 * reported, first message wins), ACC-028 (an in-place move keeps the
 * stop row), ACC-029 (an unrelated edit mirrors nothing), ACC-031/032
 * (cancel takes back only its own stop; keepStop hands it over), ACC-010
 * (every linked reservation + its budget item dies with the stay) — plus the
 * PanelMint brief's own case: a spanning stay seats every night it covers, so
 * check-in…check-out across N nights puts N seats on the plan. Response
 * envelopes, widened where a spanning stay moves more than one seat at once
 * (a lone seat keeps the single-object shape):
 *   POST   → { accommodation, assignment, movedAssignment, removedAssignments, updatedAssignments }
 *   PUT    → same fields
 *   DELETE → { success: true, removedAssignments, updatedAssignments }
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { accommodationsApi } from '../../../src/api/local/accommodations';
import type { DayRow, StoredAssignment } from '../../../src/api/local/dexieStore';
import { db } from '../../../src/db/panelmintDb';
import type { Accommodation, Assignment, LocalUser } from '../../../src/types';
import { buildBudgetItem, buildDay, buildPlace, buildReservation, buildTrip } from '../../helpers/factories';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const seedTrip = () => db.trips.put(buildTrip({ id: 1 }));

const seedDay = (id: number, assignments: StoredAssignment[] = [], date?: string) =>
  db.days.put({
    vias: [],
    ...buildDay({ id, trip_id: 1, day_number: id, date: date ?? `2025-06-0${id}` }),
    assignments: assignments as never,
  } as DayRow);

const storedStop = (over: Partial<StoredAssignment>): StoredAssignment => ({
  id: 500,
  day_id: 1,
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

const seedPlace = (id: number, over: Parameters<typeof buildPlace>[0] = {}) =>
  db.places.put(buildPlace({ id, trip_id: 1, ...over }));

const seedStay = (over: Partial<Accommodation>) =>
  db.accommodations.put({
    id: 4,
    trip_id: 1,
    place_id: 5,
    start_day_id: 1,
    end_day_id: 2,
    check_in: '15:00',
    check_in_end: null,
    check_out: '11:00',
    confirmation: null,
    notes: null,
    created_at: '2025-01-01T00:00:00.000Z',
    ...over,
  } as Accommodation);

/** `SELECT * FROM day_assignments WHERE day_id = ? ORDER BY order_index`. */
const stopsOn = async (dayId: number): Promise<StoredAssignment[]> =>
  ((((await db.days.get(dayId)) as DayRow | undefined)?.assignments ?? []) as unknown as StoredAssignment[])
    .slice()
    .sort((a, b) => a.order_index - b.order_index);

/** Linked reservations by stay — `WHERE accommodation_id = ?` (no index, a scan). */
const linkedRes = async (stayId: number) =>
  (await db.reservations.toArray()).filter((r) => Number(r.accommodation_id) === stayId);

describe('accommodationsApi.list', () => {
  it('LOCAL-ACC-001 — trip stays with the place join and the linked booking title', async () => {
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedPlace(5, { name: 'Hotel Central', address: 'Hauptstr 1' });
    await seedStay({ id: 4, place_id: 5 });
    await db.reservations.put(buildReservation({ id: 30, title: 'Booking ref 77', accommodation_id: 4 }));
    // A stay on another trip never leaks in.
    await db.accommodations.put({ id: 9, trip_id: 2, place_id: 5, start_day_id: 1, end_day_id: 1 } as Accommodation);

    const { accommodations } = await accommodationsApi.list(1);
    expect(accommodations).toHaveLength(1);
    expect(accommodations[0]).toMatchObject({
      id: 4,
      trip_id: 1,
      place_name: 'Hotel Central',
      place_address: 'Hauptstr 1',
      reservation_title: 'Booking ref 77',
    });
  });

  it('LOCAL-ACC-002 — a stay with no place answers with null joins; an unknown trip is a 404', async () => {
    await seedTrip();
    await seedDay(1);
    await seedStay({ id: 4, place_id: null });

    const { accommodations } = await accommodationsApi.list(1);
    expect(accommodations[0]).toMatchObject({ id: 4, place_name: null, reservation_title: null });

    await expect(accommodationsApi.list(999)).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Trip not found' } },
    });
  });
});

describe('accommodationsApi.create', () => {
  it('LOCAL-ACC-003 — writes the stay, the linked hotel reservation and answers {accommodation, assignment}', async () => {
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedPlace(5, { name: 'Grand Hotel' });

    const res = await accommodationsApi.create(1, {
      place_id: 5,
      start_day_id: 1,
      end_day_id: 2,
      check_in: '15:00',
      check_in_end: '20:00',
      check_out: '11:00',
      confirmation: 'ABC-1',
      notes: 'quiet side',
    });

    // POST answers the full side-channel contract — the empty keys applyStops
    // treats as no-ops, so the one-night write reads like the old envelope.
    expect(res.accommodation).toMatchObject({
      trip_id: 1,
      place_id: 5,
      start_day_id: 1,
      end_day_id: 2,
      check_in: '15:00',
      check_in_end: '20:00',
      check_out: '11:00',
      confirmation: 'ABC-1',
      notes: 'quiet side',
      place_name: 'Grand Hotel',
    });
    expect(res).toMatchObject({
      movedAssignment: null,
      removedAssignments: [],
      updatedAssignments: [],
    });

    const stayId = res.accommodation.id;
    const stored = await db.accommodations.get(stayId);
    expect(stored).toMatchObject({ check_in_end: '20:00', notes: 'quiet side' });

    // The partner booking: 'hotel'/'confirmed', the place's name, seated on the
    // check-in day, carrying the stay's times as metadata.
    const resRows = await linkedRes(stayId);
    expect(resRows).toHaveLength(1);
    expect(resRows[0]).toMatchObject({
      trip_id: 1,
      day_id: 1,
      title: 'Grand Hotel',
      status: 'confirmed',
      type: 'hotel',
      reservation_time: '2025-06-01',
      confirmation_number: 'ABC-1',
      notes: 'quiet side',
    });
    expect(JSON.parse(resRows[0]!.metadata!)).toEqual({
      check_in_time: '15:00',
      check_in_end_time: '20:00',
      check_out_time: '11:00',
    });
  });

  it('LOCAL-ACC-004 — a two-night stay seats a stop on both nights and none on the check-out day', async () => {
    // The brief's case: a two-night stay (check-in day 1, check-out day 3) is
    // two nights — day 1's night and day 2's night. The check-out day itself
    // takes no seat: the night of it is spent somewhere else.
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedDay(3);
    await seedPlace(5, { name: 'Hotel Adlon' });

    const res = await accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 3 });
    const stayId = res.accommodation.id;

    // Two seats, both owned by the stay, reported back as the list shape.
    expect(res.assignment).toEqual([
      expect.objectContaining({ day_id: 1, place_id: 5, order_index: 0, accommodation_id: stayId }),
      expect.objectContaining({ day_id: 2, place_id: 5, order_index: 0, accommodation_id: stayId }),
    ]);
    const seats = res.assignment as { id: number; day_id: number }[];
    expect(await stopsOn(1)).toEqual([
      expect.objectContaining({ id: seats[0]!.id, place_id: 5, accommodation_id: stayId }),
    ]);
    expect(await stopsOn(2)).toEqual([
      expect.objectContaining({ id: seats[1]!.id, place_id: 5, accommodation_id: stayId }),
    ]);
    expect(await stopsOn(3)).toEqual([]);

    // Booking the night typed the untyped place as lodging.
    expect((await db.places.get(5))?.stop_type).toBe('hotel');
  });

  it('LOCAL-ACC-004b — a one-night stay seats only its check-in day', async () => {
    // Check in day 1, out day 2: one night, one seat — the server's shape.
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedPlace(5, { name: 'Hotel Adlon' });

    const res = await accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 2 });
    const stayId = res.accommodation.id;

    expect(res.assignment).toMatchObject({
      day_id: 1,
      place_id: 5,
      order_index: 0,
      accommodation_id: stayId,
      place: { id: 5, name: 'Hotel Adlon' },
    });
    expect(await stopsOn(1)).toEqual([expect.objectContaining({ place_id: 5, accommodation_id: stayId })]);
    expect(await stopsOn(2)).toEqual([]);
  });

  it('LOCAL-ACC-005 — a stop the traveller placed first is claimed, not duplicated', async () => {
    await seedTrip();
    await seedDay(1);
    await seedPlace(5, { name: 'Hotel Adlon' });
    const own = storedStop({ id: 50, day_id: 1, place_id: 5 });
    await db.days.put({
      vias: [],
      ...buildDay({ id: 1, trip_id: 1, day_number: 1 }),
      assignments: [own] as never,
    } as DayRow);

    const res = await accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 1 });

    expect(res.assignment).toBeNull();
    const stops = await stopsOn(1);
    expect(stops).toEqual([expect.objectContaining({ id: 50, accommodation_id: null })]);
  });

  it('LOCAL-ACC-006 — a night is seated by its check-in, ahead of a later afternoon', async () => {
    await seedTrip();
    await seedPlace(8, { name: 'Osteria', place_time: '19:00' });
    await seedPlace(5, { name: 'Hotel Adlon' });
    await seedDay(1, [storedStop({ id: 50, day_id: 1, place_id: 8, order_index: 0 })]);

    const res = await accommodationsApi.create(1, {
      place_id: 5,
      start_day_id: 1,
      end_day_id: 1,
      check_in: '15:00',
    });

    const stops = await stopsOn(1);
    expect(stops.map((s) => s.place_id)).toEqual([5, 8]);
    expect(res.assignment).toMatchObject({ order_index: 0 });
    expect(stops.find((s) => s.place_id === 8)?.order_index).toBe(1);
  });

  it('LOCAL-ACC-007 — a stop_type the traveller picked is never restamped', async () => {
    await seedTrip();
    await seedDay(1);
    await seedPlace(5, { name: 'Camp Riverside', stop_type: 'campsite' });

    await accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 1 });

    expect((await db.places.get(5))?.stop_type).toBe('campsite');
  });

  it('LOCAL-ACC-008 — the required-ref 400 and the per-ref 404s, verbatim', async () => {
    await seedTrip();
    await seedDay(1);
    await seedPlace(5);

    await expect(accommodationsApi.create(1, { start_day_id: 1, end_day_id: 1 } as never)).rejects.toMatchObject({
      status: 400,
      response: { data: { error: 'place_id, start_day_id, and end_day_id are required' } },
    });

    await expect(accommodationsApi.create(1, { place_id: 999, start_day_id: 1, end_day_id: 1 })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Place not found' } },
    });

    await expect(accommodationsApi.create(1, { place_id: 5, start_day_id: 999, end_day_id: 1 })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Start day not found' } },
    });

    await expect(accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 999 })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'End day not found' } },
    });

    // A place from another trip is a 'Place not found' — refs are trip-scoped.
    await db.places.put(buildPlace({ id: 6, trip_id: 2 }));
    await expect(accommodationsApi.create(1, { place_id: 6, start_day_id: 1, end_day_id: 1 })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Place not found' } },
    });

    await expect(accommodationsApi.create(999, { place_id: 5, start_day_id: 1, end_day_id: 1 })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Trip not found' } },
    });
  });

  it('LOCAL-ACC-009 — a traveller-placed stop on a middle night is never claimed', async () => {
    // The traveller pinned the hotel onto day 2 by hand; booking the stay
    // seats the nights the pin does not already hold, without owning day 2's.
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedDay(3);
    await seedPlace(5, { name: 'Hotel Adlon' });
    await db.days.update(2, {
      assignments: [storedStop({ id: 50, day_id: 2, place_id: 5 })] as never,
    });

    const res = await accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 3 });
    const stayId = res.accommodation.id;

    // Only day 1's seat — a lone seat comes back as the single-object shape.
    expect(res.assignment).toMatchObject({ day_id: 1, place_id: 5, accommodation_id: stayId });
    expect(await stopsOn(2)).toEqual([expect.objectContaining({ id: 50, accommodation_id: null })]);
  });
});

describe('accommodationsApi.update', () => {
  const book = async () => {
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedDay(3);
    await seedPlace(5, { name: 'Hotel Adlon' });
    return accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 2, check_in: '15:00' });
  };

  it('LOCAL-ACC-010 — moving the check-in day carries the same stop row over', async () => {
    const created = await book();
    const stayId = created.accommodation.id;
    const stopId = (created.assignment as Assignment).id;

    const res = await accommodationsApi.update(1, stayId, { start_day_id: 2, end_day_id: 2 });

    expect(res.accommodation).toMatchObject({ start_day_id: 2, end_day_id: 2, place_name: 'Hotel Adlon' });
    expect(res.movedAssignment).toMatchObject({
      oldDayId: 1,
      assignment: { id: stopId, day_id: 2, accommodation_id: stayId },
    });
    expect(res.removedAssignments).toEqual([]);
    expect(res.assignment).toBeNull();
    // The same row, carried — not a delete plus a fresh insert.
    expect(await stopsOn(1)).toEqual([]);
    expect(await stopsOn(2)).toEqual([expect.objectContaining({ id: stopId, day_id: 2, accommodation_id: stayId })]);
  });

  it('LOCAL-ACC-011 — moving the check-out later seats the newly covered night', async () => {
    const created = await book();
    const stayId = created.accommodation.id;
    const stopId = (created.assignment as Assignment).id;

    // [1,2] → [1,3]: the stay gains the night of day 2 — a fresh seat there,
    // the check-in day's seat untouched.
    const res = await accommodationsApi.update(1, stayId, { end_day_id: 3 });

    expect(res).toMatchObject({
      assignment: { day_id: 2, place_id: 5, accommodation_id: stayId },
      movedAssignment: null,
      removedAssignments: [],
    });
    expect(res.accommodation).toMatchObject({ start_day_id: 1, end_day_id: 3 });
    expect(await stopsOn(1)).toEqual([expect.objectContaining({ id: stopId, day_id: 1, accommodation_id: stayId })]);
    expect(await stopsOn(2)).toEqual([expect.objectContaining({ place_id: 5, accommodation_id: stayId })]);
    // Still no seat on the check-out day itself.
    expect(await stopsOn(3)).toEqual([]);
  });

  it("LOCAL-ACC-011b — moving the check-out earlier takes the vacated night's seat back", async () => {
    // The brief's case: create the two-night stay first, then shorten it.
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedDay(3);
    await seedPlace(5, { name: 'Hotel Adlon' });
    const created = await accommodationsApi.create(1, {
      place_id: 5,
      start_day_id: 1,
      end_day_id: 3,
      check_in: '15:00',
    });
    const stayId = created.accommodation.id;
    const seats = created.assignment as { id: number; day_id: number }[];
    const nightTwoSeat = seats.find((s) => s.day_id === 2)!;

    const res = await accommodationsApi.update(1, stayId, { end_day_id: 2 });

    // The night of day 2 is no longer the stay's — its seat goes, exactly the
    // row that was put down for it.
    expect(res.removedAssignments).toEqual([{ id: nightTwoSeat.id, dayId: 2 }]);
    expect(res.assignment).toBeNull();
    expect(await stopsOn(1)).toEqual([expect.objectContaining({ id: seats[0]!.id, accommodation_id: stayId })]);
    expect(await stopsOn(2)).toEqual([]);
  });

  it('LOCAL-ACC-012 — an unrelated edit leaves the stop and the stored columns alone', async () => {
    const created = await book();
    const stayId = created.accommodation.id;
    const stopId = (created.assignment as Assignment).id;

    const res = await accommodationsApi.update(1, stayId, { notes: 'ask for a late checkout' });

    expect(res).toMatchObject({ assignment: null, movedAssignment: null, removedAssignments: [] });
    const stored = await db.accommodations.get(stayId);
    expect(stored).toMatchObject({ notes: 'ask for a late checkout', check_in: '15:00', end_day_id: 2 });
    expect(await stopsOn(1)).toEqual([expect.objectContaining({ id: stopId })]);
  });

  it('LOCAL-ACC-013 — check times merge into the linked reservation metadata; confirmation COALESCEs', async () => {
    const created = await book();
    const stayId = created.accommodation.id;
    await db.reservations.update((await linkedRes(stayId))[0]!.id, { confirmation_number: 'RES-9' });

    await accommodationsApi.update(1, stayId, { check_in_end: '20:00', check_out: '12:00' });

    const res = (await linkedRes(stayId))[0]!;
    expect(JSON.parse(res.metadata!)).toEqual({
      check_in_time: '15:00',
      check_in_end_time: '20:00',
      check_out_time: '12:00',
    });
    // The stay has no confirmation — a number typed on the reservation stays.
    expect(res.confirmation_number).toBe('RES-9');
    // And the reservation's own day seat was never the stay's to move.
    expect(res.day_id).toBe(1);
  });

  it('LOCAL-ACC-014 — a new check-in hour re-seats the same stop', async () => {
    await seedTrip();
    await seedPlace(8, { name: 'Osteria', place_time: '19:00' });
    await seedPlace(5, { name: 'Hotel Adlon' });
    await seedDay(1, [storedStop({ id: 50, day_id: 1, place_id: 8, order_index: 0 })]);
    const created = await accommodationsApi.create(1, {
      place_id: 5,
      start_day_id: 1,
      end_day_id: 1,
      check_in: '15:00',
    });
    const stopId = (created.assignment as Assignment).id;

    const res = await accommodationsApi.update(1, created.accommodation.id, { check_in: '21:00' });

    // Behind the 19:00 dinner now — the same row re-seated, a move on its own day.
    expect((await stopsOn(1)).map((s) => s.place_id)).toEqual([8, 5]);
    expect(res.movedAssignment).toMatchObject({ oldDayId: 1, assignment: { id: stopId, day_id: 1 } });
    expect(res.removedAssignments).toEqual([]);
  });

  it('LOCAL-ACC-015 — missing, foreign-trip and bad-ref ids 404 verbatim', async () => {
    const created = await book();

    await expect(accommodationsApi.update(1, 999, { notes: 'x' })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Accommodation not found' } },
    });
    await db.accommodations.put({ id: 9, trip_id: 2, place_id: 5, start_day_id: 1, end_day_id: 1 } as Accommodation);
    await expect(accommodationsApi.update(1, 9, { notes: 'x' })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Accommodation not found' } },
    });
    await expect(accommodationsApi.update(1, created.accommodation.id, { end_day_id: 999 })).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'End day not found' } },
    });
  });
});

describe('accommodationsApi.delete', () => {
  const book = async () => {
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedPlace(5, { name: 'Hotel Adlon' });
    return accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 2 });
  };

  it('LOCAL-ACC-016 — cancelling takes back the stop it put down, the reservation and the budget item', async () => {
    const created = await book();
    const stayId = created.accommodation.id;
    const stopId = (created.assignment as Assignment).id;
    const resId = (await linkedRes(stayId))[0]!.id;
    await db.budgetItems.put(buildBudgetItem({ id: 60, trip_id: 1, reservation_id: resId }));
    await db.budgetItems.put(buildBudgetItem({ id: 61, trip_id: 1 }));

    const res = await accommodationsApi.delete(1, stayId);

    expect(res).toEqual({
      success: true,
      removedAssignments: [{ id: stopId, dayId: 1 }],
      updatedAssignments: [],
    });
    expect(await stopsOn(1)).toEqual([]);
    expect(await db.accommodations.get(stayId)).toBeUndefined();
    expect(await linkedRes(stayId)).toHaveLength(0);
    expect(await db.budgetItems.get(60)).toBeUndefined();
    // An unrelated expense is nobody's business here.
    expect(await db.budgetItems.get(61)).toBeDefined();
  });

  it("LOCAL-ACC-016b — cancelling a spanning stay takes back every night's seat", async () => {
    await seedTrip();
    await seedDay(1);
    await seedDay(2);
    await seedDay(3);
    await seedPlace(5, { name: 'Hotel Adlon' });
    const created = await accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 3 });
    const stayId = created.accommodation.id;
    const seats = created.assignment as { id: number; day_id: number }[];

    const res = await accommodationsApi.delete(1, stayId);

    expect(res).toEqual({
      success: true,
      removedAssignments: [
        { id: seats[0]!.id, dayId: 1 },
        { id: seats[1]!.id, dayId: 2 },
      ],
      updatedAssignments: [],
    });
    expect(await stopsOn(1)).toEqual([]);
    expect(await stopsOn(2)).toEqual([]);
    expect(await linkedRes(stayId)).toHaveLength(0);
  });

  it('LOCAL-ACC-017 — keepStop hands the stop to the traveller instead of taking it', async () => {
    const created = await book();
    const stayId = created.accommodation.id;
    const stopId = (created.assignment as Assignment).id;

    const res = await accommodationsApi.delete(1, stayId, { keepStop: true });

    expect(res).toEqual({
      success: true,
      removedAssignments: [],
      updatedAssignments: [expect.objectContaining({ id: stopId, day_id: 1, accommodation_id: null })],
    });
    expect(await stopsOn(1)).toEqual([expect.objectContaining({ id: stopId, accommodation_id: null })]);
    expect(await db.accommodations.get(stayId)).toBeUndefined();
  });

  it("LOCAL-ACC-018 — a night booked over the traveller's own stop leaves it standing", async () => {
    await seedTrip();
    await seedDay(1);
    await seedPlace(5, { name: 'Hotel Adlon' });
    await db.days.put({
      vias: [],
      ...buildDay({ id: 1, trip_id: 1, day_number: 1 }),
      assignments: [storedStop({ id: 50, day_id: 1, place_id: 5 })] as never,
    } as DayRow);
    const created = await accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 1 });

    const res = await accommodationsApi.delete(1, created.accommodation.id);

    // Nothing was ever owned, so nothing is taken back — the pause stays.
    expect(res.removedAssignments).toEqual([]);
    expect(await stopsOn(1)).toEqual([expect.objectContaining({ id: 50, accommodation_id: null })]);
  });

  it('LOCAL-ACC-019 — missing and foreign-trip ids 404 verbatim', async () => {
    await seedTrip();
    await expect(accommodationsApi.delete(1, 999)).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Accommodation not found' } },
    });
    await db.accommodations.put({ id: 9, trip_id: 2, place_id: 5, start_day_id: 1, end_day_id: 1 } as Accommodation);
    await expect(accommodationsApi.delete(1, 9)).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Accommodation not found' } },
    });
  });
});
