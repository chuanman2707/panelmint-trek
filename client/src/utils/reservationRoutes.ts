import type { Reservation } from '../types'

/**
 * A reservation is routable on the map once it has at least two ordered
 * endpoints (from/to/stop).
 *
 * Total in its argument, because it is handed straight to Array.filter over a
 * list this module does not own. It used to guard the property but not the
 * element, so one undefined entry took the whole trip planner down (#1979).
 */
export function isRoutableReservation(r: Pick<Reservation, 'endpoints'> | null | undefined): boolean {
  return (r?.endpoints || []).length >= 2
}

export interface RouteVisibilityOptions {
  /** Reservation ids resolved as currently visible for this trip (per-item toggle, bulk toggle, or the account-wide default — see connectionsVisibility.ts). */
  visibleConnectionIds: number[]
}

/** Which reservations should draw a route on the map. */
export function visibleRouteReservations(reservations: Reservation[], options: RouteVisibilityOptions): Reservation[] {
  const set = new Set(options.visibleConnectionIds || [])
  return reservations.filter(r => set.has(r.id))
}

/** The type-specific floors, in screen pixels, under which a hop is not worth drawing. */
const LINE_FLOOR_PX: Record<string, number> = { flight: 50, cruise: 150, car: 80 }
const LINE_FLOOR_DEFAULT_PX = 200

/** Under this floor the endpoint labels stay off, so short hops do not stack text. */
const LABEL_FLOOR_PX: Record<string, number> = { flight: 50, cruise: 300, car: 150 }
const LABEL_FLOOR_DEFAULT_PX = 400

/** How far the line is allowed to disappear before its endpoints cannot be told apart. */
export function lineFloorPx(type: string): number {
  return LINE_FLOOR_PX[type] ?? LINE_FLOOR_DEFAULT_PX
}

export function labelFloorPx(type: string): number {
  return LABEL_FLOOR_PX[type] ?? LABEL_FLOOR_DEFAULT_PX
}

/**
 * Whether a hop is worth drawing at the current zoom.
 *
 * The declutter exists for a tiny straight connector, the kind that would sit
 * under its own endpoint markers and add nothing but clutter. It used to be
 * decided from the two endpoints alone, which was fine while every hop was a
 * straight line: the line was never longer than the gap it bridged.
 *
 * A routed car booking is not that line. It follows the road, and a road that
 * leaves a town, loops round a lake and comes back to the next town along
 * can run across half the screen while its two ends project a handful of
 * pixels apart. The old check then hid the whole drive, and the person looking
 * at their trip saw a gap in the route until they zoomed in far enough for
 * the endpoints to separate (#2275). A booking with stops on the way has the
 * same shape: the ends may be close, the drawn path is not.
 *
 * So the decision looks at what will actually be drawn. A hop stays hidden
 * only while every polyline it would draw is shorter on screen than the
 * floor, walked point to point. A straight two-point line measures the same
 * as before, so every existing floor holds for the case it was written for.
 *
 * `project` is the map's own projection — Leaflet's latLngToContainerPoint —
 * wrapped to take [lat, lng].
 */
export function hopIsVisible(
  type: string,
  lines: readonly (readonly [number, number][])[],
  project: (point: readonly [number, number]) => { x: number; y: number },
): boolean {
  const floor = lineFloorPx(type)
  for (const line of lines) {
    let length = 0
    let prev = line.length > 0 ? project(line[0]) : null
    for (let i = 1; i < line.length && prev; i++) {
      const next = project(line[i])
      length += Math.hypot(next.x - prev.x, next.y - prev.y)
      if (length >= floor) return true
      prev = next
    }
  }
  return false
}
