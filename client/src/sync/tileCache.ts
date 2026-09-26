/**
 * The Service Worker's 'map-tiles' runtime cache (see vite.config.js) — the
 * CacheFirst bucket raster tile requests land in.
 *
 * Only the clearing side survives here: the per-trip prefetch machinery that
 * filled the cache is gone (there is no "prepare for offline" surface left),
 * but the cache itself is still written by every tile the live map requests,
 * so a template/key change must still be able to drop it.
 */

/** Name of the Workbox runtime cache holding map tiles (see vite.config.js). */
const TILE_CACHE = 'map-tiles'

/**
 * Drop the whole map-tile cache. Called when the CARTO key changes — tiles are
 * cached under the full URL including the key, so a new key needs a clean
 * bucket, and the stale-key tiles are dead weight either way.
 */
export async function clearTileCache(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(TILE_CACHE)
  } catch {
    /* Cache Storage unavailable (no SW / private mode) — nothing to clear */
  }
}
