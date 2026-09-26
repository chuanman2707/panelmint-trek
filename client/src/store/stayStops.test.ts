import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTripStore } from './tripStore'
import { applyStayStops } from './stayStops'
import type { Assignment, Place } from '../types'

const stop = (id: number, dayId: number): Assignment =>
  ({ id, day_id: dayId, place_id: 7, order_index: 0, notes: null, place: { id: 7, name: 'Hotel Adlon' } }) as unknown as Assignment

const place = (id: number, over: Partial<Place> = {}): Place =>
  ({ id, trip_id: 1, name: `Place ${id}`, ...over }) as Place

beforeEach(() => {
  useTripStore.setState({ assignments: {}, places: [] })
})

describe('applyStayStops', () => {
  it('FE-STAY-STOPS-001 puts the stop a booking reported into the day it belongs to', () => {
    // The socket skips the session that sent the request, so the answer is the only
    // way the person who just booked the night learns about their own stop.
    applyStayStops({ assignment: stop(77, 3) })
    expect(useTripStore.getState().assignments['3']).toEqual([stop(77, 3)])
  })

  it('FE-STAY-STOPS-002 takes a stop back off the old day when the booking moved', () => {
    useTripStore.setState({ assignments: { '3': [stop(77, 3)] } })
    applyStayStops({ assignment: stop(78, 4), removedAssignments: [{ id: 77, dayId: 3 }] })
    expect(useTripStore.getState().assignments['3']).toEqual([])
    expect(useTripStore.getState().assignments['4']).toEqual([stop(78, 4)])
  })

  it('FE-STAY-STOPS-003 does nothing for a write that left the day plan alone', () => {
    useTripStore.setState({ assignments: { '3': [stop(77, 3)] } })
    // Booking a night at a place that was already planned for that day, and every
    // older server that answers without the field at all.
    applyStayStops({ assignment: null, removedAssignments: [] })
    applyStayStops(undefined)
    expect(useTripStore.getState().assignments['3']).toEqual([stop(77, 3)])
  })

  it('FE-STAY-STOPS-004 seats every night of a spanning stay from the list shape', () => {
    // A two-night stay answers `assignment` as a list — every seat it put down.
    applyStayStops({ assignment: [stop(77, 1), stop(78, 2)] })
    expect(useTripStore.getState().assignments['1']).toEqual([stop(77, 1)])
    expect(useTripStore.getState().assignments['2']).toEqual([stop(78, 2)])
  })

  it('FE-STAY-STOPS-005 carries several stops at once when the stay re-ranges', () => {
    useTripStore.setState({ assignments: { '1': [stop(77, 1)], '2': [stop(78, 2)] } })
    applyStayStops({
      movedAssignment: [
        { assignment: stop(77, 3), oldDayId: 1 },
        { assignment: stop(78, 4), oldDayId: 2 },
      ],
    })
    expect(useTripStore.getState().assignments['1']).toEqual([])
    expect(useTripStore.getState().assignments['2']).toEqual([])
    expect(useTripStore.getState().assignments['3']).toEqual([stop(77, 3)])
    expect(useTripStore.getState().assignments['4']).toEqual([stop(78, 4)])
  })

  it('FE-STAY-STOPS-006 types the stored place the write stamped as lodging', () => {
    // The socket's place:updated reached the sender's session too — without the
    // replay the place list's service-stop filter and the map marker keep the
    // stale untyped place until a refetch.
    useTripStore.setState({ places: [place(7, { name: 'Hotel Adlon', stop_type: null })] })
    applyStayStops({ assignment: stop(77, 3), stampedPlace: place(7, { name: 'Hotel Adlon', stop_type: 'hotel' }) })
    expect(useTripStore.getState().places[0]?.stop_type).toBe('hotel')
    // …and the embedded copy on the stop the write just put down.
    expect(useTripStore.getState().assignments['3']?.[0]?.place?.stop_type).toBe('hotel')
  })

  it('FE-STAY-STOPS-007 leaves a traveller-typed place alone (stampedPlace null)', () => {
    useTripStore.setState({ places: [place(7, { name: 'Camp Riverside', stop_type: 'campsite' })] })
    applyStayStops({ assignment: stop(77, 3), stampedPlace: null })
    expect(useTripStore.getState().places[0]?.stop_type).toBe('campsite')
  })
})
