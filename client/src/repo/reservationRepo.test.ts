// FE-REPO-RESV-001 to FE-REPO-RESV-004 — the repo now delegates straight to
// the local adapter on panelmintDb (no axios, no read-through cache).
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { reservationRepo } from './reservationRepo'
import { db } from '../db/panelmintDb'
import type { LocalUser } from '../types'
import { buildReservation, buildTrip } from '../../tests/helpers/factories'

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 }

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put(SELF)
})

describe('reservationRepo.list', () => {
  it('FE-REPO-RESV-001: returns this trip\'s reservations in the joined wire shape', async () => {
    await db.trips.put(buildTrip({ id: 14 }))
    await db.reservations.put(buildReservation({ id: 71, trip_id: 14, title: 'Sushi Bar' }))

    const result = await reservationRepo.list(14)
    expect(result.reservations).toHaveLength(1)
    expect(result.reservations[0]).toMatchObject({
      id: 71,
      title: 'Sushi Bar',
      endpoints: [],
      travelers: [],
      day_positions: null,
    })
  })

  it('FE-REPO-RESV-002: only this trip\'s rows come back', async () => {
    await db.trips.put(buildTrip({ id: 14 }))
    await db.trips.put(buildTrip({ id: 15 }))
    await db.reservations.bulkPut([
      buildReservation({ id: 72, trip_id: 14 }),
      buildReservation({ id: 73, trip_id: 15 }),
    ])

    const result = await reservationRepo.list('14')
    expect(result.reservations.map(r => r.id)).toEqual([72])
  })

  it('FE-REPO-RESV-003: a trip with no bookings answers an empty list', async () => {
    await db.trips.put(buildTrip({ id: 404 }))
    expect((await reservationRepo.list(404)).reservations).toEqual([])
  })

  it('FE-REPO-RESV-004: an unknown trip rejects with the guard\'s 404', async () => {
    await expect(reservationRepo.list(999)).rejects.toMatchObject({
      status: 404,
      response: { data: { error: 'Trip not found' } },
    })
  })
})
