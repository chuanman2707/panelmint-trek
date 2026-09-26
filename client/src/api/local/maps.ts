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
 *  - `placePhoto`/`placePhotoCredit` are gone for real: no photo proxy exists
 *    to answer them and the photo UI they served was stripped with the service.
 *  - `area` had no consumers even server-backed (it dumped the place index for
 *    the offline cache); the stub says so instead of pretending.
 *  - `resolveUrl` never fetches the pasted URL — see `ext/places.ts`.
 */
import type {
  MapsAutocompleteResult,
  MapsPlaceDetailsResult,
  MapsPlaceEnrichmentRequest,
  MapsPlaceEnrichmentResult,
  MapsResolveUrlResult,
  MapsReverseResult,
  MapsSearchResult,
} from '@trek/shared';
import * as extPlaces from '../ext/places';
import { enrich } from '../ext/wikimedia';
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
