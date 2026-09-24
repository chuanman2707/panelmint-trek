# CLAUDE.md

Guidance for coding agents in this repository. This file holds the commands, the invariants, the gates and the philosophy. Inventories (file lists, counts, history) deliberately live in the code and its READMEs, not here — when this file disagrees with the code, the code wins; fix the doc.

## What PanelMint is

PanelMint is a fork of [TREK](https://github.com/liketrek/TREK) (upstream release `v4.3.1`) being converted into a **static, offline-first trip planner**. There is no server, no auth, no realtime sync, no plugin system: the app is a client that stores everything in IndexedDB via Dexie.

npm-workspaces monorepo with exactly two workspaces:

- **`shared/`** (`@trek/shared`) — Zod schemas, the **single source of truth** for data contracts, plus all i18n locales. Must be built before client typecheck or run.
- **`client/`** (`@trek/client`) — React 19 + Vite + Zustand + Tailwind PWA, offline-first via Dexie/IndexedDB. Maps are **Leaflet raster tiles only** — the Mapbox/MapLibre GL engines are gone; do not reintroduce them.

Each package has its own `CLAUDE.md`; this file covers the monorepo picture.

## Commands

Run from the repo root unless noted. **Use `npm run ... --workspace=<pkg>`, not `npm -w <pkg>`**.

```bash
npm run dev                       # build shared, then watch shared + run the client Vite dev server
npm run build                     # build shared → client (order matters)
npm run lint                      # lint both workspaces (shared runs eslint --fix and rewrites files; client is check-only)
npm run format                    # prettier --write both
```

Tests:

```bash
npm run test                                       # both workspaces
npm run test:cov                                   # coverage (lcov) for both
cd client && npm run test                          # client vitest run
cd client && npm run lint:pages                    # enforce the Page pattern
cd client && npm run theme:lint                    # flag styling that bypasses appearance tokens
npm run typecheck --workspace=client               # tsc --noEmit (also shared)
```

Run a single test file or test:

```bash
npx vitest run src/store/slices/budgetSlice.test.ts             # (from client/)
npx vitest run -t "name of the test"                            # by test-name pattern
```

i18n parity (every non-`en` locale must have the identical file set and top-level keys):

```bash
npm run i18n:parity --workspace=shared            # audit (exit 0)
npm run i18n:parity:strict --workspace=shared     # gate (exit 1 on drift)
```

Dev ports: the Vite dev server listens on **5173** (`TREK_DEV_PORT` overrides) and proxies nothing — there is no API. There is no Node version pin.

## Client invariants

Offline-first, with a layered data flow. A Page never owns state directly:

- **Page pattern** (enforced by `lint:pages`, spec in `client/src/pages/PATTERN.md`): a `*Page.tsx` is a **wiring container** composing a co-located `use<Page>()` hook; it must not call React state/effect/memo hooks itself.
- **Data flow**: `store (Zustand, client/src/store/) → repo (client/src/repo/) → api (client/src/api/) | Dexie`. Local trip/day CRUD goes through the `api/local/` adapters onto `db/panelmintDb.ts`; the remaining axios `apiClient` surfaces are interim and are being ported domain by domain — never add new consumers of them.
- **Styling**: semantic Tailwind tokens (`bg-surface*`, `text-content*`, `border-edge*`, `bg-accent*`) or the underlying `var(--token)` variables — never color literals, arbitrary-value color classes or numeric inline `fontSize`, so user-chosen scheme/transparency/text-size keep working. `theme:lint` flags bypasses; suppress intentional exceptions (map/PDF/brand) with a `theme-lint-disable` line comment.
- **PWA**: `vite-plugin-pwa` + Workbox precaches the shell and cache raster map tiles; `prebuild` generates icons. There are no API runtime-caching rules — nothing calls `/api/*`.

## Shared contracts & i18n

- The Zod contracts in `shared/` are the source of truth for wire/data shapes. Edit the schema, rebuild shared, then the client picks up the inferred types.
- Locale files live in `shared/src/i18n/<locale>/`, one file per domain; `en/` is canonical. When you add or change a key, **add a real translation to every locale** — parity fails on missing keys, and an English placeholder is not acceptable in a non-`en` locale.

## Project direction

These principles come out of a full-repo audit and shape all new code:

- **Protect the crown jewels.** The client's offline-first data core (repos + Dexie) and the Zod contract layer are production-grade. Extend them; never route around them or rewrite them in anger.
- **No "modern shell over legacy core."** The debt pattern is a modern frame delegating to the old approach underneath (on the client: feature components calling the raw API past the offline core). New code goes all-in on the target architecture; when touching a legacy seam, migrate it rather than adding another wrapper.
- **Single source of truth over manual synchronization.** Never add a hand-mirrored copy of state, schema, or contract. Derive from one source, or guard the copy with a parity test that cannot silently skip.
- **DI over global mutable module state.** New client code avoids `window`-global buses and mutable module state.
- **Use the runtime's native idioms.** Prefer React 19 features (`useOptimistic`, Actions, `use()`/Suspense) over hand-rolled equivalents.
- **Fail closed, gates stay on.** Security switches default to safe; misconfiguration must refuse, not degrade. Never lower a quality gate to land a change — no new `any`, no new `eslint-disable`, no downgrading rules to `warn`, no lowered coverage thresholds.

## Conventions

- **Conventional commits** (`fix(maps): ...`, `feat(budget): ...`). **No Co-Authored-By or other tool-attribution trailers.**
- One focused change per commit; no unrelated reformatting. Tests ship in the same change.
- **Parity is law** when porting a domain from the hosted API to `api/local/`: same response shape, same error strings, same side-channel fields, so callers never notice the swap.

## Reference docs

- `README.md` — what the repo is now and how to run it.
- `client/src/pages/PATTERN.md` — the Page wiring-container spec.
- `client/src/api/local/README.md` — the local-adapter conventions.
