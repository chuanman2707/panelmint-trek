import { budgetApi } from '../api/client'
import type { BudgetItem } from '../types'

export const budgetRepo = {
  async list(tripId: number | string): Promise<{ items: BudgetItem[] }> {
    // The adapter runs on panelmintDb — the list is always local and durable,
    // so the offlineDb read-through cache and the online/offline split went
    // away with the axios surface (same shape the reservationRepo took).
    return budgetApi.list(tripId)
  },
}
