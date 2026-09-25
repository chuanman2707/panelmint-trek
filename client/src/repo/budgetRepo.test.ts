// FE-REPO-BUDGET-001 to FE-REPO-BUDGET-004 — the repo is a thin pass-through
// to the local adapter now (the same shape reservationRepo took): panelmintDb
// is the always-durable source, so the online/offline cache split and the
// offlineDb mirror went away with the axios surface.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { budgetRepo } from './budgetRepo'
import { budgetApi } from '../api/local/budget'
import { LocalApiError } from '../api/local/helpers'
import { db } from '../db/panelmintDb'
import { buildBudgetItem, buildTrip } from '../../tests/helpers/factories'

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 })
})

describe('budgetRepo.list', () => {
  it('FE-REPO-BUDGET-001: returns the trip\'s items straight from panelmintDb', async () => {
    await db.trips.put(buildTrip({ id: 12 }))
    await db.budgetItems.put(buildBudgetItem({ id: 61, trip_id: 12, name: 'Hotel', total_price: 420 }))

    const result = await budgetRepo.list(12)
    expect(result.items[0].total_price).toBe(420)
    // The Dexie row the adapter wrote IS the cache — no separate mirror.
    expect((await db.budgetItems.get(61))!.name).toBe('Hotel')
  })

  it('FE-REPO-BUDGET-002: returns only this trip\'s items', async () => {
    await db.trips.bulkPut([buildTrip({ id: 12 }), buildTrip({ id: 13 })])
    await db.budgetItems.bulkPut([
      buildBudgetItem({ id: 62, trip_id: 12 }),
      buildBudgetItem({ id: 63, trip_id: 13 }),
    ])

    const result = await budgetRepo.list('12')
    expect(result.items.map(i => i.id)).toEqual([62])
  })

  it('FE-REPO-BUDGET-003: an empty trip answers an empty list', async () => {
    await db.trips.put(buildTrip({ id: 404 }))
    expect((await budgetRepo.list(404)).items).toEqual([])
  })

  it('FE-REPO-BUDGET-004: an adapter failure is rethrown, not masked', async () => {
    vi.spyOn(budgetApi, 'list').mockRejectedValueOnce(new LocalApiError(500, 'boom'))
    await expect(budgetRepo.list(12)).rejects.toThrow()
  })
})
