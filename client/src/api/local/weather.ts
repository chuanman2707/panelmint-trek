/**
 * `weatherApi` — the local implementation. Same method list and result shapes
 * as the axios version in api/client.ts (`get`/`getCurrent`/`getDetailed` →
 * `WeatherResult`), backed by `api/ext/openmeteo.ts` — a direct browser fetch
 * to Open-Meteo running the ported server logic (forecast/archive/climate
 * fallback chain, WMO maps, TTL cache, 8s deadline, 1 MB cap).
 *
 * Server parity notes (server/src/nest/weather/weather.controller.ts):
 *  - `GET /api/weather` answered 400 `{error: 'Latitude and longitude are
 *    required'}` when a lat/lng query param was absent. axios drops `undefined`
 *    params, so locally that is `lat == null || lng == null`; anything else
 *    reaches the ported `coord()` check, which answers `Invalid latitude` /
 *    `Invalid longitude` exactly like the server (NaN serializes to 'NaN' and
 *    fails the range check, same as `lat=NaN` did over HTTP).
 *  - `GET /api/weather/detailed` answered 400 `{error: 'Latitude, longitude,
 *    and date are required'}` on any missing param.
 *  - `lang` defaulted to 'de' server-side when the param was absent — kept.
 *  - The impl's `ApiError` mapped to `{error: message}` at its status; any
 *    other throw became a 500 with the route's fallback message (and a
 *    console.error line) — the same mapping happens here against
 *    `LocalApiError`.
 *  - A date with no data is NOT an error: the impl returns
 *    `{temp: 0, main: '', description: '', type: '', error: 'no_forecast'}`,
 *    which consumers (`useDayDetail`, WeatherWidget) render as "not
 *    available".
 *  - Methods are async so every failure is a rejection, never a synchronous
 *    throw — axios only ever produced rejections.
 */
import type { WeatherResult } from '@trek/shared';
import {
  ApiError,
  getCurrentWeather,
  getDetailedWeather,
  getWeather,
} from '../ext/openmeteo';
import { apiError, badRequest } from './helpers';

/** Controller's `toHttp` — ApiError keeps its status, anything else is the
 *  route's 500 fallback (plus the same console.error line it logged). */
function toLocalApiError(err: unknown, logPrefix: string, fallback: string): never {
  if (err instanceof ApiError) {
    throw apiError(err.status, err.message);
  }
  console.error(logPrefix, err);
  throw apiError(500, fallback);
}

export const weatherApi = {
  // `time` (HH:MM) makes a past date answer for that hour instead of the day
  // (#1614) — only the archive path carries an hourly series.
  get: async (lat: number, lng: number, date: string, lang?: string, time?: string): Promise<WeatherResult> => {
    if (lat == null || lng == null) {
      throw badRequest('Latitude and longitude are required');
    }
    try {
      return await getWeather(String(lat), String(lng), date, lang ?? 'de', time);
    } catch (err) {
      toLocalApiError(err, 'Weather error:', 'Error fetching weather data');
    }
  },

  getCurrent: async (lat: number, lng: number, lang?: string): Promise<WeatherResult> => {
    if (lat == null || lng == null) {
      throw badRequest('Latitude and longitude are required');
    }
    try {
      return await getCurrentWeather(String(lat), String(lng), lang ?? 'de');
    } catch (err) {
      toLocalApiError(err, 'Weather error:', 'Error fetching weather data');
    }
  },

  getDetailed: async (lat: number, lng: number, date: string, lang?: string): Promise<WeatherResult> => {
    if (lat == null || lng == null || !date) {
      throw badRequest('Latitude, longitude, and date are required');
    }
    try {
      return await getDetailedWeather(String(lat), String(lng), date, lang ?? 'de');
    } catch (err) {
      toLocalApiError(err, 'Detailed weather error:', 'Error fetching detailed weather data');
    }
  },
};
