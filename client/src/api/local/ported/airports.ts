/**
 * Port of server/src/nest/airports/airports.data.ts plus the
 * flight-endpoint backfill from airports.service.ts.
 *
 * The dataset ships with the app now instead of being read off disk:
 * `client/src/data/airports.json` is a byte-for-byte copy of
 * `server/assets/airports.json`, imported statically (resolveJsonModule).
 * Rankings and the find-by-IATA path are verbatim.
 *
 * Server behaviours preserved:
 *  - Empty/whitespace query returns [].
 *  - An exact 3-letter IATA match ranks first and returns immediately.
 *  - Score tiers: exact IATA 100, exact ICAO 90, IATA prefix 70, city prefix
 *    60, name prefix 50, city substring 30, name substring 20; ties break on
 *    IATA; results cap at `limit` (default 12).
 *  - The flight-endpoint backfill: flight reservations with no endpoints get
 *    their metadata's departure/arrival IATAs resolved into `from`/`to`
 *    endpoint rows, or are flagged needs_review. Persistence is the
 *    `AirportBackfillStore` seam.
 */
import airportsJson from '../../../data/airports.json';

export interface Airport {
  iata: string;
  icao: string | null;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  tz: string;
}

let cache: Airport[] | null = null;
let byIata: Map<string, Airport> | null = null;

export function loadAirports(data: Airport[] = airportsJson as Airport[]): Airport[] {
  if (cache) return cache;
  cache = data;
  byIata = new Map(cache.map((a) => [a.iata, a]));
  return cache;
}

/** Test hook: re-point the dataset (the server tests stub the file read). */
export function setAirportData(data: Airport[]): void {
  cache = null;
  byIata = null;
  loadAirports(data);
}

export function findByIata(code: string): Airport | null {
  loadAirports();
  return byIata!.get(code.toUpperCase()) ?? null;
}

export function searchAirports(query: string, limit = 12): Airport[] {
  const all = loadAirports();
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const upper = q.toUpperCase();
  if (q.length === 3) {
    const exact = byIata!.get(upper);
    if (exact) return [exact];
  }

  const matches: Array<{ a: Airport; score: number }> = [];
  for (const a of all) {
    let score = 0;
    if (a.iata === upper) score = 100;
    else if (a.icao === upper) score = 90;
    else if (a.iata.startsWith(upper)) score = 70;
    else if (a.city.toLowerCase().startsWith(q)) score = 60;
    else if (a.name.toLowerCase().startsWith(q)) score = 50;
    else if (a.city.toLowerCase().includes(q)) score = 30;
    else if (a.name.toLowerCase().includes(q)) score = 20;
    if (score > 0) matches.push({ a, score });
  }
  matches.sort((x, y) => y.score - x.score || x.a.iata.localeCompare(y.a.iata));
  return matches.slice(0, limit).map((m) => m.a);
}

// ── Flight-endpoint backfill (the DB half of airports.service.ts) ─────────────

export interface BackfillCandidate {
  id: number;
  metadata: string | null;
  reservation_time: string | null;
  reservation_end_time: string | null;
}

export interface AirportBackfillStore {
  /** Flight reservations with no endpoint rows (the server's NOT EXISTS scan). */
  listFlightReservationsWithoutEndpoints(): BackfillCandidate[];
  insertEndpoint(row: {
    reservation_id: number;
    role: 'from' | 'to' | 'stop';
    sequence: number;
    name: string;
    code: string | null;
    lat: number;
    lng: number;
    timezone: string | null;
    local_time: string | null;
    local_date: string | null;
  }): void;
  markNeedsReview(reservationId: number): void;
}

/**
 * Repair flight reservations that predate the endpoints table: resolve the
 * metadata's departure/arrival IATAs into `from`/`to` endpoint rows, or flag
 * the booking for review. Verbatim from AirportsService.backfillFlightEndpoints,
 * minus the console log (the caller reports the counts).
 */
export function backfillFlightEndpoints(store: AirportBackfillStore): { filled: number; flagged: number } {
  const pending = store.listFlightReservationsWithoutEndpoints();
  if (pending.length === 0) return { filled: 0, flagged: 0 };

  loadAirports();

  let filled = 0;
  let flagged = 0;
  for (const r of pending) {
    if (!r.metadata) {
      store.markNeedsReview(r.id);
      flagged++;
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(r.metadata);
    } catch {
      store.markNeedsReview(r.id);
      flagged++;
      continue;
    }

    const dep = meta.departure_airport ? findByIata(String(meta.departure_airport).slice(0, 3)) : null;
    const arr = meta.arrival_airport ? findByIata(String(meta.arrival_airport).slice(0, 3)) : null;

    if (!dep || !arr) {
      store.markNeedsReview(r.id);
      flagged++;
      continue;
    }

    const split = (iso: string | null) => {
      if (!iso) return { date: null as string | null, time: null as string | null };
      const [date, time] = iso.split('T');
      return { date: date || null, time: time ? time.slice(0, 5) : null };
    };
    const depParts = split(r.reservation_time);
    const arrParts = split(r.reservation_end_time);

    store.insertEndpoint({
      reservation_id: r.id,
      role: 'from',
      sequence: 0,
      name: dep.city ? `${dep.city} (${dep.iata})` : dep.name,
      code: dep.iata,
      lat: dep.lat,
      lng: dep.lng,
      timezone: dep.tz,
      local_time: depParts.time,
      local_date: depParts.date,
    });
    store.insertEndpoint({
      reservation_id: r.id,
      role: 'to',
      sequence: 1,
      name: arr.city ? `${arr.city} (${arr.iata})` : arr.name,
      code: arr.iata,
      lat: arr.lat,
      lng: arr.lng,
      timezone: arr.tz,
      local_time: arrParts.time,
      local_date: arrParts.date,
    });
    filled++;
  }

  return { filled, flagged };
}
