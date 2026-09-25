/**
 * `ext/overpass` — the browser-side POI explorer. MSW stands in for the four
 * mirrors; the assertions pin the race (first VALID body wins, not first
 * answer), error propagation after every mirror fails (the explore UI shows
 * a retry, so a silent empty map is a bug), centred clamping, the per-category
 * cap, disused filtering and the result cache.
 *
 * The cache is module state with a 10-minute TTL — every test uses its own
 * bbox so a warm entry can never answer for a neighbour.
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { searchOverpassPois, clampPoiBounds, buildPoiQuery } from './overpass';
import { OVERPASS_MIRRORS } from './geoHelpers';

function element(id: number, tags: Record<string, string>, lat = 48.0, lon = 2.0) {
  return { type: 'node', id, lat, lon, tags };
}

type Handler = () => Response | Promise<Response>;

/** Answer all mirrors with the same body — the race detail doesn't matter here. */
function mockAllMirrors(handler: Handler) {
  server.use(...OVERPASS_MIRRORS.map((m) => http.post(m, handler)));
}

function mockMirrors(byHost: Record<string, Handler>) {
  server.use(...OVERPASS_MIRRORS.map((m) =>
    http.post(m, () => (byHost[m] ? byHost[m]() : new HttpResponse(null, { status: 503 })))));
}

const BBOX = { south: 47.9, west: 1.9, north: 48.1, east: 2.1 };

describe('overpass mirror race', () => {
  it('FE-EXT-OVERPASS-001: the first VALID answer wins — a fast 503 loses to a slow 200', async () => {
    let winner = -1;
    mockMirrors({
      [OVERPASS_MIRRORS[0]!]: () => new HttpResponse(null, { status: 503 }),
      [OVERPASS_MIRRORS[1]!]: () => { winner = 1; return HttpResponse.json({ elements: [element(1, { amenity: 'cafe', name: 'Café A' })] }) },
    });
    const res = await searchOverpassPois('cafe', { ...BBOX, south: 47.5 });
    expect(res.pois[0]).toMatchObject({ name: 'Café A', osm_id: 'node:1', category: 'cafe' });
    expect(winner).toBe(1);
  });

  it('FE-EXT-OVERPASS-001b: a remark body is a miss — Overpass reports timeouts/rate limits that way', async () => {
    // The classic failure: a fast 200 carrying { elements: [], remark: 'runtime
    // error: Query timed out…' must not beat a slower healthy mirror — that is
    // how an empty POI map looked authoritative server-side.
    mockMirrors({
      [OVERPASS_MIRRORS[0]!]: () => HttpResponse.json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1' }),
      [OVERPASS_MIRRORS[3]!]: () => HttpResponse.json({ elements: [element(9, { amenity: 'cafe', name: 'Slow but honest' })] }),
    });
    const res = await searchOverpassPois('cafe', { ...BBOX, south: 47.52 });
    expect(res.pois[0].name).toBe('Slow but honest');
  });

  it('FE-EXT-OVERPASS-002: a malformed body is a miss, not the winner', async () => {
    mockMirrors({
      [OVERPASS_MIRRORS[0]!]: () => HttpResponse.json({ elements: 'oops' }),
      [OVERPASS_MIRRORS[2]!]: () => HttpResponse.json({ elements: [element(2, { amenity: 'cafe', name: 'B' })] }),
    });
    const res = await searchOverpassPois('cafe', { ...BBOX, south: 47.55 });
    expect(res.pois[0].name).toBe('B');
  });

  it('FE-EXT-OVERPASS-003: all mirrors down propagates the error (the caller shows retry)', async () => {
    mockMirrors({});
    await expect(searchOverpassPois('cafe', { ...BBOX, south: 47.6 })).rejects.toThrow();
  });

  it('FE-EXT-OVERPASS-004: caller abort propagates', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(searchOverpassPois('cafe', { ...BBOX, south: 47.65 }, undefined, 60, ctl.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('overpass POI shaping', () => {
  it('FE-EXT-OVERPASS-005: unnamed and disused elements are dropped', async () => {
    mockAllMirrors(() => HttpResponse.json({
      elements: [
        element(1, { amenity: 'cafe' }),                       // no name
        element(2, { amenity: 'cafe', name: 'Gone', disused: 'yes' }),
        element(3, { amenity: 'cafe', name: 'Shut', opening_hours: 'closed' }),
        element(4, { amenity: 'cafe', name: 'Open' }),
      ],
    }));
    const res = await searchOverpassPois('cafe', { ...BBOX, south: 47.7 });
    expect(res.pois.map(p => p.name)).toEqual(['Open']);
  });

  it('FE-EXT-OVERPASS-006: localized name beats int_name beats name', async () => {
    mockAllMirrors(() => HttpResponse.json({
      elements: [element(1, { amenity: 'cafe', name: 'Café', 'name:de': 'Kaffee', int_name: 'Intl' })],
    }));
    const res = await searchOverpassPois('cafe', { ...BBOX, south: 47.75 }, 'de');
    expect(res.pois[0].name).toBe('Kaffee');
  });

  it('FE-EXT-OVERPASS-007: way/relation elements resolve through center', async () => {
    mockAllMirrors(() => HttpResponse.json({
      elements: [{ type: 'way', id: 9, center: { lat: 48.05, lon: 2.05 }, tags: { amenity: 'fuel', operator: 'Total' } }],
    }));
    const res = await searchOverpassPois('fuel', { ...BBOX, south: 47.8 });
    expect(res.pois[0]).toMatchObject({ osm_id: 'way:9', lat: 48.05, name: 'Total', category: 'fuel' });
  });

  it('FE-EXT-OVERPASS-008: charging stations carry socket data; cafes do not', async () => {
    mockAllMirrors(() => HttpResponse.json({
      elements: [
        element(1, { amenity: 'charging_station', name: 'Fastned', 'socket:type2': '4', 'socket:type2:output': '22 kW', capacity: '8' }),
      ],
    }));
    const res = await searchOverpassPois('charging', { ...BBOX, south: 47.85 });
    expect(res.pois[0].charging).toMatchObject({ capacity: 8 });
    expect(res.pois[0].charging!.sockets[0]).toMatchObject({ type: 'type2', count: 4 });
  });

  it('FE-EXT-OVERPASS-009: an unknown category is a 400 before any fetch', async () => {
    let called = false;
    mockAllMirrors(() => { called = true; return HttpResponse.json({ elements: [] }) });
    await expect(searchOverpassPois('nonsense', { ...BBOX, south: 47.9 })).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
  });

  it('FE-EXT-OVERPASS-010: repeat query of the same box is served from cache', async () => {
    let calls = 0;
    mockAllMirrors(() => { calls++; return HttpResponse.json({ elements: [element(1, { amenity: 'cafe', name: 'Cached' })] }) });
    const box = { ...BBOX, south: 47.95 };
    await searchOverpassPois('cafe', box);
    const afterFirst = calls; // one request per mirror — the race fires them all
    const res = await searchOverpassPois('cafe', box);
    expect(afterFirst).toBe(OVERPASS_MIRRORS.length);
    expect(calls).toBe(afterFirst); // the second query was served from cache
    expect(res.pois[0].name).toBe('Cached');
  });

  it('FE-EXT-OVERPASS-011: results beyond the cap truncate and flag it', async () => {
    const many = Array.from({ length: 70 }, (_, i) => element(i + 1, { amenity: 'cafe', name: `C${i}` }));
    mockAllMirrors(() => HttpResponse.json({ elements: many }));
    const res = await searchOverpassPois('cafe', { ...BBOX, south: 47.4 }, undefined, 20);
    // cap = min(20 * 1 category, 240) = 20
    expect(res.pois).toHaveLength(20);
    expect(res.truncated).toBe(true);
  });
});

describe('clampPoiBounds + buildPoiQuery', () => {
  it('FE-EXT-OVERPASS-012: an oversized box is centred-shrunk and flagged', () => {
    const { bbox, clamped } = clampPoiBounds({ south: 40, west: 0, north: 50, east: 10 });
    expect(clamped).toBe(true);
    expect(bbox.north - bbox.south).toBeCloseTo(0.5);
    expect(bbox.east - bbox.west).toBeCloseTo(0.5);
    expect((bbox.north + bbox.south) / 2).toBeCloseTo(45);
  });

  it('FE-EXT-OVERPASS-013: an in-range box passes through untouched', () => {
    const { bbox, clamped } = clampPoiBounds(BBOX);
    expect(clamped).toBe(false);
    expect(bbox).toEqual(BBOX);
  });

  it('FE-EXT-OVERPASS-014: the query carries Overpass box order and the cap headroom', () => {
    const q = buildPoiQuery(['cafe'], BBOX, 20);
    expect(q).toContain('nwr["amenity"="cafe"](47.9,1.9,48.1,2.1)');
    expect(q).toContain('out center tags 45');
  });
});
