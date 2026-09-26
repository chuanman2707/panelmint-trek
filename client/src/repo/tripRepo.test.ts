// FE-REPO-TRIP-001 to FE-REPO-TRIP-008
// tripRepo is a pass-through over the local tripsApi adapter now — these tests
// pin the envelope shapes and that adapter errors propagate rather than being
// swallowed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { tripRepo } from './tripRepo'
import { tripsApi } from '../api/client'
import { LocalApiError } from '../api/local/helpers'
import { db } from '../db/panelmintDb'
import { buildTrip } from '../../tests/helpers/factories'

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tripRepo.list', () => {
  it('FE-REPO-TRIP-001: merges the active and archived lists into one envelope', async () => {
    const active = buildTrip({ title: 'Lisbon' })
    const archived = buildTrip({ title: 'Old Trip', is_archived: 1 })
    await db.trips.bulkPut([active, archived])

    const result = await tripRepo.list()
    expect(result.trips.map(t => t.title)).toEqual(['Lisbon'])
    expect(result.archivedTrips.map(t => t.title)).toEqual(['Old Trip'])
  })

  it('FE-REPO-TRIP-002: an adapter failure rejects instead of answering a stale copy', async () => {
    vi.spyOn(tripsApi, 'list').mockRejectedValue(new LocalApiError(500, 'boom'))

    await expect(tripRepo.list()).rejects.toThrow()
  })
})

describe('tripRepo.get', () => {
  it('FE-REPO-TRIP-003: returns the stored trip', async () => {
    await db.trips.put(buildTrip({ id: 80, title: 'Kyoto' }))

    const result = await tripRepo.get(80)
    expect(result.trip.title).toBe('Kyoto')
  })

  it('FE-REPO-TRIP-004: an unknown id rejects with the adapter 404', async () => {
    await expect(tripRepo.get(999)).rejects.toThrow(/Trip not found/)
  })
})

describe('tripRepo.active', () => {
  // Local calendar dates, like the adapter's ranking.
  function dateOffset(days: number): string {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('FE-REPO-TRIP-005: returns the trip running today', async () => {
    await db.trips.put(
      buildTrip({ id: 90, title: 'Current', start_date: dateOffset(-1), end_date: dateOffset(2) }),
    )

    const result = await tripRepo.active()
    expect(result.trip!.id).toBe(90)
  })

  it('FE-REPO-TRIP-006: ranks ongoing over upcoming over past', async () => {
    await db.trips.put(buildTrip({ id: 91, start_date: dateOffset(-40), end_date: dateOffset(-30) }))
    await db.trips.put(buildTrip({ id: 92, start_date: dateOffset(10), end_date: dateOffset(14) }))
    await db.trips.put(buildTrip({ id: 93, start_date: dateOffset(-1), end_date: dateOffset(2) }))

    expect((await tripRepo.active()).trip!.id).toBe(93)

    await db.trips.delete(93)
    expect((await tripRepo.active()).trip!.id).toBe(92)

    await db.trips.delete(92)
    expect((await tripRepo.active()).trip!.id).toBe(91)
  })

  it('FE-REPO-TRIP-007: skips archived trips and answers null when nothing is left', async () => {
    await db.trips.put(buildTrip({ id: 94, is_archived: 1, start_date: dateOffset(-1), end_date: dateOffset(2) }))

    expect((await tripRepo.active()).trip).toBeNull()
  })

  it('FE-REPO-TRIP-008: an adapter failure still rejects', async () => {
    vi.spyOn(tripsApi, 'active').mockRejectedValue(new LocalApiError(500, 'boom'))

    await expect(tripRepo.active()).rejects.toThrow()
  })
})
