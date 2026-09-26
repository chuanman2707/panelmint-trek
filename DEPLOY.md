# Deploy — Cloudflare Pages

PanelMint is a static PWA. One Pages project serves it: `app.panelmint.com`.
Everything below is dashboard work — no code changes needed.

## 1. Connect the repo

1. Push `panelmint` (already pushed — this branch is the production line).
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git** → select the `panelmint-trek` repo.
3. Production branch: **`panelmint`**.

## 2. Build settings

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `client/dist` |
| Root directory | leave blank (repo root — the monorepo) |

- `npm run build` builds `shared/` then `client/` — do **not** substitute a
  client-only command; the client type-checks and bundles against shared's
  compiled `dist/`.
- Pages installs dependencies from `package-lock.json` before the build.
- Set env var **`NODE_VERSION=22`** if the project defaults lower — CI builds
  on Node 22.
- `client/public/_headers` (CSP + security headers) and `_redirects` (SPA
  fallback) are committed and ship into `dist/`; Pages applies them
  automatically. `public/templates/` (shareable trip templates) comes along
  the same way.

## 3. Domain + analytics

1. Pages project → **Custom domains** → add **`app.panelmint.com`**.
2. Enable **Cloudflare Web Analytics** in the dashboard (Pages project → Web
   Analytics, or Web Analytics → add site for the hostname). Dashboard
   toggle only — no token or code in the repo.

## 4. Verify the deploy

- `https://app.panelmint.com/` lands on the dashboard; create a trip, add a
  place to a day, reload — data persists (IndexedDB).
- Trip page → **Share** copies an `/import?d=…` link; opening it shows the
  import preview → **Save to my device** lands a second copy.
- `/import?src=/templates/nha-trang-3n2d.json` imports the bundled template.
- Deep links (e.g. `/settings`) serve `index.html` with a 200 — `_redirects`
  is doing its job — and security headers appear in the response (`_headers`).
