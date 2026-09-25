/**
 * `ext/wikimedia` — the free enrichment ladder. MSW stands in for Commons,
 * Wikidata and the two encyclopaedias; the assertions pin the rung order
 * (Wikidata → wiki lead → category → nearby), the credit-line bookkeeping
 * `placePhotoCredit` later reads, the facts/hours/rating derivation and the
 * positive/negative cache split.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import {
  enrich, photoCredit, candidateKey, creditLine,
  collectFacts, collectHours, collectRating, nearbyWouldMislead,
} from './wikimedia';

const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';

/** A Commons query response carrying one usable file. */
function commonsPage(pageid: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    pageid, title,
    imageinfo: [{
      url: `https://upload.wikimedia.org/${title}`,
      thumburl: `https://upload.wikimedia.org/thumb/${title}`,
      mime: 'image/jpeg', width: 2000, height: 1200,
      descriptionurl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
      extmetadata: {
        Artist: { value: 'Alice Example' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
        ...extra,
      },
    }],
  };
}

function wikiExtract(text: string, title = 'Eiffel Tower') {
  return { query: { pages: { '1': { title, extract: text } } } };
}

beforeEach(() => {
  // Defaults: every wiki endpoint answers "nothing".
  server.use(
    http.get(COMMONS, () => HttpResponse.json({ query: { pages: {} } })),
    http.get(WIKIDATA, () => HttpResponse.json({ entities: {} })),
    http.get('https://en.wikivoyage.org/w/api.php', () => HttpResponse.json({ query: { pages: {} } })),
    http.get('https://en.wikipedia.org/w/api.php', () => HttpResponse.json({ query: { pages: {} } })),
    http.get('https://nominatim.openstreetmap.org/search', () => HttpResponse.json([])),
  );
});

describe('pure helpers', () => {
  it('FE-EXT-WIKI-001: creditLine joins attribution and license, either alone survives', () => {
    expect(creditLine('Alice', 'CC BY-SA')).toBe('Alice · CC BY-SA');
    expect(creditLine('Alice', null)).toBe('Alice');
    expect(creditLine(null, null)).toBeNull();
  });

  it('FE-EXT-WIKI-002: candidateKey is stable per place+identity, differs per picture', () => {
    expect(candidateKey('p1', 'commons:5')).toBe(candidateKey('p1', 'commons:5'));
    expect(candidateKey('p1', 'commons:5')).not.toBe(candidateKey('p1', 'commons:6'));
    expect(candidateKey('p1', 'commons:5')).toMatch(/^p1~p[0-9a-f]{8}$/);
  });

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

  it('FE-EXT-WIKI-005: nearbyWouldMislead fires on food rows and fails open on unknowns', () => {
    expect(nearbyWouldMislead({ amenity: 'cafe' })).toBe(true);
    expect(nearbyWouldMislead({ tourism: 'museum' })).toBe(false);
    expect(nearbyWouldMislead(null)).toBe(false);
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
  });

  it('FE-EXT-WIKI-007: wikidata claims become candidates and the credit is recorded', async () => {
    server.use(
      http.get(WIKIDATA, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('props') === 'claims') {
          return HttpResponse.json({
            entities: {
              Q243: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Eiffel_Tower_2024.jpg' } } }] } },
            },
          });
        }
        return HttpResponse.json({ entities: {} });
      }),
      http.get(COMMONS, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('titles')) {
          return HttpResponse.json({ query: { pages: { '77': commonsPage(77, 'File:Eiffel Tower 2024.jpg') } } });
        }
        return HttpResponse.json({ query: { pages: {} } });
      }),
    );
    const res = await enrich({
      placeId: 'node:9', lat: 48.85, lng: 2.29, name: 'Eiffel Tower', lang: 'en',
      details: { wikidata: 'Q243' },
    });
    expect(res.photos).toHaveLength(1);
    expect(res.photos[0]).toMatchObject({
      url: 'https://upload.wikimedia.org/thumb/File:Eiffel Tower 2024.jpg',
      attribution: 'Alice Example',
      license: 'CC BY-SA 4.0',
      source: 'wikimedia',
    });
    // The credit the strip showed is retrievable by the same key afterwards.
    expect(photoCredit(res.photos[0].key)).toEqual({ credit: 'Alice Example · CC BY-SA 4.0' });
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
