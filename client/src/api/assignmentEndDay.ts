import { assignmentSchema, type AssignmentEndDayRequest } from '@trek/shared'
import { assignmentsApi } from './client'

export async function saveAssignmentEndDay(tripId: number | string, id: number, body: AssignmentEndDayRequest) {
  const saved = await assignmentsApi.setEndDay(tripId, id, body)
  return assignmentSchema.parse(saved.assignment)
}
