import { create } from 'zustand'
import type { User } from '../types'
import { bootstrapLocalData, getSelf, SELF_ID } from '../db/bootstrap'
import { reopenForUser } from '../db/offlineDb'

/**
 * Local-only stub of what used to be the session store.
 *
 * PanelMint has no accounts: there is exactly one user — the seeded local
 * profile (`localUsers` id 1, created by `bootstrapLocalData`) — and the
 * session never starts or ends. The shape is kept because the store is also
 * the app's static configuration surface: the flags that used to arrive from
 * `GET /api/auth/app-config` are constants here, and the ~200 readers
 * (`useCanDo`, the navbar, the settings tabs, the places gating in
 * `utils/placeSource`) keep working unchanged.
 *
 * `user.role: 'admin'` is deliberate: with a single local user there is nobody
 * to gate, and the admin path in `useCanDo`/`user.role === 'admin'` checks is
 * the one that lets every permission question trivially pass.
 */

export interface AuthState {
  /** The local self profile as a `User`. Non-null once `bootLocal()` ran. */
  user: User | null
  /** Always true once booted — kept for the guards readers still check. */
  isAuthenticated: boolean
  /** True until the first `bootLocal()` resolves. */
  isLoading: boolean
  /** Was "the auth check failed while online" — there is no auth check, so it
   *  is always false. Kept because `useDashboard` folds it into its load-error
   *  banner. */
  authCheckFailed: boolean
  /** The operator-of-this-install flag. Nothing is managed — always false. */
  managed: boolean
  /** Demo mode is cut — always false. */
  demoMode: boolean
  isPrerelease: boolean
  /** The build's version tag, baked in by the vite/vitest `define`. */
  appVersion: string
  /** No Google/Amap keys exist locally — search is Photon/OpenStreetMap. */
  hasMapsKey: boolean
  hasAmapKey: boolean
  /** Read by utils/placeSource (`selectGoogleHoldsSlot`): 'openstreetmap' keeps
   *  Google out of the keyed slot unconditionally. */
  placesProvider: string
  /** Was the server's timezone; local time is the browser's. */
  serverTimezone: string
  /** No MFA exists — always false. */
  appRequireMfa: boolean
  /** Trip reminders stay on — the flag used to come from app-config. */
  tripRemindersEnabled: boolean
  /** Place photos are cut (no photo proxy) — always false. */
  placesPhotosEnabled: boolean
  placesAutocompleteEnabled: boolean
  placesDetailsEnabled: boolean
  /** Wikimedia enrichment is a keyless browser-direct call — stays on. */
  placesEnrichEnabled: boolean
  /** Server-side search shadowing never existed locally — always false. */
  placeShadowEnabled: boolean

  /**
   * First-run boot: seed the `panelmint` Dexie database (self profile,
   * categories, settings defaults), then expose the self row as `user`.
   * Idempotent — a second call re-reads the same seeded row.
   */
  bootLocal: () => Promise<void>
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  authCheckFailed: false,
  managed: false,
  demoMode: false,
  isPrerelease: false,
  appVersion: typeof __TREK_UI_VERSION__ === 'string' ? __TREK_UI_VERSION__ : '',
  hasMapsKey: false,
  hasAmapKey: false,
  placesProvider: 'openstreetmap',
  serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  appRequireMfa: false,
  tripRemindersEnabled: true,
  // Photos resolve through the server's photo proxy
  // (`photoService` → `mapsApi.placePhoto` → `/maps/place-photo/*`) — a dead
  // network call on the local build, so they stay off.
  placesPhotosEnabled: false,
  placesAutocompleteEnabled: true,
  placesDetailsEnabled: true,
  placesEnrichEnabled: true,
  placeShadowEnabled: false,

  bootLocal: async () => {
    // The legacy offline cache is per-user (`trek-offline-u<id>`); point it at
    // the self id BEFORE bootstrap runs — bootstrap deletes the anonymous
    // `trek-offline` database the proxy would otherwise open by default.
    await reopenForUser(SELF_ID)
    await bootstrapLocalData()
    const self = await getSelf()
    set({
      user: {
        id: self.id,
        username: self.name,
        email: self.email ?? '',
        role: 'admin',
        avatar_url: null,
        maps_api_key: null,
        created_at: new Date().toISOString(),
      },
      isAuthenticated: true,
      isLoading: false,
      authCheckFailed: false,
    })
  },
}))
