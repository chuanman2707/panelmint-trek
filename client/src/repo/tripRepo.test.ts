// FE-REPO-TRIP-001 to FE-REPO-TRIP-011
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { tripRepo } from './tripRepo'
import { tripsApi } from '../api/client'
import { LocalApiError } from '../api/local/helpers'
import { offlineDb, clearAll } from '../db/offlineDb'
import { db } from '../db/panelmintDb'
import { buildTrip } from '../../tests/helpers/factories'

function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: v, writable: true, configurable: true })
}

beforeEach(async () => {
  await clearAll()
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 })
  setOnline(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The shape of a request that never reached a server — the only error
 *  onlineThenCache treats as fall-back-to-cache. */
function axiosNetworkError(): Error {
  const err = new Error('Network Error')
  Object.assign(err, { isAxiosError: true })
  return err
}

describe('tripRepo.list', () => {
  it('FE-REPO-TRIP-001: online — merges active + archived and caches both in Dexie', async () => {
    // tripsApi is the local adapter: the "online" read is the panelmint db.
    const active = buildTrip({ title: 'Lisbon' })
    const archived = buildTrip({ title: 'Old Trip', is_archived: 1 })
    await db.trips.bulkPut([active, archived])

    const result = await tripRepo.list()
    expect(result.trips.map(t => t.title)).toEqual(['Lisbon'])
    expect(result.archivedTrips.map(t => t.title)).toEqual(['Old Trip'])

    await new Promise(r => setTimeout(r, 0))
    expect(await offlineDb.trips.get(active.id)).toBeDefined()
    expect(await offlineDb.trips.get(archived.id)).toBeDefined()
  })

  it('FE-REPO-TRIP-002: offline — splits the Dexie cache by is_archived', async () => {
    await offlineDb.trips.bulkPut([
      buildTrip({ id: 71, is_archived: 0 }),
      buildTrip({ id: 72, is_archived: 1 }),
    ])
    setOnline(false)

    const apiSpy = vi.spyOn(tripsApi, 'list')

    const result = await tripRepo.list()
    expect(result.trips.map(t => t.id)).toEqual([71])
    expect(result.archivedTrips.map(t => t.id)).toEqual([72])
    expect(apiSpy).not.toHaveBeenCalled()
  })

  it('FE-REPO-TRIP-003: rethrows a server error instead of falling back to the cache', async () => {
    await offlineDb.trips.put(buildTrip({ id: 73 }))
    vi.spyOn(tripsApi, 'list').mockRejectedValue(new LocalApiError(500, 'boom'))

    await expect(tripRepo.list()).rejects.toThrow()
  })
})

describe('tripRepo.get', () => {
  it('FE-REPO-TRIP-004: online — returns the trip and caches it', async () => {
    const trip = buildTrip({ id: 80, title: 'Kyoto' })
    await db.trips.put(trip)

    const result = await tripRepo.get(80)
    expect(result.trip.title).toBe('Kyoto')

    await new Promise(r => setTimeout(r, 0))
    expect((await offlineDb.trips.get(80))!.title).toBe('Kyoto')
  })

  it('FE-REPO-TRIP-005: offline — serves the cached trip', async () => {
    await offlineDb.trips.put(buildTrip({ id: 81, title: 'Cached' }))
    setOnline(false)

    const result = await tripRepo.get('81')
    expect(result.trip.title).toBe('Cached')
  })

  it('FE-REPO-TRIP-006: offline with nothing cached — throws so the caller can show an error', async () => {
    setOnline(false)
    await expect(tripRepo.get(999)).rejects.toThrow('No cached trip data available offline')
  })

  it('FE-REPO-TRIP-007: network-level failure falls back to the cache (captive portal)', async () => {
    await offlineDb.trips.put(buildTrip({ id: 82, title: 'Fallback' }))
    vi.spyOn(tripsApi, 'get').mockRejectedValue(axiosNetworkError())

    const result = await tripRepo.get(82)
    expect(result.trip.title).toBe('Fallback')
  })
})

describe('tripRepo.active', () => {
  // Local calendar dates, like the repo itself.
  function dateOffset(days: number): string {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('FE-REPO-TRIP-008: online — passes the local ranking straight through', async () => {
    await db.trips.put(
      buildTrip({ id: 90, title: 'Current', start_date: dateOffset(-1), end_date: dateOffset(2) }),
    )

    const result = await tripRepo.active()
    expect(result.trip!.id).toBe(90)
  })

  it('FE-REPO-TRIP-009: offline — ranks ongoing over upcoming over past', async () => {
    await offlineDb.trips.put(buildTrip({ id: 91, start_date: dateOffset(-40), end_date: dateOffset(-30) }))
    await offlineDb.trips.put(buildTrip({ id: 92, start_date: dateOffset(10), end_date: dateOffset(14) }))
    await offlineDb.trips.put(buildTrip({ id: 93, start_date: dateOffset(-1), end_date: dateOffset(2) }))
    setOnline(false)

    expect((await tripRepo.active()).trip!.id).toBe(93)

    await offlineDb.trips.delete(93)
    expect((await tripRepo.active()).trip!.id).toBe(92)

    await offlineDb.trips.delete(92)
    expect((await tripRepo.active()).trip!.id).toBe(91)
  })

  it('FE-REPO-TRIP-010: offline — skips archived trips and answers null when nothing is left', async () => {
    await offlineDb.trips.put(buildTrip({ id: 94, is_archived: 1, start_date: dateOffset(-1), end_date: dateOffset(2) }))
    setOnline(false)

    expect((await tripRepo.active()).trip).toBeNull()
  })

  it('FE-REPO-TRIP-011: an HTTP error still rejects instead of falling back', async () => {
    await offlineDb.trips.put(buildTrip({ id: 95 }))
    vi.spyOn(tripsApi, 'active').mockRejectedValue(new LocalApiError(500, 'boom'))

    await expect(tripRepo.active()).rejects.toThrow()
  })
})
