import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { roadtripApi } = vi.hoisted(() => ({
  roadtripApi: {
    listVias: vi.fn(),
    addVia: vi.fn(),
    moveVia: vi.fn(),
    removeVia: vi.fn(),
  },
}))
vi.mock('../../api/client', () => ({ roadtripApi }))

// Offline is the hook's headline rule and it has no other way in: `editable` is read
// straight off useNetworkMode, so a test that never drives it can only ever see the
// online answer.
const { networkMode } = vi.hoisted(() => ({ networkMode: { offline: false } }))
vi.mock('../../hooks/useNetworkMode', () => ({ useNetworkMode: () => networkMode }))

import { useRoadtripVias } from './useRoadtripVias'

const via = (over: Partial<{ id: number; day_id: number; after_order_index: number; sequence: number; lat: number; lng: number }> = {}) => ({
  id: 1, day_id: 1, after_order_index: 0, sequence: 0, lat: 53, lng: 10, ...over,
})

beforeEach(() => {
  networkMode.offline = false
  roadtripApi.listVias.mockReset().mockResolvedValue({ vias: [] })
  roadtripApi.addVia.mockReset().mockResolvedValue({ via: via() })
  roadtripApi.moveVia.mockReset().mockResolvedValue({ via: via() })
  roadtripApi.removeVia.mockReset().mockResolvedValue({ success: true })
})

describe('useRoadtripVias', () => {
  it('FE-ROADTRIP-VIAS-001: asks once for the whole trip, not once per day', async () => {
    roadtripApi.listVias.mockResolvedValue({ vias: [via({ id: 1, day_id: 1 }), via({ id: 2, day_id: 2 })] })

    const { result } = renderHook(() => useRoadtripVias(7, true))

    await waitFor(() => expect(Object.keys(result.current.byDay)).toHaveLength(2))
    expect(roadtripApi.listVias).toHaveBeenCalledTimes(1)
    expect(result.current.byDay[1].map(v => v.id)).toEqual([1])
  })

  it('FE-ROADTRIP-VIAS-002: with road trip mode off nothing is fetched', async () => {
    const { result } = renderHook(() => useRoadtripVias(7, false))

    await waitFor(() => expect(result.current.byDay).toEqual({}))
    expect(roadtripApi.listVias).not.toHaveBeenCalled()
  })

  it('FE-ROADTRIP-VIAS-003: an addon that is switched off means no vias, not an error', async () => {
    // Shaped like the rejection axios actually produces, so the branch that
    // reads the status is the one under test.
    roadtripApi.listVias.mockRejectedValue({ response: { status: 404 } })

    const { result } = renderHook(() => useRoadtripVias(7, true))

    await waitFor(() => expect(roadtripApi.listVias).toHaveBeenCalled())
    expect(result.current.byDay).toEqual({})
    expect(result.current.stale).toBe(false)
  })

  it('FE-ROADTRIP-VIAS-007: a read that fails for another reason keeps the vias it has', async () => {
    // This read runs after every write, and the via list feeds the routing key.
    // Emptying on a 502, a dropped connection or a tab that just went offline
    // re-routed the whole trip along the roads the traveller had steered away
    // from — with no toast, nothing retrying, and no way to tell it apart from
    // having deleted them.
    roadtripApi.listVias.mockResolvedValue({ vias: [via({ id: 1, day_id: 1 })] })
    const { result } = renderHook(() => useRoadtripVias(7, true))
    await waitFor(() => expect(result.current.byDay[1]).toHaveLength(1))

    roadtripApi.listVias.mockRejectedValue({ response: { status: 502 } })
    await act(async () => { await result.current.move(1, 1, 54, 11) })

    expect(result.current.byDay[1]).toHaveLength(1)
    expect(result.current.stale).toBe(true)

    // And a read that works again clears the doubt.
    roadtripApi.listVias.mockResolvedValue({ vias: [via({ id: 1, day_id: 1 })] })
    await act(async () => { await result.current.move(1, 1, 54, 11) })
    expect(result.current.stale).toBe(false)
  })

  it('FE-ROADTRIP-VIAS-004: adding one re-reads the list rather than guessing its id', async () => {
    const { result } = renderHook(() => useRoadtripVias(7, true))
    await waitFor(() => expect(roadtripApi.listVias).toHaveBeenCalledTimes(1))

    roadtripApi.listVias.mockResolvedValue({ vias: [via({ id: 5, day_id: 3 })] })
    await act(async () => { await result.current.add(3, 1, 52, 11) })

    expect(roadtripApi.addVia).toHaveBeenCalledWith(7, 3, { after_order_index: 1, lat: 52, lng: 11 })
    // The server assigns id and sequence; patching the list by hand would be a second
    // source of truth for the sake of one round trip.
    await waitFor(() => expect(result.current.byDay[3]?.[0].id).toBe(5))
  })

  it('FE-ROADTRIP-VIAS-005: moving and removing go to the day they belong to', async () => {
    const { result } = renderHook(() => useRoadtripVias(7, true))
    await waitFor(() => expect(roadtripApi.listVias).toHaveBeenCalled())

    await act(async () => { await result.current.move(2, 9, 51, 12) })
    expect(roadtripApi.moveVia).toHaveBeenCalledWith(7, 2, 9, { lat: 51, lng: 12 })

    await act(async () => { await result.current.remove(2, 9) })
    expect(roadtripApi.removeVia).toHaveBeenCalledWith(7, 2, 9)
  })

  it('FE-ROADTRIP-VIAS-006: without a trip there is nothing to write to', async () => {
    const { result } = renderHook(() => useRoadtripVias(null, true))

    await act(async () => { await result.current.add(1, 0, 53, 10) })

    expect(roadtripApi.addVia).not.toHaveBeenCalled()
  })
  it('FE-ROADTRIP-VIAS-014: with no network the map is told not to offer a drag', async () => {
    // A via anchors to a POSITION in the day stop list, not to an id, so a write queued
    // offline and replayed after somebody else added a stop would re-pin the drive onto
    // a leg nobody chose, silently and hours later. Until the anchor is an assignment id
    // the honest answer is to stop offering the gesture rather than to lose the edit one
    // write at a time.
    roadtripApi.listVias.mockResolvedValue({ vias: [] })
    networkMode.offline = true

    const { result } = renderHook(() => useRoadtripVias(7, true))

    expect(result.current.editable).toBe(false)
  })

})
