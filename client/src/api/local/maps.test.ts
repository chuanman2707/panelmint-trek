/**
 * `mapsApi` facade tests. The facade itself is a delegation layer — the
 * assertions pin which ext module answers which method, in which envelope,
 * and that the removed-server stub (`area`) answers honestly
 * instead of throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../ext/places', () => ({
  search: vi.fn(async () => ({ places: [], source: 'openstreetmap' })),
  autocomplete: vi.fn(async () => ({ suggestions: [], source: 'openstreetmap' })),
  details: vi.fn(async () => ({ place: null })),
  reverse: vi.fn(async () => ({ name: 'X', address: 'Y' })),
  resolveUrl: vi.fn(async () => ({ lat: 1, lng: 2, name: 'N', address: null, google_ftid: null })),
  resolveOsmIdentity: vi.fn(async () => null),
}));
vi.mock('../ext/wikimedia', () => ({
  enrich: vi.fn(async () => ({ photos: [], description: null, facts: [] })),
}));
vi.mock('../ext/overpass', () => ({
  searchOverpassPois: vi.fn(async () => ({ pois: [], source: 'openstreetmap', truncated: false, clamped: false })),
}));

import { mapsApi } from './maps';
import * as extPlaces from '../ext/places';
import { enrich } from '../ext/wikimedia';
import { searchOverpassPois } from '../ext/overpass';

beforeEach(() => vi.clearAllMocks());

describe('mapsApi facade', () => {
  it('FE-LOCAL-MAPS-001: search delegates to ext/places and drops the google provider slot', async () => {
    await mapsApi.search('tower', 'en', { lat: 1, lng: 2, radius: 5 }, 'google');
    expect(extPlaces.search).toHaveBeenCalledWith('tower', 'en', { lat: 1, lng: 2, radius: 5 });
  });

  it('FE-LOCAL-MAPS-002: autocomplete keeps the axios argument order', async () => {
    const signal = new AbortController().signal;
    const bias = { low: { lat: 0, lng: 0 }, high: { lat: 1, lng: 1 } };
    await mapsApi.autocomplete('eif', 'de', bias, signal, 'tok');
    expect(extPlaces.autocomplete).toHaveBeenCalledWith('eif', 'de', bias, 'tok', signal);
  });

  it('FE-LOCAL-MAPS-003: details delegates unchanged', async () => {
    await mapsApi.details('node:123', 'en', 'tok');
    expect(extPlaces.details).toHaveBeenCalledWith('node:123', 'en', 'tok');
  });

  it('FE-LOCAL-MAPS-004: placeEnrichment forwards the body and signal', async () => {
    const signal = new AbortController().signal;
    const body = { lat: 1, lng: 2, name: 'X' };
    await mapsApi.placeEnrichment(body, signal);
    expect(enrich).toHaveBeenCalledWith(body, signal);
  });

  it('FE-LOCAL-MAPS-007: reverse and resolveUrl delegate', async () => {
    await mapsApi.reverse(48.8, 2.3, 'fr');
    expect(extPlaces.reverse).toHaveBeenCalledWith(48.8, 2.3, 'fr');
    await mapsApi.resolveUrl('https://maps.google.com/@48.8,2.3');
    expect(extPlaces.resolveUrl).toHaveBeenCalledWith('https://maps.google.com/@48.8,2.3');
  });

  it('FE-LOCAL-MAPS-008: pois delegates to Overpass with the facade\'s cap', async () => {
    const bbox = { south: 1, west: 2, north: 3, east: 4 };
    const signal = new AbortController().signal;
    await mapsApi.pois('cafe', bbox, 'en', signal);
    expect(searchOverpassPois).toHaveBeenCalledWith('cafe', bbox, 'en', 60, signal);
  });

  it('FE-LOCAL-MAPS-009: area says there is no index instead of pretending', async () => {
    expect(await mapsApi.area({ minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }))
      .toEqual({ results: [], truncated: false, unavailable: true });
  });
});
