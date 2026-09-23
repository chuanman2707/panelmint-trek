import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '../../../src/db/panelmintDb'

const EXPECTED_TABLES = [
  'trips',
  'days',
  'places',
  'packingItems',
  'todoItems',
  'budgetItems',
  'budgetSettlements',
  'reservations',
  'accommodations',
  'tripMembers',
  'tags',
  'categories',
  'localUsers',
  'settings',
  'packingBags',
  'packingBagMembers',
  'packingCategoryAssignees',
  'todoCategoryAssignees',
  'reservationTravelers',
  'assignmentParticipants',
  'syncMeta',
]

describe('panelmintDb', () => {
  beforeAll(async () => {
    await db.open()
  })

  afterAll(() => {
    db.close()
  })

  it('opens with the full schema', () => {
    const names = db.tables.map((t) => t.name)
    for (const t of EXPECTED_TABLES) {
      expect(names).toContain(t)
    }
  })

  it('does not touch legacy trek-offline databases', () => {
    expect(db.name).toBe('panelmint')
    expect(db.name.startsWith('trek-offline')).toBe(false)
  })

  it('round-trips a trip-scoped row and a junction row', async () => {
    await db.trips.put({ id: 1, title: 'T' } as never)
    await db.days.put({ id: 10, trip_id: 1, day_number: 1 } as never)
    await db.assignmentParticipants.put({ id: 100, assignment_id: 5, user_id: 1 })
    await db.packingBagMembers.put({ bag_id: 7, user_id: 1 })
    await db.syncMeta.put({
      tripId: 1,
      lastSyncedAt: null,
      status: 'idle',
      tilesBbox: null,
      filesCachedCount: 0,
    })

    expect(await db.days.where('trip_id').equals(1).count()).toBe(1)
    expect(await db.assignmentParticipants.where('assignment_id').equals(5).count()).toBe(1)
    expect(await db.packingBagMembers.get([7, 1])).toEqual({ bag_id: 7, user_id: 1 })
    expect((await db.syncMeta.get(1))?.status).toBe('idle')
  })

  it('enforces the category-assignee uniqueness constraint', async () => {
    const row = { id: 1, trip_id: 1, category_name: 'clothes', user_id: 1 }
    await db.packingCategoryAssignees.put(row)
    await expect(
      db.packingCategoryAssignees.put({ ...row, id: 2 }),
    ).rejects.toThrow()
  })
})
