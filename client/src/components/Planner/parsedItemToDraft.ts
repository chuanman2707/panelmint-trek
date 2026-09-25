import type { Reservation, ReservationEndpoint } from '@trek/shared'

/**
 * A pre-fill draft for the reservation/transport edit modals — the shape an
 * external source hands the modal so its form opens already filled. Carries
 * the normal reservation fields the modals read, plus the venue/accommodation
 * extras the hotel path needs to suggest a place and a day range. It has no
 * `id` — the modal stays in "create" mode and the user reviews/edits before
 * it is ever persisted.
 */
export interface BookingReviewDraft extends Omit<Partial<Reservation>, 'metadata' | 'endpoints'> {
  /** Type-specific extras (airline, flight_number, check_in_time, price, …) as an object. */
  metadata?: Record<string, unknown> | null
  endpoints?: ReservationEndpoint[]
  /** Venue suggestion (a place candidate) — hotel/restaurant/event. */
  _venue?: {
    name: string
    lat?: number
    lng?: number
    address?: string
    website?: string
    phone?: string
  }
  /** Check-in/out + confirmation — hotels only. */
  _accommodation?: {
    check_in?: string
    check_out?: string
    confirmation?: string
  }
  /** Source file(s) the draft came from — attached to the booking on save. */
  _sourceFiles?: File[]
}
