import { packingApi } from '../api/client'
import type { PackingItem } from '../types'

/**
 * Packing repository — the seam between the store slices and the local
 * `packingApi` adapter. The adapter is the Dexie write itself now, so there is
 * no online/offline split and no cache write-through left to mediate; the repo
 * keeps the typed signatures the slices were written against.
 */
export const packingRepo = {
  list(tripId: number | string): Promise<{ items: PackingItem[] }> {
    return packingApi.list(tripId)
  },

  create(tripId: number | string, data: Record<string, unknown> & { name: string }): Promise<{ item: PackingItem }> {
    return packingApi.create(tripId, data)
  },

  update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ item: PackingItem }> {
    return packingApi.update(tripId, id, data)
  },

  delete(tripId: number | string, id: number): Promise<{ success: true }> {
    return packingApi.delete(tripId, id)
  },

  reorder(tripId: number | string, orderedIds: number[]): Promise<{ success: true }> {
    return packingApi.reorder(tripId, orderedIds)
  },

  clone(tripId: number | string, id: number): Promise<{ item: PackingItem }> {
    return packingApi.clone(tripId, id)
  },
}
