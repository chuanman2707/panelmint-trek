/**
 * Network mode — the single source of truth for whether the app should behave
 * as if it were offline right now.
 *
 * Two inputs combine here:
 *   - the real browser state (`navigator.onLine`)
 *   - a persisted "force offline" override (`trek_forced_offline`). The Settings
 *     toggle that wrote it is gone, but a device that set it keeps it — the
 *     flag stays honored rather than silently ignored.
 *
 * Local data reads and writes are Dexie adapter calls and never consult this
 * flag. What gates on `isEffectivelyOffline()` are the genuinely networked
 * callers — geocoding/search, map tiles, weather — plus the OfflineBanner that
 * tells the user why those cannot work. Feature code must ask here, never
 * `navigator.onLine` directly, so a forced-offline session behaves exactly as
 * a genuine disconnection would.
 */

const STORAGE_KEY = 'trek_forced_offline'

let _forced = readPersisted()
const listeners = new Set<() => void>()

function readPersisted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persist(v: boolean): void {
  try {
    if (v) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode / quota — the in-memory flag still governs this session */
  }
}

function notify(): void {
  listeners.forEach(fn => {
    try { fn() } catch { /* a listener throwing must not break the others */ }
  })
}

/** True when the user has manually forced the app into offline mode. */
export function isForcedOffline(): boolean {
  return _forced
}

/** Flip the manual force-offline override and notify subscribers. */
export function setForcedOffline(v: boolean): void {
  if (_forced === v) return
  _forced = v
  persist(v)
  notify()
}

/**
 * True when the app should treat itself as offline: either the browser is
 * genuinely offline OR the user forced offline mode. This is the flag the
 * offline read/write paths must gate on.
 */
export function isEffectivelyOffline(): boolean {
  return _forced || !navigator.onLine
}

/** Convenience inverse of {@link isEffectivelyOffline}. */
export function isEffectivelyOnline(): boolean {
  return !isEffectivelyOffline()
}

/**
 * Subscribe to network-mode changes (force-offline toggled, or the browser's own
 * online/offline events). Returns an unsubscribe function. Registers the global
 * browser listeners lazily on first subscription.
 */
export function onNetworkModeChange(fn: () => void): () => void {
  ensureBrowserListeners()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let _browserListenersBound = false
function ensureBrowserListeners(): void {
  if (_browserListenersBound || typeof window === 'undefined') return
  _browserListenersBound = true
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
}

/** Reset state — test helper only. */
export function _resetNetworkMode(): void {
  _forced = false
  listeners.clear()
}
