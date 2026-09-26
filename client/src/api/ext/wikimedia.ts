/**
 * Place enrichment from the free sources — a description, facts, hours and a
 * rating for a place the user is looking at. The photo ladder is gone
 * one-for-one with the photo UI: there is no byte proxy and nowhere to show
 * candidates, so `photos` is answered empty rather than fetched.
 *
 *  - No instance cache. The server's week-long `place_details_cache` row served
 *    every user of an install; the equivalent here is a module-level Map with
 *    the same TTL split (a week for an answer, ten minutes for none) that lives
 *    as long as the tab does. The "don't cache what came off the caller's own
 *    details" rule is kept even so — it costs nothing and keeps the semantics
 *    identical if a shared cache ever returns.
 *  - No index description — there is no TREK Places API to ask. Wikivoyage and
 *    Wikipedia extracts, then the brand's article for a chain, are the whole
 *    description ladder.
 */

import {
  mapsPlaceEnrichmentResultSchema,
  placeWebsiteSchema,
  type MapsPlaceEnrichmentRequest,
  type MapsPlaceEnrichmentResult,
  type PlaceDescription,
  type PlaceFact,
  type PlaceHours,
  type PlaceRating,
} from '@trek/shared'
import {
  buildOsmDetails,
  parseWikipediaTag,
  readBrandIdentity,
  readWikiIdentity,
  toWikiLang,
  type WikiIdentity,
} from './geoHelpers'
import { details as fetchPlaceDetails, resolveOsmIdentity } from './places'

const WIKI_TIMEOUT_MS = 6000
const IDENTITY_TIMEOUT_MS = 2500
/** The cache keeps its TTL split even in memory: a bad provider minute is not a week-long blank. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const EMPTY_CACHE_TTL_MS = 10 * 60 * 1000
const enrichCache = new Map<string, { at: number; value: CachedEnrichment }>()

/** What the free sources need to know about a place. */
interface PlaceIdentity extends WikiIdentity {
  osmTags: Record<string, string> | null
  /** The chain this place belongs to — a description may fall back to it. */
  brand: { wikidata: string | null; wikipedia: string | null }
}

interface CachedEnrichment {
  description: PlaceDescription | null
  facts: PlaceFact[]
  hours: PlaceHours | null
  rating: PlaceRating | null
}

function hasAnything(value: CachedEnrichment): boolean {
  return !!(value.description || value.facts.length || value.hours || value.rating)
}

/** OSM yes/no tags; anything else (limited, only, designated) is shown verbatim. */
function yesNo(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
}

/**
 * Turns the place's OpenStreetMap tags into the short facts the column shows.
 * Only positive facts are listed — "no outdoor seating" is noise, and a missing
 * tag and a deliberate `no` are indistinguishable to a reader either way.
 */
export function collectFacts(details: Record<string, unknown> | null): PlaceFact[] {
  if (!details) return []
  const facts: PlaceFact[] = []
  const pushFact = (kind: PlaceFact['kind'], value: string | null, url: string | null = null) =>
    facts.push({ kind, value, url })

  // Everything below is OpenStreetMap tagging and has no other-source
  // equivalent; a record that isn't OSM contributes nothing here.
  if (details.source !== 'openstreetmap') return facts

  const cuisine = typeof details.cuisine === 'string' ? details.cuisine : null
  // OSM writes several cuisines semicolon-separated and underscored.
  if (cuisine)
    pushFact('cuisine', cuisine.split(';').map((c) => c.replace(/_/g, ' ').trim()).filter(Boolean).join(', '))

  // `menu_url` is a community-editable tag that becomes an href on the client,
  // so it goes through the same allow-list as a place's website.
  const menu = typeof details.menu_url === 'string' ? details.menu_url.trim() : ''
  if (placeWebsiteSchema.safeParse(menu).success) pushFact('menu', null, menu)

  if (yesNo(details.outdoor_seating) === 'yes') pushFact('outdoorSeating', null)
  if (yesNo(details.takeaway) === 'yes') pushFact('takeaway', null)
  if (yesNo(details.delivery) === 'yes') pushFact('delivery', null)

  const wheelchair = yesNo(details.wheelchair)
  if (wheelchair === 'yes' || wheelchair === 'limited') pushFact('wheelchair', wheelchair)

  if (yesNo(details.diet_vegetarian) === 'yes' || yesNo(details.diet_vegetarian) === 'only') pushFact('vegetarian', null)
  if (yesNo(details.diet_vegan) === 'yes' || yesNo(details.diet_vegan) === 'only') pushFact('vegan', null)

  const internet = yesNo(details.internet_access)
  if (internet && internet !== 'no') pushFact('internetAccess', null)

  return facts
}

/**
 * The week's opening hours, both as the provider phrased them and as data.
 * `periods` is what "open now" is computed from in the place's own timezone;
 * `weekdayDescriptions` is display text and cannot be computed from.
 */
export function collectHours(details: Record<string, unknown> | null): PlaceHours | null {
  if (!details) return null
  const lines = Array.isArray(details.opening_hours) ? (details.opening_hours as string[]) : null
  if (!lines?.length) return null
  return {
    weekdayDescriptions: lines,
    periods: (details.opening_periods as PlaceHours['periods']) ?? null,
    specialDays: (details.opening_special_days as string[] | undefined) ?? null,
  }
}

/** Facts from the carried record, topped up from the resolved OSM tags. */
export function mergeFacts(primary: PlaceFact[], extra: PlaceFact[]): PlaceFact[] {
  const seen = new Set(primary.map((fact) => fact.kind))
  return [...primary, ...extra.filter((fact) => !seen.has(fact.kind))]
}

/** The provider's star rating, with its count when there is one. */
export function collectRating(details: Record<string, unknown> | null): PlaceRating | null {
  const value = typeof details?.rating === 'number' ? details.rating : null
  if (value == null) return null
  return { value, count: typeof details?.rating_count === 'number' ? details.rating_count : null }
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

async function wikiFetch(url: string, signal: AbortSignal): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Shared shaping for every Commons query (coordinate, category, Wikidata, batch). */
export async function fetchWikidataSitelinks(
  wikidataId: string,
  sites: string[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const qid = wikidataId.trim()
  if (!/^Q\d+$/.test(qid) || !sites.length) return {}
  const params = new URLSearchParams({
    action: 'wbgetentities',
    props: 'sitelinks',
    ids: qid,
    sitefilter: sites.join('|'),
    format: 'json',
  })
  const data = (await wikiFetch(
    `https://www.wikidata.org/w/api.php?${params}`,
    signal ?? AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
  )) as { entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }> } | null
  const out: Record<string, string> = {}
  for (const [site, link] of Object.entries(data?.entities?.[qid]?.sitelinks ?? {})) {
    if (link?.title) out[site] = link.title
  }
  return out
}

/** The lead paragraph of one named article on one named wiki. */
export async function fetchWikiExtractFor(
  host: 'wikivoyage' | 'wikipedia',
  lang: string,
  title: string,
  signal?: AbortSignal,
): Promise<{ text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null> {
  if (!lang || !title) return null
  // Two sentences, not three: this sits next to a form, and a fourth line of
  // prose pushes the pictures out of view.
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: title,
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    exsentences: '2',
    redirects: '1',
  })
  const data = (await wikiFetch(
    `https://${lang}.${host}.org/w/api.php?${params}`,
    signal ?? AbortSignal.timeout(WIKI_TIMEOUT_MS),
  )) as { query?: { pages?: Record<string, { title?: string; extract?: string }> } } | null
  if (!data) return null
  for (const page of Object.values(data.query?.pages ?? {})) {
    const text = page.extract?.trim()
    // A missing article comes back as a page with no extract, not a 404.
    if (!text) continue
    const resolved = page.title ?? title
    return {
      text,
      sourceUrl: `https://${lang}.${host}.org/wiki/${encodeURIComponent(resolved)}`,
      source: host,
    }
  }
  return null
}

/** Lead paragraph resolved from the OSM `wikipedia` tag, Wikivoyage first. */
async function fetchWikiExtract(
  wikipediaTag: string | null | undefined,
  signal?: AbortSignal,
): Promise<{ text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null> {
  const parsed = parseWikipediaTag(wikipediaTag)
  if (!parsed) return null
  for (const host of ['wikivoyage', 'wikipedia'] as const) {
    const hit = await fetchWikiExtractFor(host, parsed.lang, parsed.title, signal)
    if (hit) return hit
  }
  return null
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Which encyclopaedia entry, Wikidata item and Commons category describe this
 * place.
 *
 * (The Commons field is still read for completeness; nothing consumes it now
 * that the photo ladder is gone.)
 *
 * Kept beside the provider payload rather than merged into it: `collectFacts`
 * and the OSM branch of `collectDescription` both gate on `details.source`, so
 * OSM tags folded into another record would be carried around and never read —
 * or, worse, would make that place start claiming to be an OpenStreetMap one.
 *
 * The lookup only runs when the payload brought nothing.
 */
async function resolveIdentity(
  req: MapsPlaceEnrichmentRequest,
  details: Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<PlaceIdentity> {
  const fromPayload = (key: string): string | null =>
    typeof details?.[key] === 'string' && (details[key] as string).trim()
      ? (details[key] as string).trim()
      : null

  const carried: PlaceIdentity = {
    wikipedia: fromPayload('wikipedia'),
    wikidata: fromPayload('wikidata'),
    wikimedia_commons: fromPayload('wikimedia_commons'),
    osmTags: null,
    // The brand stays out of the three fields above: those say "this is the
    // article about this place", and a chain's is not.
    brand: { wikidata: fromPayload('brand:wikidata'), wikipedia: fromPayload('brand:wikipedia') },
  }
  if (carried.wikipedia || carried.wikidata) return carried

  const resolved = await resolveOsmIdentity(req.name, req.lat, req.lng, { lang: req.lang, signal })
  if (!resolved) return carried
  const brand = readBrandIdentity(resolved.tags)
  return {
    ...readWikiIdentity(resolved.tags),
    osmTags: resolved.tags,
    // OSM first, the carried one when OSM has no brand tag for this object.
    brand: brand.wikidata || brand.wikipedia ? brand : carried.brand,
  }
}

// ── Description ──────────────────────────────────────────────────────────────

/**
 * The article about this place, in the reader's language where one exists.
 *
 * Two ways in, and a place usually has only one of them: mappers tag either
 * `wikipedia` or `wikidata`, rarely both. The Wikidata route goes through
 * sitelinks, which is also what makes the language choice honest. Wikivoyage
 * before Wikipedia at every step: it describes a place for someone about to go
 * there, where Wikipedia opens with area in square kilometres.
 */
async function fetchWikiDescription(
  identity: PlaceIdentity,
  lang: string | undefined,
  signal?: AbortSignal,
): Promise<{ text: string; sourceUrl: string; source: 'wikivoyage' | 'wikipedia' } | null> {
  const userLang = toWikiLang(lang)
  const tag = parseWikipediaTag(identity.wikipedia)

  if (identity.wikidata) {
    // The tag's own language is in the list because the place named that
    // article specifically; it beats falling through to English.
    const wanted: { site: string; host: 'wikivoyage' | 'wikipedia'; lang: string }[] = [
      { site: `${userLang}wikivoyage`, host: 'wikivoyage', lang: userLang },
      { site: `${userLang}wiki`, host: 'wikipedia', lang: userLang },
      ...(tag && tag.lang !== userLang
        ? [{ site: `${tag.lang}wiki`, host: 'wikipedia' as const, lang: tag.lang }]
        : []),
      { site: 'enwikivoyage', host: 'wikivoyage', lang: 'en' },
      { site: 'enwiki', host: 'wikipedia', lang: 'en' },
    ]
    const sitelinks = await fetchWikidataSitelinks(identity.wikidata, wanted.map((w) => w.site), signal)
    for (const { site, host, lang: hostLang } of wanted) {
      const title = sitelinks[site]
      if (!title) continue
      const hit = await fetchWikiExtractFor(host, hostLang, title, signal)
      if (hit) return hit
    }
  }

  // No Wikidata id, or its sitelinks led nowhere: fall back to the tag, which
  // names an article directly.
  return identity.wikipedia ? fetchWikiExtract(identity.wikipedia, signal) : null
}

async function collectDescription(
  req: MapsPlaceEnrichmentRequest,
  details: Record<string, unknown> | null,
  identity: PlaceIdentity,
  signal?: AbortSignal,
): Promise<PlaceDescription | null> {
  // OpenStreetMap first: it costs nothing, it is already fetched, and a
  // description someone wrote into the map data beats a generated blurb.
  const osmSummary = typeof details?.summary === 'string' ? details.summary.trim() : ''
  if (osmSummary && details?.source === 'openstreetmap') {
    return {
      text: osmSummary,
      source: 'osm',
      sourceUrl: typeof details.osm_url === 'string' ? details.osm_url : null,
      license: 'ODbL 1.0',
    }
  }

  // Then the encyclopaedias — free sources are the whole of this build, not a
  // fallback behind a keyed provider.
  const extract = await fetchWikiDescription(identity, req.lang, signal)
  if (extract) {
    return { text: extract.text, source: extract.source, sourceUrl: extract.sourceUrl, license: 'CC BY-SA 4.0' }
  }

  // Last, and about something else: the chain this place belongs to. The
  // `aboutBrand` flag is what stops the column from mistaking a chain's article
  // for a description of this particular branch — the only reason this is
  // allowed to run at all. The pictures do NOT get the same treatment.
  const brand = await fetchWikiDescription(
    { ...identity, wikipedia: identity.brand.wikipedia, wikidata: identity.brand.wikidata },
    req.lang,
    signal,
  )
  if (brand) {
    return {
      text: brand.text,
      source: brand.source,
      sourceUrl: brand.sourceUrl,
      license: 'CC BY-SA 4.0',
      aboutBrand: true,
    }
  }

  return null
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * A description, facts, hours and a rating for a place the user is looking at
 * but has not saved yet — the detail column next to the search field in the
 * add-place dialog. Signature matches `mapsApi.placeEnrichment`; the request
 * is validated against the shared schema before a single fetch goes out.
 */
export async function enrich(
  req: MapsPlaceEnrichmentRequest,
  signal?: AbortSignal,
): Promise<MapsPlaceEnrichmentResult> {
  const placeId = req.placeId?.trim() || `coords:${req.lat}:${req.lng}`
  const lang = req.lang
  const cacheKey = `${placeId}|${lang ?? ''}`

  const cached = enrichCache.get(cacheKey)
  if (cached) {
    const ttl = hasAnything(cached.value) ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS
    if (Date.now() - cached.at < ttl) return mapsPlaceEnrichmentResultSchema.parse({ ...cached.value, photos: [] })
    enrichCache.delete(cacheKey)
  }

  // The dialog already fetched this when the user picked the result, so it
  // comes along with the request. Only fetched here when the caller held none —
  // the same lookup `details()` performs, and the same quiet miss on failure.
  let details = req.details ?? null
  if (!details && req.placeId) {
    details = await fetchPlaceDetails(req.placeId, lang, undefined, signal)
      .then((r) => r.place)
      .catch(() => null)
  }
  const identity = await resolveIdentity(req, details, signal)

  const description = await collectDescription(req, details, identity, signal)

  // The OSM record found while resolving the identity carries the same tags an
  // Overpass lookup would — cuisine, opening_hours, wheelchair.
  const osmDetails = identity.osmTags ? buildOsmDetails(identity.osmTags, '', '') : null

  const ownFacts = collectFacts(details)
  const result: CachedEnrichment = {
    description,
    facts: mergeFacts(ownFacts, collectFacts(osmDetails)),
    hours: collectHours(details) ?? collectHours(osmDetails),
    rating: collectRating(details) ?? collectRating(osmDetails),
  }

  // The same trust rule the server's cache applied: an OSM summary or a menu
  // link read off the caller's own `details` is the caller's word, fine to
  // answer with but not to keep — and there is nothing here worth keeping
  // between sessions anyway, so the in-memory cache takes the rest.
  const fromCaller =
    req.details != null &&
    (description?.source === 'osm' || ownFacts.some((fact) => fact.url != null))
  if (!fromCaller) enrichCache.set(cacheKey, { at: Date.now(), value: result })

  return mapsPlaceEnrichmentResultSchema.parse({ ...result, photos: [] })
}
