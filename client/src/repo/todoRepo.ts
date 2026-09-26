import { todoApi } from '../api/client'
import type { TodoItem } from '../types'
import type { TodoCreateItemRequest, TodoUpdateItemRequest } from '@trek/shared'

/**
 * Todo repository — the seam between the store slices and the local
 * `todoApi` adapter. The adapter is the Dexie write itself now, so there is
 * no online/offline split and no cache write-through left to mediate.
 */
export const todoRepo = {
  list(tripId: number | string): Promise<{ items: TodoItem[] }> {
    return todoApi.list(tripId)
  },

  create(tripId: number | string, data: TodoCreateItemRequest): Promise<{ item: TodoItem }> {
    return todoApi.create(tripId, data)
  },

  update(tripId: number | string, id: number, data: TodoUpdateItemRequest): Promise<{ item: TodoItem }> {
    return todoApi.update(tripId, id, data)
  },

  delete(tripId: number | string, id: number): Promise<{ success: true }> {
    return todoApi.delete(tripId, id)
  },

  reorder(tripId: number | string, orderedIds: number[]): Promise<{ success: true }> {
    return todoApi.reorder(tripId, orderedIds)
  },
}
