import { useTripStore } from './tripStore'
import type { Assignment, Place } from '../types'

/** The day-plan half of what an accommodation write answers with. */
export interface StayStopsResult {
  /** The seat the write put down — one for the ordinary case, a list when a
   * stay spans nights and every night took a seat at once. */
  assignment?: Assignment | Assignment[] | null
  /** The booking's own stop carried to the day the booking now covers — again
   * a list when several nights were carried at once. */
  movedAssignment?:
    | { assignment: Assignment; oldDayId: number }
    | { assignment: Assignment; oldDayId: number }[]
    | null
  /** Stops the booking let go of but left standing (a night dropped, the place kept). */
  updatedAssignments?: Assignment[]
  removedAssignments?: { id: number; dayId: number }[]
  /** The place the write typed as lodging — the socket's `place:updated`,
   * which reached the sender's session too. null when the place was already
   * typed or the write never reached the day plan. */
  stampedPlace?: Place | null
}

/**
 * Fold the day stop a stay write reported back into the store.
 *
 * Booking a night also puts the place on its check-in day, because that stop is
 * what the road trip routes and the map draws. The server announces it over the
 * socket like any other assignment, and unlike the booking events it does not
 * skip the session that sent the request: the stop and the order it was seated
 * into arrive there together. The answer carries the stop as well, for a session
 * whose socket is down at that moment, and applying it a second time is harmless
 * because the store drops a stop it already holds. The stamped place rides the
 * same channel — announced last, after the stop events, the way the server's
 * announceMirror sent it — so the place list and the map marker see the 'hotel'
 * type immediately instead of on the next places refetch. Goes through the same
 * applier the socket uses, so the write-through to IndexedDB happens either way.
 */
export function applyStayStops(result: StayStopsResult | null | undefined): void {
  if (!result) return
  const { handleRemoteEvent } = useTripStore.getState()
  for (const removed of result.removedAssignments ?? []) {
    handleRemoteEvent({ type: 'assignment:deleted', assignmentId: removed.id, dayId: removed.dayId })
  }
  const created = result.assignment == null
    ? []
    : Array.isArray(result.assignment)
      ? result.assignment
      : [result.assignment]
  for (const assignment of created) {
    handleRemoteEvent({ type: 'assignment:created', assignment })
  }
  const moved = result.movedAssignment == null
    ? []
    : Array.isArray(result.movedAssignment)
      ? result.movedAssignment
      : [result.movedAssignment]
  for (const { assignment, oldDayId } of moved) {
    handleRemoteEvent({ type: 'assignment:moved', assignment, oldDayId, newDayId: assignment.day_id })
  }
  for (const updated of result.updatedAssignments ?? []) {
    handleRemoteEvent({ type: 'assignment:updated', assignment: updated })
  }
  if (result.stampedPlace) {
    handleRemoteEvent({ type: 'place:updated', place: result.stampedPlace })
  }
}
