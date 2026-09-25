// FE-REPO-ACCOM-001 to FE-REPO-ACCOM-004 — the repo is a pass-through onto the
// Dexie-backed accommodationsApi now; the online/offline cache split is gone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { accommodationRepo } from './accommodationRepo'
import { db } from '../db/panelmintDb'
import { buildDay, buildTrip } from '../../tests/helpers/factories'
import type { Accommodation } from '../types'
import type { DayRow } from '../api/local/dexieStore'

function buildStay(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    trip_id: 16,
    place_id: null,
    start_day_id: 1,
    end_day_id: 2,
    check_in: '15:00',
    check_in_end: null,
    check_out: '11:00',
    confirmation: null,
    notes: null,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as Accommodation
}

const seedTrip = async (tripId: number) => {
  await db.trips.put(buildTrip({ id: tripId }))
  await db.days.bulkPut([1, 2].map((i) => ({
    ...buildDay({ id: i, trip_id: tripId, day_number: i, date: `2025-06-0${i}` }),
    assignments: [], vias: [],
  })) as DayRow[])
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('accommodationRepo.list', () => {
  it('FE-REPO-ACCOM-001: returns only this trip\'s stays', async () => {
    await seedTrip(16)
    await seedTrip(17)
    await db.accommodations.bulkPut([
      buildStay({ id: 81, trip_id: 16 }),
      buildStay({ id: 82, trip_id: 17 }),
    ])

    const result = await accommodationRepo.list(16)
    expect(result.accommodations.map(a => a.id)).toEqual([81])
  })

  it('FE-REPO-ACCOM-002: a string trip id resolves the same — the adapter normalizes it', async () => {
    await seedTrip(16)
    await db.accommodations.put(buildStay({ id: 83, trip_id: 16 }))

    const result = await accommodationRepo.list('16')
    expect(result.accommodations.map(a => a.id)).toEqual([83])
  })

  it('FE-REPO-ACCOM-003: a trip with no stays answers an empty list', async () => {
    await seedTrip(16)
    expect((await accommodationRepo.list(16)).accommodations).toEqual([])
  })

  it('FE-REPO-ACCOM-004: an unknown trip is the adapter\'s 404, not a masked cache miss', async () => {
    await expect(accommodationRepo.list(404)).rejects.toThrow('Trip not found')
  })
})
