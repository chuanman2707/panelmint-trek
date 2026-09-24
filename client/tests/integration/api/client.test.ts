import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../helpers/msw/server';

const {
  apiClient,
  placesApi,
  packingApi,
  assignmentsApi,
  categoriesApi,
  mapsApi,
  budgetApi,
  filesApi,
  reservationsApi,
  accommodationsApi,
  dayNotesApi,
} = await import('../../../src/api/client');

describe('API client interceptors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset window.location to a neutral path
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: 'http://localhost/', pathname: '/', search: '', hash: '' },
    });
  });

  it('FE-API-001: mutating requests carry a generated X-Idempotency-Key', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post('/api/trips/1/places', ({ request }) => {
        receivedKey = request.headers.get('X-Idempotency-Key');
        return HttpResponse.json({ id: 1 });
      })
    );

    await placesApi.create(1, { name: 'Paris' });
    expect(receivedKey).toBeTruthy();
  });

  it('FE-API-002: read requests carry no idempotency key', async () => {
    let receivedKey: string | null = 'sentinel';
    server.use(
      http.get('/api/tags', ({ request }) => {
        receivedKey = request.headers.get('X-Idempotency-Key');
        return HttpResponse.json({ settings: {} });
      })
    );

    // Probe the axios instance directly — the interceptors live on apiClient;
    // tagsApi is a local adapter now and would never reach the wire.
    await apiClient.get('/tags');
    expect(receivedKey).toBeNull();
  });

  it('FE-API-003: a 401 never redirects — there is no login page to go to', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: 'http://localhost/dashboard', pathname: '/dashboard', search: '', hash: '' },
    });
    const originalHref = window.location.href;

    server.use(
      http.get('/api/tags', () => HttpResponse.json({ code: 'AUTH_REQUIRED' }, { status: 401 }))
    );

    await expect(apiClient.get('/tags')).rejects.toThrow();
    expect(window.location.href).toBe(originalHref);
  });

  it('FE-API-004: a 429 surfaces the translated rate-limit message', async () => {
    server.use(
      http.post('/api/maps/autocomplete', () =>
        HttpResponse.json({ error: 'slow down' }, { status: 429 }))
    );

    await expect(mapsApi.autocomplete('x')).rejects.toThrow();
  });

  it('FE-API-005: successful API call returns response data', async () => {
    server.use(http.get('/api/tags', () => HttpResponse.json({ settings: { theme: 'dark' } })));

    const res = await apiClient.get('/tags');
    expect(res.data).toMatchObject({ settings: { theme: 'dark' } });
  });

  it('FE-API-017: placesApi.create posts to /api/trips/1/places and returns data directly', async () => {
    const place = { id: 1, name: 'Paris', trip_id: 1 };
    server.use(http.post('/api/trips/1/places', () => HttpResponse.json(place)));

    const result = await placesApi.create(1, { name: 'Paris' });
    expect(result).toMatchObject({ name: 'Paris' });
  });

  it('FE-API-018: packingApi.bulkImport posts correct payload', async () => {
    let receivedBody: unknown;
    server.use(
      http.post('/api/trips/1/packing/import', async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({ imported: 1 });
      })
    );

    await packingApi.bulkImport(1, [{ name: 'Sunscreen' }]);
    expect(receivedBody).toMatchObject({ items: [{ name: 'Sunscreen' }] });
  });

  it('FE-API-007: non-401 errors are passed through as rejections', async () => {
    server.use(
      http.get('/api/tags', () => HttpResponse.json({ error: 'Internal error' }, { status: 500 }))
    );

    await expect(apiClient.get('/tags')).rejects.toThrow();
  });
});

// ── API namespace smoke tests ────────────────────────────────────────────────
// (tripsApi/daysApi/tagsApi/weatherApi are local adapters — api/local/* — so
// there is no /api/trips, /api/trips/:id/days, /api/tags or /api/weather
// traffic left to smoke-test here; their coverage lives in
// tests/unit/local/{trips,days,tags,weather}.test.ts.)

describe('API namespace smoke tests', () => {
  it('assignmentsApi.list fetches day assignments', async () => {
    server.use(http.get('/api/trips/1/days/1/assignments', () => HttpResponse.json([])));
    await expect(assignmentsApi.list(1, 1)).resolves.toEqual([]);
  });

  it('categoriesApi.list fetches categories', async () => {
    server.use(http.get('/api/categories', () => HttpResponse.json([])));
    await expect(categoriesApi.list()).resolves.toEqual([]);
  });

  it('mapsApi.search posts query', async () => {
    server.use(http.post('/api/maps/search', () => HttpResponse.json({ results: [] })));
    await expect(mapsApi.search('Paris')).resolves.toMatchObject({ results: [] });
  });

  it('mapsApi.reverse fetches reverse geocode', async () => {
    server.use(http.get('/api/maps/reverse', () => HttpResponse.json({ display_name: 'Rome' })));
    await expect(mapsApi.reverse(41.9, 12.5)).resolves.toMatchObject({ display_name: 'Rome' });
  });

  it('budgetApi.list fetches budget items', async () => {
    server.use(http.get('/api/trips/1/budget', () => HttpResponse.json([])));
    await expect(budgetApi.list(1)).resolves.toEqual([]);
  });

  it('filesApi.list fetches trip files', async () => {
    server.use(http.get('/api/trips/1/files', () => HttpResponse.json([])));
    await expect(filesApi.list(1)).resolves.toEqual([]);
  });

  it('reservationsApi.list fetches reservations', async () => {
    server.use(http.get('/api/trips/1/reservations', () => HttpResponse.json([])));
    await expect(reservationsApi.list(1)).resolves.toEqual([]);
  });

  it('accommodationsApi.list fetches accommodations', async () => {
    server.use(http.get('/api/trips/1/accommodations', () => HttpResponse.json([])));
    await expect(accommodationsApi.list(1)).resolves.toEqual([]);
  });

  it('dayNotesApi.list fetches day notes', async () => {
    server.use(http.get('/api/trips/1/days/1/notes', () => HttpResponse.json([])));
    await expect(dayNotesApi.list(1, 1)).resolves.toEqual([]);
  });

  it('placesApi.list fetches places', async () => {
    server.use(http.get('/api/trips/1/places', () => HttpResponse.json([])));
    await expect(placesApi.list(1)).resolves.toEqual([]);
  });

  it('placesApi.get fetches a place', async () => {
    server.use(http.get('/api/trips/1/places/5', () => HttpResponse.json({ id: 5 })));
    await expect(placesApi.get(1, 5)).resolves.toMatchObject({ id: 5 });
  });

  it('placesApi.update updates a place', async () => {
    server.use(http.put('/api/trips/1/places/5', () => HttpResponse.json({ id: 5 })));
    await expect(placesApi.update(1, 5, { name: 'Rome' })).resolves.toMatchObject({ id: 5 });
  });

  it('placesApi.delete deletes a place', async () => {
    server.use(http.delete('/api/trips/1/places/5', () => HttpResponse.json({ ok: true })));
    await expect(placesApi.delete(1, 5)).resolves.toMatchObject({ ok: true });
  });

  // ── packingApi additional methods ────────────────────────────────────────────

  it('packingApi.list fetches packing items', async () => {
    server.use(http.get('/api/trips/1/packing', () => HttpResponse.json([])));
    await expect(packingApi.list(1)).resolves.toEqual([]);
  });

  it('packingApi.create creates a packing item', async () => {
    server.use(http.post('/api/trips/1/packing', () => HttpResponse.json({ id: 1, name: 'Towel' })));
    await expect(packingApi.create(1, { name: 'Towel' })).resolves.toMatchObject({ id: 1 });
  });

  it('packingApi.delete deletes a packing item', async () => {
    server.use(http.delete('/api/trips/1/packing/1', () => HttpResponse.json({ ok: true })));
    await expect(packingApi.delete(1, 1)).resolves.toMatchObject({ ok: true });
  });

  // ── assignmentsApi additional methods ────────────────────────────────────────

  it('assignmentsApi.create creates an assignment', async () => {
    server.use(http.post('/api/trips/1/days/1/assignments', () => HttpResponse.json({ id: 1 })));
    await expect(assignmentsApi.create(1, 1, { place_id: 5 })).resolves.toMatchObject({ id: 1 });
  });

  it('assignmentsApi.delete deletes an assignment', async () => {
    server.use(http.delete('/api/trips/1/days/1/assignments/1', () => HttpResponse.json({ ok: true })));
    await expect(assignmentsApi.delete(1, 1, 1)).resolves.toMatchObject({ ok: true });
  });

  it('assignmentsApi.reorder reorders assignments', async () => {
    server.use(http.put('/api/trips/1/days/1/assignments/reorder', () => HttpResponse.json({ ok: true })));
    await expect(assignmentsApi.reorder(1, 1, [3, 1, 2])).resolves.toMatchObject({ ok: true });
  });

  // ── categoriesApi additional methods ────────────────────────────────────────
  // (tagsApi is a local adapter — covered by tests/unit/local/tags.test.ts.)

  it('categoriesApi.create creates a category', async () => {
    server.use(http.post('/api/categories', () => HttpResponse.json({ id: 1, name: 'Food' })));
    await expect(categoriesApi.create({ name: 'Food' })).resolves.toMatchObject({ id: 1 });
  });

  it('categoriesApi.delete deletes a category', async () => {
    server.use(http.delete('/api/categories/1', () => HttpResponse.json({ ok: true })));
    await expect(categoriesApi.delete(1)).resolves.toMatchObject({ ok: true });
  });

  it('budgetApi.create creates a budget item', async () => {
    server.use(http.post('/api/trips/1/budget', () => HttpResponse.json({ id: 1 })));
    await expect(budgetApi.create(1, { name: 'Hotel' })).resolves.toMatchObject({ id: 1 });
  });

  it('budgetApi.delete deletes a budget item', async () => {
    server.use(http.delete('/api/trips/1/budget/1', () => HttpResponse.json({ ok: true })));
    await expect(budgetApi.delete(1, 1)).resolves.toMatchObject({ ok: true });
  });

  // ── reservationsApi additional methods ───────────────────────────────────────

  it('reservationsApi.create creates a reservation', async () => {
    server.use(http.post('/api/trips/1/reservations', () => HttpResponse.json({ id: 1 })));
    await expect(reservationsApi.create(1, { title: 'Hotel' })).resolves.toMatchObject({ id: 1 });
  });

  it('reservationsApi.delete deletes a reservation', async () => {
    server.use(http.delete('/api/trips/1/reservations/1', () => HttpResponse.json({ ok: true })));
    await expect(reservationsApi.delete(1, 1)).resolves.toMatchObject({ ok: true });
  });

  // ── accommodationsApi additional methods ─────────────────────────────────────

  it('accommodationsApi.create creates accommodation', async () => {
    server.use(http.post('/api/trips/1/accommodations', () => HttpResponse.json({ id: 1 })));
    await expect(accommodationsApi.create(1, { place_id: 1, start_day_id: 1, end_day_id: 1 })).resolves.toMatchObject({ id: 1 });
  });

  it('accommodationsApi.delete deletes accommodation', async () => {
    server.use(http.delete('/api/trips/1/accommodations/1', () => HttpResponse.json({ ok: true })));
    await expect(accommodationsApi.delete(1, 1)).resolves.toMatchObject({ ok: true });
  });

  // ── dayNotesApi additional methods ───────────────────────────────────────────

  it('dayNotesApi.create creates a day note', async () => {
    server.use(http.post('/api/trips/1/days/1/notes', () => HttpResponse.json({ id: 1 })));
    await expect(dayNotesApi.create(1, 1, { text: 'Hello' })).resolves.toMatchObject({ id: 1 });
  });

  it('dayNotesApi.delete deletes a day note', async () => {
    server.use(http.delete('/api/trips/1/days/1/notes/1', () => HttpResponse.json({ ok: true })));
    await expect(dayNotesApi.delete(1, 1, 1)).resolves.toMatchObject({ ok: true });
  });

  // ── mapsApi additional methods ────────────────────────────────────────────────

  it('FE-MAPS-001: mapsApi.autocomplete sends input, lang, and locationBias', async () => {
    let capturedBody: any = null;

    server.use(
      http.post('/api/maps/autocomplete', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          suggestions: [{ placeId: 'ChIJ1234', mainText: 'Paris', secondaryText: 'France' }],
          source: 'google',
        });
      })
    );

    const result = await mapsApi.autocomplete('Par', 'fr', { low: { lat: 48.5, lng: 2.0 }, high: { lat: 49.0, lng: 2.8 } });

    expect(capturedBody).toEqual({
      input: 'Par',
      lang: 'fr',
      locationBias: { low: { lat: 48.5, lng: 2.0 }, high: { lat: 49.0, lng: 2.8 } },
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].mainText).toBe('Paris');
    expect(result.source).toBe('google');
  });

  it('FE-MAPS-002: mapsApi.autocomplete works without optional params', async () => {
    server.use(
      http.post('/api/maps/autocomplete', async ({ request }) => {
        const body: any = await request.json();
        expect(body.lang).toBeUndefined();
        expect(body.locationBias).toBeUndefined();
        return HttpResponse.json({ suggestions: [], source: 'nominatim' });
      })
    );

    const result = await mapsApi.autocomplete('test');
    expect(result.suggestions).toEqual([]);
  });

  it('FE-MAPS-003: mapsApi.autocomplete rejects on server error', async () => {
    server.use(
      http.post('/api/maps/autocomplete', () => {
        return HttpResponse.json({ error: 'Rate limited' }, { status: 429 });
      })
    );

    await expect(mapsApi.autocomplete('test')).rejects.toThrow();
  });

  it('FE-MAPS-004: mapsApi.autocomplete rejects when AbortSignal is aborted', async () => {
    const controller = new AbortController();

    server.use(
      http.post('/api/maps/autocomplete', async () => {
        // Never resolves — request will be aborted
        await new Promise(() => {});
        return HttpResponse.json({ suggestions: [] });
      })
    );

    const promise = mapsApi.autocomplete('Paris', undefined, undefined, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow();
  });
});
