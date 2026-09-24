// FE-REPO-PLACE-001 to FE-REPO-PLACE-013
// Offline write paths (straight-to-Dexie optimistic rows) and the bulk online
// paths, which tests/unit/repo/placeRepo.test.ts does not touch. There is no
// replay queue any more — offline writes ARE the stored state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { placeRepo } from './placeRepo'
import { offlineDb, clearAll } from '../db/offlineDb'
import { buildPlace } from '../../tests/helpers/factories'

function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: v, writable: true, configurable: true })
}

beforeEach(async () => {
  await clearAll()
  setOnline(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  setOnline(true)
})

describe('placeRepo.create — offline', () => {
  it('FE-REPO-PLACE-001: writes an optimistic row with a negative temp id', async () => {
    const { place } = await placeRepo.create(3, { name: 'Sagrada Familia', lat: 41.4 })
    expect(place.id).toBeLessThan(0)
    expect(place.trip_id).toBe(3)

    const cached = await offlineDb.places.get(place.id)
    expect(cached!.name).toBe('Sagrada Familia')
  })

  it('FE-REPO-PLACE-002: an offline create is readable straight back from the cache', async () => {
    const { place } = await placeRepo.create('3', { name: 'Park Güell' })

    expect((await offlineDb.places.get(place.id))!.name).toBe('Park Güell')
    expect(await offlineDb.places.where('trip_id').equals(3).toArray()).toHaveLength(1)
  })
})

describe('placeRepo.update — offline', () => {
  it('FE-REPO-PLACE-003: merges into the cached row and sends the concurrency token', async () => {
    await offlineDb.places.put(buildPlace({ id: 90, trip_id: 3, name: 'Old', updated_at: '2026-01-01T00:00:00.000Z' }))

    const { place } = await placeRepo.update(3, 90, { name: 'New' })
    expect(place.name).toBe('New')
    expect(place.trip_id).toBe(3)
    expect((await offlineDb.places.get(90))!.name).toBe('New')
  })

  it('FE-REPO-PLACE-004: an unsynced (negative id) target is updated in place', async () => {
    await offlineDb.places.put(buildPlace({ id: -5, trip_id: 3 }))

    await placeRepo.update(3, -5, { notes: 'later' })
    expect((await offlineDb.places.get(-5))!.notes).toBe('later')
  })

  it('FE-REPO-PLACE-005: nothing cached — the optimistic row still carries its trip_id', async () => {
    const { place } = await placeRepo.update(3, '91', { name: 'Ghost' })
    expect(place).toEqual({ name: 'Ghost', id: 91, trip_id: 3 })
    expect((await offlineDb.places.get(91))!.name).toBe('Ghost')
    // Without trip_id the row would be invisible to every where('trip_id') read
    // and would survive clearTripData() forever.
    expect(await offlineDb.places.where('trip_id').equals(3).toArray()).toHaveLength(1)
  })
})

describe('placeRepo.delete — offline', () => {
  it('FE-REPO-PLACE-006: removes the cached row', async () => {
    await offlineDb.places.put(buildPlace({ id: 92, trip_id: 3 }))

    expect(await placeRepo.delete(3, 92)).toEqual({ success: true })
    expect(await offlineDb.places.get(92)).toBeUndefined()
  })

  it('FE-REPO-PLACE-007: deleting an unsynced place removes its temp row too', async () => {
    await offlineDb.places.put(buildPlace({ id: -7, trip_id: 3 }))

    await placeRepo.delete(3, -7)
    expect(await offlineDb.places.get(-7)).toBeUndefined()
  })
})

describe('placeRepo.deleteMany', () => {
  it('FE-REPO-PLACE-008: offline — every id drops its cached row, temp ids included', async () => {
    await offlineDb.places.bulkPut([
      buildPlace({ id: 93, trip_id: 3 }),
      buildPlace({ id: -9, trip_id: 3 }),
    ])

    const result = await placeRepo.deleteMany(3, [93, -9])
    expect(result).toEqual({ deleted: [93, -9], count: 2 })
    expect(await offlineDb.places.where('trip_id').equals(3).count()).toBe(0)
  })

  it('FE-REPO-PLACE-009: online — calls the bulk endpoint and drops the rows locally', async () => {
    setOnline(true)
    await offlineDb.places.bulkPut([buildPlace({ id: 94, trip_id: 3 }), buildPlace({ id: 95, trip_id: 3 })])

    let body: unknown
    server.use(http.post('/api/trips/3/places/bulk-delete', async ({ request }) => {
      body = await request.json()
      return HttpResponse.json({ deleted: [94, 95], count: 2 })
    }))

    const result = await placeRepo.deleteMany(3, [94, 95])
    expect(result).toEqual({ deleted: [94, 95], count: 2 })
    expect(body).toEqual({ ids: [94, 95] })
    expect(await offlineDb.places.where('trip_id').equals(3).count()).toBe(0)
  })
})

describe('placeRepo.updateMany', () => {
  it('FE-REPO-PLACE-010: offline — merges each cached row', async () => {
    await offlineDb.places.bulkPut([
      buildPlace({ id: 96, trip_id: 3, updated_at: '2026-02-02T00:00:00.000Z' }),
      buildPlace({ id: 97, trip_id: 3, updated_at: '2026-03-03T00:00:00.000Z' }),
    ])

    const result = await placeRepo.updateMany(3, [96, 97], { category_id: 4 })
    expect(result).toEqual({ updated: [96, 97], count: 2 })

    expect((await offlineDb.places.get(96))!.category_id).toBe(4)
    expect((await offlineDb.places.get(97))!.category_id).toBe(4)
  })

  it('FE-REPO-PLACE-011: offline — an uncached id is counted without inventing a local row', async () => {
    const result = await placeRepo.updateMany(3, [-11], { notes: 'x' })
    expect(result.count).toBe(1)
    expect(await offlineDb.places.get(-11)).toBeUndefined()
  })

  it('FE-REPO-PLACE-012: online — calls the bulk endpoint and merges into the cached rows', async () => {
    setOnline(true)
    await offlineDb.places.bulkPut([buildPlace({ id: 98, trip_id: 3 }), buildPlace({ id: 99, trip_id: 3 })])

    let body: unknown
    server.use(http.post('/api/trips/3/places/bulk-update', async ({ request }) => {
      body = await request.json()
      return HttpResponse.json({ updated: [98, 99], count: 2 })
    }))

    const result = await placeRepo.updateMany(3, [98, 99], { category_id: 7 })
    expect(result.count).toBe(2)
    expect(body).toEqual({ ids: [98, 99], category_id: 7 })
    expect((await offlineDb.places.get(98))!.category_id).toBe(7)
    expect((await offlineDb.places.get(99))!.category_id).toBe(7)
  })

  it('FE-REPO-PLACE-013: online — ids missing from the cache are skipped on the merge', async () => {
    setOnline(true)
    await offlineDb.places.put(buildPlace({ id: 100, trip_id: 3 }))
    server.use(http.post('/api/trips/3/places/bulk-update', () => HttpResponse.json({ updated: [100, 101], count: 2 })))

    await placeRepo.updateMany(3, [100, 101], { category_id: 8 })
    expect((await offlineDb.places.get(100))!.category_id).toBe(8)
    expect(await offlineDb.places.get(101)).toBeUndefined()
  })
})
