/**
 * The shared Frankfurter client (`api/ext/fx.ts`) — the port of the server's
 * ExchangeRatesService, used by the budget FX freeze, the dashboard widgets,
 * the PDF and the trip currency rebase. Pins the array→map parse with the
 * base=1 self-rate seed, the 6h TTL cache, inflight coalescing, the stale
 * fallback, the 1 MB cap, and the localStorage persistence — all offline
 * (fetch is stubbed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchExchangeRates, peekExchangeRates, clearExchangeRateCache } from '../../../src/api/ext/fx';

const FRANKFURTER = [
  { date: '2026-03-01', base: 'EUR', quote: 'USD', rate: 1.1 },
  { date: '2026-03-01', base: 'EUR', quote: 'GBP', rate: 0.85 },
];

function stubFetch(payload: unknown = FRANKFURTER, init: { ok?: boolean } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  clearExchangeRateCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchExchangeRates', () => {
  it('parses the Frankfurter array and seeds base = 1', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const rates = await fetchExchangeRates('EUR');
    expect(rates).toEqual({ EUR: 1, USD: 1.1, GBP: 0.85 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toBe('https://api.frankfurter.dev/v2/rates?base=EUR');
    // A deadline rides on the fetch — the server's 10s timeout preserved.
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves the cache within the TTL — no second request', async () => {
    vi.stubGlobal('fetch', stubFetch());
    await fetchExchangeRates('EUR');
    const again = await fetchExchangeRates('eur'); // case-insensitive key
    expect(again).toEqual({ EUR: 1, USD: 1.1, GBP: 0.85 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent same-base requests onto one fetch', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const [a, b] = await Promise.all([fetchExchangeRates('EUR'), fetchExchangeRates('EUR')]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache is stale, and force bypasses a fresh cache', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', stubFetch());
      await fetchExchangeRates('EUR');
      await fetchExchangeRates('EUR', { force: true });
      expect(fetch).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 1);
      await fetchExchangeRates('EUR');
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the stale cache when the upstream is down', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', stubFetch());
      await fetchExchangeRates('EUR');
      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 1);
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => '' })));
      const rates = await fetchExchangeRates('EUR');
      expect(rates).toEqual({ EUR: 1, USD: 1.1, GBP: 0.85 }); // stale beats nothing
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers null (never rejects) when there is nothing usable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchExchangeRates('EUR')).toBeNull();
    // A map that only carries the self-rate is treated as unusable.
    vi.stubGlobal('fetch', stubFetch([]));
    expect(await fetchExchangeRates('EUR')).toBeNull();
    // A non-array payload the same way.
    vi.stubGlobal('fetch', stubFetch({ rates: { USD: 1.1 } }));
    expect(await fetchExchangeRates('EUR')).toBeNull();
    // And a response past the 1 MB cap.
    vi.stubGlobal('fetch', stubFetch('x'.repeat(1024 * 1024 + 1)));
    expect(await fetchExchangeRates('EUR')).toBeNull();
  });

  it('persists to localStorage and a cold peek reads it back without fetching', async () => {
    vi.stubGlobal('fetch', stubFetch());
    await fetchExchangeRates('EUR');
    const raw = localStorage.getItem('trek_fx_EUR');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).rates.USD).toBe(1.1);
    // A stored entry is visible to peekExchangeRates (which warms the memory
    // cache) — and a fresh stored entry short-circuits the fetch entirely.
    clearExchangeRateCache();
    localStorage.setItem('trek_fx_EUR', JSON.stringify({ rates: { EUR: 1, USD: 2 }, ts: Date.now() }));
    expect(peekExchangeRates('EUR')!.rates.USD).toBe(2);
    expect(await fetchExchangeRates('EUR')).toEqual({ EUR: 1, USD: 2 });
    // Still just the one cold fetch — the stored entry short-circuited the second.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
