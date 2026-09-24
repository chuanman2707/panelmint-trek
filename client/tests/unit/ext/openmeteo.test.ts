/**
 * Tests for the public Open-Meteo adapter (`api/ext/openmeteo.ts`) — the
 * browser-direct face of the ported `weather-transform.ts`.
 *
 * `fetch` is stubbed everywhere; fixtures are hand-written in the recorded
 * Open-Meteo response shape (daily/hourly/current blocks, `timezone=auto`
 * local ISO times). The ported transform's own suite
 * (tests/unit/local/weather-transform.test.ts) pins the capped-read helpers
 * and estimateCondition thresholds; this file pins the adapter surface: URL
 * family selection (forecast vs archive), locale/WMO fallback, the past_days
 * window, archive hourly lookup, climate synthesis and the cache/dedup
 * contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  clearWeatherCache,
  getCurrentWeather,
  getDetailedWeather,
  getWeather,
} from '../../../src/api/ext/openmeteo';

const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: init.headers });

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

const fetchMock = () => {
  const fn = vi.fn(async (_url: string) => jsonResponse({}));
  vi.stubGlobal('fetch', fn);
  return fn;
};

beforeEach(() => clearWeatherCache());
afterEach(() => vi.unstubAllGlobals());

describe('getWeather — current', () => {
  it('answers current conditions from the forecast API current block', async () => {
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('api.open-meteo.com/v1/forecast');
      expect(url).toContain('current=temperature_2m,weathercode');
      return jsonResponse({ current: { temperature_2m: 21.6, weathercode: 2 } });
    });
    const res = await getCurrentWeather('48.1', '11.5', 'en');
    expect(res).toEqual({ temp: 22, main: 'Clouds', description: 'Partly cloudy', type: 'current' });
  });

  it('falls back to English descriptions for non-de locales', async () => {
    fetchMock().mockImplementation(async () =>
      jsonResponse({ current: { temperature_2m: 5, weathercode: 61 } })
    );
    const vi_ = await getCurrentWeather('10.7', '106.6', 'vi');
    expect(vi_.description).toBe('Light rain');
    expect(vi_.main).toBe('Rain');
  });

  it('unknown WMO code → Clouds + empty description (the English-map fallback)', async () => {
    fetchMock().mockImplementation(async () =>
      jsonResponse({ current: { temperature_2m: 5, weathercode: 999 } })
    );
    const res = await getCurrentWeather('48.1', '11.5', 'de');
    expect(res).toMatchObject({ main: 'Clouds', description: '' });
  });
});

describe('getWeather — forecast window', () => {
  it('a date inside −1..+16 days hits /v1/forecast with forecast_days=16', async () => {
    const date = isoDay(3);
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('api.open-meteo.com/v1/forecast');
      expect(url).toContain('forecast_days=16');
      return jsonResponse({
        daily: { time: [date], temperature_2m_max: [25.4], temperature_2m_min: [14.6], weathercode: [0] },
      });
    });
    const res = await getWeather('48.1', '11.5', date, 'en');
    expect(res).toMatchObject({ type: 'forecast', temp: 20, temp_max: 25, temp_min: 15, main: 'Clear' });
  });

  it('a recent past date without a time asks the forecast API for past_days', async () => {
    const date = isoDay(-3);
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      // diffDays < −1: the forward window is skipped entirely and the recent-
      // past path goes straight to `past_days=5` on the forecast API.
      expect(url).toContain('api.open-meteo.com/v1/forecast');
      expect(url).toContain('past_days=5');
      return jsonResponse({
        daily: { time: [date], temperature_2m_max: [12.4], temperature_2m_min: [3.6], weathercode: [61] },
      });
    });
    const res = await getWeather('48.1', '11.5', date, 'en');
    expect(res).toMatchObject({ type: 'forecast', temp: 8, main: 'Rain', description: 'Light rain' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('getWeather — archive paths', () => {
  it('an actual past date (no usable time) reads the archive daily series', async () => {
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('archive-api.open-meteo.com/v1/archive');
      expect(url).toContain('daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum');
      return jsonResponse({
        daily: {
          time: ['2020-06-15'],
          temperature_2m_max: [24.2],
          temperature_2m_min: [11.8],
          weathercode: [2],
          precipitation_sum: [0],
        },
      });
    });
    const res = await getWeather('48.1', '11.5', '2020-06-15', 'en');
    expect(res).toMatchObject({ type: 'forecast', temp: 18, temp_max: 24, temp_min: 12, main: 'Clouds' });
  });

  it('a past date with HH:MM picks that hour out of the archive hourly series', async () => {
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('archive-api.open-meteo.com/v1/archive');
      expect(url).toContain('hourly=temperature_2m,weathercode');
      return jsonResponse({
        daily: { time: ['2020-06-15'], temperature_2m_max: [24], temperature_2m_min: [11], weathercode: [2], precipitation_sum: [0] },
        hourly: {
          time: Array.from({ length: 24 }, (_, h) => `2020-06-15T${String(h).padStart(2, '0')}:00`),
          temperature_2m: Array.from({ length: 24 }, (_, h) => h),
          weathercode: Array.from({ length: 24 }, () => 61),
        },
      });
    });
    const res = await getWeather('48.1', '11.5', '2020-06-15', 'de', '14:00');
    expect(res).toMatchObject({ temp: 14, main: 'Rain', description: 'Leichter Regen', type: 'forecast' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a far-future date synthesizes climate from last year\'s archive window', async () => {
    const date = isoDay(60);
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('archive-api.open-meteo.com/v1/archive');
      expect(url).toContain('daily=temperature_2m_max,temperature_2m_min,precipitation_sum');
      return jsonResponse({
        daily: {
          time: ['r-2', 'r-1', 'r', 'r+1', 'r+2'],
          temperature_2m_max: [20, 22, 24, 26, 28],
          temperature_2m_min: [10, 11, 12, 13, 14],
          precipitation_sum: [0, 0, 0, 0, 0],
        },
      });
    });
    const res = await getWeather('48.1', '11.5', date, 'en');
    // Means: max 24, min 12 → avg temp 18, no precipitation → Clear (>15°C).
    expect(res).toEqual({ temp: 18, temp_max: 24, temp_min: 12, main: 'Clear', description: '', type: 'climate' });
  });

  it('archive daily row of nulls answers no_forecast instead of throwing', async () => {
    fetchMock().mockImplementation(async () =>
      jsonResponse({ daily: { time: ['2020-06-15'], temperature_2m_max: [null], temperature_2m_min: [null], weathercode: [null] } })
    );
    const res = await getWeather('48.1', '11.5', '2020-06-15', 'en');
    expect(res).toMatchObject({ error: 'no_forecast' });
  });
});

describe('errors, cache, dedup', () => {
  it('out-of-range and empty coordinates reject with a 400 ApiError', async () => {
    await expect(getWeather('91', '0', undefined, 'en')).rejects.toMatchObject({ status: 400, message: 'Invalid latitude' });
    await expect(getWeather('', '0', undefined, 'en')).rejects.toMatchObject({ status: 400 });
    await expect(getWeather('48.1', '181', undefined, 'en')).rejects.toMatchObject({ status: 400, message: 'Invalid longitude' });
  });

  it('a provider error body surfaces as an ApiError at the provider status', async () => {
    fetchMock().mockImplementation(async () => jsonResponse({ error: true, reason: 'boom' }, { status: 429 }));
    await expect(getCurrentWeather('48.1', '11.5', 'en')).rejects.toMatchObject({ status: 429, message: 'boom' });
  });

  it('an unreadable/oversize body is a 502 Open-Meteo API error', async () => {
    // A body that fails JSON.parse → readCappedJson answers undefined → 502.
    fetchMock().mockImplementation(async () => new Response('<<<not json>>>', { status: 200 }));
    await expect(getCurrentWeather('48.1', '11.5', 'en')).rejects.toMatchObject({ status: 502, message: 'Open-Meteo API error' });
    clearWeatherCache();
    // A declared content-length over the 1 MB cap is refused without a read.
    fetchMock().mockImplementation(async () =>
      jsonResponse({ current: { temperature_2m: 1, weathercode: 0 } }, { headers: { 'content-length': String(2 * 1024 * 1024) } })
    );
    await expect(getCurrentWeather('48.1', '11.5', 'en')).rejects.toBeInstanceOf(ApiError);
  });

  it('caches a forecast answer — a repeat call does not refetch', async () => {
    const date = isoDay(3);
    const fetch = fetchMock();
    fetch.mockImplementation(async () =>
      jsonResponse({ daily: { time: [date], temperature_2m_max: [20], temperature_2m_min: [10], weathercode: [1] } })
    );
    await getWeather('48.1', '11.5', date, 'en');
    await getWeather('48.1', '11.5', date, 'en');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('dedups in-flight requests for the same key', async () => {
    const fetch = fetchMock();
    fetch.mockImplementation(async () =>
      jsonResponse({ current: { temperature_2m: 10, weathercode: 0 } })
    );
    const [a, b] = await Promise.all([
      getCurrentWeather('48.1', '11.5', 'en'),
      getCurrentWeather('48.1', '11.5', 'en'),
    ]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('getDetailedWeather', () => {
  it('a forecast date returns the daily + hourly projection', async () => {
    const date = isoDay(2);
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('api.open-meteo.com/v1/forecast');
      expect(url).toContain(`start_date=${date}`);
      return jsonResponse({
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
          time: [`${date}T08:00`, `${date}T14:00`],
          temperature_2m: [15.4, 22.6],
          precipitation_probability: [10, 55],
          precipitation: [0, 0.7],
          weathercode: [2, 80],
          windspeed_10m: [12.4, 30.6],
          relativehumidity_2m: [70, 58],
        },
      });
    });
    const res = await getDetailedWeather('48.1', '11.5', date, 'en');
    expect(res).toMatchObject({
      type: 'forecast',
      temp: 18,
      temp_max: 23,
      temp_min: 12,
      main: 'Rain',
      description: 'Light rain showers',
      precipitation_sum: 1.2,
      precipitation_probability_max: 60,
      wind_max: 34,
    });
    expect(res.hourly).toEqual([
      { hour: 8, temp: 15, precipitation_probability: 10, precipitation: 0, main: 'Clouds', wind: 12, humidity: 70 },
      { hour: 14, temp: 23, precipitation_probability: 55, precipitation: 0.7, main: 'Rain', wind: 31, humidity: 58 },
    ]);
  });

  it('a date beyond +16 days takes the archive (climate) hourly path', async () => {
    const date = isoDay(40);
    const fetch = fetchMock();
    fetch.mockImplementation(async (url: string) => {
      expect(url).toContain('archive-api.open-meteo.com/v1/archive');
      return jsonResponse({
        daily: {
          time: ['2025-01-01'],
          temperature_2m_max: [5],
          temperature_2m_min: [-2],
          weathercode: [71],
          precipitation_sum: [3.26],
          windspeed_10m_max: [40.4],
          sunrise: ['2025-01-01T07:55'],
          sunset: ['2025-01-01T16:30'],
        },
        hourly: {
          time: ['2025-01-01T10:00'],
          temperature_2m: [1.4],
          precipitation: [0.2],
          weathercode: [71],
          windspeed_10m: [20.5],
          relativehumidity_2m: [80],
        },
      });
    });
    const res = await getDetailedWeather('48.1', '11.5', date, 'en');
    expect(res.type).toBe('climate');
    expect(res.hourly).toHaveLength(1);
    expect(res.sunrise).toBe('07:55');
  });
});
