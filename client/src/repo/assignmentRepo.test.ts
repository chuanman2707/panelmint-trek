import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assignmentRepo } from './assignmentRepo'
import { saveAssignmentEndDay } from '../api/assignmentEndDay'
import { assignmentsApi } from '../api/client'
import { applyLocalEffect } from '../store/localEffects'
import type { Assignment } from '../types'

// The repo no longer branches on connectivity — every write runs the local
// adapter on panelmintDb, so the seam to pin is the adapter call itself plus
// the reordered side-channel replay setTimes owes the store.
vi.mock('../api/assignmentEndDay', () => ({ saveAssignmentEndDay: vi.fn() }))
vi.mock('../api/client', () => ({ assignmentsApi: { updateTime: vi.fn() } }))
vi.mock('../store/localEffects', () => ({ applyLocalEffect: vi.fn() }))

const assignment = { id: 7, day_id: 1, place_id: 2, order_index: 0, assignment_time: '07:00', place: { id: 2, name: 'Berlin' } } as Assignment

beforeEach(() => {
  vi.clearAllMocks()
})

describe('assignment day-end persistence', () => {
  it('writes through the local end-day route and returns the saved row', async () => {
    vi.mocked(saveAssignmentEndDay).mockResolvedValue({ ...assignment, end_day: false })
    const saved = await assignmentRepo.setEndDay(9, assignment, false)
    expect(saveAssignmentEndDay).toHaveBeenCalledWith(9, 7, { end_day: false })
    expect(saved.end_day).toBe(false)
  })

  it('propagates a refused save', async () => {
    vi.mocked(saveAssignmentEndDay).mockRejectedValue(new Error('Denied'))
    await expect(assignmentRepo.setEndDay(9, assignment, true)).rejects.toThrow('Denied')
  })
})

describe('assignment time persistence', () => {
  const times = { place_time: '07:00', end_time: null }

  it('writes through the local time route and returns the parsed row', async () => {
    vi.mocked(assignmentsApi.updateTime).mockResolvedValue({
      assignment: { ...assignment, assignment_end_time: null }, reordered: null, vias: null,
    })
    const saved = await assignmentRepo.setTimes(9, { ...assignment, assignment_end_time: '14:00' }, times)
    expect(assignmentsApi.updateTime).toHaveBeenCalledWith(9, 7, times)
    expect(saved.assignment_end_time).toBeNull()
    // A null reordered payload is still handed to the effect — it no-ops inside.
    expect(applyLocalEffect).toHaveBeenCalledWith('assignment:reordered', null)
  })

  it('replays the day re-sort the adapter answered with', async () => {
    const reordered = { dayId: 1, orderedIds: [9, 7] }
    vi.mocked(assignmentsApi.updateTime).mockResolvedValue({
      assignment, reordered, vias: null,
    })
    await assignmentRepo.setTimes(9, assignment, times)
    expect(applyLocalEffect).toHaveBeenCalledWith('assignment:reordered', reordered)
  })

  it('propagates a refused save', async () => {
    vi.mocked(assignmentsApi.updateTime).mockRejectedValue(new Error('Denied'))
    await expect(assignmentRepo.setTimes(9, assignment, times)).rejects.toThrow('Denied')
  })
})
