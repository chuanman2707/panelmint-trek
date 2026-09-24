> **PanelMint** is a fork of [TREK](https://github.com/liketrek/TREK) (AGPL-3.0),
> rebranded and operated as the trip planner behind [panelmint.com](https://panelmint.com).
> Pinned to upstream release `v4.3.1`. All modifications live in this public repo.

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-trek-light.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/logo-trek-dark.svg" />
  <img src="docs/logo-trek-dark.svg" alt="TREK" height="96" />
</picture>

<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/subtitle-light.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/subtitle-dark.png" />
  <img src="docs/subtitle-dark.png" alt="your trip. your plan." height="28" />
</picture>

A local-first travel planner — trips, day plans, maps, budgets and packing lists,
running entirely in the browser against IndexedDB.

</div>

---

## What this repo is

PanelMint is being converted from TREK's self-hosted client/server product into a
**static, offline-first application**: there is no backend, no account system, no
realtime sync — your data lives in the browser's IndexedDB (Dexie) and never
leaves the device.

- **`shared/`** (`@trek/shared`) — Zod schemas and i18n locales. Build it before
  the client (`npm run build --workspace=shared`).
- **`client/`** (`@trek/client`) — React 19 + Vite + Zustand + Tailwind PWA.
  Maps are Leaflet raster tiles only (OpenStreetMap default; Amap and satellite
  presets remain).

The upstream `server/`, `plugin-sdk/`, Docker deployment files, wiki and CI
workflows have been removed. Documentation is being rewritten as the conversion
lands — treat any reference to a server, plugins, Docker or `/api/*` endpoints in
older docs as historical.

## Develop

```bash
npm install
npm run dev        # builds shared, watches it, and serves the client (Vite, :5173)
npm run build      # shared then client — output lands in client/dist
npm run test       # shared then client vitest suites
```

Per-workspace commands use `npm run <script> --workspace=client` (or `shared`).

## License

AGPL-3.0 — see [LICENSE](LICENSE). PanelMint is a fork of TREK; upstream
copyright and attribution live in [NOTICE.md](NOTICE.md).
