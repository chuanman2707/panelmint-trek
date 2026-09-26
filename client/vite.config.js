import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync } from 'node:fs';

// The version this bundle is built as, baked in at build time. The release build
// bumps every package.json before it builds, so this matches the app version.
const UI_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// `npm run build:analyze` writes dist/stats.html — a treemap of what actually ended
// up in each chunk. The plain build only reports chunk sizes, which tells you a chunk
// is too big but not which dependency made it so.
// Mehrere Worktrees laufen hier parallel. Ohne diese Variable streiten
// sie sich um 5173; mit ihr bekommt jeder seinen eigenen Port.
const DEV_PORT = Number(process.env.TREK_DEV_PORT) || 5173;

export default defineConfig(({ mode }) => ({
  define: { __TREK_UI_VERSION__: JSON.stringify(UI_VERSION) },
  plugins: [
    react(),
    mode === 'analyze' &&
      visualizer({ filename: 'dist/stats.html', gzipSize: true, brotliSize: true }),
    VitePWA({
      registerType: 'autoUpdate',
      // Serve the generated manifest (+ dev SW) in development too, so the installed
      // PWA can be tested against the dev server. Without this, dev ships no
      // <link rel="manifest">, so iOS falls back to legacy standalone
      // (apple-mobile-web-app-capable only) and pops the Safari chrome on every
      // in-app navigation away from the start URL. Prod already serves the manifest.
      devOptions: {
        enabled: true,
        type: 'module',
        suppressWarnings: true,
        /*
         * No navigation fallback from the dev service worker.
         *
         * `workbox.navigateFallback` below is right for production: offline, a
         * deep link has to be answered by the cached shell. In development it
         * means the worker answers a reload with the index.html it cached
         * earlier, whose <script> tags point at module URLs from before the last
         * restart — so the browser faithfully re-runs the previous version of
         * the app while the editor shows the new one, and every explanation for
         * that is wrong until someone thinks of the service worker. It cost
         * several rounds of "I don't see the change" to find.
         */
        navigateFallback: undefined,
      },
      workbox: {
        // Anything above this is dropped from the precache manifest. The build does
        // not fail over it, it only prints "won't be precached", so the ceiling has
        // to sit close to the real bundle or an accidental heavyweight goes
        // offline-broken unnoticed. Largest precached entry is the heic-to chunk at
        // 3.0 MB, which leaves about 670 kB of headroom; the entry chunk is 258 kB.
        maximumFileSizeToCacheInBytes: 3.5 * 1024 * 1024,
        // Every route chunk is precached alongside the shell, deliberately: for an
        // offline-first travel planner a route the user never opened before losing
        // signal still has to work. The trade is that splitting buys first paint and
        // not install size: 107 entries / 17,795 KiB before any of it, 463 /
        // 23,292 KiB now (measured, not estimated).
        //
        // Keep this figure honest. #2228 traced PWA boot failures to the browser
        // evicting this origin's whole bucket, precached shell included, and this
        // comment is the only record of what the install actually costs. Anything
        // matching the globs below is fetched at service-worker install by every
        // user, whether or not they ever reach the code. `templates/*.json` covers
        // the bundled trip templates under public/templates/ — Settings ▸ Data's
        // sample trip must open offline too — without sweeping in whatever other
        // JSON ever lands in dist/.
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,ttf}', 'templates/*.json'],
        // build:analyze drops a treemap next to the app; it must never end up in a
        // precache manifest if someone ships that build by accident.
        globIgnores: ['**/stats.html'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // Carto map tiles (default provider)
            // The apex host counts too: a template without {s} points straight at
            // basemaps.cartocdn.com, and matching only the shards left those tiles
            // uncached, so the map went blank offline.
            urlPattern: /^https:\/\/(?:[a-d]\.)?basemaps\.cartocdn\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenStreetMap tiles (fallback / alternative)
            // Shares the 'map-tiles' cache; keep maxEntries equal to the Carto
            // rule above (12288) — the shared LRU budget.
            // Both spellings have to stay in the pattern: templates are rewritten
            // onto the apex host (src/utils/tileUrl.ts), but caches filled before
            // that still hold a/b/c URLs and must keep serving offline.
            urlPattern: /^https:\/\/(?:[a-c]\.)?tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenStreetMap DE — a shipped preset that would otherwise match no
            // rule at all (#2180). Same cache, same limits as the rules above.
            urlPattern: /^https:\/\/tile\.openstreetmap\.de\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Stadia Smooth — the other shipped raster preset with the same hole (#2180).
            urlPattern: /^https:\/\/tiles\.stadiamaps\.com\/tiles\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Amap road and satellite presets, served from the shard hosts under
            // is.autonavi.com (src/constants/mapDefaults.ts). Without a rule here
            // they would be the #2180 hole all over again.
            urlPattern: /^https:\/\/(?:[a-z0-9]+\.)?is\.autonavi\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 12288, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'PanelMint \u2014 Travel Planner',
        short_name: 'PanelMint',
        description: 'Travel planning, itineraries, budgets and packing \u2014 based on TREK',
        theme_color: '#0d9488',
        background_color: '#0f172a',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        categories: ['travel', 'navigation'],
        icons: [
          { src: 'icons/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png' },
          { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
          // Dedicated safe-zone renders: the full-bleed icon under a maskable
          // purpose filled the whole Android launcher tile without any padding.
          { src: 'icons/icon-maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ].filter(Boolean),
  build: {
    // Pin the output level instead of inheriting whatever the current Vite default
    // is, so a toolchain bump can't silently change which browsers still work.
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: true },
    // Vite 8 bundles with rolldown, not rollup. `rollupOptions` is only an alias
    // onto `rolldownOptions`, and both `manualChunks` and `advancedChunks` are
    // deprecated in favour of `codeSplitting.groups` — a config mixing them still
    // builds green and simply has no effect.
    //
    // `tags: ['$initial']` is not optional here. Without it a group also collects
    // modules that today hang behind React.lazy, which turns the group chunk into
    // a static import of the entry and lifts it into the index.html modulepreload.
    //
    // Deliberately no groups for leaflet or react-markdown. Those already sit in
    // async chunks of their own with hashes that survive a release; a group would
    // only rename them, and at worst make them eager.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              priority: 40,
              tags: ['$initial'],
              // react-dom/server is pulled dynamically by TripPDF and lives in an
              // async chunk. Excluding it keeps a later static import from lifting
              // ~170 kB of Fizz into the eager vendor chunk.
              test: (id) =>
                /[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id) &&
                !/react-dom[\\/](server|static)|react-dom-server/.test(id),
            },
            {
              name: 'vendor-core',
              priority: 30,
              // zod and dompurify arrive through @trek/shared but live in
              // node_modules themselves, so they are caught here. @trek/shared is
              // not: it resolves to shared/dist without a node_modules segment,
              // and its contract code changes with every release anyway.
              tags: ['$initial'],
              test: /[\\/]node_modules[\\/](zustand|dexie|zod|dompurify|isomorphic-dompurify)[\\/]/,
            },
          ],
        },
      },
    },
  },
  /*
   * Never pre-bundle the workspace's own contracts.
   *
   * `@trek/shared` resolves to shared/dist, which is a build output that changes
   * whenever a Zod schema does. Pre-bundled, the dev server keeps serving the
   * copy it optimised at startup: a field added to the document contract is
   * missing in the browser, `normalizeBookDocument` strips it on load, and the
   * change you just made vanishes on reload with nothing in the console. It
   * cost an afternoon twice before anyone worked out it was not the code.
   */
  optimizeDeps: {
    exclude: ['@trek/shared'],
  },
  server: {
    port: DEV_PORT,
    // And watch the build output, so rebuilding shared reloads the page rather
    // than leaving a stale module graph behind.
    watch: {
      ignored: ['!**/shared/dist/**'],
    },
  },
}));
