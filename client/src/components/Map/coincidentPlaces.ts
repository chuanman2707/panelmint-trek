/**
 * Stops that land on the same spot on screen.
 *
 * A trip often models one building as several stops — drop the bags, check in, the
 * museum inside the hotel, the tour — and every one of them carries the same
 * coordinates. No zoom level can pull those apart, so Leaflet draws the pile as a
 * cluster bubble that carries a count and fans open on click: a stop inside one is
 * still reachable, which is what makes the generous radius below safe.
 */

/**
 * How close two pins have to be before Leaflet stacks them into a cluster.
 *
 * A place pin is 36 px across (44 while selected), so a third of a pin is already
 * enough overlap to swallow whatever is underneath: two stops two metres apart sit
 * about 7 px apart at the map's maximum zoom.
 */
export const STACK_RADIUS_PX = 12
