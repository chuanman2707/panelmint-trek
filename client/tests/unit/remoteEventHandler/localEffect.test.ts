import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { useTripStore } from '../../../src/store/tripStore';
import { applyLocalEffect, applyLocalEffects } from '../../../src/store/localEffects';
import { db } from '../../../src/db/panelmintDb';
import { resetAllStores } from '../../helpers/store';
import { buildPlace, buildTodoItem, buildAssignment, buildDay } from '../../helpers/factories';

/**
 * applyLocalEffect replays the side-channel a local adapter returned through
 * the same reducer + Dexie writer a socket frame used — the write-through the
 * broadcast used to provide. These tests pin the two halves: the Zustand
 * update lands immediately, and the panelmint DB row follows.
 */

beforeEach(() => {
  resetAllStores();
});

describe('applyLocalEffect', () => {
  it('applies the state update and writes the row through to the panelmint db', async () => {
    const place = buildPlace({ id: 99, name: 'New Place' });
    applyLocalEffect('place:created', { place });

    expect(useTripStore.getState().places[0].id).toBe(99);
    await vi.waitFor(async () => {
      expect((await db.places.get(99))?.name).toBe('New Place');
    });
  });

  it('is the same method on the store (slice callers use get().applyLocalEffect)', async () => {
    const item = buildTodoItem({ id: 7, name: 'Book ferry' });
    useTripStore.getState().applyLocalEffect('todo:created', { item });

    expect(useTripStore.getState().todoItems.map(i => i.id)).toEqual([7]);
    await vi.waitFor(async () => {
      expect((await db.todoItems.get(7))?.name).toBe('Book ferry');
    });
  });

  it('replays a reorder side-channel: state order changes, day row re-persists', async () => {
    const a1 = buildAssignment({ id: 1, day_id: 10, order_index: 0 });
    const a2 = buildAssignment({ id: 2, day_id: 10, order_index: 1 });
    const day = buildDay({ id: 10 });
    useTripStore.setState({ days: [day], assignments: { '10': [a1, a2] } });

    applyLocalEffect('assignment:reordered', { dayId: 10, orderedIds: [2, 1] });

    const { assignments } = useTripStore.getState();
    expect(assignments['10'].map(a => a.id)).toEqual([2, 1]);
    await vi.waitFor(async () => {
      const stored = await db.days.get(10);
      expect(stored?.assignments?.map(a => a.id)).toEqual([2, 1]);
    });
  });

  it('applyLocalEffects replays several effects in order', async () => {
    const place = buildPlace({ id: 5, name: 'Cafe' });
    const assignment = buildAssignment({ id: 42, day_id: 10, place });
    applyLocalEffects([
      { type: 'place:created', payload: { place } },
      { type: 'assignment:created', payload: { assignment } },
    ]);

    const state = useTripStore.getState();
    expect(state.places[0].id).toBe(5);
    expect(state.assignments['10'][0].id).toBe(42);
  });

  it('events with no applier are a no-op (same as a socket frame nobody handles)', () => {
    // 'packing:reordered' is in IGNORED_WS_EVENTS — must not throw or mutate.
    applyLocalEffect('packing:reordered', { tripId: 1 });
    expect(useTripStore.getState().packingItems).toEqual([]);
  });

  it('a null side-channel payload is a no-op — adapters pass `reordered` through unchecked', () => {
    // updateTime returns { reordered: {dayId, orderedIds} | null } — null means
    // the day was already in time order, and the applier's orderedIds guard
    // makes the replay a no-op rather than a caller-side `if`.
    expect(() => applyLocalEffect('assignment:reordered', null)).not.toThrow();
    expect(useTripStore.getState().assignments).toEqual({});
  });
});
