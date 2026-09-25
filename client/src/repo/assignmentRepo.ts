import { assignmentSchema } from '@trek/shared'
import { saveAssignmentEndDay } from '../api/assignmentEndDay'
import { assignmentsApi } from '../api/client'
import { applyLocalEffect } from '../store/localEffects'
import type { Assignment } from '../types'

/** Start and End of one visit, as the time route stores them: null is no time. */
export interface AssignmentTimes {
  place_time: string | null
  end_time: string | null
}

export const assignmentRepo = {
  async setEndDay(tripId: number | string, assignment: Assignment, endDay: boolean): Promise<Assignment> {
    // The adapter runs on panelmintDb — offline writes land durably, no
    // separate cache step.
    return saveAssignmentEndDay(tripId, assignment.id, { end_day: endDay })
  },

  /**
   * A visit's own Start and End, the pair the time route takes.
   *
   * The route writes both columns every time, so a caller changing one of them hands the
   * other in as it stands; leaving it out would clear it.
   */
  async setTimes(tripId: number | string, assignment: Assignment, times: AssignmentTimes): Promise<Assignment> {
    const res = await assignmentsApi.updateTime(tripId, assignment.id, times)
    // The local adapter hands back the day's re-sorted order the server
    // used to broadcast — the socket is gone, so replay it through the
    // store effect (null means the save left every stop where it was).
    applyLocalEffect('assignment:reordered', res.reordered)
    return assignmentSchema.parse(res.assignment)
  },
}
