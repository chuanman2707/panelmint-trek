import { daysApi } from '../api/client'
import type { Day } from '../types'

export const dayRepo = {
  async list(tripId: number | string): Promise<{ days: Day[] }> {
    return daysApi.list(tripId)
  },
}
