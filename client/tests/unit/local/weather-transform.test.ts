/**
 * Parity tests for the ported weather transform + capped fetch.
 *
 * Source fixtures: server/tests/unit/nest/weather.*.test.ts pins the WMO code
 * mapping, localized descriptions, cache-key rounding, the forecast/archive
 * window split, estimateCondition thresholds and the 1 MB body cap. `fetch` is
 * stubbed — the port calls the platform global (no Node http here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  cacheKey,
  clearWeatherCache,
  estimateCondition,
  exceedsDeclaredLength,
  getDetailedWeather,
  getWeather,
  readCapped,
  readCappedJson,
  readCappedText,
} from '../../../src/api/local/ported/weather-transform';

const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: init.headers });

beforeEach(() => clearWeatherCache());
afterEach(() => vi.unstubAllGlobals());

describe('estimateCondition', () => {
  it('maps precipitation + temperature to the four bands', () => {
    expect(estimateCondition(10, 6)).toBe('Rain');
    expect(estimateCondition(-2, 6)).toBe('Snow');
    expect(estimateCondition(10, 2)).toBe('Drizzle');
    expect(estimateCondition(-2, 2)).toBe('Snow');
    expect(estimateCondition(10, 0.5)).toBe('Clouds');
    expect(estimateCondition(20, 0)).toBe('Clear');
    expect(estimateCondition(5, 0)).toBe('Clouds');
  });
});

describe('cacheKey', () => {
  it('rounds coordinates to two decimals and carries date + language', () => {
    expect(cacheKey('48.1374', '11.5755')).toBe('48.14_11.58_current');
    expect(cacheKey('48.1374', '11.5755', '2026-03-01', 'de')).toBe('48.14_11.58_2026-03-01_de');
    expect(cacheKey('48.1374', '11.5755', '2026-03-01T14:00')).toBe('48.14_11.58_2026-03-01T14:00');
  });
});

describe('capped fetch helpers', () => {
  it('exceedsDeclaredLength reads the content-length header', () => {
    expect(exceedsDeclaredLength({ headers: { get: () => '2000' } }, 1000)).toBe(true);
    expect(exceedsDeclaredLength({ headers: { get: () => '500' } }, 1000)).toBe(false);
    expect(exceedsDeclaredLength({ headers: { get: () => null } }, 1000)).toBe(false);
  });

  it('readCapped truncates a streamed body at the cap', async () => {
    const chunk = new Uint8Array(600).fill(65);
    const res = {
      body: {
        getReader: () => {
          let n = 0;
          return {
            read: async () => (n++ < 3 ? { done: false, value: chunk } : { done: true }),
            cancel: async () => {},
          };
        },
      },
    };
    const { bytes, truncated } = await readCapped(res, 1000);
    expect(truncated).toBe(true);
    expect(bytes.length).toBe(1000);
  });

  it('readCappedText falls back to text() and post-checks the cap', async () => {
    const res = { text: async () => 'x'.repeat(50) };
    expect(await readCappedText(res, 100)).toEqual({ text: 'x'.repeat(50), truncated: false });
    const over = await readCappedText(res, 10);
    expect(over.truncated).toBe(true);
    expect(over.text).toBe('x'.repeat(10));
  });

  it('readCappedJson answers undefined on declared-oversize, truncation, and garbage', async () => {
    expect(
      await readCappedJson(
        {
          headers: { get: () => '9999' },
          body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
        },
        10
      )
    ).toBeUndefined();
    expect(await readCappedJson({ text: async () => 'not json' }, 100)).toBeUndefined();
    expect(await readCappedJson<{ a: number }>({ text: async () => '{"a":1}' }, 100)).toEqual({ a: 1 });
  });
});

describe('getWeather', () => {
  it('rejects out-of-range and empty coordinates with a 400 ApiError', async () => {
    await expect(getWeather('91', '0', undefined, 'en')).rejects.toMatchObject({ status: 400 });
    await expect(getWeather('', '0', undefined, 'en')).rejects.toMatchObject({ status: 400 });
    await expect(getWeather('48.1', 'abc', undefined, 'en')).rejects.toMatchObject({ status: 400 });
    await expect(getWeather('48.1', '181', undefined, 'en')).rejects.toMatchObject({ status: 400 });
  });

  it('current weather maps WMO codes and localizes descriptions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ current: { temperature_2m: 18.4, weathercode: 61 } }))
    );
    const en = await getWeather('48.1', '11.5', undefined, 'en');
    expect(en).toMatchObject({ temp: 18, main: 'Rain', description: 'Light rain', type: 'current' });
    clearWeatherCache();
    const de = await getWeather('48.1', '11.5', undefined, 'de');
    expect(de.description).toBe('Leichter Regen');
  });

  it('a near-future date takes the forecast path', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('api.open-meteo.com/v1/forecast');
        return jsonResponse({
          daily: { time: [tomorrow], temperature_2m_max: [22.6], temperature_2m_min: [10.4], weathercode: [3] },
        });
      })
    );
    const res = await getWeather('48.1', '11.5', tomorrow, 'en');
    expect(res).toMatchObject({
      type: 'forecast',
      temp: 17,
      temp_max: 23,
      temp_min: 10,
      main: 'Clouds',
      description: 'Overcast',
    });
  });

  it('provider error bodies surface as a 502-shaped ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: true, reason: 'boom' }, { status: 400 }))
    );
    await expect(getWeather('48.1', '11.5', undefined, 'en')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getDetailedWeather', () => {
  it('dates beyond the forecast window take the archive/climate path', async () => {
    const farDate = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('archive-api.open-meteo.com');
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
    vi.stubGlobal('fetch', fetchMock);
    const res = await getDetailedWeather('48.1', '11.5', farDate, 'en');
    expect(res.type).toBe('climate');
    expect(res.main).toBe('Snow');
    expect(res.precipitation_sum).toBe(3.3);
    expect(res.sunrise).toBe('07:55');
    expect(res.hourly).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
