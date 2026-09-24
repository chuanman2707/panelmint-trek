import { roadtripPreferencesResponseSchema, roadtripPreferencesUpdateSchema, type RoadtripPreferences } from '@trek/shared'
import { apiClient } from '../api/client'
import { offlineDb } from '../db/offlineDb'
import { isEffectivelyOffline } from '../sync/networkMode'
import { onlineThenCache } from './withOfflineFallback'

export async function cachedRoadtripPreferences(tripId: number): Promise<RoadtripPreferences> {
  const cached = await offlineDb.roadtripPreferences.get(tripId)
  if (!cached) throw new Error('Driving settings are not available offline.')
  return cached.preferences
}

const writes = new Map<number, Promise<RoadtripPreferences>>()

export const roadtripPreferencesRepo = {
  async read(tripId: number): Promise<RoadtripPreferences> {
    return onlineThenCache(async () => {
      const fetched = await apiClient.get(`/trips/${tripId}/roadtrip/preferences`)
      const saved = roadtripPreferencesResponseSchema.parse(fetched.data)
      await offlineDb.roadtripPreferences.put(saved)
      return saved.preferences
    }, () => cachedRoadtripPreferences(tripId))
  },

  update(tripId: number, patch: RoadtripPreferences): Promise<RoadtripPreferences> {
    const save = (writes.get(tripId) ?? Promise.resolve({})).catch(() => ({})).then(async () => {
      const validated = roadtripPreferencesUpdateSchema.parse(patch)
      if (!isEffectivelyOffline()) {
        const saved = await apiClient.put(`/trips/${tripId}/roadtrip/preferences`, validated)
        await offlineDb.roadtripPreferences.put(roadtripPreferencesResponseSchema.parse(saved.data))
      } else {
        const next = { ...await cachedRoadtripPreferences(tripId), ...validated }
        if (next.roadtrip_day_start && next.roadtrip_day_end && next.roadtrip_day_end <= next.roadtrip_day_start) throw new Error('Day end must be later than day start.')
        await offlineDb.roadtripPreferences.put({ tripId, preferences: next })
      }
      return cachedRoadtripPreferences(tripId)
    })
    writes.set(tripId, save)
    void save.finally(() => { if (writes.get(tripId) === save) writes.delete(tripId) }).catch(() => {})
    return save
  },
}
