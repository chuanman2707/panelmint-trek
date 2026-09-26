/**
 * Browser-side Overpass client — the POI explore pill, formerly
 * `searchOverpassPois`/`fetchOverpassDetails` inside the server's
 * `maps.service.ts` (+ `overpassFetch` in `overpass.client.ts`).
 *
 * What the port kept:
 *
 *  - Mirror race. All public mirrors are queried in parallel, first valid
 *    response wins — the reason the map POIs load at all on networks where the
 *    canonical instance is throttled. A non-200 or malformed reply is
 *    neutralised and the race continues; the call only fails when every mirror
 *    did, and that failure propagates so `usePoiExplore` can show its retry
 *    state instead of a silent empty map.
 *  - Bbox clamp. An oversized viewport is shrunk to a centred window so the
 *    query stays cheap and fast at any zoom, instead of timing out on a huge
 *    area. The caller sees the `clamped` flag.
 *  - Per-category share of the result cap, name localization, the
 *    disused/closed filters, `poi_type` = the matched selector.
 *  - The pan cache. Repeat pans/toggles of the same area answer locally for
 *    POI_CACHE_TTL_MS — also what keeps us inside Overpass's 2-slots-per-IP
 *    courtesy limit now that every user's browser is its own client.
 *
 * The constants and tables (mirrors, timeouts, category filters) live in
 * `./geoHelpers.ts` so tests pin them without fetch.
 */

import {
  CATEGORY_OSM_FILTERS,
  OVERPASS_MIRRORS,
  OVERPASS_QUERY_TIMEOUT_S,
  OVERPASS_TIMEOUT_MS,
  parsePoiCategories,
  toApiLang,
} from './geoHelpers'

// Mirrors the `Poi` shape in components/Map/poiCategories.ts — kept structural
// so this module stays free of component imports.
export interface OverpassPoi {
  osm_id: string
  name: string
  lat: number
  lng: number
  category: string
  poi_type: string
  brand?: string | null
  brand_wikidata?: string | null
  address: string | null
  website: string | null
  phone: string | null
  opening_hours: string | null
  cuisine: string | null
  source: string
  rating?: number | null
}

export interface PoiSearchResult {
  pois: OverpassPoi[]
  source: 'openstreetmap'
  /** More elements matched than the cap returned. */
  truncated: boolean
  /** The caller's bbox exceeded MAX_BBOX_SPAN_DEG and was centred-shrunk. */
  clamped?: boolean
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

export interface PoiBounds {
  south: number
  west: number
  north: number
  east: number
}

/** Longest bbox edge in degrees — a 0.5°×0.5° window is city-viewport sized. */
const MAX_BBOX_SPAN_DEG = 0.5
const POI_RESULT_CAP = 240
// Deliberately not the server's 5 min/500 entries: a 10-minute TTL halves the
// repeat load the free mirrors absorb during a planning session, and 120
// entries is a generous working set for one trip's viewports.
const POI_CACHE_TTL_MS = 10 * 60 * 1000
const POI_CACHE_MAX = 120
const poiCache = new Map<string, { at: number; value: PoiSearchResult }>()

/**
 * Clamps an oversized viewport to a centred window. Returns the effective box
 * plus whether it changed.
 */
export function clampPoiBounds(bbox: PoiBounds): { bbox: PoiBounds; clamped: boolean } {
  let { south, west, north, east } = bbox
  let clamped = false
  if (north - south > MAX_BBOX_SPAN_DEG) {
    const c = (north + south) / 2
    south = c - MAX_BBOX_SPAN_DEG / 2
    north = c + MAX_BBOX_SPAN_DEG / 2
    clamped = true
  }
  if (east - west > MAX_BBOX_SPAN_DEG) {
    const c = (east + west) / 2
    west = c - MAX_BBOX_SPAN_DEG / 2
    east = c + MAX_BBOX_SPAN_DEG / 2
    clamped = true
  }
  return { bbox: { south, west, north, east }, clamped }
}

/** The query string as it goes on the wire — exported for the tests. */
export function buildPoiQuery(categories: string[], bbox: PoiBounds, cap: number): string {
  // Overpass wants the box as (south,west,north,east) = (minLat,minLng,maxLat,maxLng).
  const box = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`
  const selectors = categories
    .flatMap((key) => CATEGORY_OSM_FILTERS[key] ?? [])
    .map((f) => {
      const eq = f.indexOf('=')
      return `  nwr["${f.slice(0, eq)}"="${f.slice(eq + 1)}"]${box};`
    })
    .join('\n')
  // `out center tags <n>` returns ways/relations with a computed center and caps
  // the result count in one round-trip.
  return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];\n(\n${selectors}\n);\nout center tags ${cap + 25};`
}

/**
 * Fires a query at every mirror at once and takes the first response that is a
 * 200 with a JSON body — not the first to finish, because a mirror that answers
 * 429 quickly is worse than a healthy one that takes a second.
 *
 * Reachability varies enough by network that no mirror is assumed healthy, and
 * no mirror is probed "first" — probing in series could take ~50 s of timeouts
 * before the first real request even ran. Losers are aborted once a winner
 * lands. The call rejects (the last per-mirror failure — `Promise.any` and
 * `AggregateError` predate the TS lib) only when every mirror did; the
 * caller's own abort wins over everything.
 */
export async function overpassFetch(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  const controller = new AbortController()
  const cancelAll = () => controller.abort()
  if (signal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    signal.addEventListener('abort', cancelAll, { once: true })
  }
  const timeout = setTimeout(cancelAll, OVERPASS_TIMEOUT_MS)

  // Promise.any, written out: ES2020's lib has neither it nor AggregateError.
  // First success wins; the promise only rejects once every mirror has.
  const firstSuccess = new Promise<OverpassElement[]>((resolve, reject) => {
    let pending = OVERPASS_MIRRORS.length
    let lastError: unknown = new Error('No Overpass mirrors configured')
    for (const mirror of OVERPASS_MIRRORS) {
      void (async () => {
        const res = await fetch(mirror, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: query,
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { elements?: OverpassElement[]; remark?: string }
        // A `remark` is how Overpass reports a timeout/rate-limit on a 200 —
        // often fast, with empty or partial elements. Server parity
        // (maps.service): it is a miss, never the winner.
        if (!data || typeof data !== 'object' || !Array.isArray(data.elements) || data.remark)
          throw new Error('Malformed Overpass response')
        return data.elements
      })().then(resolve, (err) => {
        lastError = err
        pending -= 1
        if (pending === 0) reject(lastError)
      })
    }
  })

  try {
    return await firstSuccess
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (controller.signal.aborted)
      // `new Error(msg, { cause })` is ES2022 — one lib newer than this target.
      throw Object.assign(new Error(`Overpass timed out after ${OVERPASS_TIMEOUT_MS} ms`), { cause: err })
    throw err
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancelAll)
    cancelAll()
  }
}

/**
 * Every named POI of the given categories inside a viewport box.
 *
 * Errors propagate on purpose: the explore pill distinguishes "no POIs here"
 * from "the mirrors are down" and shows a retry affordance on the latter —
 * swallowing the failure would draw an empty map and leave the user assuming
 * there is nothing around. The caller's abort is likewise rethrown untouched.
 */
export async function searchOverpassPois(
  category: string,
  bbox: PoiBounds,
  lang?: string,
  limit = 60,
  signal?: AbortSignal,
): Promise<PoiSearchResult> {
  // One or several categories in one query. Each OSM selector belongs to
  // exactly one category, so a hit can still be labelled with what it answered.
  const categories = parsePoiCategories(category).filter((key) => key in CATEGORY_OSM_FILTERS)
  if (!categories.length) throw Object.assign(new Error('Unknown POI category'), { status: 400 })
  const categoryOfFilter = new Map<string, string>()
  for (const key of categories)
    for (const f of CATEGORY_OSM_FILTERS[key]!) categoryOfFilter.set(f, key)
  const filters = [...categoryOfFilter.keys()]
  // Each category gets its own share of the cap, or a mixed search would spend
  // the whole budget on whichever kind happens to be densest.
  const cap = Math.min(limit * categories.length, POI_RESULT_CAP)

  const { bbox: box, clamped } = clampPoiBounds(bbox)

  // OSM `name:*` tags are keyed by language subtag: prefer the user's language
  // over the native `name`. `int_name` is the romanized fallback. Part of the
  // cache key so a cached area isn't served with another language's titles.
  const osmLang = toApiLang(lang).split('-')[0].toLowerCase()

  // Serve repeat pans/toggles of the same area straight from the cache.
  const cacheKey = `${[...categories].sort((a, b) => a.localeCompare(b)).join('+')}|${osmLang}|${box.south.toFixed(2)},${box.west.toFixed(2)},${box.north.toFixed(2)},${box.east.toFixed(2)}|${cap}`
  const cached = poiCache.get(cacheKey)
  if (cached && Date.now() - cached.at < POI_CACHE_TTL_MS) return cached.value
  if (cached) poiCache.delete(cacheKey)

  const elements = await overpassFetch(buildPoiQuery(categories, box, cap), signal)

  const pois: OverpassPoi[] = []
  for (const el of elements) {
    const tags = el.tags || {}
    // `operator` comes last: chains are routinely mapped with an operator and
    // no name, and dropping those would empty whole stretches of the map.
    const name =
      tags[`name:${osmLang}`] || tags['int_name'] || tags.name || tags.brand || tags.operator || null
    if (!name) continue // unnamed POIs aren't useful to add to a plan
    // A shut-down place is not somewhere to plan a visit (#1341). OSM usually
    // re-tags one with a `disused:`/`abandoned:` prefix, and those never match
    // the selectors above — but plenty keep their original tag and gain a
    // marker instead, and those do come back. `opening_hours=closed`/`off` is
    // the same statement in the hours field.
    if (tags.disused === 'yes' || tags.abandoned === 'yes') continue
    if (tags.opening_hours === 'closed' || tags.opening_hours === 'off') continue
    const lat = el.lat ?? el.center?.lat
    const lng = el.lon ?? el.center?.lon
    if (lat == null || lng == null) continue
    const matched = filters.find((f) => {
      const eq = f.indexOf('=')
      return tags[f.slice(0, eq)] === f.slice(eq + 1)
    }) ?? filters[0]!
    const addr =
      [tags['addr:street'], tags['addr:housenumber'], tags['addr:postcode'], tags['addr:city']]
        .filter(Boolean)
        .join(' ') || null
    pois.push({
      osm_id: `${el.type}:${el.id}`,
      name,
      lat,
      lng,
      category: categoryOfFilter.get(matched) ?? categories[0]!,
      poi_type: matched,
      address: addr,
      website: tags.website || tags['contact:website'] || null,
      phone: tags.phone || tags['contact:phone'] || null,
      opening_hours: tags.opening_hours || null,
      cuisine: tags.cuisine || null,
      brand: tags.brand || tags.operator || null,
      // Only the plain Q-id form is passed on; anything else would be a lookup
      // we would have to guess at.
      brand_wikidata: /^Q[0-9]+$/.test(tags['brand:wikidata'] ?? '') ? tags['brand:wikidata']! : null,
      source: 'openstreetmap',
    })
  }
  const truncated = pois.length > cap
  const value: PoiSearchResult = {
    pois: pois.slice(0, cap),
    source: 'openstreetmap',
    truncated,
    clamped,
  }
  // FIFO eviction: a Map preserves insertion order, so the first key is oldest.
  if (poiCache.size >= POI_CACHE_MAX) poiCache.delete(poiCache.keys().next().value!)
  poiCache.set(cacheKey, { at: Date.now(), value })
  return value
}

/**
 * One element's tags, for the place-details path. Fails soft (null) — the
 * details column treats missing tags as "no extra data", not as an error.
 */
export async function fetchOverpassDetails(
  osmType: 'node' | 'way' | 'relation',
  osmId: string,
  signal?: AbortSignal,
): Promise<OverpassElement | null> {
  // The id is the one thing written into the query, and the query is a
  // language. An OSM element id is a number and nothing else.
  if (!/^\d+$/.test(osmId)) return null
  const query = `[out:json][timeout:5];${osmType}(${osmId});out tags;`
  try {
    const elements = await overpassFetch(query, signal)
    return elements[0] ?? null
  } catch {
    return null
  }
}
