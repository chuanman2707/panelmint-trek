import { useCallback, useEffect, useState } from 'react'
import { fetchExchangeRates, peekExchangeRates } from '../api/ext/fx'

/**
 * Live FX rates for the Costs panel, used to convert every amount into the user's
 * display currency. The fetch/cache logic lives in `api/ext/fx.ts` — shared with
 * the local adapters, the PDF export and the dashboard widgets — this file keeps
 * only the React shell plus `convertBooked`.
 */

export { fetchExchangeRates, clearExchangeRateCache } from '../api/ext/fx'

/**
 * Convert a booked amount the way the server's settlement does (#1335, #1445): the FX
 * rate frozen when the expense or transfer was entered wins over today's rate, so a cost
 * keeps the value it was booked at instead of drifting with the market. The frozen rate is
 * "units of the row's currency per 1 *trip* currency", which is why the amount goes to the
 * trip currency first and only then, live, to whatever currency the viewer reads in.
 *
 * `convertLive` is the hook's own `convert`. Passing it in keeps this a plain function that
 * both shells and the PDF can share, rather than three copies of the same three branches.
 */
export function convertBooked(
  amount: number,
  rowCurrency: string | null | undefined,
  frozenRate: number | null | undefined,
  tripCurrency: string,
  convertLive: (amount: number, from: string | null | undefined) => number,
): number {
  const trip = (tripCurrency || 'EUR').toUpperCase()
  // A NULL currency means the trip's own, and then there was never anything to freeze.
  const cur = (rowCurrency || trip).toUpperCase()
  if (cur === trip) return convertLive(amount, trip)
  // A rate of exactly 1 is the column default, not a booked rate: rows written before the
  // freeze existed carry it, and those still convert live, as they always did.
  if (frozenRate != null && frozenRate > 0 && frozenRate !== 1) return convertLive(amount / frozenRate, trip)
  return convertLive(amount, cur)
}

const TTL_MS = 6 * 60 * 60 * 1000 // 6h — the same freshness window ext/fx enforces

export function useExchangeRates(base: string) {
  const upper = (base || 'EUR').toUpperCase()
  const [rates, setRates] = useState<Record<string, number> | null>(() => peekExchangeRates(upper)?.rates ?? null)

  useEffect(() => {
    const cached = peekExchangeRates(upper)
    if (cached) setRates(cached.rates)
    if (cached && Date.now() - cached.ts < TTL_MS) return
    let cancelled = false
    fetchExchangeRates(upper).then(r => {
      if (!cancelled && r) setRates(r)
    })
    return () => { cancelled = true }
  }, [upper])

  const convert = useCallback(
    (amount: number, from: string | null | undefined): number => {
      const f = (from || upper).toUpperCase()
      if (f === upper || !rates) return amount
      const r = rates[f]
      return r && r > 0 ? amount / r : amount
    },
    [rates, upper],
  )

  return { rates, convert }
}
