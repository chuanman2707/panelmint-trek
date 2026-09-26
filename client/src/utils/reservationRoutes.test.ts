import { describe, it, expect } from 'vitest'
import { hopIsVisible, isRoutableReservation, labelFloorPx, lineFloorPx, visibleRouteReservations } from './reservationRoutes'
import type { Reservation, ReservationEndpoint } from '../types'

function endpoint(role: 'from' | 'to', lat: number, lng: number): ReservationEndpoint {
  return { role, sequence: role === 'from' ? 0 : 1, name: role, code: null, lat, lng, timezone: null, local_time: null, local_date: null }
}

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 1, trip_id: 1, title: 'Flight', type: 'flight', status: 'confirmed',
    reservation_time: null, reservation_end_time: null, location: null,
    confirmation_number: null, notes: null, url: null,
    ...overrides,
  } as Reservation
}

describe('isRoutableReservation', () => {
  it('is false with no endpoints', () => {
    expect(isRoutableReservation(reservation())).toBe(false)
  })

  it('is false with a single endpoint', () => {
    expect(isRoutableReservation(reservation({ endpoints: [endpoint('from', 1, 2)] }))).toBe(false)
  })

  it('is true with 2+ endpoints', () => {
    expect(isRoutableReservation(reservation({ endpoints: [endpoint('from', 1, 2), endpoint('to', 3, 4)] }))).toBe(true)
  })
})

describe('visibleRouteReservations', () => {
  const twoStop = [endpoint('from', 1, 2), endpoint('to', 3, 4)]

  it('includes a reservation whose id is in visibleConnectionIds regardless of type', () => {
    const flight = reservation({ id: 5, type: 'flight', endpoints: twoStop })
    const train = reservation({ id: 6, type: 'train', endpoints: twoStop })
    expect(visibleRouteReservations([flight, train], { visibleConnectionIds: [5, 6] })).toEqual([flight, train])
  })

  it('excludes a routable reservation whose route is toggled off', () => {
    const r = reservation({ id: 7, type: 'flight', endpoints: twoStop })
    expect(visibleRouteReservations([r], { visibleConnectionIds: [] })).toEqual([])
  })

  it('does not duplicate a reservation listed once in visibleConnectionIds', () => {
    const r = reservation({ id: 10, type: 'flight', endpoints: twoStop })
    expect(visibleRouteReservations([r], { visibleConnectionIds: [10] })).toEqual([r])
  })
})

describe('hopIsVisible (#2275)', () => {
  // A flat projection: one unit of lat or lng is one pixel.
  const px = (p: readonly [number, number]) => ({ x: p[1], y: p[0] })

  it('keeps the type floors of the old endpoint check', () => {
    expect(lineFloorPx('car')).toBe(80)
    expect(lineFloorPx('flight')).toBe(50)
    expect(lineFloorPx('cruise')).toBe(150)
    expect(lineFloorPx('train')).toBe(200)
    expect(labelFloorPx('car')).toBe(150)
    expect(labelFloorPx('bus')).toBe(400)
  })

  it('measures a straight two-point line exactly as the endpoint gap', () => {
    expect(hopIsVisible('car', [[[0, 0], [0, 79]]], px)).toBe(false)
    expect(hopIsVisible('car', [[[0, 0], [0, 80]]], px)).toBe(true)
  })

  it('walks a routed line, so a loop between close ends counts its full length', () => {
    const loop: [number, number][] = [[0, 0], [30, 0], [30, 30], [0, 30], [0, 5]]
    expect(hopIsVisible('car', [loop], px)).toBe(true)
    expect(hopIsVisible('train', [loop], px)).toBe(false)
  })

  it('adds the legs of a multi-stop booking together', () => {
    const legs: [number, number][][] = [[[0, 0], [0, 50]], [[0, 50], [0, 100]]]
    expect(hopIsVisible('car', legs, px)).toBe(false)
    expect(hopIsVisible('car', [[[0, 0], [0, 50], [0, 100]]], px)).toBe(true)
  })

  it('draws nothing for an empty or one-point line', () => {
    expect(hopIsVisible('car', [], px)).toBe(false)
    expect(hopIsVisible('car', [[]], px)).toBe(false)
    expect(hopIsVisible('car', [[[0, 0]]], px)).toBe(false)
  })
})
