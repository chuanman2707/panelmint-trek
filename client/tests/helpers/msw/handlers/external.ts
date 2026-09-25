import { http, HttpResponse } from 'msw';

/**
 * Third-party endpoints the app calls directly, rather than through /api.
 *
 * Without these the call is refused: tests/setup.ts errors on an unhandled request to
 * another origin. It used to warn and then perform the request, which is how the mobile
 * FX widget reached api.frankfurter.dev from CI and settled its promise after the test
 * environment was gone, surfacing as `window is not defined` attributed to whichever
 * case happened to be running. Add the endpoint here rather than letting it out.
 *
 * An empty rate list is the shape the widget already handles: it seeds the
 * base's own self-rate and renders with nothing else selectable.
 */
export const externalHandlers = [
  http.get('https://api.frankfurter.dev/v2/rates', () => HttpResponse.json([])),
  http.get('https://api.frankfurter.dev/v2/currencies', () => HttpResponse.json({})),
  /**
   * The public Valhalla, answered as unreachable by default.
   *
   * It is a shipped default rather than a configured host, so every alternatives test
   * reaches it without asking for it, and the warn-then-perform path above sent those
   * requests to the real FOSSGIS instance — a test asserting a fixed divergence point
   * got a genuine one off the A2 instead, which fails differently on every OSM update.
   *
   * 503 rather than 404 on purpose: the adapter remembers a 404 as "this host is not a
   * Valhalla" in module state, which would then leak into whichever file ran next. A
   * 503 is about this request alone, so it lands as the null every caller already
   * handles and the OSRM path takes over exactly as it did before. A test about the
   * Valhalla path overrides this with server.use().
   */
  http.post('https://valhalla1.openstreetmap.de/route', () => new HttpResponse(null, { status: 503 })),
  /**
   * Open-Meteo — the local weather adapter (src/api/local/weather.ts) fetches it
   * straight from the browser now that no server sits in between. Both hosts get
   * a default so a stray weather call in an unrelated test cannot egress.
   *
   * The default answers "provider has no data": an empty `daily`/`hourly` series
   * makes the ported transform resolve to `{ error: 'no_forecast' }` (the shape
   * consumers render as "No weather"), while the `current` block keeps
   * `getCurrentWeather` resolving instead of tripping the 502 cap guard. A test
   * about the weather itself overrides this with server.use().
   */
  http.get('https://api.open-meteo.com/v1/forecast', () =>
    HttpResponse.json({
      current: { temperature_2m: 20, weathercode: 0 },
      daily: { time: [] },
      hourly: { time: [] },
    })),
  http.get('https://archive-api.open-meteo.com/v1/archive', () =>
    HttpResponse.json({
      daily: { time: [] },
      hourly: { time: [] },
    })),

  /**
   * The places ext clients (src/api/ext/*) — the local mapsApi facade calls
   * them straight from the browser. Every default answers "provider has no
   * data": Photon/Nominatim get empty result sets so the search→fallback
   * ladder resolves to `{ places: [] }` instead of egressing; the Overpass
   * mirrors get an empty `elements` page; the wiki endpoints get a 404, which
   * `ext/wikimedia` already reads as "no enrichment for this place". A test
   * about the providers overrides with server.use().
   */
  http.get('https://photon.komoot.io/api/', () => HttpResponse.json({ features: [] })),
  http.get('https://nominatim.openstreetmap.org/*', () => HttpResponse.json([])),
  http.post('https://overpass-api.de/api/interpreter', () => HttpResponse.json({ elements: [] })),
  http.post('https://overpass.kumi.systems/api/interpreter', () => HttpResponse.json({ elements: [] })),
  http.post('https://overpass.private.coffee/api/interpreter', () => HttpResponse.json({ elements: [] })),
  http.post('https://maps.mail.ru/osm/tools/overpass/api/interpreter', () => HttpResponse.json({ elements: [] })),
  http.get('https://en.wikipedia.org/*', () => new HttpResponse(null, { status: 404 })),
  http.get('https://en.wikivoyage.org/*', () => new HttpResponse(null, { status: 404 })),
  http.get('https://www.wikidata.org/*', () => new HttpResponse(null, { status: 404 })),
  http.get('https://commons.wikimedia.org/*', () => HttpResponse.json({ query: { pages: {} } })),
];
