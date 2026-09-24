/**
 * `mapsApi` — the local facade. Same method list, envelopes and argument order
 * as the axios version, backed by the browser-side clients in `api/ext/`.
 *
 * What changed and why:
 *  - Everything the server proxied is now a direct browser call: Photon +
 *    Nominatim for search/autocomplete/details/reverse, Overpass for POIs,
 *    the Wikimedia ladder for enrichment. Latency budget notes the axios
 *    comments carried (the 20 s POI timeout, the 25 s enrichment timeout) are
 *    now the abort/timeout logic inside the ext clients.
 *  - `provider: 'google'` on search is accepted and ignored — there is no
 *    keyed slot. The autocomplete `sessionToken` (a Google billing concept)
 *    likewise.
 *  - `placePhoto` is gone for real: no photo proxy exists to answer it, and
 *    the callers that fetched bytes through it were stripped with the service.
 *    The stub returns the honest empty answer so a stale caller degrades to
 *    "no photo" instead of a network error.
 *  - `placePhotoCredit` reads the credit map `ext/wikimedia` fills while it
 *    builds a strip — the same lookup the server's photo-cache table provided.
 *  - `area` had no consumers even server-backed (it dumped the place index for
 *    the offline cache); the stub says so instead of pretending.
 *  - `resolveUrl` never fetches the pasted URL — see `ext/places.ts`.
 */
import type {
  MapsAutocompleteResult,
  MapsPlaceDetailsResult,
  MapsPlaceEnrichmentRequest,
  MapsPlaceEnrichmentResult,
  MapsPlacePhotoResult,
  MapsResolveUrlResult,
  MapsReverseResult,
  MapsSearchResult,
} from '@trek/shared';
import * as extPlaces from '../ext/places';
import { enrich, photoCredit } from '../ext/wikimedia';
import { searchOverpassPois, type PoiSearchResult } from '../ext/overpass';

export const mapsApi = {
  search: (
    query: string,
    lang?: string,
    locationBias?: { lat: number; lng: number; radius?: number },
    provider?: 'google',
  ): Promise<MapsSearchResult> => {
    void provider; // no keyed provider exists in the local build
    return extPlaces.search(query, lang, locationBias);
  },

  autocomplete: (
    input: string,
    lang?: string,
    locationBias?: { low: { lat: number; lng: number }; high: { lat: number; lng: number } },
    signal?: AbortSignal,
    sessionToken?: string,
  ): Promise<MapsAutocompleteResult> =>
    extPlaces.autocomplete(input, lang, locationBias, sessionToken, signal),

  details: (placeId: string, lang?: string, sessionToken?: string): Promise<MapsPlaceDetailsResult> =>
    extPlaces.details(placeId, lang, sessionToken),

  placeEnrichment: (
    body: { placeId?: string; lat: number; lng: number; name: string; lang?: string; details?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<MapsPlaceEnrichmentResult> =>
    enrich(body as MapsPlaceEnrichmentRequest, signal),

  /**
   * The credit the strip recorded for a candidate key. Local read over the map
   * `ext/wikimedia` fills as it ranks — a miss (a key minted before the map was
   * populated, or in a previous session) answers null, exactly as the server's
   * swept photo-cache row did.
   */
  placePhotoCredit: async (key: string): Promise<{ credit: string | null }> => photoCredit(key),

  /** No photo proxy exists in the client-only build — the honest empty answer. */
  placePhoto: async (
    _placeId: string,
    _lat?: number,
    _lng?: number,
    _name?: string,
  ): Promise<MapsPlacePhotoResult> => ({ photoUrl: null, attribution: null }),

  reverse: (lat: number, lng: number, lang?: string): Promise<MapsReverseResult> =>
    extPlaces.reverse(lat, lng, lang),

  resolveUrl: (url: string): Promise<MapsResolveUrlResult> => extPlaces.resolveUrl(url),

  /** The server dumped its place index for offline caching; there is no index. */
  area: async (
    _bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
    _limit?: number,
    _signal?: AbortSignal,
  ): Promise<{ results: Record<string, unknown>[]; truncated: boolean; unavailable?: boolean }> =>
    ({ results: [], truncated: false, unavailable: true }),

  pois: (
    category: string,
    bbox: { south: number; west: number; north: number; east: number },
    lang?: string,
    signal?: AbortSignal,
  ): Promise<PoiSearchResult> => searchOverpassPois(category, bbox, lang, 60, signal),
};
