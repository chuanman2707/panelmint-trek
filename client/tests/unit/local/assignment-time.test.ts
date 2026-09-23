/**
 * Parity tests for the ported assignment time-sort.
 *
 * Source fixtures: server/tests/unit/nest/assignments.service.test.ts pins the
 * '99:99' unreadable sentinel, the "only a moved start re-sorts" rule, the
 * clear-on-falsy write, and re-pinning road-trip vias across a reorder.
 */
import { describe, expect, it } from 'vitest';
import { sortMinutes, UNREADABLE_TIME, updateTime } from '../../../src/api/local/ported/assignment-time';
import { MemoryStore, type MemAssignment, type MemPlace } from './helpers/memoryStore';

const place = (id: number, lat: number | null, lng: number | null): MemPlace => ({
  id,
  trip_id: 1,
  name: `p${id}`,
  lat,
  lng,
});
const stop = (
  id: number,
  placeId: number,
  order: number,
  time: string | null = null,
  acc: number | null = null
): MemAssignment => ({
  id,
  day_id: 1,
  place_id: placeId,
  order_index: order,
  assignment_time: time,
  assignment_end_time: null,
  accommodation_id: acc,
});

describe('sortMinutes', () => {
  it('parses HH:mm to minutes', () => {
    expect(sortMinutes('09:30')).toBe(570);
    expect(sortMinutes('2026-03-01T14:05')).toBe(845);
  });
  it('unreadable values get the 99:99 sentinel (after every real time)', () => {
    expect(sortMinutes('morning')).toBe(UNREADABLE_TIME);
    expect(sortMinutes('99:99')).toBe(UNREADABLE_TIME);
    expect(UNREADABLE_TIME).toBeGreaterThan(24 * 60);
  });
  it('null/empty stay untimed', () => {
    expect(sortMinutes(null)).toBeNull();
    expect(sortMinutes('')).toBeNull();
  });
});

describe('updateTime', () => {
  const store = () =>
    new MemoryStore({
      places: [place(1, 1, 1), place(2, 2, 2), place(3, 3, 3)],
      assignments: [stop(11, 1, 0, '09:00'), stop(12, 2, 1, '14:00'), stop(13, 3, 2, '11:00')],
    });

  it('a moved start re-sorts the day and reports the new order', () => {
    const s = store();
    const res = updateTime(s, 11, '15:00', null); // 11 was first at 09:00
    expect(res.reordered?.orderedIds).toEqual([13, 12, 11]);
    expect(s.assignments.find((a) => a.id === 13)!.order_index).toBe(0);
    expect(s.assignments.find((a) => a.id === 11)!.order_index).toBe(2);
  });

  it('a start sent again as it stood leaves the day alone', () => {
    const s = store();
    const res = updateTime(s, 11, '09:00', null);
    expect(res.reordered).toBeNull();
    expect(res.vias).toBeNull();
  });

  it('an end time alone is a label — no resort', () => {
    const s = store();
    const res = updateTime(s, 11, '09:00', '10:30');
    expect(res.reordered).toBeNull();
    expect(s.assignments.find((a) => a.id === 11)!.assignment_end_time).toBe('10:30');
  });

  it('falsy times clear the override and do not resort', () => {
    const s = store();
    const res = updateTime(s, 11, '', null);
    expect(s.assignments.find((a) => a.id === 11)!.assignment_time).toBeNull();
    expect(res.reordered).toBeNull();
  });

  it('a leading untimed stop keeps the front (chronoOrder: -Infinity before any time)', () => {
    const s = new MemoryStore({
      places: [place(1, 1, 1), place(2, 2, 2), place(3, 3, 3)],
      assignments: [stop(11, 1, 0, null), stop(12, 2, 1, '08:00'), stop(13, 3, 2, null)],
    });
    // 13 gets a new early start → it moves ahead of 08:00, but the untimed
    // leader has nothing to inherit and stays first.
    const res = updateTime(s, 13, '07:00', null);
    expect(res.reordered?.orderedIds).toEqual([11, 13, 12]);
  });

  it('an untimed stop mid-day inherits the previous timed stop’s hour', () => {
    const s = new MemoryStore({
      places: [place(1, 1, 1), place(2, 2, 2), place(3, 3, 3)],
      assignments: [
        stop(11, 1, 0, '14:00'),
        stop(12, 2, 1, '09:00'),
        stop(13, 3, 2, null), // inherits whatever precedes it after sorting
      ],
    });
    // 13 inherits 12's time (540) in original order → ties with 12, keeps
    // index order behind it; 11 at 14:00 goes last.
    const res = updateTime(s, 12, '09:30', null); // nudge to trigger the sort
    expect(res.reordered?.orderedIds).toEqual([12, 13, 11]);
  });

  it('a booked night is timed by its check-in, not by an override nobody typed', () => {
    const s = new MemoryStore({
      places: [place(1, 1, 1), place(2, 2, 2)],
      accommodations: [{ id: 7, trip_id: 1, place_id: 2, start_day_id: 1, end_day_id: 1, check_in: '20:00' }],
      assignments: [stop(11, 1, 0, '09:00'), stop(12, 2, 1, null, 7)],
    });
    // Moving 11 past the night's 20:00 check-in puts the night first.
    const res = updateTime(s, 11, '21:00', null);
    expect(res.reordered?.orderedIds).toEqual([12, 11]);
  });

  it('re-pins a via when the located stops it sits between re-sort', () => {
    const s = new MemoryStore({
      places: [place(1, 1, 1), place(2, 2, 2), place(3, 3, 3), place(4, 4, 4)],
      assignments: [
        stop(11, 1, 0, '09:00'), // A
        stop(12, 2, 1, '11:00'), // B
        stop(13, 3, 2, '14:00'), // C
        stop(14, 4, 3, '13:00'), // D — moved to the front below
      ],
      // Via is pinned after the first located stop (A).
      vias: [{ id: 50, day_id: 1, after_order_index: 0, sequence: 0, lat: 5, lng: 5 }],
    });
    const res = updateTime(s, 14, '08:00', null);
    // New order: D, A, B, C — A moved from index 0 to index 1, so the via
    // keeps following A at after_order_index 1.
    expect(res.vias?.dayId).toBe(1);
    expect(s.vias.find((v) => v.id === 50)?.after_order_index).toBe(1);
  });

  it('drops a via whose anchor became the last located stop', () => {
    const s = new MemoryStore({
      places: [place(1, 1, 1), place(2, 2, 2), place(3, 3, 3)],
      assignments: [stop(11, 1, 0, '09:00'), stop(12, 2, 1, '11:00'), stop(13, 3, 2, '14:00')],
      vias: [{ id: 51, day_id: 1, after_order_index: 0, sequence: 0, lat: 5, lng: 5 }],
    });
    // 11 goes last → the via behind it would bend the drive into tomorrow.
    const res = updateTime(s, 11, '20:00', null);
    expect(res.vias).not.toBeNull();
    expect(s.vias.find((v) => v.id === 51)).toBeUndefined();
  });
});

describe.todo('assignment time via Dexie adapter', () => {
  // getAssignment's wire shape and the broadcast `vias` payload depend on the
  // repo layer's row mapping — covered once the seam is wired to offlineDb.
});
