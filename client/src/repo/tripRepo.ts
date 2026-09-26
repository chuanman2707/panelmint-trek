import { tripsApi } from '../api/client'
import type { Trip } from '../types'
import type { ActiveTripResponse } from '@trek/shared'

export const tripRepo = {
  async list(): Promise<{ trips: Trip[]; archivedTrips: Trip[] }> {
    const [active, archived] = await Promise.all([
      tripsApi.list(),
      tripsApi.list({ archived: 1 }),
    ])
    return { trips: active.trips, archivedTrips: archived.trips }
  },

  /**
   * The startup redirect asks for this on the very first paint — the local
   * adapter answers it out of Dexie, so launch never waits on anything.
   */
  async active(): Promise<ActiveTripResponse> {
    return tripsApi.active()
  },

  async get(tripId: number | string): Promise<{ trip: Trip }> {
    return tripsApi.get(tripId)
  },
}
