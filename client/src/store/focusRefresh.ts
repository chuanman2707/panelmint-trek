/**
 * Multi-tab refresh (spec §17): two browser tabs share the same Dexie database
 * but not the same store, so a trip edited in tab A stays stale in tab B until
 * reload. There is no sync channel — the cheap guard is re-reading the open
 * trip out of Dexie when this tab regains focus, which is where the user looks
 * next anyway.
 *
 * `installFocusRefresh` is wired from `authStore.bootLocal()` — the single boot
 * path — and is idempotent so a repeated boot (or a test re-run in the same
 * module instance) never stacks a second listener.
 */

import { tripRepo } from '../repo/tripRepo'
import { useTripStore } from './tripStore'

let installed = false

export function installFocusRefresh(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('visibilitychange', onVisibilityChange)
}

/** Test teardown — the app itself never uninstalls. */
export function uninstallFocusRefresh(): void {
  if (!installed || typeof document === 'undefined') return
  installed = false
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return
  const tripId = useTripStore.getState().trip?.id
  if (tripId == null) return
  void refreshOpenTrip(tripId)
}

/**
 * Silently re-read the open trip from Dexie. `hydrateActiveTrip` covers the
 * trip-scoped collections (days/places/packing/todos/budget/reservations) and
 * nudges accommodations; it does not fetch the `trip` row itself, so the get()
 * leg lands a rename or date change made in the other tab too.
 *
 * No `resetTrip`, no `isLoading` — a focus refresh must never blank the screen.
 * Every leg is non-fatal: a failed read leaves the current state untouched.
 */
async function refreshOpenTrip(tripId: number | string): Promise<void> {
  await Promise.all([
    tripRepo
      .get(tripId)
      .then(({ trip }) => {
        // The user may have switched trips (or to none) while the read was in
        // flight — only land the row if it is still the open one.
        const current = useTripStore.getState().trip
        if (current?.id === trip.id) useTripStore.setState({ trip })
      })
      .catch(() => {}),
    useTripStore.getState().hydrateActiveTrip(tripId),
  ])
}
