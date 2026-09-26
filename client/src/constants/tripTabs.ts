/**
 * The trip planner's core tab ids, in the order the tab bar shows them.
 *
 * These are the German legacy names the planner has always used internally
 * ('buchungen', 'finanzplan', 'listen') — not the English labels. They are what
 * sessionStorage, the ?tab= deep link and the startup-destination setting
 * persist, so renaming one would silently strand saved preferences.
 *
 * Ids are kept broader than what a default build enables: useTripPlanner builds
 * TRIP_TABS from what is actually on (packing, budget), and anything pointing at
 * a tab that isn't there falls back to the plan view.
 */
export const TRIP_TAB_IDS = [
  'plan',
  'transports',
  'buchungen',
  'listen',
  'finanzplan',
] as const

export type TripTabId = (typeof TRIP_TAB_IDS)[number]

/**
 * Translation key per tab, so the startup-destination picker in Settings names
 * the tabs exactly as the planner's own tab bar does. useTripPlanner builds its
 * TRIP_TABS from these too — one source, or the two would drift apart the first
 * time a tab is renamed.
 */
export const TRIP_TAB_LABEL_KEYS: Record<TripTabId, string> = {
  plan: 'trip.tabs.plan',
  transports: 'trip.tabs.transports',
  buchungen: 'trip.tabs.reservations',
  listen: 'trip.tabs.lists',
  finanzplan: 'trip.tabs.budget',
}

export const isTripTabId = (value: unknown): value is TripTabId =>
  typeof value === 'string' && (TRIP_TAB_IDS as readonly string[]).includes(value)

/** What `/trips/:id?tab=…` accepts — the real tab ids, nothing else. */
export const isDeepLinkableTripTab = (value: string): boolean => isTripTabId(value)
