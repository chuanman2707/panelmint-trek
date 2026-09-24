/**
 * Parity tests for the local `weatherApi` — the adapter that replaced
 * `apiClient.get('/weather', …)` over `api/ext/openmeteo.ts`. Pins the
 * controller's bespoke 400s, the ApiError → error-envelope mapping the Nest
 * `toHttp` produced (status + `{error}` readable via `err.response`), the
 * 'de' language default, and the `no_forecast` body passthrough. `fetch` is
 * stubbed — the Open-Meteo provider behaviour itself lives in
 * tests/unit/ext/openmeteo.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { weatherApi } from '../../../src/api/local/weather';
import { clearWeatherCache } from '../../../src/api/ext/openmeteo';
import { LocalApiError } from '../../../src/api/local/helpers';

const jsonResponse = (body: unknown, init: { status?: number } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200 });

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

const fetchMock = () => {
  const fn = vi.fn(async (_url: string) => jsonResponse({}));
  vi.stubGlobal('fetch', fn);
  return fn;
};

beforeEach(() => clearWeatherCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('weatherApi.get — controller 400s', () => {
  it('missing lat/lng answer 400 Latitude and longitude are required', async () => {
    for (const [lat, lng] of [[undefined, 11.5], [48.1, undefined], [undefined, undefined]] as const) {
      const err = await fail(weatherApi.get(lat as never, lng as never, '2026-03-01'));
      expect(err).toBeInstanceOf(LocalApiError);
      expect(err.response.status).toBe(400);
      expect(err.response.data.error).toBe('Latitude and longitude are required');
    }
    // The axios route was a rejection, not a sync throw.
    await expect(weatherApi.get(undefined as never, 0, '2026-03-01')).rejects.toBeInstanceOf(LocalApiError);
  });

  it('out-of-range coordinates carry the impl\'s 400 through unchanged', async () => {
    const err = await fail(weatherApi.get(91, 0, '2026-03-01'));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('Invalid latitude');
  });

  it('NaN reaches the coordinate check like the serialized NaN param did', async () => {
    const err = await fail(weatherApi.get(NaN, 0, '2026-03-01'));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toBe('Invalid latitude');
  });
});

describe('weatherApi.get — provider + fallback errors', () => {
  it('an ApiError keeps its status and message in the axios-shaped envelope', async () => {
    fetchMock().mockImplementation(async () => jsonResponse({ error: true, reason: 'quota exceeded' }, { status: 429 }));
    const err = await fail(weatherApi.get(48.1, 11.5, '2026-03-01', 'en'));
    expect(err).toBeInstanceOf(LocalApiError);
    expect(err.status).toBe(429);
    expect(err.response.status).toBe(429);
    expect(err.response.data.error).toBe('quota exceeded');
  });

  it('a non-ApiError failure answers the route\'s 500 fallback', async () => {
    fetchMock().mockImplementation(async () => { throw new TypeError('network down'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await fail(weatherApi.get(48.1, 11.5, '2026-03-01', 'en'));
    expect(err.response.status).toBe(500);
    expect(err.response.data.error).toBe('Error fetching weather data');
    expect(spy).toHaveBeenCalledWith('Weather error:', expect.any(TypeError));
  });
});

describe('weatherApi.get — happy paths', () => {
  it('omitted lang uses the server default de', async () => {
    fetchMock().mockImplementation(async () =>
      jsonResponse({ current: { temperature_2m: 10, weathercode: 61 } })
    );
    // get() without a usable date falls to the current-weather path; lang is
    // still the server default.
    const res = await weatherApi.get(48.1, 11.5, undefined as never);
    expect(res.description).toBe('Leichter Regen');
  });

  it('a forecast date maps the daily row', async () => {
    const date = isoDay(2);
    fetchMock().mockImplementation(async () =>
      jsonResponse({ daily: { time: [date], temperature_2m_max: [20], temperature_2m_min: [10], weathercode: [2] } })
    );
    const res = await weatherApi.get(48.1, 11.5, date, 'en');
    expect(res).toMatchObject({ type: 'forecast', temp: 15, main: 'Clouds', description: 'Partly cloudy' });
  });

  it('no_forecast comes back as a body, not a rejection', async () => {
    fetchMock().mockImplementation(async () =>
      jsonResponse({ daily: { time: ['2020-01-01'], temperature_2m_max: [null], temperature_2m_min: [null], weathercode: [null] } })
    );
    const res = await weatherApi.get(48.1, 11.5, '2020-06-15', 'en');
    expect(res.error).toBe('no_forecast');
  });
});

describe('weatherApi.getCurrent', () => {
  it('answers the current block', async () => {
    fetchMock().mockImplementation(async (url: string) => {
      expect(url).toContain('current=temperature_2m,weathercode');
      return jsonResponse({ current: { temperature_2m: 7.6, weathercode: 3 } });
    });
    const res = await weatherApi.getCurrent(48.1, 11.5, 'en');
    expect(res).toEqual({ temp: 8, main: 'Clouds', description: 'Overcast', type: 'current' });
  });

  it('missing lng answers the 400', async () => {
    const err = await fail(weatherApi.getCurrent(48.1, undefined as never));
    expect(err.response.data.error).toBe('Latitude and longitude are required');
  });
});

describe('weatherApi.getDetailed', () => {
  it('requires a date — the controller\'s bespoke 400', async () => {
    for (const [lat, lng, date] of [[undefined, 11.5, '2026-03-01'], [48.1, undefined, '2026-03-01'], [48.1, 11.5, ''], [48.1, 11.5, undefined]] as const) {
      const err = await fail(weatherApi.getDetailed(lat as never, lng as never, date as never));
      expect(err.response.status).toBe(400);
      expect(err.response.data.error).toBe('Latitude, longitude, and date are required');
    }
  });

  it('returns the detailed daily + hourly projection', async () => {
    const date = isoDay(2);
    fetchMock().mockImplementation(async () =>
      jsonResponse({
        daily: {
          time: [date],
          temperature_2m_max: [23],
          temperature_2m_min: [12],
          weathercode: [80],
          sunrise: [`${date}T05:55`],
          sunset: [`${date}T21:10`],
          precipitation_probability_max: [60],
          precipitation_sum: [1.2],
          windspeed_10m_max: [33.6],
        },
        hourly: {
          time: [`${date}T08:00`],
          temperature_2m: [15.4],
          precipitation_probability: [10],
          precipitation: [0],
          weathercode: [2],
          windspeed_10m: [12.4],
          relativehumidity_2m: [70],
        },
      })
    );
    const res = await weatherApi.getDetailed(48.1, 11.5, date, 'en');
    expect(res.type).toBe('forecast');
    expect(res.hourly).toHaveLength(1);
    expect(res.wind_max).toBe(34);
  });

  it('the impl\'s ApiError surfaces at its status; other errors hit the detailed 500', async () => {
    fetchMock().mockImplementation(async () => jsonResponse({ error: true, reason: 'nope' }, { status: 503 }));
    let err = await fail(weatherApi.getDetailed(48.1, 11.5, isoDay(2), 'en'));
    expect(err.response.status).toBe(503);
    expect(err.response.data.error).toBe('nope');

    clearWeatherCache();
    fetchMock().mockImplementation(async () => { throw new Error('kaboom'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    err = await fail(weatherApi.getDetailed(48.1, 11.5, isoDay(2), 'en'));
    expect(err.response.status).toBe(500);
    expect(err.response.data.error).toBe('Error fetching detailed weather data');
  });
});
