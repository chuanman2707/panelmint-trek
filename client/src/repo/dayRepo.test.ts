// FE-REPO-DAY-001 to FE-REPO-DAY-003
// dayRepo is a pass-through over the local daysApi adapter now — these tests
// pin the list envelope, the day_number ordering the adapter answers, and that
// an adapter failure propagates rather than being masked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { dayRepo } from './dayRepo'
import { daysApi } from '../api/client'
import { LocalApiError } from '../api/local/helpers'
import { db } from '../db/panelmintDb'
import { buildDay, buildTrip } from '../../tests/helpers/factories'

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dayRepo.list', () => {
  it('FE-REPO-DAY-001: returns the trip days ordered by day_number', async () => {
    await db.trips.put(buildTrip({ id: 5 }))
    await db.days.bulkPut([
      buildDay({ id: 21, trip_id: 5, day_number: 3 }),
      buildDay({ id: 22, trip_id: 5, day_number: 1 }),
      buildDay({ id: 23, trip_id: 5, day_number: 2 }),
      buildDay({ id: 24, trip_id: 6, day_number: 1 }),
    ])

    const result = await dayRepo.list('5')
    expect(result.days.map(d => d.id)).toEqual([22, 23, 21])
  })

  it('FE-REPO-DAY-002: a trip with no days answers an empty list', async () => {
    await db.trips.put(buildTrip({ id: 5 }))
    expect((await dayRepo.list(5)).days).toEqual([])
  })

  it('FE-REPO-DAY-003: an adapter failure rejects, not masked', async () => {
    vi.spyOn(daysApi, 'list').mockRejectedValue(new LocalApiError(500, 'nope'))

    await expect(dayRepo.list(5)).rejects.toThrow()
  })
})
