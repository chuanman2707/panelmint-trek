import { packingApi } from '../api/client'
import { offlineDb, upsertPackingItems, nextTempId } from '../db/offlineDb'
import { isEffectivelyOffline } from '../sync/networkMode'
import { onlineThenCache } from './withOfflineFallback'
import type { PackingItem } from '../types'

export const packingRepo = {
  async list(tripId: number | string): Promise<{ items: PackingItem[] }> {
    return onlineThenCache(
      async () => {
        const result = await packingApi.list(tripId)
        upsertPackingItems(result.items)
        return result
      },
      async () => ({
        items: await offlineDb.packingItems
          .where('trip_id').equals(Number(tripId)).toArray(),
      }),
    )
  },

  async create(tripId: number | string, data: Record<string, unknown> & { name: string }): Promise<{ item: PackingItem }> {
    if (isEffectivelyOffline()) {
      const tempId = nextTempId()
      const tempItem: PackingItem = {
        ...(data as Partial<PackingItem>),
        id: tempId,
        trip_id: Number(tripId),
        name: (data.name as string) ?? 'New item',
        checked: 0,
      } as PackingItem
      await offlineDb.packingItems.put(tempItem)
      return { item: tempItem }
    }
    const result = await packingApi.create(tripId, data)
    offlineDb.packingItems.put(result.item)
    return result
  },

  async update(tripId: number | string, id: number, data: Record<string, unknown>): Promise<{ item: PackingItem }> {
    if (isEffectivelyOffline()) {
      const existing = await offlineDb.packingItems.get(id)
      const optimistic: PackingItem = { ...(existing ?? {} as PackingItem), ...(data as Partial<PackingItem>), id }
      await offlineDb.packingItems.put(optimistic)
      return { item: optimistic }
    }
    const result = await packingApi.update(tripId, id, data)
    offlineDb.packingItems.put(result.item)
    return result
  },

  async delete(tripId: number | string, id: number): Promise<unknown> {
    if (isEffectivelyOffline()) {
      await offlineDb.packingItems.delete(id)
      return { success: true }
    }
    const result = await packingApi.delete(tripId, id)
    offlineDb.packingItems.delete(id)
    return result
  },
}
