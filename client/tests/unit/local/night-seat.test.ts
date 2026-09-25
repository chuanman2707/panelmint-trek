/**
 * Parity tests for the ported night-seat rules.
 *
 * Source fixtures: server/tests/unit/nest/accommodations/night-seat.test.ts
 * pins the seating order (untimed nights lead; timed nights settle by check-in
 * then booking id; a booking-owned stop is measured by its check-in), the
 * two-step reseat (park at end, then seat), and the via rules (follow your
 * stop; inherit the road of a removed stop; a via behind the last stop stays
 * while that stop stays last). Pure rules run bare; store-dependent rules run
 * over the MemoryStore seam.
 */
import { describe, expect, it } from 'vitest';
import {
  attachStayNights,
  attachStayStop,
  carryVias,
  dropStayStops,
  mirrorTouchedDays,
  moveStayNights,
  moveStayStop,
  reseatOwnStop,
  seatAmong,
  seatHolds,
  seatIndex,
  standsAhead,
  type Night,
  type SeatRow,
} from '../../../src/api/local/ported/night-seat';
import { MemoryStore, type MemAssignment, type MemPlace } from './helpers/memoryStore';

const row = (
  id: number,
  order_index: number,
  at: string | null,
  night_id: number | null = null,
  located = 1
): SeatRow => ({ id, order_index, at, night_id, located });
const night = (id: number, check_in: string | null | undefined): Night => ({ id, check_in });
const place = (id: number, lat: number | null = 1, lng: number | null = 1): MemPlace => ({
  id,
  trip_id: 1,
  name: `p${id}`,
  lat,
  lng,
});
const stop = (id: number, dayId: number, placeId: number, order: number, acc: number | null = null): MemAssignment => ({
  id,
  day_id: dayId,
  place_id: placeId,
  order_index: order,
  assignment_time: null,
  assignment_end_time: null,
  accommodation_id: acc,
});

describe('standsAhead / seatAmong', () => {
  it('an untimed night leads everything except earlier untimed bookings', () => {
    const rows = [row(1, 0, '09:00'), row(2, 1, null), row(3, 2, null, 5)];
    // Untimed night 9: only the earlier untimed *booking* (night 5) stands ahead.
    expect(seatAmong(rows, night(9, null))).toBe(3);
    // Untimed night 3 sits ahead of nothing untimed-booking → seat 0.
    expect(seatAmong(rows, night(3, null))).toBe(0);
  });

  it('a timed night settles right behind the last row at or before check-in', () => {
    const rows = [row(1, 0, '09:00'), row(2, 1, '15:00'), row(3, 2, null)];
    expect(seatAmong(rows, night(9, '12:00'))).toBe(1); // behind the 09:00 stop
    expect(seatAmong(rows, night(9, '18:00'))).toBe(2); // behind the 15:00 stop
  });

  it('a stop AT the check-in stands ahead; a stop after does not', () => {
    const rows = [row(1, 0, '12:00'), row(2, 1, '12:00'), row(3, 2, '13:00')];
    expect(seatAmong(rows, night(9, '12:00'))).toBe(2);
  });

  it('two nights at the same check-in settle by booking id', () => {
    const rows = [row(1, 0, null, 4)]; // night 4 owns an untimed row
    // Night 2 check-in 15:00: row.at is null but row.night_id set → stands ahead.
    expect(standsAhead(rows[0], night(2, '15:00'))).toBe(true);
    // …and an earlier booking id beats a later one at equal times.
    const atRow = row(5, 0, '15:00', 1);
    expect(standsAhead(atRow, night(3, '15:00'))).toBe(true); // night 1 < night 3
    const atRowLater = row(5, 0, '15:00', 8);
    expect(standsAhead(atRowLater, night(3, '15:00'))).toBe(false); // 8 > 3
  });
});

describe('seatHolds', () => {
  it('always holds when the booking has no check-in', () => {
    expect(seatHolds([row(1, 0, '09:00'), row(2, 1, '20:00')], 2, null)).toBe(true);
    expect(seatHolds([row(1, 0, '09:00'), row(2, 1, '20:00')], 2, undefined)).toBe(true);
  });

  it('holds while no later stop stands ahead and no earlier-capable stop sits behind', () => {
    // Own stop sits last, after a 09:00 — a 12:00 check-in still holds.
    expect(seatHolds([row(1, 0, '09:00'), row(2, 1, '12:00', 7)], 2, '12:00')).toBe(true);
  });

  it('breaks when a later-than-check-in stop stands ahead of the night', () => {
    // A 20:00 stop before the night’s own row, check-in 12:00 → reseat.
    expect(seatHolds([row(1, 0, '20:00'), row(2, 1, '12:00', 7)], 2, '12:00')).toBe(false);
  });

  it('breaks when an earlier-capable stop sits behind the night', () => {
    // A 09:00 stop BEHIND the night’s row, check-in 12:00 → it should lead.
    expect(seatHolds([row(2, 0, '12:00', 7), row(1, 1, '09:00')], 2, '12:00')).toBe(false);
    // A booking-owned row behind needs strictly earlier (at < check-in).
    expect(seatHolds([row(2, 0, '12:00', 7), row(1, 1, '12:00', 3)], 2, '12:00')).toBe(true);
  });
});

describe('reseatOwnStop / seatIndex over the store seam', () => {
  it('parks at the end then seats by check-in (two-step write)', () => {
    const s = new MemoryStore({
      places: [place(1), place(2), place(3)],
      assignments: [
        stop(11, 1, 1, 0, null),
        stop(12, 1, 2, 1, null),
        stop(13, 1, 3, 2, 7), // night's own stop, currently last
      ],
      accommodations: [{ id: 7, trip_id: 1, place_id: 3, start_day_id: 1, end_day_id: 1, check_in: '23:00' }],
    });
    // Check-in 23:00 after the day's 09:00/14:00 → stays last.
    s.assignments[0].assignment_time = '09:00';
    s.assignments[1].assignment_time = '14:00';
    reseatOwnStop(s, { id: 13, day_id: 1, order_index: 2 }, 3, 1, night(7, '23:00'));
    expect(s.assignments.find((a) => a.id === 13)!.order_index).toBe(2);
  });

  it('seats an early check-in at the front', () => {
    const s = new MemoryStore({
      places: [place(1), place(2), place(3)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 3, start_day_id: 1, end_day_id: 1, check_in: '08:00' }],
      assignments: [
        { ...stop(11, 1, 1, 0), assignment_time: '09:00' },
        { ...stop(12, 1, 2, 1), assignment_time: '14:00' },
        stop(13, 1, 3, 2, 7),
      ],
    });
    reseatOwnStop(s, { id: 13, day_id: 1, order_index: 2 }, 3, 1, night(7, '08:00'));
    expect(s.assignments.find((a) => a.id === 13)!.order_index).toBe(0);
    expect(s.assignments.find((a) => a.id === 11)!.order_index).toBe(1);
    expect(s.assignments.find((a) => a.id === 12)!.order_index).toBe(2);
  });

  it('seatIndex lands behind the last row standing ahead', () => {
    const s = new MemoryStore({
      places: [place(1), place(2)],
      assignments: [
        { ...stop(11, 1, 1, 0), assignment_time: '09:00' },
        { ...stop(12, 1, 2, 1), assignment_time: '14:00' },
      ],
    });
    expect(seatIndex(s, 1, night(7, '10:00'))).toBe(1);
    expect(seatIndex(s, 1, night(7, '06:00'))).toBe(0);
  });
});

describe('carryVias', () => {
  const base = () =>
    new MemoryStore({
      places: [place(1), place(2), place(3)],
      assignments: [stop(11, 1, 1, 0), stop(12, 1, 2, 1), stop(13, 1, 3, 2)],
      vias: [
        { id: 50, day_id: 1, after_order_index: 0, sequence: 0, lat: 5, lng: 5 },
        { id: 51, day_id: 1, after_order_index: 1, sequence: 0, lat: 6, lng: 6 },
      ],
    });

  it('returns null when the located order is unchanged', () => {
    const s = base();
    expect(carryVias(s, 1, [11, 12, 13], [11, 12, 13])).toBeNull();
  });

  it('a removed stop hands its road to the stop before it', () => {
    const s = base();
    // Stop 12 leaves: via 51 (after idx 1) merges onto the leg after idx 0.
    const res = carryVias(s, 1, [11, 12, 13], [11, 13]);
    expect(res).toEqual({ moved: 1, removed: 0 });
    expect(s.vias.find((v) => v.id === 51)?.after_order_index).toBe(0);
    // Merged leg renumbers: two vias now share leg 0.
    expect(s.vias.find((v) => v.id === 50)?.sequence).toBe(0);
    expect(s.vias.find((v) => v.id === 51)?.sequence).toBe(1);
  });

  it('drops a via whose anchor chain runs out of located stops', () => {
    const s = base();
    // Only the last stop remains: both vias lose their legs.
    const res = carryVias(s, 1, [11, 12, 13], [13]);
    expect(res!.removed).toBeGreaterThan(0);
    expect(s.vias).toHaveLength(0);
  });
});

describe('stay mirror (attachStayStop / dropStayStops)', () => {
  it('inserts a booking-owned stop and stamps an untyped place as lodging', () => {
    const s = new MemoryStore({
      places: [{ ...place(9), stop_type: null }],
      assignments: [stop(11, 1, 1, 0)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 1, check_in: '15:00' }],
    });
    const mirror = attachStayStop(s, 7, 9, 1, '15:00');
    expect(mirror.created).not.toBeNull();
    const created = s.assignments.find((a) => a.accommodation_id === 7)!;
    expect(created.place_id).toBe(9);
    expect(s.places.find((p) => p.id === 9)?.stop_type).toBe('hotel');
    expect(mirror.stamped).not.toBeNull();
  });

  it('a day already holding the place keeps the traveller’s stop — the booking rides along', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(11, 1, 9, 0)], // traveller already placed the hotel
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 1, check_in: '15:00' }],
    });
    const mirror = attachStayStop(s, 7, 9, 1, '15:00');
    expect(mirror.created).toBeNull();
    expect(s.assignments.filter((a) => a.day_id === 1)).toHaveLength(1);
  });

  it('does not re-stamp a place the traveller typed themselves', () => {
    const s = new MemoryStore({
      places: [{ ...place(9), stop_type: 'museum' }],
      assignments: [],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 1, check_in: '15:00' }],
    });
    const mirror = attachStayStop(s, 7, 9, 1, '15:00');
    expect(s.places.find((p) => p.id === 9)?.stop_type).toBe('museum');
    expect(mirror.stamped).toBeNull();
  });

  it('moveStayStop carries the booking’s own stop to the new day', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7), stop(11, 2, 1, 0)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 1, check_in: '15:00' }],
    });
    const mirror = moveStayStop(s, 7, 9, 2, '15:00');
    const own = s.assignments.find((a) => a.accommodation_id === 7)!;
    expect(own.day_id).toBe(2);
    expect(mirror.moved?.oldDayId).toBe(1);
  });

  it('dropStayStops removes the booking’s own stops', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 1, check_in: '15:00' }],
    });
    const mirror = dropStayStops(s, 7);
    expect(s.assignments.find((a) => a.id === 20)).toBeUndefined();
    expect(mirror.removed).toEqual([{ id: 20, dayId: 1 }]);
  });
});

describe('multi-night mirror (attachStayNights / moveStayNights)', () => {
  it('seats every seat day, reporting the extras in createdExtra', () => {
    const s = new MemoryStore({
      places: [{ ...place(9), stop_type: null }],
      assignments: [],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 3, check_in: '15:00' }],
    });
    const mirror = attachStayNights(s, 7, 9, [1, 2], '15:00');
    expect(mirror.created?.day_id).toBe(1);
    expect(mirror.createdExtra.map((a) => a.day_id)).toEqual([2]);
    expect(s.assignments.filter((a) => a.accommodation_id === 7)).toHaveLength(2);
    expect(s.places.find((p) => p.id === 9)?.stop_type).toBe('hotel');
    // Two seats put down → both days are the touched set.
    expect(mirrorTouchedDays(mirror).sort()).toEqual([1, 2]);
  });

  it('keeps the traveller’s stop on a night the place already covers', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(11, 2, 9, 0)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 3, check_in: '15:00' }],
    });
    const mirror = attachStayNights(s, 7, 9, [1, 2], '15:00');
    expect(mirror.created?.day_id).toBe(1);
    expect(mirror.createdExtra).toEqual([]);
    expect(s.assignments.find((a) => a.id === 11)?.accommodation_id).toBeNull();
  });

  it('takes back the seat of a night a shortened stay no longer covers', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7), stop(21, 2, 9, 0, 7)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 3, check_in: '15:00' }],
    });
    const mirror = moveStayNights(s, 7, 9, [1], '15:00');
    expect(mirror.removed).toEqual([{ id: 21, dayId: 2 }]);
    expect(s.assignments.find((a) => a.id === 21)).toBeUndefined();
    expect(s.assignments.find((a) => a.id === 20)?.accommodation_id).toBe(7);
  });

  it('carries a surplus row onto a newly covered night — same row, new home', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7), stop(21, 2, 9, 0, 7)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 3, check_in: '15:00' }],
    });
    // [1,3] → [2,4]: nights shift from {1,2} to {2,3} — day 2 stays put, day 1's
    // row is carried onto day 3 keeping its id.
    const mirror = moveStayNights(s, 7, 9, [2, 3], '15:00');
    expect(mirror.moved).toMatchObject({ oldDayId: 1, assignment: { id: 20, day_id: 3 } });
    expect(mirror.removed).toEqual([]);
    expect(s.assignments.find((a) => a.id === 20)?.day_id).toBe(3);
    expect(s.assignments.find((a) => a.id === 21)?.day_id).toBe(2);
  });

  it('removes every own stop when the stay loses its place', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7), stop(21, 2, 9, 0, 7)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 3, check_in: '15:00' }],
    });
    const mirror = moveStayNights(s, 7, null, [1, 2], '15:00');
    expect(mirror.removed).toEqual([
      { id: 20, dayId: 1 },
      { id: 21, dayId: 2 },
    ]);
    expect(s.assignments.filter((a) => a.accommodation_id === 7)).toHaveLength(0);
  });

  it('answers the empty mirror for a stay that never had a place', () => {
    const s = new MemoryStore({ places: [], assignments: [] });
    expect(attachStayNights(s, 7, null, [1, 2], '15:00')).toEqual({
      created: null,
      createdExtra: [],
      moved: null,
      movedExtra: [],
      updated: [],
      removed: [],
      stamped: null,
    });
    expect(s.assignments).toHaveLength(0);
  });

  it('carries several surplus rows at once — moved and movedExtra', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7), stop(21, 2, 9, 0, 7), stop(22, 3, 9, 0, 7)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 4, check_in: '15:00' }],
    });
    // [1,4] → [4,5]: a same-day stay now — all three seats are surplus, and
    // only the first lands on the one remaining night.
    const mirror = moveStayNights(s, 7, 9, [4], '15:00');
    expect(mirror.moved).toMatchObject({ oldDayId: 1, assignment: { id: 20, day_id: 4 } });
    expect(mirror.movedExtra).toEqual([]);
    expect(mirror.removed).toEqual([
      { id: 21, dayId: 2 },
      { id: 22, dayId: 3 },
    ]);

    // And the two-carry case: {1,2,3} nights → {4,5} nights carries two rows.
    const s2 = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7), stop(21, 2, 9, 0, 7), stop(22, 3, 9, 0, 7)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 4, check_in: '15:00' }],
    });
    const mirror2 = moveStayNights(s2, 7, 9, [4, 5], '15:00');
    expect(mirror2.moved).toMatchObject({ oldDayId: 1, assignment: { id: 20, day_id: 4 } });
    expect(mirror2.movedExtra).toEqual([
      { oldDayId: 2, assignment: expect.objectContaining({ id: 21, day_id: 5 }) },
    ]);
    expect(mirror2.removed).toEqual([{ id: 22, dayId: 3 }]);
  });

  it('takes back a kept stop whose new place the day already holds — and still stamps it', () => {
    // The stay moved hotels, but the day already pins the new hotel — two own
    // rows would stand on the same place, so the booking's goes away. Nothing
    // was created or carried, yet the server's rebuild path stamped the place
    // inside mirrorStay, before its dayHasPlace return — so does this one.
    const s = new MemoryStore({
      places: [place(9), place(5)],
      assignments: [stop(20, 1, 9, 0, 7), stop(11, 1, 5, 1)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 2, check_in: '15:00' }],
    });
    const mirror = moveStayNights(s, 7, 5, [1], '15:00');
    expect(mirror.removed).toEqual([{ id: 20, dayId: 1 }]);
    expect(s.assignments.find((a) => a.accommodation_id === 7)).toBeUndefined();
    expect(s.assignments.find((a) => a.id === 11)?.accommodation_id).toBeNull();
    expect(s.places.find((p) => p.id === 5)?.stop_type).toBe('hotel');
    expect(mirror.stamped).toMatchObject({ id: 5 });
  });

  it('a reseat on a covered night is a same-day move, not a rebuild', () => {
    const s = new MemoryStore({
      places: [place(9), place(2)],
      assignments: [
        stop(20, 1, 9, 0, 7), // the 15:00 check-in seat, ahead of dinner
        { ...stop(11, 1, 2, 1), assignment_time: '19:00' },
        stop(21, 2, 9, 0, 7),
      ],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 3, check_in: '21:00' }],
    });
    // check_in 15:00→21:00: the day-1 seat now belongs behind the 19:00 dinner —
    // a new hour reseats it on its own day; the day-2 seat is untouched.
    const mirror = moveStayNights(s, 7, 9, [1, 2], '21:00', { checkInChanged: true });
    expect(mirror.moved).toMatchObject({ oldDayId: 1, assignment: { id: 20, day_id: 1 } });
    expect(mirror.movedExtra).toEqual([]);
    expect(s.assignments.find((a) => a.id === 20)?.order_index).toBe(1);
    expect(s.assignments.find((a) => a.id === 21)?.day_id).toBe(2);
  });

  it('a stop the clocks call settled is left alone even off the insert seat', () => {
    // The 15:00 seat already stands behind an untimed pause — a fresh insert
    // would lead, but nothing the clocks measure moved, so the edit mirrors
    // nothing (remirrorStay's seatHolds clause).
    const s = new MemoryStore({
      places: [place(9), place(2)],
      assignments: [
        stop(11, 1, 2, 0), // untimed pause
        stop(20, 1, 9, 1, 7),
      ],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 2, check_in: '15:00' }],
    });
    const mirror = moveStayNights(s, 7, 9, [1], '15:00');
    expect(mirror.moved).toBeNull();
    expect(mirror.removed).toEqual([]);
    // remirrorStay's settled no-op returns before the stamp — the untyped
    // place stays untyped.
    expect(mirror.stamped).toBeNull();
    expect(s.places.find((p) => p.id === 9)?.stop_type).toBeUndefined();
    expect(s.assignments.find((a) => a.id === 20)?.order_index).toBe(1);
  });

  it('mirrorTouchedDays names every day the mirror reached, once', () => {
    const s = new MemoryStore({
      places: [place(9)],
      assignments: [stop(20, 1, 9, 0, 7), stop(21, 2, 9, 0, 7), stop(22, 3, 9, 0, 7)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 9, start_day_id: 1, end_day_id: 4, check_in: '15:00' }],
    });
    const mirror = moveStayNights(s, 7, 9, [4, 5], '15:00');
    // Carries touched days 1,4 (moved) and 2,5 (movedExtra); the drop touched 3.
    expect(mirrorTouchedDays(mirror).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe.todo('night-seat against real Dexie persistence', () => {
  // Unique order_index contention under concurrent edits, the wire-shape reads
  // behind getStopForMirror/getPlaceForMirror, and transactional rollback all
  // need the repo adapter over offlineDb.
});
