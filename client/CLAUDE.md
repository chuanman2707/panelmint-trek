# CLAUDE.md

Scope: the **`@trek/client`** workspace (React 19 + Vite + Zustand + Tailwind PWA). See the repo-root `CLAUDE.md` for the monorepo picture and the philosophy. This file holds the client's commands, invariants and pitfalls; `ls` the directories for the inventory.

PanelMint has no backend: the dev server proxies nothing, and trip/day data lives in Dexie (`src/db/panelmintDb.ts`) via the `src/api/local/` adapters.

## Commands (run from `client/`)

```bash
npm run dev               # Vite dev server on :5173 (TREK_DEV_PORT overrides); no proxy — there is no API
npm run build             # prebuild generates PWA icons, then vite build
npm run typecheck         # tsc --noEmit
npm run lint              # eslint .   (lint:check is the same, check-only)
npm run lint:pages        # enforce the Page pattern
npm run test              # vitest run (tests/** + co-located src/**/*.test.{ts,tsx}); also test:unit / test:integration / test:coverage
npm run theme:lint        # theme conformance audit (theme:lint:strict exits 1)
```

Single test: `npx vitest run src/store/slices/budgetSlice.test.ts`, or `npx vitest run -t "optimistically adds the place"`.

## Page pattern (enforced — `lint:pages` fails otherwise)

Every `src/pages/*Page.tsx` is a thin **wiring container**; all state/effects/handlers live in a co-located **`use<Page>()` hook** under `src/pages/<page>/`. The page body must **not** call React state/effect/memo/ref hooks — only context hooks like `useTranslation()`. An optional `<page>Model.ts` holds pure, React-free types and helpers. Full spec in `src/pages/PATTERN.md`. When extracting, keep the rendered JSX byte-identical — it is a refactor of where logic lives.

## Data flow — offline-first

The layering is **component → feature hook → store/slice → `repo/` → `api/` | Dexie**:

- **`src/store/`** — Zustand. `tripStore.ts` is composed from slices in `store/slices/`; `slices/remoteEventHandler.ts` holds the event appliers the local adapters reuse (there is no socket — the name is historical).
- **`src/repo/`** — per-entity repositories mediating between the API surface and the offline cache. Always go through a repo for trip data.
- **`src/api/client.ts`** — the single Axios instance, typed from `@trek/shared`, plus the interim hosted-domain surfaces not yet ported to `src/api/local/`. Local trip/day CRUD already runs on `api/local/` against `panelmintDb`; ports continue domain by domain — never add new consumers of the axios surfaces.
- **`src/db/panelmintDb.ts`** — the local Dexie database (trips, days, settings, …). `src/db/offlineDb.ts` is the legacy read-through cache still referenced by unported repo fallbacks; it shrinks as domains land locally. Database and table names are the on-device contract — renaming one orphans every user's data.
- **`src/sync/`** — connectivity (`networkMode.ts`), storage persistence, and raster map pre-download (`tilePrefetcher.ts`). There is no mutation queue or reconnect replay anymore — writes are local and durable immediately.

## Rules for new code

The offline core is flagship work surrounded by a periphery that ignores it. New code extends the core's discipline, not the periphery's shortcuts:

- **One data path, no layer skips.** Never import `api/client` (or raw fetch/axios) from a component or modal — especially never *write* from one. A long tail of existing files bypasses the layering and no lint ratchet holds the line yet; that is debt, not precedent.
- **Offline-first is the product promise.** New domains get a local adapter + Dexie table with the same response shape the hosted API returned. If a domain is deliberately online-only, say so explicitly.
- **No god components or god hooks.** The page pattern is a floor, not a ceiling. Decompose hooks by concern, split renders into memoizable sections, and don't pass huge prop bags with inline-arrow callbacks.
- **Prefer React 19 idioms**: `useOptimistic`, `useActionState`/`useFormStatus`, `use()` + Suspense, `useSyncExternalStore` for external subscriptions (`hooks/useNetworkMode` is the reference).
- **Optimistic writes must reconcile** — rollback + user-visible toast on failure. No `.catch(() => {})`, no bare `catch {}`.
- **Subscribe with selectors** (`useShallow` for multi-field reads); never whole-store subscriptions; `getState()` for imperative access in effects.
- **Connectivity**: `isEffectivelyOffline()` is the single source of truth — never read `navigator.onLine` in feature code.
- **Rendering security**: never interpolate user content into HTML strings (map popups included — build via DOM + `textContent`, or `escapeHtml` from `@trek/shared`); untrusted markdown gets `rehype-sanitize`; never `rehype-raw` near it.
- **No `window` event buses or global mutable `window` state.** No `any` at boundaries: event payloads and map props get real types.
- **Hygiene**: error boundaries around new shells/routes (`components/shared/ErrorBoundary.tsx`); every async `.then(setState)` needs a cancelled flag or `AbortController`; no routine `eslint-disable exhaustive-deps` (a missing dep has already shipped wrong money on screen); no sequential-await N+1 fetch loops; search for an existing utility before writing a duplicate.
- **Theming**: use the semantic Tailwind tokens defined in `tailwind.config.js` (`bg-surface*`, `text-content*`, `border-edge*`, `bg-accent*`, status colors) — no palette classes, hex literals, arbitrary-value color classes, or invented CSS vars. Only `applyAppearance()` in `src/theme/` mutates `<html>` styling (see `src/theme/README.md`). `theme:lint` catches literals and `bg-[#...]`-style classes but not named palette classes — review those by hand.

## Big-picture pieces

- **Maps** (`src/components/Map/`): Leaflet only — callers import `MapView` directly (it fetches road-trip hazards itself; the `MapViewAuto` passthrough is gone). Raster tiles (OSM default; Amap GCJ-02 and satellite presets remain); a stored vector-style URL resolves to the raster fallback. The raster prefetcher (`sync/tilePrefetcher.ts`) fetches tiles `no-cors` so custom tile providers without CORS headers keep working.
- **i18n** (`src/i18n/TranslationContext.tsx`): `en` is bundled; every other locale is a dynamic `import('@trek/shared/i18n/<locale>')` so Vite emits one chunk per locale. Strings live in `shared/`, never here.
- **Mobile shell** (`src/mobile/`): below the phone breakpoint (`useIsPhone`) `App.tsx` wraps routes in `MobileShell` and the `M*` screens under `mobile/screens/` take over. A UI change to a domain with an `M*` twin usually needs both — put shared logic in one hook/module and keep only markup in each shell.
- **Managed installs** (`src/managed/index.tsx`): the attachment point for screens that only exist on a centrally administered install. Empty here by design — an operator replaces it at build time. Don't put features there.

## Tests

vitest with `@vitejs/plugin-react`, a custom jsdom environment (`tests/environment/`), `forks` pool. Tests live in `tests/{unit,integration}/` and co-located as `src/**/*.test.{ts,tsx}`. `msw` mocks HTTP (for the not-yet-ported hosted surfaces), `fake-indexeddb` backs Dexie. Page tests render JSX against a mocked hook; hook/slice logic is tested in isolation (see `store/slices/budgetSlice.test.ts`).
