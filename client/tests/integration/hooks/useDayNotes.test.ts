// FE-HOOK-DAYNOTES-001 to -020 — useDayNotes against the local dayNotesApi.
//
// dayNotesApi is the Dexie-backed adapter — there is no HTTP layer to mock.
// Notes embed on `days.notes_items`: the tests seed the trip + day rows into
// `panelmintDb`, spy on the adapter to prove calls (or their absence), and
// read the stored rows back where a request body used to be asserted.
import 'fake-indexeddb/auto';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDayNotes } from '../../../src/hooks/useDayNotes';
import { useTripStore } from '../../../src/store/tripStore';
import { TranslationProvider } from '../../../src/i18n/TranslationContext';
import { buildDay, buildDayNote, buildTrip } from '../../helpers/factories';
import { resetAllStores } from '../../helpers/store';
import { dayNotesApi } from '../../../src/api/client';
import { db } from '../../../src/db/panelmintDb';
import type { DayRow } from '../../../src/api/local/dexieStore';
import type { DayNote } from '../../../src/types';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(TranslationProvider, null, children);

const TRIP_ID = 1;
const DAY_ID = 10;

/**
 * Clean db + trip 1 + day DAY_ID (embedding `notes` in `notes_items`), plus the
 * store-side dayNotes map the slice keeps in sync. Call with `seed: false` to
 * leave the db empty for the adapter-failure paths.
 */
async function seedDay(notes: DayNote[] = [], opts: { seed?: boolean } = {}) {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 });
  if (opts.seed === false) return;
  await db.trips.put(buildTrip({ id: TRIP_ID }));
  await db.days.put({ ...buildDay({ id: DAY_ID, trip_id: TRIP_ID }), notes_items: notes, vias: [] } as DayRow);
  useTripStore.setState({ dayNotes: { [String(DAY_ID)]: notes } });
}

/** The stored notes_items of day DAY_ID. */
async function storedNotes(): Promise<DayNote[]> {
  return (((await db.days.get(DAY_ID))?.notes_items) ?? []) as DayNote[];
}

describe('useDayNotes', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__addToast;
  });

  it('FE-HOOK-DAYNOTES-001: initial noteUi state is empty', async () => {
    await seedDay();
    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });
    expect(result.current.noteUi).toEqual({});
  });

  it('FE-HOOK-DAYNOTES-002: initial dayNotes comes from tripStore', async () => {
    const note = buildDayNote({ day_id: DAY_ID });
    await seedDay([note]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });
    expect(result.current.dayNotes[String(DAY_ID)]).toEqual([note]);
  });

  it('FE-HOOK-DAYNOTES-003: openAddNote sets mode=add and default sort order', async () => {
    await seedDay();
    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.openAddNote(DAY_ID, () => []);
    });

    expect(result.current.noteUi[DAY_ID]).toMatchObject({
      mode: 'add',
      text: '',
      sortOrder: 0, // maxKey(-1) + 1 = 0
    });
  });

  it('FE-HOOK-DAYNOTES-004: openAddNote calculates sortOrder as max(sortKey) + 1 from merged items', async () => {
    await seedDay();
    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 5, data: buildDayNote() },
      { type: 'note' as const, sortKey: 10, data: buildDayNote() },
    ];

    act(() => {
      result.current.openAddNote(DAY_ID, getMergedItems);
    });

    expect(result.current.noteUi[DAY_ID]).toMatchObject({
      mode: 'add',
      sortOrder: 11, // max(5,10) + 1
    });
  });

  it('FE-HOOK-DAYNOTES-005: openEditNote sets mode=edit with note data', async () => {
    await seedDay();
    const note = buildDayNote({ id: 99, text: 'Hello', time: '10:00', icon: 'Star' });
    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.openEditNote(DAY_ID, note);
    });

    expect(result.current.noteUi[DAY_ID]).toMatchObject({
      mode: 'edit',
      noteId: 99,
      text: 'Hello',
      time: '10:00',
      icon: 'Star',
    });
  });

  it('FE-HOOK-DAYNOTES-006: cancelNote removes the UI entry for that day', async () => {
    await seedDay();
    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.openAddNote(DAY_ID, () => []);
    });
    expect(result.current.noteUi[DAY_ID]).toBeDefined();

    act(() => {
      result.current.cancelNote(DAY_ID);
    });
    expect(result.current.noteUi[DAY_ID]).toBeUndefined();
  });

  it('FE-HOOK-DAYNOTES-007: saveNote with empty text is a no-op', async () => {
    await seedDay();
    const createSpy = vi.spyOn(dayNotesApi, 'create');

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.setNoteUi({ [DAY_ID]: { mode: 'add', text: '', time: '', icon: 'FileText', sortOrder: 0 } });
    });

    await act(async () => {
      await result.current.saveNote(DAY_ID);
    });

    expect(createSpy).not.toHaveBeenCalled();
    // noteUi remains set (no cancelNote was called)
    expect(result.current.noteUi[DAY_ID]).toBeDefined();
  });

  it('FE-HOOK-DAYNOTES-008: saveNote in add mode calls addDayNote and clears UI', async () => {
    await seedDay();

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.setNoteUi({
        [DAY_ID]: { mode: 'add', text: 'New note', time: '', icon: 'FileText', sortOrder: 0 },
      });
    });

    await act(async () => {
      await result.current.saveNote(DAY_ID);
    });

    // UI should be cleared after successful save
    expect(result.current.noteUi[DAY_ID]).toBeUndefined();
    // The note is a row on the day's embedded notes_items now.
    expect((await storedNotes()).map(n => n.text)).toEqual(['New note']);
  });

  it('FE-HOOK-DAYNOTES-009: saveNote in edit mode calls updateDayNote and clears UI', async () => {
    const noteId = 55;
    await seedDay([buildDayNote({ id: noteId, day_id: DAY_ID, text: 'Before' })]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.setNoteUi({
        [DAY_ID]: { mode: 'edit', noteId, text: 'Updated', time: '', icon: 'FileText' },
      });
    });

    await act(async () => {
      await result.current.saveNote(DAY_ID);
    });

    expect(result.current.noteUi[DAY_ID]).toBeUndefined();
    expect((await storedNotes()).find(n => n.id === noteId)?.text).toBe('Updated');
  });

  it('FE-HOOK-DAYNOTES-010: deleteNote calls deleteDayNote on the store', async () => {
    const note = buildDayNote({ id: 77, day_id: DAY_ID });
    await seedDay([note]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    await act(async () => {
      await result.current.deleteNote(DAY_ID, 77);
    });

    // Note is removed from the store and from the day's embedded rows.
    const dayNotes = useTripStore.getState().dayNotes[String(DAY_ID)] || [];
    expect(dayNotes.find((n) => n.id === 77)).toBeUndefined();
    expect((await storedNotes()).find(n => n.id === 77)).toBeUndefined();
  });

  it('FE-HOOK-DAYNOTES-011: saveNote on adapter error shows toast', async () => {
    const toastSpy = vi.fn();
    window.__addToast = toastSpy;
    await seedDay([], { seed: false }); // no trip — the create rejects

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.setNoteUi({
        [DAY_ID]: { mode: 'add', text: 'Test note', time: '', icon: 'FileText', sortOrder: 0 },
      });
    });

    await act(async () => {
      await result.current.saveNote(DAY_ID);
    });

    expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error', undefined);
  });

  it('FE-HOOK-DAYNOTES-012: deleteNote on adapter error shows toast', async () => {
    const toastSpy = vi.fn();
    window.__addToast = toastSpy;
    // Day without the note — delete rejects 'Note not found'.
    await seedDay();

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    await act(async () => {
      await result.current.deleteNote(DAY_ID, 88);
    });

    expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error', undefined);
  });

  it('FE-HOOK-DAYNOTES-013: moveNote up calculates midpoint sort order', async () => {
    const noteA = buildDayNote({ id: 1 });
    const noteB = buildDayNote({ id: 2 });
    const noteC = buildDayNote({ id: 3 });
    await seedDay([noteA, noteB, noteC]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    // merged items with sortKeys 0, 2, 4
    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 0, data: noteA },
      { type: 'note' as const, sortKey: 2, data: noteB },
      { type: 'note' as const, sortKey: 4, data: noteC },
    ];

    // Move noteC (idx=2) up → new order should be between idx=0 and idx=1 → (0+2)/2 = 1
    await act(async () => {
      await result.current.moveNote(DAY_ID, noteC.id, 'up', getMergedItems);
    });

    expect((await storedNotes()).find(n => n.id === noteC.id)?.sort_order).toBe(1);
  });

  it('FE-HOOK-DAYNOTES-014: moveNote down calculates midpoint sort order', async () => {
    const noteA = buildDayNote({ id: 1 });
    const noteB = buildDayNote({ id: 2 });
    const noteC = buildDayNote({ id: 3 });
    await seedDay([noteA, noteB, noteC]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 0, data: noteA },
      { type: 'note' as const, sortKey: 2, data: noteB },
      { type: 'note' as const, sortKey: 4, data: noteC },
    ];

    // Move noteA (idx=0) down → new order between idx=1 and idx=2 → (2+4)/2 = 3
    await act(async () => {
      await result.current.moveNote(DAY_ID, noteA.id, 'down', getMergedItems);
    });

    expect((await storedNotes()).find(n => n.id === noteA.id)?.sort_order).toBe(3);
  });

  it('FE-HOOK-DAYNOTES-015: moveNote up at index 0 is a no-op', async () => {
    const updateSpy = vi.spyOn(dayNotesApi, 'update');
    const noteA = buildDayNote({ id: 1 });
    await seedDay([noteA]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 0, data: noteA },
    ];

    await act(async () => {
      await result.current.moveNote(DAY_ID, noteA.id, 'up', getMergedItems);
    });

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('FE-HOOK-DAYNOTES-016: moveNote down at last index is a no-op', async () => {
    const updateSpy = vi.spyOn(dayNotesApi, 'update');
    const noteA = buildDayNote({ id: 1 });
    await seedDay([noteA]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 0, data: noteA },
    ];

    await act(async () => {
      await result.current.moveNote(DAY_ID, noteA.id, 'down', getMergedItems);
    });

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('FE-HOOK-DAYNOTES-017: moveNote down at last item uses sortKey + 1', async () => {
    const noteA = buildDayNote({ id: 1 });
    const noteB = buildDayNote({ id: 2 });
    await seedDay([noteA, noteB]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 5, data: noteA },
      { type: 'note' as const, sortKey: 10, data: noteB },
    ];

    // Move noteA (idx=0) down — only 2 items, so idx < length-1 is false after going down
    // direction=down, idx=0, length=2, idx < length-2 is false (0 < 0), so newSortOrder = sortKey[1]+1 = 11
    await act(async () => {
      await result.current.moveNote(DAY_ID, noteA.id, 'down', getMergedItems);
    });

    expect((await storedNotes()).find(n => n.id === noteA.id)?.sort_order).toBe(11);
  });

  it('FE-HOOK-DAYNOTES-018: moveNote on adapter error shows toast', async () => {
    const toastSpy = vi.fn();
    window.__addToast = toastSpy;
    // Day without the moved note — update rejects 'Note not found'.
    await seedDay();

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    const noteA = buildDayNote({ id: 1 });
    const noteB = buildDayNote({ id: 2 });

    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 0, data: noteA },
      { type: 'note' as const, sortKey: 1, data: noteB },
    ];

    await act(async () => {
      await result.current.moveNote(DAY_ID, noteA.id, 'down', getMergedItems);
    });

    expect(toastSpy).toHaveBeenCalledWith(expect.any(String), 'error', undefined);
  });

  it('FE-HOOK-DAYNOTES-019: moveNote up with only 1 item before uses sortKey - 1', async () => {
    const noteA = buildDayNote({ id: 1 });
    const noteB = buildDayNote({ id: 2 });
    await seedDay([noteA, noteB]);

    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    const getMergedItems = () => [
      { type: 'note' as const, sortKey: 5, data: noteA },
      { type: 'note' as const, sortKey: 10, data: noteB },
    ];

    // Move noteB (idx=1) up — idx >= 2 is false, so newSortOrder = sortKey[idx-1] - 1 = 5-1 = 4
    await act(async () => {
      await result.current.moveNote(DAY_ID, noteB.id, 'up', getMergedItems);
    });

    expect((await storedNotes()).find(n => n.id === noteB.id)?.sort_order).toBe(4);
  });

  it('FE-HOOK-DAYNOTES-020: openAddNote calls expandDay if provided', async () => {
    await seedDay();
    const expandDay = vi.fn();
    const { result } = renderHook(() => useDayNotes(TRIP_ID), { wrapper });

    act(() => {
      result.current.openAddNote(DAY_ID, () => [], expandDay);
    });

    expect(expandDay).toHaveBeenCalledWith(DAY_ID);
  });
});

// Type augment for window.__addToast — must mirror the canonical declaration
// in components/shared/Toast.tsx (a divergent signature is a merge conflict).
declare global {
  interface Window {
    __addToast?: (message: string, type?: 'success' | 'error' | 'warning' | 'info', duration?: number) => number;
  }
}
