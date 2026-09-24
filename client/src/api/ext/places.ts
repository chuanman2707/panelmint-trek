/**
 * Browser-side place search — the client-only port of the OpenStreetMap half
 * of the server's `maps.service.ts`. The keyed providers (Google, Amap) and
 * the TREK Places index are gone; what is left is Photon, Nominatim and a
 * purely local URL parser.
 *
 * What the port kept:
 *
 *  - Photon first, Nominatim behind it. Photon exists precisely for the
 *    keystroke path: it tolerates autocomplete-style traffic that Nominatim's
 *    usage policy names unacceptable in its own words. Search falls back to
 *    Nominatim when Photon errors or answers nothing.
 *  - The Nominatim throttle. The usage policy caps the public instance at one
 *    request per second per client; on the server that was one process-wide
 *    lane, here it is one module-wide chain per browser. `setGeoThrottleForTests`
 *    exists so the tests do not pay real seconds.
 *  - The OSM search-result shape (`osm_id` as "type:id", `readWikiIdentity`
 *    tags carried through), the `resolveOsmIdentity` two-gate match (distance
 *    + shared name word, Nominatim `importance` breaks the tie) and the
 *    details fan-out (Nominatim lookup + Overpass tags, Overpass wins on
 *    overlap but Nominatim alone still yields a record).
 *  - `resolveUrl` parses coordinates out of the pasted text and never fetches
 *    the URL. A browser cannot follow a goo.gl redirect anyway (CORS), and the
 *    SSRF guard the server ran here has no client-side equivalent — so the
 *    short-link path is gone, not weakened.
 *
 * All outbound payloads are normalised into the shared `maps*Result` contract
 * shapes (`z.record(z.unknown())` provider blobs — the schema stays open on
 * purpose) before they leave this module.
 */

import {
  mapsAutocompleteResultSchema,
  mapsPlaceDetailsResultSchema,
  mapsResolveUrlResultSchema,
  mapsReverseResultSchema,
  mapsSearchResultSchema,
  type MapsAutocompleteResult,
  type MapsPlaceDetailsResult,
  type MapsResolveUrlResult,
  type MapsReverseResult,
  type MapsSearchResult,
} from '@trek/shared'
import { gcj02ToWgs84, fromAmapLocation } from '@trek/shared'
import {
  buildOsmDetails,
  googleFtidFromMapsUrl,
  haversineMetres,
  isOsmPlaceId,
  namesOverlap,
  readWikiIdentity,
  toApiLang,
} from './geoHelpers'
import { fetchOverpassDetails } from './overpass'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const PHOTON = 'https://photon.komoot.io/api/'

const SEARCH_TIMEOUT_MS = 6000
const IDENTITY_TIMEOUT_MS = 2500

// ── Nominatim fetch, throttled ───────────────────────────────────────────────
//
// The public Nominatim instance allows one request per second per client. On
// the server this was one process-wide lane; the browser equivalent is a
// module-level chain — every tab is its own client, and a page that issues
// three lookups in a burst still owes the service its gaps.
let nominatimGapMs = 1100
let nominatimChain: Promise<unknown> = Promise.resolve()
let lastNominatimAt = 0

/** Test seam — the suite cannot afford a real second per call. */
export function setGeoThrottleForTests(gapMs: number): void {
  nominatimGapMs = gapMs
}

function nominatimThrottle(): Promise<void> {
  const run = nominatimChain.then(async () => {
    const wait = nominatimGapMs - (Date.now() - lastNominatimAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastNominatimAt = Date.now()
  })
  nominatimChain = run.catch(() => {})
  return run
}

/**
 * One Nominatim request: throttled, timed, abortable. `Accept-Language` is the
 * header the policy asks for; a browser cannot set `User-Agent`, which is the
 * half of the identification the policy wants that fetch simply cannot give.
 */
async function nominatimFetch(
  endpoint: 'search' | 'reverse' | 'lookup',
  params: URLSearchParams,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    await nominatimThrottle()
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return await fetch(`${NOMINATIM}/${endpoint}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
  } finally {
    clearTimeout(timeout)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

// ── Result shapes ────────────────────────────────────────────────────────────

interface NominatimResult {
  osm_type?: 'node' | 'way' | 'relation' | string
  osm_id?: number | string
  lat?: string
  lon?: string
  name?: string
  display_name?: string
  importance?: number
  extratags?: Record<string, string>
  address?: Record<string, string>
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }
  properties?: {
    osm_type?: string
    osm_id?: number | string
    name?: string
    street?: string
    housenumber?: string
    postcode?: string
    city?: string
    district?: string
    county?: string
    state?: string
    country?: string
  }
}

/** The search-record fields every source fills the same way. */
function osmSearchRecord(item: {
  osmType: string
  osmId: string | number
  name: string
  address: string
  lat: number | null
  lng: number | null
  extratags?: Record<string, string> | null
}) {
  return {
    google_place_id: null,
    google_ftid: null,
    osm_id: `${item.osmType}:${item.osmId}`,
    name: item.name,
    address: item.address,
    // Number.isFinite, not `|| null`: a place on the equator or prime meridian
    // has a legitimate 0 coordinate.
    lat: item.lat,
    lng: item.lng,
    rating: null,
    website: null,
    phone: null,
    source: 'openstreetmap',
    ...readWikiIdentity(item.extratags),
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Photon first. It is a hosted OSM search built for exactly this — tolerant of
 * the short, half-typed queries that are abuse on Nominatim — and it answers
 * in OpenStreetMap vocabulary, so both paths return the same record shape.
 */
async function searchPhoton(
  query: string,
  lang?: string,
  bias?: { lat: number; lng: number },
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ q: query, limit: '8', lang: toApiLang(lang).split('-')[0] })
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
    params.set('lat', String(bias.lat))
    params.set('lon', String(bias.lng))
  }
  const res = await fetch(`${PHOTON}?${params.toString()}`, {
    signal: signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Photon error: ${res.status}`)
  const data = (await res.json()) as { features?: PhotonFeature[] }
  const out: Record<string, unknown>[] = []
  for (const feature of data.features ?? []) {
    const [lng, lat] = feature.geometry?.coordinates ?? []
    const props = feature.properties ?? {}
    if (props.osm_type == null || props.osm_id == null) continue
    const address = [
      props.name,
      [props.street, props.housenumber].filter(Boolean).join(' '),
      [props.postcode, props.city || props.district || props.county].filter(Boolean).join(' '),
      props.state,
      props.country,
    ]
      .filter(Boolean)
      .join(', ')
    out.push(
      osmSearchRecord({
        osmType: String(props.osm_type).toLowerCase() === 'r' ? 'relation' : String(props.osm_type).toLowerCase() === 'w' ? 'way' : 'node',
        osmId: props.osm_id,
        name: props.name || '',
        address,
        lat: typeof lat === 'number' && Number.isFinite(lat) ? lat : null,
        lng: typeof lng === 'number' && Number.isFinite(lng) ? lng : null,
      }),
    )
  }
  return out
}

/**
 * The Nominatim half of search — also the building block `resolveOsmIdentity`
 * and `autocomplete` reuse.
 *
 * `viewbox`/`bounded=0`: prefer the area the caller is looking at, never
 * restrict to it. Without it, "Hase-dera" returns the temple in Nara rather
 * than the one in Kamakura the user is standing next to; with bounded=1 a
 * search for somewhere genuinely far away returns nothing.
 */
async function searchNominatim(
  query: string,
  lang?: string,
  bias?: { lat: number; lng: number },
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    // Free, same request: this is where a place's wikidata/wikipedia/commons
    // tags live. Without them the enrichment column can only fall back to
    // "photos taken within 300m".
    extratags: '1',
    limit: '10',
    'accept-language': toApiLang(lang),
  })
  if (bias) {
    const d = 0.5
    params.set('viewbox', [bias.lng - d, bias.lat - d, bias.lng + d, bias.lat + d].join(','))
    params.set('bounded', '0')
  }
  const res = await nominatimFetch('search', params, { signal })
  if (!res.ok) throw new Error(`Nominatim error: ${res.status}`)
  const data = (await res.json()) as NominatimResult[]
  if (!Array.isArray(data)) throw new Error('Malformed Nominatim response')
  return data.map((item) => {
    const lat = Number.parseFloat(item.lat ?? '')
    const lng = Number.parseFloat(item.lon ?? '')
    return osmSearchRecord({
      osmType: item.osm_type ?? 'node',
      osmId: item.osm_id ?? '',
      name: item.name || item.display_name?.split(',')[0] || '',
      address: item.display_name || '',
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      extratags: item.extratags,
    })
  })
}

/**
 * mapsApi.search(query, lang, locationBias?) → `{ places, source }`.
 *
 * `locationBias` keeps the axios signature's `{ lat, lng, radius? }` shape;
 * radius was never read server-side either.
 */
export async function search(
  query: string,
  lang?: string,
  locationBias?: { lat: number; lng: number; radius?: number },
  signal?: AbortSignal,
): Promise<MapsSearchResult> {
  const trimmed = (query || '').trim()
  if (!trimmed) return mapsSearchResultSchema.parse({ places: [], source: 'openstreetmap' })
  try {
    const places = await searchPhoton(trimmed, lang, locationBias ?? undefined, signal)
    if (places.length) return mapsSearchResultSchema.parse({ places, source: 'openstreetmap' })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    // Photon down or empty — Nominatim still answers, at its own pace.
  }
  try {
    const places = await searchNominatim(trimmed, lang, locationBias ?? undefined, signal)
    return mapsSearchResultSchema.parse({ places, source: 'openstreetmap' })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return mapsSearchResultSchema.parse({ places: [], source: 'openstreetmap' })
  }
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

/**
 * The keystroke path. Photon answers the OSM layer in the same suggestion shape
 * the old index did — `source` per row because a mixed list would mark half
 * the rows wrong — with Nominatim as the failure fallback. `sessionToken` was
 * a Google billing concept; accepted and ignored so the caller keeps compiling.
 */
export async function autocomplete(
  input: string,
  lang?: string,
  locationBias?: { low: { lat: number; lng: number }; high: { lat: number; lng: number } },
  sessionToken?: string,
  signal?: AbortSignal,
): Promise<MapsAutocompleteResult> {
  void sessionToken
  const trimmed = (input || '').trim()
  if (!trimmed) return mapsAutocompleteResultSchema.parse({ suggestions: [], source: 'openstreetmap' })

  const centre = locationBias
    ? { lat: (locationBias.low.lat + locationBias.high.lat) / 2, lng: (locationBias.low.lng + locationBias.high.lng) / 2 }
    : undefined

  try {
    const places = await searchPhoton(trimmed, lang, centre, signal)
    if (places.length) {
      const suggestions = places
        .filter((p) => typeof p.osm_id === 'string' && p.osm_id.includes(':'))
        .slice(0, 8)
        .map((p) => ({
          placeId: p.osm_id as string,
          mainText: (p.name as string) || '',
          secondaryText: (p.address as string | undefined)?.split(',').slice(1).join(',').trim() ?? '',
          source: 'openstreetmap',
          ...(typeof p.lat === 'number' ? { lat: p.lat } : {}),
          ...(typeof p.lng === 'number' ? { lng: p.lng } : {}),
        }))
      return mapsAutocompleteResultSchema.parse({ suggestions, source: 'openstreetmap' })
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    // fall through to Nominatim
  }

  // The fallback. Kept narrow (5 rows) because Nominatim was never meant for
  // autocomplete and only sees this path when Photon cannot answer.
  try {
    const places = await searchNominatim(trimmed, lang, centre, signal)
    const suggestions = places
      .filter((p) => typeof p.osm_id === 'string' && p.osm_id.split(':')[1])
      .slice(0, 5)
      .map((p) => {
        const parts = ((p.address as string) || '').split(',').map((s) => s.trim())
        return {
          placeId: p.osm_id as string,
          mainText: (p.name as string) || parts[0] || '',
          secondaryText: parts.slice(1).join(', '),
          ...(typeof p.lat === 'number' ? { lat: p.lat } : {}),
          ...(typeof p.lng === 'number' ? { lng: p.lng } : {}),
        }
      })
    return mapsAutocompleteResultSchema.parse({ suggestions, source: 'nominatim' })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return mapsAutocompleteResultSchema.parse({ suggestions: [], source: 'nominatim' })
  }
}

// ── Details ──────────────────────────────────────────────────────────────────

/**
 * Finds the OpenStreetMap record for a place we only know by name and
 * coordinate, and hands back its tags.
 *
 * Two gates keep it from describing the wrong building, because a confident
 * description of somewhere else is worse than none: the match has to be within
 * `maxDistanceM` of where we are looking, and it has to share a substantial
 * word with the name we are looking for. Among what survives, Nominatim's own
 * `importance` decides — that is what separates the Brandenburg Gate from the
 * underground station named after it.
 */
export async function resolveOsmIdentity(
  name: string,
  lat: number,
  lng: number,
  opts: { lang?: string; maxDistanceM?: number; signal?: AbortSignal } = {},
): Promise<{ tags: Record<string, string>; osmUrl: string | null; matchedName: string } | null> {
  const query = (name || '').trim()
  if (!query || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const maxDistanceM = opts.maxDistanceM ?? 2000

  // ~2km box around the point, so Nominatim ranks locally instead of handing
  // back the most famous place on earth with this name.
  const d = 0.02
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    extratags: '1',
    limit: '5',
    bounded: '1',
    viewbox: `${lng - d},${lat - d},${lng + d},${lat + d}`,
    'accept-language': toApiLang(opts.lang),
  })

  try {
    const res = await nominatimFetch('search', params, {
      signal: opts.signal,
      timeoutMs: IDENTITY_TIMEOUT_MS,
    })
    if (!res.ok) return null
    const data = (await res.json()) as NominatimResult[]
    if (!Array.isArray(data)) return null

    const best = data
      .map((item) => ({ item, lat: Number.parseFloat(item.lat ?? ''), lng: Number.parseFloat(item.lon ?? '') }))
      .filter(({ item, lat: hitLat, lng: hitLng }) => {
        if (!Number.isFinite(hitLat) || !Number.isFinite(hitLng)) return false
        if (haversineMetres(lat, lng, hitLat, hitLng) > maxDistanceM) return false
        const label = item.name || item.display_name?.split(',')[0] || ''
        return namesOverlap(query, label)
      })
      .sort((a, b) => {
        const byImportance = (b.item.importance ?? 0) - (a.item.importance ?? 0)
        if (byImportance !== 0) return byImportance
        return haversineMetres(lat, lng, a.lat, a.lng) - haversineMetres(lat, lng, b.lat, b.lng)
      })[0]

    if (!best) return null
    return {
      tags: best.item.extratags ?? {},
      osmUrl:
        best.item.osm_type && best.item.osm_id
          ? `https://www.openstreetmap.org/${best.item.osm_type}/${best.item.osm_id}`
          : null,
      matchedName: best.item.name || best.item.display_name?.split(',')[0] || query,
    }
  } catch {
    return null
  }
}

async function lookupNominatim(
  osmType: string,
  osmId: string,
  lang?: string,
  signal?: AbortSignal,
): Promise<{
  name: string
  address: string
  lat: number | null
  lng: number | null
  extratags: Record<string, string> | null
} | null> {
  const typePrefix = osmType.charAt(0).toUpperCase() // N, W, R
  const params = new URLSearchParams({
    osm_ids: `${typePrefix}${osmId}`,
    format: 'json',
    // Overpass is the richer source but it is also the one that times out;
    // whatever Nominatim already knows costs nothing extra here.
    extratags: '1',
    'accept-language': toApiLang(lang),
  })
  try {
    const res = await nominatimFetch('lookup', params, { signal })
    if (!res.ok) return null
    const data = (await res.json()) as NominatimResult[]
    const item = data[0]
    if (!item) return null
    const lat = Number.parseFloat(item.lat ?? '')
    const lng = Number.parseFloat(item.lon ?? '')
    return {
      name: item.name || item.display_name?.split(',')[0] || '',
      address: item.display_name || '',
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      extratags: item.extratags ?? null,
    }
  } catch {
    return null
  }
}

/**
 * mapsApi.details(placeId, lang?, sessionToken?) → `{ place }`.
 *
 * Only `node|way|relation:<digits>` resolves — every other id form (a legacy
 * Google id, a `gers:` index id, a coordinate pseudo-id) has no free provider
 * behind it, and returning `{ place: null }` is the same miss the callers
 * already treat a keyless Google id as.
 */
export async function details(
  placeId: string,
  lang?: string,
  sessionToken?: string,
  signal?: AbortSignal,
): Promise<MapsPlaceDetailsResult> {
  void sessionToken
  if (!isOsmPlaceId(placeId)) return mapsPlaceDetailsResultSchema.parse({ place: null })
  const [osmType, osmId] = placeId.split(':') as [string, string]

  // buildOsmDetails never yields name/address/coordinates — Nominatim is always
  // the source for those (Overpass contributes the tag-derived rest). Overpass
  // has the fuller tag set and wins where both answer, but it is also the one
  // that goes down; Nominatim's extratags carry the wiki tags too, so a place
  // keeps its pictures and its description when Overpass times out.
  const [element, nominatim] = await Promise.all([
    fetchOverpassDetails(osmType as 'node' | 'way' | 'relation', osmId, signal),
    lookupNominatim(osmType, osmId, lang, signal),
  ])
  if (!element && !nominatim) return mapsPlaceDetailsResultSchema.parse({ place: null })

  const record = {
    ...buildOsmDetails({ ...(nominatim?.extratags ?? {}), ...(element?.tags ?? {}) }, osmType, osmId),
    name: nominatim?.name || element?.tags?.name || '',
    address: nominatim?.address || '',
    lat: nominatim?.lat ?? null,
    lng: nominatim?.lng ?? null,
    osm_id: placeId,
  }
  return mapsPlaceDetailsResultSchema.parse({ place: record })
}

// ── Reverse geocode ──────────────────────────────────────────────────────────

/** mapsApi.reverse(lat, lng, lang?) → `{ name, address }`. */
export async function reverse(
  lat: number | string,
  lng: number | string,
  lang?: string,
  opts: { locality?: boolean; signal?: AbortSignal } = {},
): Promise<MapsReverseResult> {
  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      format: 'json',
      addressdetails: '1',
      zoom: opts.locality ? '10' : '18',
      'accept-language': toApiLang(lang),
    })
    const res = await nominatimFetch('reverse', params, { signal: opts.signal })
    if (!res.ok) return mapsReverseResultSchema.parse({ name: null, address: null })
    const data = (await res.json()) as NominatimResult
    const addr = data.address || {}
    const name = opts.locality
      ? addr.city || addr.town || addr.village || addr.municipality || data.name || null
      : data.name || addr.tourism || addr.amenity || addr.shop || addr.building || addr.road || null
    return mapsReverseResultSchema.parse({ name, address: data.display_name || null })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return mapsReverseResultSchema.parse({ name: null, address: null })
  }
}

// ── resolveUrl ───────────────────────────────────────────────────────────────

/**
 * Amap's own hosts, including the short-link one. Matched by exact suffix
 * rather than by shape: unlike Google, Amap has no ccTLD family, so a pattern
 * would only widen what counts as trusted.
 */
const AMAP_HOSTS = new Set([
  'amap.com', 'www.amap.com', 'uri.amap.com', 'wb.amap.com', 'surl.amap.com',
  'gaode.com', 'www.gaode.com',
])

/**
 * Google Maps encodes coordinates several ways: `/@lat,lng,zoom`,
 * `!3dlat!4dlng` in the map-data param, `?q=`/`?ll=`.
 */
function extractCoords(s: string): { lat: number; lng: number } | null {
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s)
  if (at) return { lat: Number.parseFloat(at[1]), lng: Number.parseFloat(at[2]) }
  const data = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(s)
  if (data) return { lat: Number.parseFloat(data[1]), lng: Number.parseFloat(data[2]) }
  const q = /[?&](?:q|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s)
  if (q) return { lat: Number.parseFloat(q[1]), lng: Number.parseFloat(q[2]) }
  return null
}

function urlError(): Error & { status: number } {
  return Object.assign(new Error('Could not extract coordinates from URL'), { status: 400 })
}

/**
 * Coordinates and a name out of a shared Amap link — the server original's
 * ordering kept, because the Amap `lng,lat` spelling inside the Google
 * patterns would put a Shanghai restaurant in the East China Sea. Returned
 * coordinates are WGS-84; the link carries GCJ-02.
 */
function parseAmapUrl(rawUrl: string): { lat: number; lng: number; name: string | null } | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (!AMAP_HOSTS.has(parsed.hostname.toLowerCase())) return null

  const name = parsed.searchParams.get('name')?.trim() || null
  // `position=lng,lat` (uri.amap.com) and `p=…,lng,lat,…` (the web viewport)
  // both spell longitude first, like every other Amap coordinate.
  const position = parsed.searchParams.get('position') || parsed.searchParams.get('location')
  const fromPosition = position ? fromAmapLocation(position) : null
  if (fromPosition) return { ...fromPosition, name }

  const anywhere = /(\d{2,3}\.\d+),(\d{1,2}\.\d+)/.exec(`${parsed.search}${parsed.hash}`)
  if (anywhere) {
    const converted = gcj02ToWgs84(Number.parseFloat(anywhere[2]), Number.parseFloat(anywhere[1]))
    return { ...converted, name }
  }
  return null
}

/**
 * mapsApi.resolveUrl(url) — parse a pasted map link into coordinates.
 *
 * Deliberately network-free: the server followed short-link redirects and read
 * Google page bodies through its SSRF guard; a browser can do neither (CORS on
 * the follow, and the rule for this port is that a pasted URL is never
 * fetched). What survives is everything the URL text itself says: the `@`,
 * `!3d/!4d` and `?q=` coordinate spellings, the `/place/<name>` slug, the
 * `!1s<ftid>` feature id, and Amap's GCJ-02 forms. Anything else — a short
 * link, a cid page — is the same 400 the server gave when it found nothing.
 */
export async function resolveUrl(url: string): Promise<MapsResolveUrlResult> {
  // Parse once up front so garbage that happens to carry a `!3d…!4d…` fragment
  // is still a 400, the way the server answered a URL it could not resolve.
  try {
    new URL(url)
  } catch {
    throw urlError()
  }

  // Amap links first, and on their own — see parseAmapUrl's comment.
  const amap = parseAmapUrl(url)
  if (amap) {
    if (!Number.isFinite(amap.lat) || !Number.isFinite(amap.lng)) throw urlError()
    const rev = await reverse(amap.lat, amap.lng).catch(() => ({ name: null, address: null }))
    return mapsResolveUrlResultSchema.parse({
      lat: amap.lat,
      lng: amap.lng,
      name: amap.name || rev.name,
      address: rev.address,
      google_ftid: null,
    })
  }

  const coords = extractCoords(url)
  // A short link's coordinates live behind a redirect we refuse to follow; any
  // URL text that does carry one of the coordinate spellings resolves, the way
  // it did server-side.
  if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) throw urlError()

  // Place name from the path: /place/Place+Name/@...
  let placeName: string | null = null
  const placeMatch = /\/place\/([^/@]+)/.exec(url)
  if (placeMatch) placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '))

  // A non-ok reverse answer must not fail the resolution — the coordinates are
  // already extracted, so fall back to the URL-derived name and a null address.
  const rev = await reverse(coords.lat, coords.lng).catch(() => ({ name: null, address: null }))

  return mapsResolveUrlResultSchema.parse({
    lat: coords.lat,
    lng: coords.lng,
    name: placeName || rev.name,
    address: rev.address,
    google_ftid: googleFtidFromMapsUrl(url),
  })
}
