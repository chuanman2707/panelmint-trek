// Bound local-effect appliers — the write-through half of api/local/*.
//
// There is no socket in local mode, so a local adapter cannot rely on the
// server broadcasting the caller's own change back. Instead every mutating
// adapter returns the side-channel fields the server's response carried
// (`reordered`, `movedAssignment`, cascade-created rows, …) and the caller
// replays each one here. `applyLocalEffect` feeds the same
// `handleRemoteEvent` reducer + Dexie writer the socket used, so a local
// effect and a remote event are indistinguishable downstream.
//
// Precedent: store/stayStops.ts does this by hand for the accommodation
// cascade — applyStayStops stays as the named helper for that one shape.
//
// Slice actions should prefer `get().applyLocalEffect(...)` (same method, no
// extra import); this module is for repos, page hooks and components that
// reach the store by `useTripStore.getState()`. `api/local/*` itself never
// calls it — adapters stay below the store layer: Dexie in, response out.
import type { TrekWsTripEventName } from '@trek/shared'
import { useTripStore } from './tripStore'

/** One replayed side-channel: a registry event name plus its payload fields. */
export interface LocalEffect {
  type: TrekWsTripEventName
  payload?: Record<string, unknown>
}

/**
 * Apply one local write's side effect to the trip store (+ Dexie
 * write-through). `type` is the WS registry event the server would have
 * broadcast for the change — e.g. after a local `updateTime` resolves:
 *
 *   applyLocalEffect('assignment:updated', { assignment: res.assignment })
 *   if (res.reordered) applyLocalEffect('assignment:reordered', res.reordered)
 *
 * An event with no registered applier is a no-op, matching socket behaviour.
 */
export function applyLocalEffect(type: TrekWsTripEventName, payload: Record<string, unknown> = {}): void {
  useTripStore.getState().applyLocalEffect(type, payload)
}

/** Same, for adapters whose response carries several effects to replay in order. */
export function applyLocalEffects(effects: readonly LocalEffect[]): void {
  const { applyLocalEffect } = useTripStore.getState()
  for (const effect of effects) applyLocalEffect(effect.type, effect.payload)
}
