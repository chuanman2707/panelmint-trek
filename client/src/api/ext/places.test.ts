/**
 * `ext/places` — the browser-side geocoding client. MSW answers Photon and
 * Nominatim; the assertions pin the fallback ladder (Photon → Nominatim →
 * empty), the schema-normalised envelopes, the OSM-id gate on `details`, and
 * `resolveUrl`'s no-fetch rule: a coordinate-bearing URL resolves off its
 * text, everything else is the server's old 400.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { search, autocomplete, details, reverse, resolveUrl, resolveOsmIdentity } from './places';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

function photonFeature(overrides: Record<string, unknown> = {}) {
  return {
    geometry: { coordinates: [2.2945, 48.8584] },
    properties: {
      osm_type: 'N', osm_id: 12345, name: 'Eiffel Tower',
      city: 'Paris', country: 'France', ...overrides,
    },
  };
}

function nominatimItem(overrides: Record<string, unknown> = {}) {
  return {
    osm_type: 'node', osm_id: 12345, lat: '48.8584', lon: '2.2945',
    display_name: 'Eiffel Tower, Paris, France', importance: 0.9,
    ...overrides,
  };
}

beforeEach(() => {
  server.use(
    // Default: both providers empty; individual tests override.
    http.get(`${PHOTON}*`, () => HttpResponse.json({ features: [] })),
    http.get(`${NOMINATIM}/search`, () => HttpResponse.json([])),
    http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json({})),
    http.get(`${NOMINATIM}/lookup`, () => HttpResponse.json([])),
  );
});

describe('ext/places search', () => {
  it('FE-EXT-PLACES-001: Photon answers first — Nominatim is never asked', async () => {
    let nominatimCalled = false;
    server.use(
      http.get(`${PHOTON}*`, () => HttpResponse.json({ features: [photonFeature()] })),
      http.get(`${NOMINATIM}/search`, () => { nominatimCalled = true; return HttpResponse.json([]) }),
    );
    const res = await search('eiffel', 'en');
    expect(res.source).toBe('openstreetmap');
    expect(res.places).toHaveLength(1);
    expect(res.places[0]).toMatchObject({ name: 'Eiffel Tower', osm_id: 'node:12345' });
    expect(nominatimCalled).toBe(false);
  });

  it('FE-EXT-PLACES-002: Photon down → Nominatim answers', async () => {
    server.use(
      http.get(`${PHOTON}*`, () => new HttpResponse(null, { status: 503 })),
      http.get(`${NOMINATIM}/search`, () => HttpResponse.json([nominatimItem()])),
    );
    const res = await search('eiffel');
    expect(res.places).toHaveLength(1);
    expect(res.places[0].name).toBe('Eiffel Tower');
  });

  it('FE-EXT-PLACES-003: both providers failing answers the empty envelope, not an error', async () => {
    server.use(
      http.get(`${PHOTON}*`, () => new HttpResponse(null, { status: 503 })),
      http.get(`${NOMINATIM}/search`, () => new HttpResponse(null, { status: 500 })),
    );
    const res = await search('eiffel');
    expect(res).toEqual({ places: [], source: 'openstreetmap' });
  });

  it('FE-EXT-PLACES-004: a blank query short-circuits before any fetch', async () => {
    let called = false;
    server.use(http.get(`${PHOTON}*`, () => { called = true; return HttpResponse.json({ features: [] }) }));
    expect(await search('   ')).toEqual({ places: [], source: 'openstreetmap' });
    expect(called).toBe(false);
  });

  it('FE-EXT-PLACES-005: malformed Photon payloads fall through to Nominatim', async () => {
    server.use(
      http.get(`${PHOTON}*`, () => HttpResponse.json({ nope: true })),
      http.get(`${NOMINATIM}/search`, () => HttpResponse.json([nominatimItem({ display_name: 'X' })])),
    );
    const res = await search('x');
    expect(res.places).toHaveLength(1);
  });
});

describe('ext/places autocomplete', () => {
  it('FE-EXT-PLACES-006: Photon rows become suggestions with per-row source', async () => {
    server.use(http.get(`${PHOTON}*`, () => HttpResponse.json({ features: [photonFeature()] })));
    const res = await autocomplete('eif');
    expect(res.suggestions[0]).toMatchObject({
      placeId: 'node:12345', mainText: 'Eiffel Tower', source: 'openstreetmap',
    });
  });

  it('FE-EXT-PLACES-007: Photon empty → Nominatim fallback names its own source', async () => {
    server.use(
      http.get(`${PHOTON}*`, () => HttpResponse.json({ features: [] })),
      http.get(`${NOMINATIM}/search`, () => HttpResponse.json([nominatimItem()])),
    );
    const res = await autocomplete('eif');
    expect(res.source).toBe('nominatim');
    expect(res.suggestions[0].placeId).toBe('node:12345');
  });
});

describe('ext/places details', () => {
  it('FE-EXT-PLACES-008: a non-OSM place id is a quiet miss — no fetch goes out', async () => {
    let called = false;
    server.use(http.get(`${NOMINATIM}/lookup`, () => { called = true; return HttpResponse.json([]) }));
    expect(await details('ChIJlegacy')).toEqual({ place: null });
    expect(called).toBe(false);
  });

  it('FE-EXT-PLACES-009: Nominatim lookup fills name/address for an osm id', async () => {
    server.use(
      http.get(`${NOMINATIM}/lookup`, () => HttpResponse.json([nominatimItem()])),
      // Overpass mirrors stay quiet — malformed answers exercise the soft path.
      http.post('https://overpass-api.de/api/interpreter', () => HttpResponse.json({ elements: [] })),
      http.post('https://maps.mail.ru/osm/tools/overpass/api/interpreter', () => HttpResponse.json({ elements: [] })),
      http.post('https://overpass.kumi.systems/api/interpreter', () => HttpResponse.json({ elements: [] })),
      http.post('https://overpass.private.coffee/api/interpreter', () => HttpResponse.json({ elements: [] })),
    );
    const res = await details('node:12345', 'en');
    expect(res.place).toMatchObject({ name: 'Eiffel Tower', osm_id: 'node:12345' });
  });
});

describe('ext/places reverse', () => {
  it('FE-EXT-PLACES-010: a non-ok reverse is a null answer, not a throw', async () => {
    server.use(http.get(`${NOMINATIM}/reverse`, () => new HttpResponse(null, { status: 500 })));
    expect(await reverse(48, 2)).toEqual({ name: null, address: null });
  });

  it('FE-EXT-PLACES-011: locality mode prefers the city name', async () => {
    server.use(http.get(`${NOMINATIM}/reverse`, () =>
      HttpResponse.json({ display_name: 'Paris, France', name: 'Tour Eiffel', address: { city: 'Paris' } })));
    expect(await reverse(48, 2, 'en', { locality: true })).toEqual({ name: 'Paris', address: 'Paris, France' });
  });
});

describe('ext/places resolveUrl — text-only, never fetches the URL', () => {
  it('FE-EXT-PLACES-012: a @lat,lng Google Maps URL resolves off its text', async () => {
    server.use(http.get(`${NOMINATIM}/reverse`, () =>
      HttpResponse.json({ display_name: 'Somewhere, FR', name: 'Spot' })));
    const res = await resolveUrl('https://www.google.com/maps/place/Eiffel+Tower/@48.8584,2.2945,17z');
    expect(res).toMatchObject({ lat: 48.8584, lng: 2.2945, name: 'Eiffel Tower', address: 'Somewhere, FR' });
  });

  it('FE-EXT-PLACES-013: !3d/!4d data params resolve too', async () => {
    server.use(http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json({})));
    const res = await resolveUrl('https://maps.google.com/?cid=1&data=!3m1!4b1!4m2!3d48.8584!4d2.2945');
    expect(res).toMatchObject({ lat: 48.8584, lng: 2.2945 });
  });

  it('FE-EXT-PLACES-014: a short link is a 400 — the redirect is never followed', async () => {
    let fetched = false;
    server.use(http.get('https://maps.app.goo.gl/*', () => { fetched = true; return HttpResponse.text('') }));
    await expect(resolveUrl('https://maps.app.goo.gl/abc')).rejects.toMatchObject({ status: 400 });
    expect(fetched).toBe(false);
  });

  it('FE-EXT-PLACES-015: an unparseable string is a 400', async () => {
    await expect(resolveUrl('not a url')).rejects.toMatchObject({ status: 400 });
  });

  it('FE-EXT-PLACES-016: an Amap link converts GCJ-02 and keeps the name param', async () => {
    server.use(http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json({ display_name: 'Shanghai' })));
    const res = await resolveUrl('https://uri.amap.com/marker?position=121.4737,31.2304&name=Bund');
    expect(res.name).toBe('Bund');
    // GCJ-02 → WGS-84: the answer is near, but not equal to, the raw numbers.
    expect(Math.abs(res.lat - 31.2304)).toBeLessThan(0.01);
    expect(res.lat).not.toBe(31.2304);
  });
});

describe('ext/places resolveOsmIdentity', () => {
  it('FE-EXT-PLACES-017: picks the in-range hit whose name overlaps', async () => {
    server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json([
      // Wrong side of the city — filtered by distance.
      nominatimItem({ osm_id: 1, lat: '50.0', lon: '2.3', name: 'Eiffel Tower' }),
      // In range, name overlaps.
      nominatimItem({ osm_id: 2, lat: '48.8584', lon: '2.2945', name: 'Eiffel Tower', extratags: { wikidata: 'Q243' } }),
    ])));
    const res = await resolveOsmIdentity('Eiffel Tower', 48.8584, 2.2945);
    expect(res?.osmUrl).toBe('https://www.openstreetmap.org/node/2');
    expect(res?.tags.wikidata).toBe('Q243');
  });

  it('FE-EXT-PLACES-018: a name that shares no word is not an identity', async () => {
    server.use(http.get(`${NOMINATIM}/search`, () =>
      HttpResponse.json([nominatimItem({ name: 'Something Else', lat: '48.8584', lon: '2.2945' })])));
    expect(await resolveOsmIdentity('Eiffel Tower', 48.8584, 2.2945)).toBeNull();
  });
});
