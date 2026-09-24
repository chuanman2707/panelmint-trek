/**
 * Open-Meteo external adapter — the client's only weather provider.
 *
 * The server used to sit between the browser and Open-Meteo
 * (server/src/nest/weather/weather.impl.ts): it owned the 8s deadline, the 1 MB
 * response cap, the result cache and the forecast/archive/climate fallback
 * chain. That file was lifted into `api/local/ported/weather-transform.ts`
 * before the server tree was deleted, and this module is its public face — a
 * browser `fetch` call straight to api.open-meteo.com / archive-api.open-meteo.com.
 *
 * What the port already does (see its header for the full parity list):
 *  - WMO weathercode → `main`/`description`, descriptions in English or German
 *    (`lang === 'de'`); unknown codes fall back to 'Clouds' + ''.
 *  - Forecast window −1..+16 days on `/v1/forecast`; a recent past date first
 *    tries the forecast API's `past_days` window, then the archive API; a past
 *    date carrying a usable `HH:MM` goes straight to the archive's hourly
 *    series (the only path that has it).
 *  - Dates beyond +16 days synthesize climate normals from last year's archive
 *    (5-day window averaged, `estimateCondition` on the means).
 *  - `current` weather via `/v1/forecast?current=temperature_2m,weathercode`.
 *  - TTL cache (forecast 1h / current 15min / climate 24h) + in-flight dedup;
 *    `startCacheCleanup` is the lifecycle hook a boot path calls once.
 *
 * Errors are thrown as `ApiError` (status + message) — the shape the Nest
 * controller mapped to HTTP. The `local/weather.ts` adapter converts them to
 * `LocalApiError` so callers keep reading `err.response.data.error`.
 */
export {
  ApiError,
  clearWeatherCache,
  estimateCondition,
  getDetailedWeather,
  getWeather,
  startCacheCleanup,
  stopCacheCleanup,
} from '../local/ported/weather-transform';
export type { HourlyEntry, WeatherResult } from '../local/ported/weather-transform';

import { getWeather } from '../local/ported/weather-transform';
import type { WeatherResult } from '../local/ported/weather-transform';

/**
 * Current conditions — `getWeather` with no date is the server's
 * `GET /api/weather?lat&lng` (no `date` param) path: the forecast API's
 * `current=temperature_2m,weathercode` fields, 15-minute cache TTL.
 */
export function getCurrentWeather(
  lat: string,
  lng: string,
  lang: string,
): Promise<WeatherResult> {
  return getWeather(lat, lng, undefined, lang);
}
