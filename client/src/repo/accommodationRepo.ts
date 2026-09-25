import { accommodationsApi } from '../api/client'
import type { Accommodation } from '../types'

export const accommodationRepo = {
  async list(tripId: number | string): Promise<{ accommodations: Accommodation[] }> {
    // The adapter runs on panelmintDb — the list is always local and durable,
    // so the offlineDb read-through cache and the online/offline split went
    // away with the axios surface.
    return accommodationsApi.list(tripId)
  },
}
