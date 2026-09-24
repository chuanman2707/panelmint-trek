/**
 * Pure geo/maps helpers shared by the `api/ext/*` clients — the browser port of
 * `server/src/nest/maps/maps.helpers.ts`, `common/geo.ts` and
 * `common/stripHtmlTags.ts`, lifted when the server went away.
 *
 * Everything here is a pure function over plain values: no fetch, no Dexie, no
 * env. The pieces that did I/O (Nominatim, Overpass, Wikimedia) live in
 * `places.ts`, `overpass.ts` and `wikimedia.ts` next door and import from here.
 * Comments preserved from the server source where the reasoning still applies.
 */

// ── Language codes ───────────────────────────────────────────────────────────

// PanelMint's internal language codes mostly coincide with valid BCP-47 codes,
// but a couple don't: 'br' is Brazilian Portuguese here (BCP-47 'pt-BR'; bare
// 'br' is Breton) and 'gr' is Greek (BCP-47 'el'). Outbound geo APIs (Nominatim,
// Photon) expect BCP-47, so normalise before sending — otherwise names and
// opening hours come back in the wrong language.
const API_LANG_OVERRIDES: Record<string, string> = {
  br: 'pt-BR',
  gr: 'el',
  'el-GR': 'el',
};

export function toApiLang(lang: string | undefined, fallback = 'en'): string {
  const code = (lang || '').trim();
  if (!code) return fallback;
  return API_LANG_OVERRIDES[code] ?? code;
}

/**
 * A wiki subdomain out of a PanelMint language code.
 *
 * Not the same normalisation as `toApiLang`, and the difference bites: PanelMint
 * calls Brazilian Portuguese `br`, but `br.wikipedia.org` exists and is the
 * BRETON Wikipedia. Passing the raw code through would not fail — it would
 * quietly return Breton articles. `pt-br.wikipedia.org` does not resolve at
 * all, so the region subtag has to go as well.
 */
const WIKI_LANG_OVERRIDES: Record<string, string> = {
  br: 'pt',
  gr: 'el',
};
export function toWikiLang(lang: string | undefined, fallback = 'en'): string {
  const raw = (lang || '').trim();
  if (!raw) return fallback;
  const mapped = WIKI_LANG_OVERRIDES[raw] ?? raw;
  const base = mapped.split('-')[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(base) ? base : fallback;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * Great-circle distance in metres. The clamped form (asin of a value a hair
 * over 1, which floating point produces for near-antipodal points, is NaN) —
 * a NaN distance silently fails every comparison it feeds.
 */
export function haversineMetres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether two place names plausibly refer to the same thing.
 *
 * The gate that keeps a coordinate-based lookup from confidently describing the
 * wrong building. "Hamburg Airport" and "Flughafen Hamburg" pass on "hamburg";
 * "Hamburg Airport" and "Bahnhof Ohlsdorf" do not.
 *
 * One shared word is enough only when it carries some weight — four letters or
 * more. Otherwise two have to match. A single short word is almost always an
 * article or a generic noun.
 */
export function namesOverlap(a: string, b: string): boolean {
  const words = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2),
    );
  const left = [...words(a)];
  const right = [...words(b)];

  // Neither name has a Latin word to compare: two CJK names that merely share
  // a character are usually two different places, so compared strictly. NFKC
  // folds the width and compatibility variants the two sources disagree on.
  if (left.length === 0 && right.length === 0) {
    const strict = (value: string): string =>
      value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
    const [sa, sb] = [strict(a), strict(b)];
    return sa.length > 0 && sa === sb;
  }

  if (left.length === 0) return false;

  // Same word, allowing for an inflected ending — providers localise names, so
  // "Hamburg Airport" must match "Hamburger Flughafen Helmut Schmidt" over the
  // "-er". A short prefix would over-match, so the shared stem has to carry
  // weight and the endings have to be close.
  const sameStem = (x: string, y: string): boolean => {
    if (x === y) return true;
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 4 && long.length - short.length <= 3 && long.startsWith(short);
  };

  let shared = 0;
  for (const word of right) {
    const match = left.find((candidate) => sameStem(candidate, word));
    if (!match) continue;
    if (Math.min(match.length, word.length) >= 4) return true;
    if (++shared >= 2) return true;
  }
  return false;
}

// ── HTML/wiki text ───────────────────────────────────────────────────────────

/**
 * Remove HTML-ish tags from a string, exactly as `/<[^>]+>/g` did — a scan
 * rather than a regex because that pattern backtracks on attacker-supplied
 * text (Wikimedia Commons metadata is one of its callers).
 */
export function stripHtmlTags(input: string, replacement = ''): string {
  let out = '';
  let cursor = 0;

  for (;;) {
    const open = input.indexOf('<', cursor);
    if (open === -1) break;

    const close = input.indexOf('>', open + 1);
    // No closing bracket anywhere after: the rest is literal.
    if (close === -1) break;

    // `<>` — nothing between the brackets, so not a tag.
    if (close === open + 1) {
      out += input.slice(cursor, open + 1);
      cursor = open + 1;
      continue;
    }

    out += input.slice(cursor, open) + replacement;
    cursor = close + 1;
  }

  return out + input.slice(cursor);
}

/**
 * Commons extmetadata values arrive as HTML fragments — an author is typically
 * an <a> to the uploader's user page, a licence can carry <span> wrappers. We
 * show these as plain text next to a thumbnail, so the markup has to go.
 */
export function stripWikiMarkup(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = stripHtmlTags(value, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/**
 * Splits an OSM `wikipedia` tag ("de:Museum Ludwig") into host language and
 * article title. Returns null for the bare-title spelling, which has no language
 * and would send us to the wrong wiki.
 */
export function parseWikipediaTag(tag: string | undefined | null): { lang: string; title: string } | null {
  if (!tag) return null;
  const match = /^([a-z-]{2,12}):(.+)$/i.exec(tag.trim());
  if (!match) return null;
  const title = match[2].trim();
  return title ? { lang: match[1].toLowerCase(), title } : null;
}

// ── URL-derived ids ──────────────────────────────────────────────────────────

const GOOGLE_FTID_RE = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;
// The same id inside the `data=` pathname blob, where a resolved share link keeps it:
// /maps/place/<name>/data=!4m6!3m5!1s0x47e66e1f06e2b70f:0x40b82c3688c9460!8m2!3d48.85!4d2.29
const GOOGLE_FTID_DATA_RE = /!1s(0x[0-9a-f]{1,20}:0x[0-9a-f]{1,20})/i;

/**
 * Extracts a Google Maps feature id (ftid, 0x..:0x..) from a URL — the `?ftid=`
 * query parameter, or the `!1s…` data blob inside a /place/ path. Kept for
 * `resolveUrl`: a pasted share link still carries the id, we just never resolve
 * the link over the network any more.
 */
export function googleFtidFromMapsUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const ftid = parsed.searchParams.get('ftid')?.trim();
    if (ftid && GOOGLE_FTID_RE.test(ftid)) return ftid.toLowerCase();
    // Only for a place URL. A /maps/dir/ route carries one !1s per waypoint and
    // the first one is the origin, not the place the link is about.
    if (!parsed.pathname.includes('/place/')) return null;
    const fromPath = GOOGLE_FTID_DATA_RE.exec(parsed.pathname)?.[1];
    return fromPath ? fromPath.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ── Wiki identity ────────────────────────────────────────────────────────────

/**
 * The keys that say which encyclopaedia entry, Wikidata item and Commons
 * category describe a place.
 *
 * Bare keys only. OSM also carries `brand:wikidata` / `brand:wikipedia`, and
 * following those means a branch of a chain gets the chain's article and the
 * chain's logo — that is the exact failure the tag-only rule was written to
 * avoid, so do not "improve" this by falling back to brand:*.
 */
const WIKI_IDENTITY_TAGS = ['wikipedia', 'wikidata', 'wikimedia_commons'] as const;

export interface WikiIdentity {
  wikipedia: string | null;
  wikidata: string | null;
  wikimedia_commons: string | null;
}

/** Picks the three identity tags out of a Nominatim `extratags` blob. */
export function readWikiIdentity(extratags: Record<string, string> | null | undefined): WikiIdentity {
  const out: WikiIdentity = { wikipedia: null, wikidata: null, wikimedia_commons: null };
  if (!extratags) return out;
  for (const tag of WIKI_IDENTITY_TAGS) {
    const value = extratags[tag];
    if (typeof value === 'string' && value.trim()) out[tag] = value.trim();
  }
  return out;
}

/**
 * The chain a place belongs to, when it belongs to one. Read separately from
 * `readWikiIdentity` and never mixed into it: for a description the brand is a
 * fallback worth having (with the aboutBrand flag); the picture ladder never
 * reads it.
 */
export function readBrandIdentity(extratags: Record<string, string> | null | undefined): {
  wikidata: string | null;
  wikipedia: string | null;
} {
  const read = (key: string): string | null => {
    const value = extratags?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  return { wikidata: read('brand:wikidata'), wikipedia: read('brand:wikipedia') };
}

// ── Wikidata claims ──────────────────────────────────────────────────────────

export interface WikidataSnak {
  mainsnak?: { datavalue?: { value?: unknown } };
  rank?: 'preferred' | 'normal' | 'deprecated';
}
export type WikidataClaims = Record<string, WikidataSnak[] | undefined>;

/**
 * Wikidata properties that name a picture of a place, in the order we want them.
 * P18 is the representative image; the rest buy genuine variety (interior,
 * night, aerial, panorama, winter) rather than more frames of the same façade.
 */
const WIKIDATA_IMAGE_PROPERTIES = [
  'P18', // image
  'P5775', // interior view
  'P3451', // night view
  'P8592', // aerial view
  'P4291', // panoramic view
  'P5252', // winter view
  'P948', // Wikivoyage banner
] as const;

/** First non-empty string value of a claim list. */
export function claimValue(snaks: WikidataSnak[] | undefined): string | null {
  for (const snak of snaks ?? []) {
    const value = snak.mainsnak?.datavalue?.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** `File:` prefix off, underscores and case normalised — Commons treats these as one title. */
export function normalizeFileTitle(title: string): string {
  return title.replace(/^File:/i, '').replace(/_/g, ' ').trim().toLowerCase();
}

/**
 * File names from an item's picture properties, best first.
 *
 * Within P18 the statement rank decides: an item with several images marks one
 * `preferred`, and that is the one an editor considers representative. The API
 * returns statements in edit order, not rank order, so taking `[0]` picks
 * whichever was added first.
 */
export function wikidataImageClaims(claims: WikidataClaims, limit: number): string[] {
  const rankOrder = { preferred: 0, normal: 1, deprecated: 2 } as const;
  const names: string[] = [];
  const seen = new Set<string>();

  for (const property of WIKIDATA_IMAGE_PROPERTIES) {
    const snaks = [...(claims[property] ?? [])]
      .filter((snak) => snak.rank !== 'deprecated')
      .sort((a, b) => (rankOrder[a.rank ?? 'normal'] ?? 1) - (rankOrder[b.rank ?? 'normal'] ?? 1));
    for (const snak of snaks) {
      const value = snak.mainsnak?.datavalue?.value;
      if (typeof value !== 'string' || !value.trim()) continue;
      const key = normalizeFileTitle(value);
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(value.trim());
      if (names.length >= limit) return names;
    }
  }
  return names;
}

/**
 * A bare Commons category name out of whatever an OSM `wikimedia_commons` tag
 * holds — the tag is free text: a bare name, a prefixed `Category:…`, or a
 * single `File:…` (which is not a category and has nothing to derive from).
 */
export function normalizeCategoryName(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(file|datei|image|bild)\s*:/i.test(value)) return null;
  return value.replace(/^(category|kategorie|categorie|categoría|categoria)\s*:/i, '').trim() || null;
}

// ── Overpass POI categories ──────────────────────────────────────────────────

export interface ChargingInfo {
  /** One entry per socket family the station lists, with how many and how fast. */
  sockets: { type: string; count: number | null; kw: number | null }[];
  /** How many vehicles can charge at once, across all sockets. */
  capacity: number | null;
  /** true = costs money, false = free, null = OSM does not say. */
  fee: boolean | null;
}

/**
 * OSM writes sockets as one key per family: `socket:type2=4` is the count, and
 * `socket:type2:output=22 kW` the power. Both are free text in practice, so the
 * count is only taken when it parses as a whole number and the power only when
 * a number can be read off the front of it.
 */
const SOCKET_FAMILIES = [
  'type2', 'type2_combo', 'type2_cable', 'ccs', 'chademo', 'type1', 'type1_combo',
  'schuko', 'tesla_supercharger', 'tesla_destination',
] as const;

/** Leading number out of a free-text value like "22 kW" or "50kw". */
function leadingNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function readChargingInfo(tags: Record<string, string>): ChargingInfo | null {
  const sockets: ChargingInfo['sockets'] = [];
  for (const family of SOCKET_FAMILIES) {
    const raw = tags[`socket:${family}`];
    if (raw === undefined) continue;
    const count = Number.parseInt(raw, 10);
    sockets.push({
      type: family,
      count: Number.isInteger(count) && count > 0 ? count : null,
      kw: leadingNumber(tags[`socket:${family}:output`]),
    });
  }
  const capacity = Number.parseInt(tags.capacity ?? '', 10);
  const fee = tags.fee === 'yes' ? true : tags.fee === 'no' ? false : null;
  const info: ChargingInfo = {
    sockets,
    capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : null,
    fee,
  };
  // Nothing said is null rather than an empty shell, so the client can tell
  // "no data" from "no sockets" without inspecting three fields.
  return sockets.length || info.capacity !== null || fee !== null ? info : null;
}

// Each pill category → the OSM tag selectors it searches. Keys here are the
// contract with the client's POI_CATEGORIES (same keys, label/icon/colour live
// client-side in components/Map/poiCategories.ts).
export const CATEGORY_OSM_FILTERS: Record<string, string[]> = {
  restaurant: ['amenity=restaurant', 'amenity=fast_food'],
  cafe: ['amenity=cafe'],
  bar: ['amenity=bar', 'amenity=pub', 'amenity=nightclub'],
  hotel: ['tourism=hotel', 'tourism=hostel', 'tourism=guest_house', 'tourism=apartment', 'tourism=motel'],
  sights: [
    'tourism=attraction',
    'tourism=viewpoint',
    'historic=monument',
    'historic=castle',
    'historic=memorial',
    'historic=ruins',
  ],
  museum: ['tourism=museum', 'tourism=gallery', 'tourism=artwork', 'amenity=theatre'],
  nature: ['leisure=park', 'leisure=garden', 'natural=beach', 'natural=peak'],
  activity: ['tourism=theme_park', 'tourism=zoo', 'tourism=aquarium', 'leisure=water_park'],
  shopping: ['shop=mall', 'shop=department_store', 'amenity=marketplace'],
  supermarket: ['shop=supermarket', 'shop=convenience'],
  // What a drive needs rather than what a city visit does (#1797). Separate from
  // `activity`/`nature` on purpose: nobody browsing museums wants petrol
  // stations in the same result set.
  fuel: ['amenity=fuel'],
  charging: ['amenity=charging_station'],
  rest_area: ['highway=rest_area', 'highway=services'],
  campsite: ['tourism=camp_site', 'tourism=caravan_site'],
};

export const POI_CATEGORY_KEYS = Object.keys(CATEGORY_OSM_FILTERS);

/** How many categories one POI query may carry, so a caller can't fan out the mirrors. */
export const MAX_POI_CATEGORIES = 8;

/** The `category` parameter is either one key or a comma-separated list. */
export function parsePoiCategories(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const key = part.trim();
    if (key) seen.add(key);
    if (seen.size >= MAX_POI_CATEGORIES) break;
  }
  return [...seen];
}

// Public Overpass mirrors, queried in PARALLEL (first valid response wins).
// Reachability and load vary a lot by network/region — the canonical instance is
// frequently overloaded and some community mirrors are unreachable from certain
// networks. All of these answer CORS-enabled, which is what makes the race
// possible from a browser at all.
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * How long Overpass is allowed to spend on one query, in seconds — sent inside
 * the query as `[timeout:N]`, so the mirror itself enforces it. Anything we
 * wait client-side has to be longer than this or we hang up on an answer that
 * was still coming.
 */
export const OVERPASS_QUERY_TIMEOUT_S = 20;

/** The fetch-side budget: the mirror's own, plus room to hand the answer back. */
export const OVERPASS_TIMEOUT_MS = (OVERPASS_QUERY_TIMEOUT_S + 5) * 1000;

// ── Opening hours parsing ────────────────────────────────────────────────────

// Machine-readable opening hours, in Google's numbering: day 0 = Sunday …
// 6 = Saturday — the numbering the shared `placeHoursTimePointSchema` pins.
export interface OpeningTimePoint {
  day: number;
  hour: number;
  minute: number;
}

export interface OpeningPeriod {
  open: OpeningTimePoint;
  close: OpeningTimePoint | null;
}

// "09:00-18:00", also the "20:00-02:00" and "00:00-24:00" spellings OSM uses.
const OSM_TIME_RANGE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;

/** Periods for one OSM weekday line. `dayIdx` is Monday-based, the output is not. */
function osmPeriods(dayIdx: number, timePart: string): OpeningPeriod[] {
  const day = (dayIdx + 1) % 7;
  const periods: OpeningPeriod[] = [];
  for (const match of timePart.matchAll(OSM_TIME_RANGE)) {
    const openHour = Number.parseInt(match[1], 10);
    const openMinute = Number.parseInt(match[2], 10);
    let closeHour = Number.parseInt(match[3], 10);
    const closeMinute = Number.parseInt(match[4], 10);
    if (openHour > 23 || openMinute > 59 || closeHour > 24 || closeMinute > 59) continue;
    // OSM writes the end of a day as 24:00, a clock reading the wire numbering
    // has no hour 24 — that is midnight of the following day.
    let nextDay = closeHour * 60 + closeMinute <= openHour * 60 + openMinute;
    if (closeHour === 24) {
      if (closeMinute !== 0) continue;
      closeHour = 0;
      nextDay = true;
    }
    periods.push({
      open: { day, hour: openHour, minute: openMinute },
      close: { day: nextDay ? (day + 1) % 7 : day, hour: closeHour, minute: closeMinute },
    });
  }
  return periods;
}

export function parseOpeningHours(ohString: string): {
  weekdayDescriptions: string[];
  openNow: boolean | null;
  periods: OpeningPeriod[];
} {
  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const result: string[] = LONG.map((d) => `${d}: ?`);
  const periods: OpeningPeriod[] = [];

  // "24/7" — and it is not an edge case. Every segment below needs a weekday
  // prefix to match, so this would fall straight through and `buildOsmDetails`
  // would throw the whole thing away as unparseable — which is why airports,
  // main stations and petrol stations used to show no hours at all.
  if (/^\s*(24\/7|open)\s*$/i.test(ohString)) {
    return {
      weekdayDescriptions: LONG.map((d) => `${d}: 00:00-24:00`),
      openNow: true,
      // One period that never closes. `close: null` is how the client's
      // open/closed logic already spells "does not close".
      periods: [{ open: { day: 0, hour: 0, minute: 0 }, close: null }],
    };
  }

  // Parse segments like "Mo-Fr 09:00-18:00; Sa 10:00-14:00"
  for (const segment of ohString.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const match = trimmed.match(
      /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(\S.*)$/i,
    );
    if (!match) continue;
    const [, daysPart, timePart] = match;
    const dayIndices = new Set<number>();
    for (const range of daysPart.split(',')) {
      const parts = range
        .trim()
        .split('-')
        .map((d) => DAYS.indexOf(d.trim()));
      if (parts.length === 2 && parts[0] >= 0 && parts[1] >= 0) {
        // do/while, not while: a range that wraps all the way round — "Mo-Su",
        // or "Tu-Mo", both of which mean every day — starts already satisfying
        // the exit condition.
        let day = parts[0];
        do {
          dayIndices.add(day);
          day = (day + 1) % 7;
        } while (day !== (parts[1] + 1) % 7);
      } else if (parts[0] >= 0) {
        dayIndices.add(parts[0]);
      }
    }
    for (const idx of dayIndices) {
      result[idx] = `${LONG[idx]}: ${timePart.trim()}`;
      periods.push(...osmPeriods(idx, timePart));
    }
  }

  // Compute openNow
  let openNow: boolean | null = null;
  try {
    const now = new Date();
    const jsDay = now.getDay();
    const dayIdx = jsDay === 0 ? 6 : jsDay - 1;
    const todayLine = result[dayIdx];
    const timeRanges = [...todayLine.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    if (timeRanges.length > 0) {
      const nowMins = now.getHours() * 60 + now.getMinutes();
      openNow = timeRanges.some((m) => {
        const start = Number.parseInt(m[1]) * 60 + Number.parseInt(m[2]);
        const end = Number.parseInt(m[3]) * 60 + Number.parseInt(m[4]);
        return end > start ? nowMins >= start && nowMins < end : nowMins >= start || nowMins < end;
      });
    }
  } catch {
    /* best effort */
  }

  return { weekdayDescriptions: result, openNow, periods };
}

// ── Standardised OSM details ─────────────────────────────────────────────────

/**
 * Turns a raw OSM tag set into the details record the enrichment column and the
 * place form read (`website`, `phone`, `opening_hours`, wiki identity tags, the
 * restaurant facts). osmType/osmId feed only the `osm_url` link — pass '' where
 * the record is a bare tag set with no element identity.
 */
export function buildOsmDetails(tags: Record<string, string>, osmType: string, osmId: string) {
  let opening_hours: string[] | null = null;
  let open_now: boolean | null = null;
  let opening_periods: OpeningPeriod[] | null = null;
  if (tags.opening_hours) {
    const parsed = parseOpeningHours(tags.opening_hours);
    const hasData = parsed.weekdayDescriptions.some((line) => !line.endsWith('?'));
    if (hasData) {
      opening_hours = parsed.weekdayDescriptions;
      open_now = parsed.openNow;
      opening_periods = parsed.periods.length > 0 ? parsed.periods : null;
    }
  }
  return {
    website: tags['contact:website'] || tags.website || null,
    phone: tags['contact:phone'] || tags.phone || null,
    opening_hours,
    open_now,
    opening_periods,
    osm_url: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    summary: tags.description || null,
    // Kept so enrichment can resolve the right Wikipedia article instead of
    // guessing one from the place name, which picks the wrong article whenever
    // the name is ambiguous.
    wikipedia: tags.wikipedia || null,
    wikidata: tags.wikidata || null,
    // A Commons category is pictures OF this place, where a coordinate search
    // only finds whatever was photographed near it.
    wikimedia_commons: tags.wikimedia_commons || null,
    // The tags that make the difference for a restaurant or a shop: no
    // encyclopaedia will ever describe one, but its cuisine, its hours and a
    // link to its menu are usually right here.
    cuisine: tags.cuisine || null,
    menu_url: tags['website:menu'] || tags.menu || null,
    outdoor_seating: tags.outdoor_seating || null,
    takeaway: tags.takeaway || null,
    delivery: tags.delivery || null,
    wheelchair: tags.wheelchair || null,
    diet_vegetarian: tags['diet:vegetarian'] || null,
    diet_vegan: tags['diet:vegan'] || null,
    internet_access: tags.internet_access || null,
    source: 'openstreetmap' as const,
  };
}

// ── Place-id classification ──────────────────────────────────────────────────

// Ids that can never resolve against a keyed provider: coordinate pseudo-ids
// (`coords:` and the bare "lat,lng" spelling), OSM ids, GERS ids from the
// former index, Amap POI ids, raw photo URLs, and photo cache keys of the form
// "<placeId>~p3" that enrichment mints for the picker.
const NON_OSM_PLACE_ID =
  /^(?:coords|gers|node|way|relation|amap):|^https?:\/\/|^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$|~p\d+$/i;

/**
 * The subset that still has a provider behind it — Nominatim lookup + Overpass
 * tags. The id has to be the whole of what follows the colon: it is written
 * into an Overpass query and a Nominatim `osm_ids` parameter as it came in.
 */
export const OSM_PLACE_ID = /^(?:node|way|relation):\d+$/i;

/** True when the id names an OSM element the details path can resolve. */
export function isOsmPlaceId(placeId: string): boolean {
  return OSM_PLACE_ID.test(placeId);
}

/** True for every id that is not an OSM element — incl. legacy Google ids. */
export function isNonOsmPlaceId(placeId: string): boolean {
  return NON_OSM_PLACE_ID.test(placeId) || !OSM_PLACE_ID.test(placeId);
}

// ── Ranking Commons candidates ───────────────────────────────────────────────

/** A candidate as the ranker needs to see it. */
export interface RankableCommonsCandidate {
  pageId: number | null;
  title: string | null;
  attribution: string | null;
  width: number | null;
  height: number | null;
  descriptors: string | null;
  photoUrl: string;
}

/**
 * Commons files that are near a place but are not a picture of it.
 * Orthophotos are the worst offender by volume: German states upload their
 * aerial survey tiles to Commons with coordinates, so a geosearch around any
 * airport returns the runway as seen from a plane at 3000m. The rest are
 * documents that happen to live in a place's category: noise maps, floor
 * plans, terminal layouts, logos, coats of arms.
 */
const NOT_A_PHOTO_OF_THE_PLACE =
  /orthophoto|orthofoto|sommerbefliegung|luftbildkarte|dop\d+|l[äa]rmkarte|noise map|floor ?plan|grundriss|lageplan|layout|diagram|schematic|blueprint|coat of arms|wappen|\blogo\b|flag of/i;

/**
 * Strips what makes two frames of the same burst look like different files, so
 * they collapse onto one stem: trailing counters, camera dumps, dates, and the
 * `- 17` / `(2)` suffixes press sets use.
 */
function seriesStem(title: string): string {
  return title
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    // 20260614 100717648 HDR — a camera dump, all from the same minute
    .replace(/\b\d{8}[ _-]\d{6,9}\b/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    // The character in front of the suffix is matched and put straight back:
    // /[ _-]+…$/ on its own restarts at every space of a title that has no such
    // suffix, and re-reads the rest of the run each time.
    .replace(/([^ _-]|^)[ _-]+\(?\d{1,4}\)?$/g, '$1')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/**
 * Picks the pictures worth showing out of whatever the providers returned.
 *
 * Everything here was written against a real failing case. Deduplication is by
 * page id because the same file reaches us under different thumbnail URLs. The
 * series rule exists because Commons categories are full of bursts. The author
 * cap is the same problem seen from the other side: one contributor who
 * documented a station thoroughly should not supply the whole strip.
 *
 * `perAuthor` is the one knob: coordinate search gets 1, because there being no
 * evidence the pictures are even of the right subject makes variety the only
 * defence. Curated sources get 2 — someone already vouched that these depict
 * the place.
 */
export function rankCommonsCandidates<T extends RankableCommonsCandidate>(
  candidates: T[],
  limit: number,
  opts: { perAuthor?: number } = {},
): T[] {
  const perAuthor = opts.perAuthor ?? 2;
  const seenPages = new Set<number>();
  const seenUrls = new Set<string>();
  const seenStems = new Set<string>();
  const authorCounts = new Map<string, number>();
  const out: T[] = [];

  for (const candidate of candidates) {
    if (out.length >= limit) break;

    if (candidate.pageId != null) {
      if (seenPages.has(candidate.pageId)) continue;
    } else if (seenUrls.has(candidate.photoUrl)) {
      // No page id: the URL is a weaker key but better than letting an exact
      // repeat through.
      continue;
    }

    const haystack = `${candidate.title ?? ''} ${candidate.descriptors ?? ''}`;
    if (NOT_A_PHOTO_OF_THE_PLACE.test(haystack)) continue;

    const { width, height } = candidate;
    if (width && height) {
      // Survey tiles are square and enormous; nothing photographed by hand is.
      if (width === height && width >= 3000) continue;
      const ratio = Math.max(width / height, height / width);
      // Panorama strips and tall banners crop to nothing in a square tile.
      if (ratio > 4) continue;
    }

    const stem = candidate.title ? seriesStem(candidate.title) : '';
    if (stem && seenStems.has(stem)) continue;

    const author = (candidate.attribution ?? '').trim().toLowerCase();
    if (author) {
      const used = authorCounts.get(author) ?? 0;
      if (used >= perAuthor) continue;
      authorCounts.set(author, used + 1);
    }

    if (candidate.pageId != null) seenPages.add(candidate.pageId);
    seenUrls.add(candidate.photoUrl);
    if (stem) seenStems.add(stem);
    out.push(candidate);
  }

  return out;
}
