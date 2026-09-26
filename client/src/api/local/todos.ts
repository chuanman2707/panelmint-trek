/**
 * `todoApi` — the Dexie port of the hosted TodoController + TodoService pair
 * (server/src/nest/todo/). Method list and envelopes unchanged from the axios
 * surface this replaces:
 *
 *   GET                       → { items }
 *   POST                      → { item }
 *   PUT :id                   → { item }
 *   DELETE :id                → { success: true }
 *   PUT reorder               → { success: true }
 *   GET category-assignees    → { assignees }   (grouped record)
 *   PUT category-assignees/*  → { assignees }   (flat array for the category)
 *
 * Server parity notes:
 *  - Trip-scoped like packing (TripAccessGuard → 404 'Trip not found'); there
 *    is no visibility filter on todos — items are scoped id + trip_id only.
 *  - create coerced every optional field with `||` (falsy → column default):
 *    category/due_date/description/assigned_user_id → null, priority → 0,
 *    checked is hardcoded 0 in the INSERT. sort_order appends at MAX+1.
 *  - update followed the bodyKeys presence protocol on the nullable columns:
 *    a key present with null clears, an omitted key keeps. name/category are
 *    the exception — plain COALESCE of `data.x || null`, so even an explicit
 *    null keeps the stored value (the schema cannot express null for them
 *    anyway: the 400 is the same either way).
 *  - checked arrives boolean or 0/1 on the wire, stores 0/1; the server's
 *    presence test was value-based (`data.checked !== undefined`).
 *  - reorder ran `UPDATE … SET sort_order = ? WHERE id = ? AND trip_id = ?`
 *    per listed id — a foreign id is a silent no-op that still consumes its
 *    slot; no permutation check.
 *  - The 'Item not found' 404 string is shared with packing verbatim.
 */
import {
  todoCategoryAssigneesRequestSchema,
  todoCreateItemRequestSchema,
  todoReorderRequestSchema,
  todoUpdateItemRequestSchema,
  type TodoCreateItemRequest,
  type TodoUpdateItemRequest,
} from '@trek/shared';
import type { TodoItem } from '../../types';
import { DexieStore, withStore } from './dexieStore';
import { detached, notFound, nowIso, numId, parseBody } from './helpers';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/** `SELECT * FROM todo_items WHERE id = ? AND trip_id = ?` or the 404. */
function requireItem(store: DexieStore, tripId: number, id: number | string): TodoItem {
  const item = store.todoItemRaw(numId(id));
  if (!item || item.trip_id !== tripId) throw notFound('Item');
  return item;
}

export const todoApi = {
  list: (tripId: number | string): Promise<{ items: TodoItem[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return { items: store.listTodoItemsWire(tid) };
    }),

  create: (tripId: number | string, data: TodoCreateItemRequest): Promise<{ item: TodoItem }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(todoCreateItemRequestSchema, data);
      let max = -1;
      for (const t of store.todoItemsOfTrip(tid)) max = Math.max(max, t.sort_order ?? 0);
      const item: TodoItem = {
        id: store.allocId('todoItems'),
        trip_id: tid,
        name: body.name,
        checked: 0,
        category: body.category || null,
        sort_order: max + 1,
        due_date: body.due_date || null,
        description: body.description || null,
        assigned_user_id: body.assigned_user_id || null,
        priority: body.priority || 0,
        created_at: nowIso(),
      };
      store.put('todoItems', item);
      return { item: detached(item) };
    }),

  update: (tripId: number | string, id: number, data: TodoUpdateItemRequest): Promise<{ item: TodoItem }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const body = parseBody(todoUpdateItemRequestSchema, data);
      const item = requireItem(store, tid, id);
      if (body.name) item.name = body.name;
      if (body.checked !== undefined) item.checked = body.checked ? 1 : 0;
      // name/category are plain COALESCE of `data.x || null` — an explicit
      // falsy keeps the stored value; the other columns follow the key-
      // presence protocol (present null clears, absent keeps).
      if (body.category) item.category = body.category;
      if ('due_date' in body) item.due_date = body.due_date ?? null;
      if ('description' in body) item.description = body.description ?? null;
      if ('assigned_user_id' in body) item.assigned_user_id = body.assigned_user_id ?? null;
      if ('priority' in body) item.priority = body.priority ?? 0;
      store.put('todoItems', item);
      return { item: detached(item) };
    }),

  delete: (tripId: number | string, id: number): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const item = requireItem(store, tid, id);
      store.delete('todoItems', item.id);
      return { success: true as const };
    }),

  reorder: (tripId: number | string, orderedIds: number[]): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const { orderedIds: ids } = parseBody(todoReorderRequestSchema, { orderedIds });
      ids.forEach((itemId, index) => {
        const item = store.todoItemRaw(itemId);
        if (item && item.trip_id === tid) {
          item.sort_order = index;
          store.put('todoItems', item);
        }
      });
      return { success: true as const };
    }),

  getCategoryAssignees: (
    tripId: number | string,
  ): Promise<{ assignees: Record<string, { user_id: number; username: string; avatar: null }[]> }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return { assignees: store.categoryAssigneesWire('todoCategoryAssignees', tid) };
    }),

  setCategoryAssignees: (
    tripId: number | string,
    categoryName: string,
    userIds: number[],
  ): Promise<{ assignees: { user_id: number; username: string; avatar: null }[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const { user_ids } = parseBody(todoCategoryAssigneesRequestSchema, { user_ids: userIds });
      // Only people on this trip may be assigned — off-roster ids drop
      // silently, never error.
      const roster = store.rosterUserIds(tid);
      const ids = user_ids.filter((uid) => roster.has(uid));
      return { assignees: store.setCategoryAssigneeRows('todoCategoryAssignees', tid, categoryName, ids) };
    }),
};
