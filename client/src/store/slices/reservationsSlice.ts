import { reservationsApi } from '../../api/client'
import type { ReservationDeleteResult, ReservationWriteResult } from '../../api/local/reservations'
import { reservationRepo } from '../../repo/reservationRepo'
import { applyStayStops } from '../stayStops'
import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Reservation } from '../../types'
import { getErrorMessage } from '../../utils/apiError'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

/**
 * Fold a reservation write's side channels into the store, in the order the
 * server's socket fan-out ran: the mirrored day stops first (announceStayMirror
 * never skipped the sender's session), then the accommodation ping — there is
 * no `accommodation:*` store applier because stays live in planner-local state,
 * so it lands as the `accommodations:refresh` nudge — then the budget events,
 * and the reservation event itself last.
 */
function replayReservationWrite(get: GetState, result: ReservationWriteResult, event: 'reservation:created' | 'reservation:updated'): void {
  applyStayStops(result)
  if (result.accommodationPing) window.dispatchEvent(new CustomEvent('accommodations:refresh'))
  for (const ev of result.budgetEvents) {
    get().applyLocalEffect(ev.event, { item: ev.item, itemId: ev.itemId })
  }
  get().applyLocalEffect(event, { reservation: result.reservation })
}

/** DELETE's fan-out: the mirror, `accommodation:deleted`, `budget:deleted`,
 *  `reservation:deleted` — same order the controller broadcast them. */
function replayReservationDelete(get: GetState, id: number, result: ReservationDeleteResult): void {
  applyStayStops(result)
  if (result.deletedAccommodationId != null) {
    window.dispatchEvent(new CustomEvent('accommodations:refresh'))
  }
  if (result.deletedBudgetItemId != null) {
    get().applyLocalEffect('budget:deleted', { itemId: result.deletedBudgetItemId })
  }
  get().applyLocalEffect('reservation:deleted', { reservationId: id })
}

export interface ReservationsSlice {
  loadReservations: (tripId: number | string) => Promise<void>
  addReservation: (tripId: number | string, data: Partial<Reservation> & { title: string }) => Promise<Reservation>
  updateReservation: (tripId: number | string, id: number, data: Partial<Reservation>) => Promise<Reservation>
  toggleReservationStatus: (tripId: number | string, id: number) => Promise<void>
  deleteReservation: (tripId: number | string, id: number) => Promise<void>
  setReservationTravelers: (tripId: number | string, id: number, userIds: number[]) => Promise<void>
}

export const createReservationsSlice = (set: SetState, get: GetState): ReservationsSlice => ({
  loadReservations: async (tripId) => {
    try {
      const data = await reservationRepo.list(tripId)
      set({ reservations: data.reservations })
    } catch (err: unknown) {
      console.error('Failed to load reservations:', err)
    }
  },

  addReservation: async (tripId, data) => {
    try {
      const result = await reservationsApi.create(tripId, data)
      replayReservationWrite(get, result, 'reservation:created')
      return result.reservation
    } catch (err: unknown) {
      throw new Error(getErrorMessage(err, 'Error creating reservation'))
    }
  },

  updateReservation: async (tripId, id, data) => {
    try {
      const result = await reservationsApi.update(tripId, id, data)
      replayReservationWrite(get, result, 'reservation:updated')
      return result.reservation
    } catch (err: unknown) {
      throw new Error(getErrorMessage(err, 'Error updating reservation'))
    }
  },

  toggleReservationStatus: async (tripId, id) => {
    const prev = get().reservations
    const current = prev.find(r => r.id === id)
    if (!current) return
    const newStatus: 'pending' | 'confirmed' = current.status === 'confirmed' ? 'pending' : 'confirmed'
    set(state => ({
      reservations: state.reservations.map(r => r.id === id ? { ...r, status: newStatus } : r)
    }))
    try {
      const result = await reservationsApi.update(tripId, id, { status: newStatus })
      // Reconcile the optimistic toggle with the authoritative joined row —
      // identical in the ordinary case, but a linked stay/budget side channel
      // still has to reach the store.
      replayReservationWrite(get, result, 'reservation:updated')
    } catch (err: unknown) {
      // Roll back the optimistic toggle and surface the failure so the caller's
      // catch can notify the user — without it the status silently snaps back.
      set({ reservations: prev })
      throw new Error(getErrorMessage(err, 'Error updating reservation'))
    }
  },

  deleteReservation: async (tripId, id) => {
    try {
      const result = await reservationsApi.delete(tripId, id)
      replayReservationDelete(get, id, result)
    } catch (err: unknown) {
      throw new Error(getErrorMessage(err, 'Error deleting reservation'))
    }
  },

  setReservationTravelers: async (tripId, id, userIds) => {
    try {
      const result = await reservationsApi.setTravelers(tripId, id, userIds)
      get().applyLocalEffect('reservation:travelers-updated', { reservationId: id, travelers: result.travelers })
    } catch (err: unknown) {
      throw new Error(getErrorMessage(err, 'Error updating travelers'))
    }
  },
})
