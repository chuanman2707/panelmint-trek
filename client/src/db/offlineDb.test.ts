// FE-DB-OFFLINE-001 to FE-DB-OFFLINE-029
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import {
  offlineDb,
  clearAll,
  clearTripData,
  reopenForUser,
  reopenAnonymous,
  deleteCurrentUserDb,
  upsertTrip,
  upsertDays,
  upsertPlaces,
  upsertBudgetItems,
  upsertReservations,
  upsertAccommodations,
  upsertTripMembers,
  upsertTags,
  upsertCategories,
  upsertSyncMeta,
} from './offlineDb'
import type { Accommodation, TripMember } from '../types'
import {
  buildTrip,
  buildDay,
  buildPlace,
  buildBudgetItem,
  buildReservation,
  buildTag,
  buildCategory,
} from '../../tests/helpers/factories'

beforeEach(async () => {
  await clearAll()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await reopenAnonymous()
})

describe('offlineDb — bulk upsert helpers', () => {
  it('FE-DB-OFFLINE-001: every entity helper writes into its own table', async () => {
    await upsertTrip(buildTrip({ id: 1 }))
    await upsertDays([buildDay({ id: 1, trip_id: 1 })])
    await upsertPlaces([buildPlace({ id: 1, trip_id: 1 })])
    await upsertBudgetItems([buildBudgetItem({ id: 1, trip_id: 1 })])
    await upsertReservations([buildReservation({ id: 1, trip_id: 1 })])
    await upsertAccommodations([{ id: 1, trip_id: 1, start_day_id: 1, end_day_id: 2 } as Accommodation])
    await upsertTags([buildTag({ id: 1 })])
    await upsertCategories([buildCategory({ id: 1 })])

    expect(await offlineDb.trips.count()).toBe(1)
    expect(await offlineDb.days.count()).toBe(1)
    expect(await offlineDb.places.count()).toBe(1)
    expect(await offlineDb.budgetItems.count()).toBe(1)
    expect(await offlineDb.reservations.count()).toBe(1)
    expect(await offlineDb.accommodations.count()).toBe(1)
    expect(await offlineDb.tags.count()).toBe(1)
    expect(await offlineDb.categories.count()).toBe(1)
  })

  it('FE-DB-OFFLINE-002: upsertTripMembers stamps the tripId onto every member row', async () => {
    const members = [
      { id: 5, username: 'ana', role: 'owner' },
      { id: 6, username: 'ben', role: 'member' },
    ] as unknown as TripMember[]

    await upsertTripMembers(42, members)

    const rows = await offlineDb.tripMembers.where('tripId').equals(42).toArray()
    expect(rows.map(r => r.username).sort()).toEqual(['ana', 'ben'])
    expect(rows.every(r => r.tripId === 42)).toBe(true)
  })

  it('FE-DB-OFFLINE-003: upsertSyncMeta overwrites the previous row for the same trip', async () => {
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: 100, status: 'idle', tilesBbox: null })
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: 200, status: 'error', tilesBbox: [0, 0, 1, 1] })

    const meta = await offlineDb.syncMeta.get(1)
    expect(meta).toMatchObject({ lastSyncedAt: 200, status: 'error' })
    expect(await offlineDb.syncMeta.count()).toBe(1)
  })
})

describe('offlineDb — clearTripData', () => {
  it('FE-DB-OFFLINE-018: drops the trip\'s read cache and leaves other trips alone', async () => {
    await upsertTrip(buildTrip({ id: 1 }))
    await upsertTrip(buildTrip({ id: 2 }))
    await upsertDays([buildDay({ id: 1, trip_id: 1 }), buildDay({ id: 2, trip_id: 2 })])
    await upsertPlaces([buildPlace({ id: 1, trip_id: 1 }), buildPlace({ id: 2, trip_id: 2 })])
    await upsertBudgetItems([buildBudgetItem({ id: 1, trip_id: 1 })])
    await upsertReservations([buildReservation({ id: 1, trip_id: 1 })])
    await upsertAccommodations([{ id: 1, trip_id: 1, start_day_id: 1, end_day_id: 2 } as Accommodation])
    await upsertTripMembers(1, [{ id: 9, username: 'ana', role: 'owner' } as unknown as TripMember])
    await upsertSyncMeta({ tripId: 1, lastSyncedAt: 1, status: 'idle', tilesBbox: null })

    await clearTripData(1)

    expect(await offlineDb.trips.get(1)).toBeUndefined()
    expect(await offlineDb.days.where('trip_id').equals(1).count()).toBe(0)
    expect(await offlineDb.places.where('trip_id').equals(1).count()).toBe(0)
    expect(await offlineDb.budgetItems.count()).toBe(0)
    expect(await offlineDb.reservations.count()).toBe(0)
    expect(await offlineDb.accommodations.count()).toBe(0)
    expect(await offlineDb.tripMembers.count()).toBe(0)
    expect(await offlineDb.syncMeta.get(1)).toBeUndefined()

    expect(await offlineDb.trips.get(2)).toBeDefined()
    expect(await offlineDb.days.where('trip_id').equals(2).count()).toBe(1)
  })
})

describe('offlineDb — per-user database scoping', () => {
  it('FE-DB-OFFLINE-020: reopenForUser switches to the user-scoped database', async () => {
    await reopenForUser(7)
    expect(offlineDb.name).toBe('trek-offline-u7')
    expect(offlineDb.isOpen()).toBe(true)
  })

  it('FE-DB-OFFLINE-021: one account cannot read another account\'s cached trips', async () => {
    await reopenForUser(7)
    await upsertTrip(buildTrip({ id: 500, title: 'Seven' }))

    await reopenForUser(8)
    expect(await offlineDb.trips.get(500)).toBeUndefined()

    await reopenForUser(7)
    expect((await offlineDb.trips.get(500))!.title).toBe('Seven')
  })

  it('FE-DB-OFFLINE-022: switching to the database already in use just reopens it', async () => {
    await reopenForUser(7)
    offlineDb.close()

    await reopenForUser(7)
    expect(offlineDb.name).toBe('trek-offline-u7')
    expect(offlineDb.isOpen()).toBe(true)
  })

  it('FE-DB-OFFLINE-023: deleteCurrentUserDb wipes the account data and returns to anonymous', async () => {
    await reopenForUser(9)
    await upsertTrip(buildTrip({ id: 501 }))

    await deleteCurrentUserDb()
    expect(offlineDb.name).toBe('trek-offline')

    await reopenForUser(9)
    expect(await offlineDb.trips.count()).toBe(0)
  })

  it('FE-DB-OFFLINE-024: deleteCurrentUserDb on the anonymous database is a no-op switch', async () => {
    await reopenAnonymous()
    await upsertTrip(buildTrip({ id: 502 }))

    await deleteCurrentUserDb()

    expect(offlineDb.name).toBe('trek-offline')
    expect(await offlineDb.trips.get(502)).toBeDefined()
  })
})

describe('offlineDb — connection proxy', () => {
  it('FE-DB-OFFLINE-028: reads and writes go to the connection that is live right now', async () => {
    const proxied = offlineDb as unknown as Record<string, unknown>
    proxied.__marker = 'anon'
    expect(proxied.__marker).toBe('anon')

    await reopenForUser(56)
    expect((offlineDb as unknown as Record<string, unknown>).__marker).toBeUndefined()
  })

  it('FE-DB-OFFLINE-029: upgrading a pre-v11 cache drops the cut tables', async () => {
    const legacy = new Dexie('trek-offline-u55')
    legacy.version(1).stores({
      trips: 'id',
      days: 'id, trip_id',
      places: 'id, trip_id',
      packingItems: 'id, trip_id',
      todoItems: 'id, trip_id',
      budgetItems: 'id, trip_id',
      reservations: 'id, trip_id',
      tripFiles: 'id, trip_id',
      mutationQueue: 'id, tripId, status, createdAt',
      syncMeta: 'tripId',
      blobCache: 'url, cachedAt',
    })
    legacy.version(2).stores({
      accommodations: 'id, trip_id',
      tripMembers: '[tripId+id], tripId',
      tags: 'id',
      categories: 'id',
    })
    await legacy.open()
    await legacy.table('tripFiles').put({ id: 1, trip_id: 1 })
    await legacy.table('blobCache').put({ url: '/legacy.pdf', blob: new Blob(['abc']), mime: 'application/pdf', cachedAt: 1 })
    legacy.close()

    await reopenForUser(55)

    // v11 dropped tripFiles/blobCache/mutationQueue/roadtripPreferences — the
    // tables are gone, not just emptied.
    expect(offlineDb.tables.map(t => t.name)).not.toContain('tripFiles')
    expect(offlineDb.tables.map(t => t.name)).not.toContain('blobCache')
    expect(offlineDb.tables.map(t => t.name)).not.toContain('mutationQueue')
  })
})

describe('offlineDb — initial database name', () => {
  it('FE-DB-OFFLINE-025: boots straight into the persisted user\'s database', async () => {
    localStorage.setItem('trek_auth_snapshot', JSON.stringify({ state: { user: { id: 33 } } }))
    vi.resetModules()

    const mod = await import('./offlineDb')
    expect(mod.offlineDb.name).toBe('trek-offline-u33')
  })

  it('FE-DB-OFFLINE-026: falls back to the anonymous database without a snapshot', async () => {
    localStorage.removeItem('trek_auth_snapshot')
    vi.resetModules()

    const mod = await import('./offlineDb')
    expect(mod.offlineDb.name).toBe('trek-offline')
  })

  it('FE-DB-OFFLINE-027: a corrupt snapshot falls back to the anonymous database', async () => {
    localStorage.setItem('trek_auth_snapshot', 'not json')
    vi.resetModules()

    const mod = await import('./offlineDb')
    expect(mod.offlineDb.name).toBe('trek-offline')
  })
})
