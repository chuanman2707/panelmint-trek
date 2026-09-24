/**
 * `dashboardApi` — the local dashboard feed. Covers the two cross-trip reads
 * the dashboard page used to take from the hosted server: `travelStats` (was
 * `authApi.travelStats`, GET /api/auth/travel-stats) and `upcoming` (was
 * `reservationsApi.upcoming`, GET /api/reservations/upcoming). Both are plain
 * Dexie aggregates over the `panelmint` database — no request ever leaves the
 * browser.
 *
 * Server parity notes (server/src/nest/atlas/atlas.service.ts `getTravelStats`
 * + reservations.service.ts `listUpcoming`):
 *  - trips/days/places are straight counts; the local store hard-deletes, so
 *    there is no deleted_at arm to carry over.
 *  - totalDistanceKm keeps `flightDistanceKm` semantics: ordered endpoints of
 *    non-cancelled flight reservations, haversine between consecutive points.
 *    The traveler's-own clause simplifies to "no traveler rows, or self is
 *    named" — the roster's only account is self.
 *  - countries stays empty: the server resolved them through the atlas
 *    place_regions cache + point-in-polygon scans, and the atlas pipeline is
 *    gone. The passport tile renders "0 / 195" and never loads flagcdn art.
 *  - upcoming() keeps the same entry rules: non-archived trips, non-cancelled,
 *    hotels excluded (a stay is a range, not a moment), plus check-in/check-out
 *    rows minted from accommodations. The one deliberate divergence is the
 *    "today" edge: the server used UTC (`date('now')`); a local app answers in
 *    the user's own wall-clock day, matching `localIsoDate()` everywhere else.
 */
import { haversineKm } from '@trek/shared/roadtrip'
import { db } from '../../db/panelmintDb'
import { SELF_ID } from '../../db/bootstrap'
import { localIsoDate } from '../../utils/localDate'
import type { TravelStats, UpcomingReservation } from '../../pages/dashboard/dashboardModel'
import type { Reservation } from '../../types'

/** 'YYYY-MM-DD' — the reservation_time prefix that counts as a real datetime. */
const DATED = /^\d{4}-\d{2}-\d{2}/

interface UpcomingEntry {
  row: UpcomingReservation
  atDate: string | null
  atTime: string | null
}

async function travelStats(): Promise<TravelStats> {
  const [totalTrips, totalDays, totalPlaces, reservations, travelerRows] = await Promise.all([
    db.trips.count(),
    db.days.count(),
    db.places.count(),
    db.reservations.filter(r => r.type === 'flight' && r.status !== 'cancelled').toArray(),
    db.reservationTravelers.toArray(),
  ])

  const travelersByReservation = new Map<number, Set<number>>()
  for (const t of travelerRows) {
    const set = travelersByReservation.get(t.reservation_id) ?? new Set<number>()
    set.add(t.user_id)
    travelersByReservation.set(t.reservation_id, set)
  }

  let totalDistanceKm = 0
  for (const r of reservations) {
    // The booking counts toward self's stats when nobody is named on it, or
    // when self is — the server's TRAVELER_OWNS clause, minus the shared-trips
    // arm a local install cannot have.
    const named = travelersByReservation.get(r.id)
    if (named && !named.has(SELF_ID)) continue
    const points = [...(r.endpoints ?? [])]
      .filter(e => e.lat != null && e.lng != null)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    for (let i = 1; i < points.length; i++) {
      totalDistanceKm += haversineKm(points[i - 1], points[i])
    }
  }

  return {
    totalTrips,
    totalDays,
    totalPlaces,
    totalDistanceKm: Math.round(totalDistanceKm),
    countries: [],
  }
}

async function upcoming(limit = 6): Promise<{ reservations: UpcomingReservation[] }> {
  const [trips, reservations, days, places, accommodations] = await Promise.all([
    db.trips.toArray(),
    db.reservations.toArray(),
    db.days.toArray(),
    db.places.toArray(),
    db.accommodations.toArray(),
  ])

  const visibleTrips = new Map(trips.filter(t => !t.is_archived).map(t => [t.id, t]))
  const dayById = new Map(days.map(d => [d.id, d]))
  const placeById = new Map(places.map(p => [p.id, p]))
  const entries: UpcomingEntry[] = []

  for (const r of reservations) {
    const trip = visibleTrips.get(r.trip_id)
    if (!trip || r.status === 'cancelled' || (r.type ?? '') === 'hotel') continue
    const dated = typeof r.reservation_time === 'string' && DATED.test(r.reservation_time)
    const day = r.day_id != null ? dayById.get(r.day_id) : undefined
    const place = r.place_id != null ? placeById.get(r.place_id) : undefined
    entries.push({
      row: {
        id: r.id,
        trip_id: r.trip_id,
        title: r.title,
        type: r.type,
        status: r.status,
        location: r.location ?? null,
        reservation_time: r.reservation_time ?? null,
        day_date: day?.date ?? null,
        place_name: place?.name ?? null,
        trip_title: trip.title,
      },
      atDate: dated ? (r.reservation_time as string).slice(0, 10) : (day?.date ?? null),
      atTime: dated ? (r.reservation_time as string).slice(11) : (r.reservation_time ?? null),
    })
  }

  // Check-in and check-out ride the accommodation's own dates (#1934): the stay
  // itself is a range and never listed, but arriving and leaving are moments.
  for (const a of accommodations) {
    const trip = visibleTrips.get(a.trip_id)
    if (!trip) continue
    const place = a.place_id != null ? placeById.get(a.place_id) : undefined
    const linked = reservations.find(
      (res: Reservation) => Number(res.accommodation_id) === a.id && res.status !== 'cancelled',
    )
    const title = place?.name ?? linked?.title ?? trip.title
    for (const [dayId, atTime, type] of [
      [a.start_day_id, a.check_in, 'checkin'],
      [a.end_day_id, a.check_out, 'checkout'],
    ] as const) {
      const day = dayById.get(dayId)
      if (!day?.date) continue
      entries.push({
        row: {
          id: a.id,
          trip_id: a.trip_id,
          title,
          type,
          status: 'confirmed',
          location: null,
          reservation_time: atTime ? `${day.date}T${atTime}` : null,
          day_date: day.date,
          place_name: place?.name ?? null,
          trip_title: trip.title,
        },
        atDate: day.date,
        atTime: atTime ?? null,
      })
    }
  }

  const today = localIsoDate()
  const now = new Date()
  const nowHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

  const rows = entries
    .filter(e => e.atDate !== null && (e.atDate > today || (e.atDate === today && (e.atTime ?? '23:59') >= nowHHMM)))
    .sort((a, b) =>
      (a.atDate as string).localeCompare(b.atDate as string)
      || (a.atTime ?? '00:00').localeCompare(b.atTime ?? '00:00')
      || a.row.id - b.row.id,
    )
    .slice(0, limit)
    .map(e => e.row)

  return { reservations: rows }
}

export const dashboardApi = { travelStats, upcoming }
