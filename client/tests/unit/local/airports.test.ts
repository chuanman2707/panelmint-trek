/**
 * Parity tests for the ported airport search.
 *
 * Source fixtures: server/tests/unit/nest/airports.service.test.ts asserts the
 * scoring tiers, the exact-IATA short-circuit, the blank-query early return and
 * the default limit. The in-memory half (search + findByIata) is fully ported
 * and asserted here; the endpoint backfill runs against the MemoryStore seam.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  backfillFlightEndpoints,
  findByIata,
  searchAirports,
  setAirportData,
  type Airport,
} from '../../../src/api/local/ported/airports';
import { airportsApi } from '../../../src/api/local/airports';
import { LocalApiError } from '../../../src/api/local/helpers';
import { MemoryStore } from './helpers/memoryStore';

const JFK: Airport = {
  iata: 'JFK',
  icao: 'KJFK',
  name: 'John F Kennedy International',
  city: 'New York',
  country: 'US',
  lat: 40.64,
  lng: -73.78,
  tz: 'America/New_York',
};
const LGA: Airport = {
  iata: 'LGA',
  icao: 'KLGA',
  name: 'LaGuardia',
  city: 'New York',
  country: 'US',
  lat: 40.78,
  lng: -73.87,
  tz: 'America/New_York',
};
const EWR: Airport = {
  iata: 'EWR',
  icao: 'KEWR',
  name: 'Newark Liberty International',
  city: 'Newark',
  country: 'US',
  lat: 40.69,
  lng: -74.17,
  tz: 'America/New_York',
};
const CDG: Airport = {
  iata: 'CDG',
  icao: 'LFPG',
  name: 'Charles de Gaulle',
  city: 'Paris',
  country: 'FR',
  lat: 49.01,
  lng: 2.55,
  tz: 'Europe/Paris',
};

beforeEach(() => setAirportData([JFK, LGA, EWR, CDG]));

describe('searchAirports', () => {
  it('returns [] for a blank or whitespace query', () => {
    expect(searchAirports('')).toEqual([]);
    expect(searchAirports('   ')).toEqual([]);
  });

  it('an exact 3-letter IATA match ranks first and returns immediately', () => {
    const hits = searchAirports('jfk');
    expect(hits).toHaveLength(1);
    expect(hits[0].iata).toBe('JFK');
  });

  it('matches on ICAO at the 90 tier below exact IATA', () => {
    // "kjfk" isn't a 3-letter IATA, so it goes through the scoring pass.
    const hits = searchAirports('kjfk');
    expect(hits[0].iata).toBe('JFK');
  });

  it('city-prefix hits outrank name-substring hits', () => {
    // "new york" is a city prefix for JFK/LGA (60) and a name substring of nothing.
    const hits = searchAirports('new york');
    expect(hits.map((h) => h.iata)).toEqual(['JFK', 'LGA']);
  });

  it('name-prefix beats city-substring', () => {
    const hits = searchAirports('charles');
    expect(hits[0].iata).toBe('CDG');
  });

  it('caps results at the default limit of 12', () => {
    const many: Airport[] = Array.from({ length: 20 }, (_, i) => ({
      iata: `A${String(i).padStart(2, '0')}`,
      icao: null,
      name: `Townsville ${i}`,
      city: 'Townsville',
      country: 'AU',
      lat: 0,
      lng: 0,
      tz: 'UTC',
    }));
    setAirportData(many);
    expect(searchAirports('townsville')).toHaveLength(12);
  });

  it('is case-insensitive', () => {
    expect(searchAirports('NEW YORK')[0].iata).toBe('JFK');
  });
});

describe('findByIata', () => {
  it('finds an airport case-insensitively', () => {
    expect(findByIata('cdg')?.name).toBe('Charles de Gaulle');
  });
  it('returns null for an unknown code', () => {
    expect(findByIata('zzz')).toBeNull();
  });
});

describe('backfillFlightEndpoints', () => {
  it('resolves metadata IATAs into from/to endpoint rows', () => {
    const store = new MemoryStore({
      reservations: [
        {
          id: 1,
          trip_id: 10,
          day_id: null,
          end_day_id: null,
          place_id: null,
          assignment_id: null,
          title: 'Flight',
          reservation_time: '2026-03-01T08:05',
          reservation_end_time: '2026-03-01T11:40',
          location: null,
          confirmation_number: null,
          notes: null,
          url: null,
          status: 'booked',
          type: 'flight',
          accommodation_id: null,
          metadata: JSON.stringify({ departure_airport: 'JFK', arrival_airport: 'CDG' }),
          needs_review: 0,
        },
      ],
    });
    const result = backfillFlightEndpoints(store);
    expect(result).toEqual({ filled: 1, flagged: 0 });
    const eps = store.endpoints.filter((e) => e.reservation_id === 1);
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({
      role: 'from',
      sequence: 0,
      code: 'JFK',
      local_date: '2026-03-01',
      local_time: '08:05',
    });
    expect(eps[1]).toMatchObject({ role: 'to', sequence: 1, code: 'CDG', local_time: '11:40' });
  });

  it('flags reservations whose metadata cannot resolve to known airports', () => {
    const store = new MemoryStore({
      reservations: [
        {
          id: 2,
          trip_id: 10,
          day_id: null,
          end_day_id: null,
          place_id: null,
          assignment_id: null,
          title: 'Flight',
          reservation_time: null,
          reservation_end_time: null,
          location: null,
          confirmation_number: null,
          notes: null,
          url: null,
          status: 'booked',
          type: 'flight',
          accommodation_id: null,
          metadata: JSON.stringify({ departure_airport: 'ZZZ', arrival_airport: 'JFK' }),
          needs_review: 0,
        },
      ],
    });
    expect(backfillFlightEndpoints(store)).toEqual({ filled: 0, flagged: 1 });
    expect(store.reservations[0].needs_review).toBe(1);
  });

  it('skips flights that already have endpoint rows (the NOT EXISTS scan)', () => {
    const store = new MemoryStore({
      reservations: [
        {
          id: 3,
          trip_id: 10,
          day_id: null,
          end_day_id: null,
          place_id: null,
          assignment_id: null,
          title: 'Flight',
          reservation_time: null,
          reservation_end_time: null,
          location: null,
          confirmation_number: null,
          notes: null,
          url: null,
          status: 'booked',
          type: 'flight',
          accommodation_id: null,
          metadata: JSON.stringify({ departure_airport: 'JFK', arrival_airport: 'CDG' }),
          needs_review: 0,
        },
      ],
      endpoints: [
        {
          id: 1,
          reservation_id: 3,
          role: 'from',
          sequence: 0,
          name: 'x',
          code: 'JFK',
          lat: 1,
          lng: 1,
          timezone: null,
          local_time: null,
          local_date: null,
        },
      ],
    });
    expect(backfillFlightEndpoints(store)).toEqual({ filled: 0, flagged: 0 });
  });
});

describe('airportsApi', () => {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

  it('search returns a bare array — no envelope', async () => {
    const hits = await airportsApi.search('new york');
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.map((h) => h.iata)).toEqual(['JFK', 'LGA']);
  });

  it('search answers [] for an empty, blank or non-string query', async () => {
    expect(await airportsApi.search('')).toEqual([]);
    expect(await airportsApi.search('   ')).toEqual([]);
    expect(await airportsApi.search(undefined as never)).toEqual([]);
    expect(await airportsApi.search(['a'] as never)).toEqual([]);
  });

  it('an exact 3-letter IATA returns just that airport', async () => {
    const hits = await airportsApi.search('cdg');
    expect(hits).toHaveLength(1);
    expect(hits[0].iata).toBe('CDG');
  });

  it('an already-aborted signal rejects like the axios cancel did', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(airportsApi.search('new', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('byIata is case-insensitive and carries the dataset tz', async () => {
    const a = await airportsApi.byIata('jfk');
    expect(a.iata).toBe('JFK');
    expect(a.tz).toBe('America/New_York');
  });

  it('byIata answers the 404 Airport not found envelope on an unknown code', async () => {
    const err = await fail(airportsApi.byIata('zzz'));
    expect(err).toBeInstanceOf(LocalApiError);
    expect(err.status).toBe(404);
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Airport not found');
    await expect(airportsApi.byIata('')).rejects.toBeInstanceOf(LocalApiError);
  });

  it('byIata fills a missing tz via tz-lookup (dataset rows ship one)', async () => {
    setAirportData([{ ...CDG, iata: 'ORY', icao: 'LFPO', name: 'Orly', city: 'Paris', tz: '' }]);
    const a = await airportsApi.byIata('ory');
    expect(a.tz).toBe('Europe/Paris');
  });

  it('returned rows are detached — mutating a hit must not corrupt the dataset', async () => {
    const hits = await airportsApi.search('jfk');
    hits[0].city = 'Mutated';
    expect((await airportsApi.byIata('JFK')).city).toBe('New York');
  });
});
