/**
 * `airportsApi` — the local implementation. Same method list as the axios
 * version in api/client.ts (`search`/`byIata`), backed by the bundled dataset
 * (`src/data/airports.json` — the byte-for-byte copy of the server's
 * `assets/airports.json`) through the ported search in
 * `local/ported/airports.ts`.
 *
 * Server parity notes (server/src/nest/airports/):
 *  - `GET /api/airports/search?q=` answered a bare `Airport[]` — no envelope.
 *    An absent or non-string `q` (Express hands array query params through as
 *    `string[]`) answered `[]`, not a 400; a blank/whitespace string hits the
 *    ported early return, also `[]`.
 *  - Scoring order is verbatim: exact 3-letter IATA short-circuits; otherwise
 *    IATA 100 / ICAO 90 / IATA-prefix 70 / city-prefix 60 / name-prefix 50 /
 *    city-substring 30 / name-substring 20, ties on IATA, capped at 12.
 *  - `GET /api/airports/:iata` is case-insensitive and answers 404
 *    `{error: 'Airport not found'}` on an unknown code.
 *  - `search` accepted an axios abort signal. The lookup is synchronous so the
 *    signal is only consulted up front — `throwIfAborted()` produces the
 *    AbortError the picker treats as a stale keystroke.
 *  - `tz` ships inside every dataset row (built with tz-lookup upstream); the
 *    fill here is defensive for rows that ever arrive without one — the same
 *    lookup the dataset build ran.
 *  - Returned rows are detached copies: the dataset is module-shared, and the
 *    server handed out a fresh object per request.
 *  - Methods are async so every failure is a rejection, never a synchronous
 *    throw — axios only ever produced rejections.
 */
import tzlookup from 'tz-lookup';
import { findByIata, searchAirports } from './ported/airports';
import type { Airport } from './ported/airports';
import { apiError, detached, detachedList } from './helpers';

/** Dataset row with a guaranteed timezone — `tz-lookup` by coordinates when a
 *  row lacks one (invalid coordinates keep whatever the row carried). */
function withTz(a: Airport): Airport {
  if (a.tz) return a;
  try {
    return { ...a, tz: tzlookup(a.lat, a.lng) };
  } catch {
    return a;
  }
}

export const airportsApi = {
  search: async (q: string, signal?: AbortSignal): Promise<Airport[]> => {
    signal?.throwIfAborted();
    // The controller coerced a missing/array `q` to '' — the search's own
    // blank-query early return answers [] for it.
    const term = typeof q === 'string' ? q : '';
    if (!term) return [];
    return detachedList(searchAirports(term)).map(withTz);
  },

  byIata: async (iata: string): Promise<Airport> => {
    const airport = typeof iata === 'string' ? findByIata(iata) : null;
    if (!airport) throw apiError(404, 'Airport not found');
    return withTz(detached(airport));
  },
};
