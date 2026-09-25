import { reservationsApi } from '../api/client'
import type { Reservation } from '../types'

export const reservationRepo = {
  async list(tripId: number | string): Promise<{ reservations: Reservation[] }> {
    // The adapter runs on panelmintDb — the list is always local and durable,
    // so the offlineDb read-through cache and the online/offline split went
    // away with the axios surface (same shape the accommodationRepo took).
    return reservationsApi.list(tripId)
  },
}
