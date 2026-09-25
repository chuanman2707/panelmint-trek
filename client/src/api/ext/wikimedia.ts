/**
 * Place enrichment from the free sources — the browser port of the server's
 * `place-enrichment.service.ts`. The photo ladder, the description ladder and
 * the facts/hours/rating collectors are kept one-for-one; what changed is the
 * tail of the pipeline:
 *
 *  - No byte proxying. The server downloaded every candidate through its photo
 *    cache and handed out `/api/maps/place-photo/<key>/bytes` URLs so provider
 *    hosts never saw a user's IP and Google URLs could not expire. A client-only
 *    build has nowhere to put that cache — the `url` a candidate carries is the
 *    Commons `thumburl` itself, fetched by the `<img>` tag when it renders.
 *    Attribution fields are unchanged: author, licence and the file's
 *    description page travel with every candidate exactly as before.
 *  - No instance cache. The server's week-long `place_details_cache` row served
 *    every user of an install; the equivalent here is a module-level Map with
 *    the same TTL split (a week for an answer, ten minutes for none) that lives
 *    as long as the tab does. The "don't cache what came off the caller's own
 *    details" rule is kept even so — it costs nothing and keeps the semantics
 *    identical if a shared cache ever returns.
 *  - No Google rungs and no index description — there is no key and no TREK
 *    Places API to ask. The free ladder is the whole ladder: Wikidata claims →
 *    wiki lead image → Commons category → anything photographed nearby, the
 *    last gated by `nearbyWouldMislead` exactly as before.
 *
 * The pieces that make a picture trustworthy (page-id dedup, burst-series
 * collapse, the author cap, the not-a-photo rejections) live in
 * `rankCommonsCandidates` in `./geoHelpers.ts`.
 */

import {
  mapsPlaceEnrichmentResultSchema,
  placeWebsiteSchema,
  type MapsPlaceEnrichmentRequest,
  type MapsPlaceEnrichmentResult,
  type PlaceDescription,
  type PlaceFact,
  type PlaceHours,
  type PlacePhotoCandidate,
  type PlaceRating,
} from '@trek/shared'
import {
  buildOsmDetails,
  claimValue,
  normalizeCategoryName,
  normalizeFileTitle,
  parseWikipediaTag,
  rankCommonsCandidates,
  readBrandIdentity,
  readWikiIdentity,
  stripWikiMarkup,
  toWikiLang,
  wikidataImageClaims,
  type WikidataClaims,
  type WikiIdentity,
} from './geoHelpers'
import { details as fetchPlaceDetails, resolveOsmIdentity } from './places'

const WIKI_TIMEOUT_MS = 6000
const IDENTITY_TIMEOUT_MS = 2500
const COMMONS_CAP = 5

/** The cache keeps its TTL split even in memory: a bad provider minute is not a week-long blank. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const EMPTY_CACHE_TTL_MS = 10 * 60 * 1000
const enrichCache = new Map<string, { at: number; value: CachedEnrichment }>()

/**
 * Credit lines, keyed by candidate key. The proxy URL carried the credit lookup
 * on the server; here the strip already shows author and licence, and this map
 * is what the `placePhotoCredit` facade answers from for a `key` that outlives
 * the strip (a picked `image_url` no longer encodes the key, so misses are
 * common and benign).
 */
const creditByKey = new Map<string, string>()
const CREDIT_MAP_MAX = 400

export interface CommonsCandidate {
  photoUrl: string
  attribution: string | null
  license: string | null
  licenseUrl: string | null
  sourceUrl: string | null
  pageId: number | null
  title: string | null
  width: number | null
  height: number | null
  descriptors: string | null
}

interface WikiCommonsPage {
  pageid?: number
  title?: string
  imageinfo?: {
    url?: string
    thumburl?: string
    descriptionurl?: string
    mime?: string
    width?: number
    height?: number
    extmetadata?: Record<string, { value?: string }>
  }[]
}

/** What the free sources need to know about a place. */
interface PlaceIdentity extends WikiIdentity {
  osmTags: Record<string, string> | null
  /** The chain this place belongs to — a description may fall back to it; the picture ladder never reads it. */
  brand: { wikidata: string | null; wikipedia: string | null }
}

type CommonsPick = CommonsCandidate & { rung: 'wikidata' | 'wikipedia' | 'category' | 'nearby' }

interface CachedEnrichment {
  photos: PlacePhotoCandidate[]
  description: PlaceDescription | null
  facts: PlaceFact[]
  hours: PlaceHours | null
  rating: PlaceRating | null
}

function hasAnything(value: CachedEnrichment): boolean {
  return !!(value.photos.length || value.description || value.facts.length || value.hours || value.rating)
}

function push(pool: CommonsPick[], candidates: CommonsCandidate[], rung: CommonsPick['rung']): void {
  for (const candidate of candidates) pool.push({ ...candidate, rung })
}

/**
 * The credit line stored for a candidate — author and licence in one string,
 * the only record of who made a picture once the dialog is gone.
 */
export function creditLine(attribution: string | null, license: string | null): string | null {
  if (attribution && license) return `${attribution} · ${license}`
  return attribution || license || null
}

/** What `mapsApi.placePhotoCredit(key)` answers with. */
export function photoCredit(key: string): { credit: string | null } {
  return { credit: creditByKey.get(key) ?? null }
}

/**
 * Cache key for one candidate picture — keyed by which picture it is, not by
 * where it sat in the strip. The ladder returns different counts depending on
 * which providers answered, so a positional key would credit the wrong person.
 * FNV-1a rather than the server's sha1: `crypto.subtle` is async and this key
 * is computed synchronously mid-render; 32 bits is plenty for ≤5 candidates.
 */
export function candidateKey(placeId: string, identity: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < identity.length; i++) {
    h ^= identity.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${placeId}~p${(h >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * Categories where a picture taken nearby is almost certainly of something
 * else, so the bottom rung of the ladder is skipped for them entirely.
 *
 * Measured across 600 places in six cities: 2 percent of ordinary businesses
 * have a picture on Wikimedia, against 70 percent of churches. So for a cafe
 * the curated rungs practically never fire and the fallback practically always
 * does, which is how the town hall ends up over the doner shop. A missing
 * picture is honest; a confident picture of the building opposite is not.
 */
const NEARBY_MISLEADS = [
  'restaurant', 'cafe', 'coffee', 'bar', 'pub', 'bakery', 'fast_food', 'food',
  'eatery', 'biergarten', 'ice_cream', 'shop', 'store', 'supermarket', 'retail',
  'pharmacy', 'hairdresser', 'kiosk', 'convenience', 'butcher', 'greengrocer',
  'clothing', 'florist', 'bank', 'atm', 'nightclub',
]

/**
 * True when a nearby picture would more likely mislead than inform. Fails OPEN
 * on an unknown category: silently dropping pictures for everything unlabelled
 * would take them away from the places where the fallback actually works.
 */
export function nearbyWouldMislead(details: Record<string, unknown> | null): boolean {
  if (!details) return false
  const haystack = [
    details.category, details.category_path, details.amenity, details.shop, details.cuisine,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
  if (!haystack) return false
  return NEARBY_MISLEADS.some((word) => haystack.includes(word))
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
function toCommonsCandidates(
  pages: Record<string, WikiCommonsPage> | undefined,
  limit: number,
): CommonsCandidate[] {
  if (!pages) return []
  const out: CommonsCandidate[] = []
  // entries(), not values(): the map key is the page id, and for the queries
  // that reach a file by title it is the only place the id appears.
  for (const [key, page] of Object.entries(pages)) {
    const info = page.imageinfo?.[0]
    // Only use actual photos (JPEG/PNG), skip SVGs and PDFs.
    const mime = info?.mime || ''
    if (!info?.url || !(mime.startsWith('image/jpeg') || mime.startsWith('image/png'))) continue
    const meta = info.extmetadata
    const pageId = page.pageid ?? (Number.isInteger(Number(key)) ? Number(key) : null)
    out.push({
      // iiurlwidth=400 makes Commons also return a scaled thumburl. Prefer it —
      // info.url is the full-resolution original (multi-megapixel exports).
      photoUrl: info.thumburl ?? info.url,
      attribution: stripWikiMarkup(meta?.Artist?.value),
      license: stripWikiMarkup(meta?.LicenseShortName?.value) ?? stripWikiMarkup(meta?.UsageTerms?.value),
      licenseUrl: meta?.LicenseUrl?.value?.trim() || null,
      sourceUrl: info.descriptionurl || null,
      pageId: pageId && pageId > 0 ? pageId : null,
      title: page.title ?? null,
      width: info.width ?? null,
      height: info.height ?? null,
      descriptors:
        [
          stripWikiMarkup(meta?.ObjectName?.value),
          stripWikiMarkup(meta?.ImageDescription?.value),
          stripWikiMarkup(meta?.Categories?.value),
        ]
          .filter(Boolean)
          .join(' | ') || null,
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Anything photographed near a coordinate — the bottom rung of the picture
 * ladder, and the only one with no claim on the subject at all. 60 metres is
 * roughly "the same building and its neighbours"; the 300 it used to be is a
 * whole city block, which is how the wrong answer came back confident.
 */
export async function fetchCommonsCandidates(
  lat: number,
  lng: number,
  limit = 5,
  signal?: AbortSignal,
): Promise<CommonsCandidate[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'geosearch',
    ggsprimary: 'all',
    ggsnamespace: '6',
    ggsradius: '60',
    ggscoord: `${lat}|${lng}`,
    // Deliberately more than the caller asked for: the ranker needs a pool to
    // reject from, and geosearch charges the same for one result as for twenty.
    ggslimit: String(Math.max(1, Math.min(Math.max(limit * 4, 8), 20))),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime|size',
    iiurlwidth: '400',
  })
  const data = (await wikiFetch(
    `https://commons.wikimedia.org/w/api.php?${params}`,
    signal ?? AbortSignal.timeout(WIKI_TIMEOUT_MS),
  )) as { query?: { pages?: Record<string, WikiCommonsPage> } } | null
  return toCommonsCandidates(data?.query?.pages, Number(params.get('ggslimit')))
}

/** Commons images from a category — the set of pictures OF a place. */
export async function fetchCommonsCategoryCandidates(
  category: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<CommonsCandidate[]> {
  const name = normalizeCategoryName(category)
  if (!name) return []
  // Overfetch: the ranker throws away survey imagery, diagrams and repeats, and
  // it can only do that from a pool bigger than the strip.
  const poolSize = String(Math.max(1, Math.min(limit * 3, 20)))

  // `generator=search` first. `categorymembers` orders alphabetically by file
  // name, which is not a quality signal in any direction: "Category:Brandenburg
  // Gate" opens with an .ogg pronunciation, a marathon photo and six
  // near-identical press shots.
  const search = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `incategory:"${name}" filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: poolSize,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime|size',
    iiurlwidth: '400',
  })
  const members = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'categorymembers',
    gcmtitle: `Category:${name}`,
    gcmtype: 'file',
    gcmlimit: poolSize,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime|size',
    iiurlwidth: '400',
  })

  for (const params of [search, members]) {
    const data = (await wikiFetch(
      `https://commons.wikimedia.org/w/api.php?${params}`,
      signal ?? AbortSignal.timeout(WIKI_TIMEOUT_MS),
    )) as { query?: { pages?: Record<string, WikiCommonsPage> } } | null
    const hits = toCommonsCandidates(data?.query?.pages, Number(poolSize))
    if (hits.length) return hits
  }
  return []
}

/**
 * Metadata for a list of Commons files, in one request. `redirects=1` matters
 * more than it looks: a claim often names a file that has since been renamed,
 * and without it the API answers with a `missing` page and the picture
 * disappears silently.
 */
export async function fetchCommonsFilesByName(
  fileNames: string[],
  signal?: AbortSignal,
): Promise<Map<string, CommonsCandidate>> {
  const out = new Map<string, CommonsCandidate>()
  const titles = fileNames.map((name) => (/^File:/i.test(name) ? name : `File:${name}`))
  if (!titles.length) return out

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: titles.join('|'),
    redirects: '1',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime|size',
    iiurlwidth: '400',
  })
  const data = (await wikiFetch(
    `https://commons.wikimedia.org/w/api.php?${params}`,
    signal ?? AbortSignal.timeout(WIKI_TIMEOUT_MS),
  )) as
    | {
        query?: {
          pages?: Record<string, WikiCommonsPage>
          normalized?: { from: string; to: string }[]
          redirects?: { from: string; to: string }[]
        }
      }
    | null
  if (!data) return out

  // The API renames titles twice on the way in (normalisation, then redirects),
  // so walk the chain back to what the caller asked for.
  const aliases = new Map<string, string>()
  for (const hop of [...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])]) {
    aliases.set(normalizeFileTitle(hop.to), normalizeFileTitle(hop.from))
  }
  const resolveOriginal = (title: string): string => {
    let key = normalizeFileTitle(title)
    for (let hop = 0; hop < 4; hop++) {
      const previous = aliases.get(key)
      if (!previous || previous === key) break
      key = previous
    }
    return key
  }

  for (const candidate of toCommonsCandidates(data.query?.pages, titles.length)) {
    if (!candidate.title) continue
    out.set(resolveOriginal(candidate.title), candidate)
    out.set(normalizeFileTitle(candidate.title), candidate)
  }
  return out
}

/** The pictures Wikidata records for a place, best first. */
export async function fetchWikidataCandidates(
  wikidataId: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<{ candidates: CommonsCandidate[]; commonsCategory: string | null }> {
  const empty = { candidates: [] as CommonsCandidate[], commonsCategory: null }
  const qid = wikidataId.trim()
  if (!/^Q\d+$/.test(qid)) return empty
  const data = (await wikiFetch(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&ids=${qid}&format=json`,
    signal ?? AbortSignal.timeout(WIKI_TIMEOUT_MS),
  )) as { entities?: Record<string, { claims?: WikidataClaims }> } | null
  const claims = data?.entities?.[qid]?.claims
  if (!claims) return empty

  const fileNames = wikidataImageClaims(claims, limit)
  const commonsCategory = claimValue(claims.P373) ?? null
  if (!fileNames.length) return { candidates: [], commonsCategory }

  const byTitle = await fetchCommonsFilesByName(fileNames, signal)
  // Back into the order Wikidata implied, which the batch response loses.
  const candidates = fileNames
    .map((name) => byTitle.get(normalizeFileTitle(name)))
    .filter((c): c is CommonsCandidate => !!c)
  return { candidates, commonsCategory }
}

/**
 * The lead image a wiki article picked for a place. Only the file NAME is taken
 * from here; the bytes and the licence come from the same Commons batch as
 * everything else — the thumbnail URL the API offers alongside carries no
 * attribution, and a picture we cannot credit is a picture we cannot show.
 */
export async function fetchWikiLeadImageName(
  wikipediaTag: string | null | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const parsed = parseWikipediaTag(wikipediaTag)
  if (!parsed) return null
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    titles: parsed.title,
    prop: 'pageimages',
    piprop: 'name',
    redirects: '1',
  })
  for (const host of ['wikivoyage', 'wikipedia'] as const) {
    const data = (await wikiFetch(
      `https://${parsed.lang}.${host}.org/w/api.php?${params}`,
      signal ?? AbortSignal.timeout(WIKI_TIMEOUT_MS),
    )) as { query?: { pages?: Record<string, { pageimage?: string }> } } | null
    for (const page of Object.values(data?.query?.pages ?? {})) {
      if (page.pageimage) return page.pageimage
    }
  }
  return null
}

/** Which articles a Wikidata item is linked to, for the wikis we care about. */
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
  if (carried.wikipedia || carried.wikidata || carried.wikimedia_commons) return carried

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

// ── Photos ───────────────────────────────────────────────────────────────────

async function collectPhotos(
  placeId: string,
  req: MapsPlaceEnrichmentRequest,
  identity: PlaceIdentity,
  details: Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<PlacePhotoCandidate[]> {
  const { wikidata, wikipedia } = identity

  // The free ladder, in order of how much anyone vouched that the picture shows
  // THIS place:
  //   Wikidata  — a person attached this file to this exact object.
  //   Wiki lead — the article about it opens with this picture.
  //   Category  — the set of pictures of it.
  //   Nearby    — anything photographed within 60m.
  // Only the last one has no claim on the subject at all, which is how an
  // airport ended up represented by aerial survey tiles of its runway.
  const commonsPool: CommonsPick[] = []
  let categoryName = identity.wikimedia_commons

  if (wikidata) {
    const fromWikidata = await fetchWikidataCandidates(wikidata, COMMONS_CAP, signal)
    push(commonsPool, fromWikidata.candidates, 'wikidata')
    categoryName ??= fromWikidata.commonsCategory
  }

  if (commonsPool.length < COMMONS_CAP && wikipedia) {
    const leadName = await fetchWikiLeadImageName(wikipedia, signal)
    if (leadName) {
      const byName = await fetchCommonsFilesByName([leadName], signal)
      push(commonsPool, [...byName.values()], 'wikipedia')
    }
  }

  if (commonsPool.length < COMMONS_CAP && categoryName) {
    push(commonsPool, await fetchCommonsCategoryCandidates(categoryName, COMMONS_CAP, signal), 'category')
  }

  // Two is the bar: one curated picture plus the nearby noise reads worse than
  // one curated picture on its own. The nearby fetch starts early because it is
  // free and unmetered — discarded results cost nothing — and it is skipped
  // outright for the categories where it misleads.
  const curated = commonsPool.length
  const skipNearby = nearbyWouldMislead(details) || nearbyWouldMislead(identity.osmTags)
  const nearbyPending =
    curated < 2 && !skipNearby
      ? fetchCommonsCandidates(req.lat, req.lng, COMMONS_CAP, signal)
      : Promise.resolve([] as CommonsCandidate[])

  if (curated < 2) push(commonsPool, await nearbyPending, 'nearby')

  // One ranking pass over everything: the same file reaches us from several
  // rungs and only the page id catches that.
  const ranked = rankCommonsCandidates(commonsPool, COMMONS_CAP, { perAuthor: curated > 0 ? 2 : 1 })

  return ranked.map((pick) => {
    const identityKey = `commons:${pick.pageId ?? pick.photoUrl}`
    const key = candidateKey(placeId, identityKey)
    const credit = creditLine(pick.attribution, pick.license)
    if (credit) {
      if (creditByKey.size >= CREDIT_MAP_MAX) creditByKey.delete(creditByKey.keys().next().value!)
      creditByKey.set(key, credit)
    }
    return {
      key,
      // No proxy in a client-only build: the Commons thumb URL is shown as-is.
      url: pick.photoUrl,
      attribution: pick.attribution,
      license: pick.license,
      licenseUrl: pick.licenseUrl,
      sourceUrl: pick.sourceUrl,
      source: (pick.rung === 'wikipedia' ? 'wikipedia' : 'wikimedia') as 'wikipedia' | 'wikimedia',
    }
  })
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
 * Photos and a description for a place the user is looking at but has not saved
 * yet — the detail column next to the search field in the add-place dialog.
 * Signature matches `mapsApi.placeEnrichment`; the request is validated against
 * the shared schema before a single fetch goes out.
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
    if (Date.now() - cached.at < ttl) return mapsPlaceEnrichmentResultSchema.parse(cached.value)
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

  const [photos, description] = await Promise.all([
    collectPhotos(placeId, req, identity, details, signal),
    collectDescription(req, details, identity, signal),
  ])

  // The OSM record found while resolving the identity carries the same tags an
  // Overpass lookup would — cuisine, opening_hours, wheelchair.
  const osmDetails = identity.osmTags ? buildOsmDetails(identity.osmTags, '', '') : null

  const ownFacts = collectFacts(details)
  const result: CachedEnrichment = {
    photos,
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

  return mapsPlaceEnrichmentResultSchema.parse(result)
}
