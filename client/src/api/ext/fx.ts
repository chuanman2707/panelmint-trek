/**
 * Live exchange rates — the client-side port of the server's
 * ExchangeRatesService (server/src/nest/budget/exchange-rates.service.ts),
 * shared by every FX consumer (Costs settlement, the dashboard currency
 * widgets, the PDF export, the trip currency rebase).
 *
 * Fetches from api.frankfurter.dev (no key, already CSP-allowlisted) and
 * caches per base currency in memory + localStorage for a few hours so a
 * settlement request never hammers the upstream. Rates are "units of X per 1
 * base", so an amount in currency C converts to base as `amount / rates[C]`.
 *
 * Server behaviors preserved: the 6h TTL, same-base inflight coalescing, the
 * 10s fetch deadline, the 1 MB response cap, boundary validation instead of
 * `as`-casts, the `base = 1` self-rate seed, the ">1 keys" empty-response
 * heuristic (a map that only carries the self-rate is unusable → null), and
 * the stale-cache fallback on upstream failure — stale beats nothing. On top
 * of the server model the entry is also persisted to `trek_fx_<BASE>` in
 * localStorage, the shape the Costs widgets already stored, so an offline
 * start can still convert.
 *
 * Everything degrades gracefully: if the fetch fails (offline, upstream down),
 * callers get `null`/identity conversion rather than a rejection.
 */

const TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FETCH_TIMEOUT_MS = 10_000;
// Frankfurter quotes a few dozen currencies (~2 KB); anything near this cap is
// not the API we think it is.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const STORAGE_PREFIX = 'trek_fx_';

const mem = new Map<string, { rates: Record<string, number>; ts: number }>();
const inflight = new Map<string, Promise<Record<string, number> | null>>();

const isRateEntry = (v: unknown): v is { quote: string; rate: number } =>
  typeof v === 'object' && v !== null &&
  typeof (v as { quote?: unknown }).quote === 'string' &&
  typeof (v as { rate?: unknown }).rate === 'number';

function writePersisted(base: string, entry: { rates: Record<string, number>; ts: number }): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + base, JSON.stringify(entry));
  } catch { /* storage quota / private mode — the memory cache still serves */ }
}

/** The cache as it stands: memory first, then the `trek_fx_<base>`
 *  localStorage entry (which also warms the memory map). Never fetches. */
export function peekExchangeRates(base: string): { rates: Record<string, number>; ts: number } | null {
  const upper = (base || 'EUR').toUpperCase();
  const m = mem.get(upper);
  if (m) return m;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + upper);
    if (raw) {
      const parsed = JSON.parse(raw) as { rates: Record<string, number>; ts: number };
      if (parsed?.rates) {
        mem.set(upper, parsed);
        return parsed;
      }
    }
  } catch { /* corrupt entry — treat as absent */ }
  return null;
}

async function fetchRates(base: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`https://api.frankfurter.dev/v2/rates?base=${encodeURIComponent(base)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return null;
    // Frankfurter returns an array of { date, base, quote, rate } and omits the
    // base's own self-rate, so seed the map with `base = 1` then index by quote.
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return null;
    const rates: Record<string, number> = { [base.toUpperCase()]: 1 };
    for (const r of data) {
      if (isRateEntry(r)) rates[r.quote] = r.rate;
    }
    return Object.keys(rates).length > 1 ? rates : null;
  } catch (err) {
    console.error('[exchange-rates] rates fetch failed for', base, err);
    return null;
  }
}

/**
 * Rates map for `base` (cached). Never rejects: a fresh cache short-circuits,
 * concurrent same-base calls coalesce onto one fetch, and on failure the
 * stale cache wins — `null` only when there is nothing usable at all.
 *
 * `opts.force` bypasses the fresh-cache check (the widget's explicit refresh
 * button); the stale-cache fallback and coalescing still apply.
 */
export function fetchExchangeRates(
  base: string,
  opts: { force?: boolean } = {},
): Promise<Record<string, number> | null> {
  const key = (base || 'EUR').toUpperCase();
  const hit = peekExchangeRates(key);
  const now = Date.now();
  if (!opts.force && hit && now - hit.ts < TTL_MS) return Promise.resolve(hit.rates);

  // Coalesce concurrent fetches for the same base.
  let p = inflight.get(key);
  if (!p) {
    p = fetchRates(key)
      .then(rates => {
        if (rates) {
          const entry = { rates, ts: Date.now() };
          mem.set(key, entry);
          writePersisted(key, entry);
        }
        return rates;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p);
  }
  return p.then(rates => {
    // On failure fall back to the last cached value if we have one.
    if (!rates && hit) return hit.rates;
    return rates;
  });
}

/** Test-only: the module-level caches outlive a vitest file's individual tests. */
export function clearExchangeRateCache(): void {
  mem.clear();
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(STORAGE_PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}
