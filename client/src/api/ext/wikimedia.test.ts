/**
 * `ext/wikimedia` — the free enrichment ladder. MSW stands in for Wikidata and
 * the two encyclopaedias; the assertions pin the description ladder, the
 * facts/hours/rating derivation and the positive/negative cache split. The
 * photo ladder is gone with the photo UI: `photos` is pinned empty.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { enrich, collectFacts, collectHours, collectRating } from './wikimedia';

const WIKIDATA = 'https://www.wikidata.org/w/api.php';

function wikiExtract(text: string, title = 'Eiffel Tower') {
  return { query: { pages: { '1': { title, extract: text } } } };
}

beforeEach(() => {
  // Defaults: every wiki endpoint answers "nothing".
  server.use(
    http.get(WIKIDATA, () => HttpResponse.json({ entities: {} })),
    http.get('https://en.wikivoyage.org/w/api.php', () => HttpResponse.json({ query: { pages: {} } })),
    http.get('https://en.wikipedia.org/w/api.php', () => HttpResponse.json({ query: { pages: {} } })),
    http.get('https://nominatim.openstreetmap.org/search', () => HttpResponse.json([])),
  );
});

describe('pure helpers', () => {
  it('FE-EXT-WIKI-003: collectFacts reads OSM tags only from OSM records', () => {
    const facts = collectFacts({ source: 'openstreetmap', cuisine: 'french;italian', wheelchair: 'yes', takeaway: 'no' });
    const labels = facts.map(f => `${f.kind}:${f.value}`);
    expect(labels).toContain('cuisine:french, italian');
    expect(labels).toContain('wheelchair:yes');
    expect(collectFacts({ source: 'other', cuisine: 'french' })).toEqual([]);
  });

  it('FE-EXT-WIKI-004: collectHours + collectRating from details', () => {
    const hours = collectHours({ opening_hours: ['Monday: 9:00 AM – 6:00 PM'], opening_periods: [{ open: { day: 1, hour: 9, minute: 0 } }] });
    expect(hours).toMatchObject({ weekdayDescriptions: ['Monday: 9:00 AM – 6:00 PM'] });
    expect(collectHours({ opening_hours: 'Mo-Fr 09:00-18:00' })).toBeNull(); // OSM raw strings are not weekday lines
    expect(collectRating({ rating: 4.5, rating_count: 120 })).toEqual({ value: 4.5, count: 120 });
    expect(collectRating({})).toBeNull();
  });
});

describe('enrich', () => {
  it('FE-EXT-WIKI-006: caller-supplied wikipedia tag → wikivoyage-first description', async () => {
    server.use(
      http.get('https://en.wikivoyage.org/w/api.php', () =>
        HttpResponse.json(wikiExtract('A tower worth visiting.'))),
    );
    const res = await enrich({
      placeId: 'node:1', lat: 48.85, lng: 2.29, name: 'Eiffel Tower', lang: 'en',
      details: { wikipedia: 'en:Eiffel Tower', source: 'openstreetmap' },
    });
    expect(res.description).toMatchObject({ source: 'wikivoyage', text: 'A tower worth visiting.' });
    expect(res.photos).toEqual([]);
  });

  it('FE-EXT-WIKI-008: no identity and no details answers the empty result, not an error', async () => {
    const res = await enrich({ lat: 10, lng: 10, name: 'Nowhere', lang: 'en' });
    expect(res).toMatchObject({ photos: [], description: null, facts: [] });
  });

  it('FE-EXT-WIKI-009: an OSM summary in the caller details wins over the encyclopaedias', async () => {
    let wikiCalled = false;
    server.use(http.get('https://en.wikivoyage.org/w/api.php', () => {
      wikiCalled = true; return HttpResponse.json(wikiExtract('x'));
    }));
    const res = await enrich({
      placeId: 'node:2', lat: 1, lng: 2, name: 'Cafe', lang: 'en',
      details: {
        source: 'openstreetmap',
        summary: 'A quiet courtyard cafe.',
        osm_url: 'https://www.openstreetmap.org/node/2',
      },
    });
    expect(res.description).toMatchObject({ source: 'osm', text: 'A quiet courtyard cafe.', license: 'ODbL 1.0' });
    expect(wikiCalled).toBe(false);
  });

  it('FE-EXT-WIKI-010: an empty answer is cached for its short TTL — the repeat call does not re-fetch', async () => {
    let nominatimCalls = 0;
    server.use(http.get('https://nominatim.openstreetmap.org/search', () => {
      nominatimCalls++; return HttpResponse.json([]);
    }));
    // No placeId → no details fetch; the identity lookup is the only outbound call.
    const req = { lat: 3, lng: 4, name: 'Uncached Emptiness', lang: 'en' };
    await enrich(req);
    const afterFirst = nominatimCalls;
    await enrich(req);
    expect(afterFirst).toBe(1);
    expect(nominatimCalls).toBe(1);
  });
});
