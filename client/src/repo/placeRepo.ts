import { placesApi } from '../api/client'
import type { Place } from '../types'

export const placeRepo = {
  async list(tripId: number | string, params?: Record<string, unknown>): Promise<{ places: Place[] }> {
    return placesApi.list(tripId, params)
  },

  async create(tripId: number | string, data: Record<string, unknown> & { name: string }): Promise<{ place: Place }> {
    return placesApi.create(tripId, data)
  },

  async update(tripId: number | string, id: number | string, data: Record<string, unknown>): Promise<{ place: Place }> {
    return placesApi.update(tripId, id, data)
  },

  async delete(tripId: number | string, id: number | string): Promise<unknown> {
    return placesApi.delete(tripId, id)
  },

  async deleteMany(tripId: number | string, ids: number[]): Promise<unknown> {
    return placesApi.bulkDelete(tripId, ids)
  },

  async updateMany(tripId: number | string, ids: number[], data: Record<string, unknown>): Promise<{ updated: number[]; count: number }> {
    return placesApi.bulkUpdate(tripId, ids, data as Parameters<typeof placesApi.bulkUpdate>[2])
  },
}
