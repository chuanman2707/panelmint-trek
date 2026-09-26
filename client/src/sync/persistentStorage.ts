/**
 * Ask the browser for persistent storage so our offline data — cached raster
 * map tiles, the Workbox precache, the IndexedDB data — is exempt from eviction
 * under storage pressure. Without this the browser may purge tiles right when a
 * traveler goes offline and needs them (audit H8 / M6).
 *
 * The answer matters: a browser that refuses persistence evicts this origin's
 * WHOLE bucket under pressure (the Workbox precache with it), and since sw.js
 * is byte-identical between releases, Workbox never re-installs and never
 * refills what was evicted. The PWA then cannot start offline at all, and
 * reinstalling does not help because it does not clear or restore site data
 * (#2228).
 *
 * Best-effort: returns whether persistence is (now) granted.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
      return false
    }
    // Already persisted? Avoid re-prompting where the API distinguishes.
    if (navigator.storage.persisted && (await navigator.storage.persisted())) {
      return true
    }
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
