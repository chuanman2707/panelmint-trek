import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './helpers/msw/server';

// waitFor/findBy* default to 1s, which is enough on a dev machine but not on a
// 4-core CI runner running the whole suite in parallel forks — a multipart POST
// through MSW plus an IndexedDB write can exceed it. Still well inside the 15s
// testTimeout, so a genuinely broken assertion fails, it just takes longer.
configure({ asyncUtilTimeout: 5000 });

// MSW lifecycle. A cross-origin request nobody mocked is the dangerous kind: 'warn'
// lets it through, so the runner really talks to frankfurter or a tile server and settles
// a promise after the test environment is gone (see handlers/external.ts). Those fail now.
// An unhandled same-origin call stays a warning: that is a missing handler, not egress.
beforeAll(() => server.listen({
  onUnhandledRequest: (request, print) => {
    if (new URL(request.url).origin === location.origin) print.warning();
    else print.error();
  },
}));
afterEach(() => {
  server.resetHandlers();
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
afterAll(() => server.close());

// ── jsdom stubs ────────────────────────────────────────────────────────────────

// Force en-US locale for toLocaleDateString so tests are deterministic on
// non-US dev machines (Windows-de-DE returns "Sonntag" instead of "Sunday").
// Only affects calls without an explicit locale — callers that pass a locale
// keep their behavior.
const _origToLocaleDateString = Date.prototype.toLocaleDateString
Date.prototype.toLocaleDateString = function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
  return _origToLocaleDateString.call(this, locales ?? 'en-US', options)
}

// window.matchMedia — used by dark mode / responsive components.
// Width queries are answered from window.innerWidth, which is what a test sets
// when it wants a phone viewport, and the lists re-evaluate on a resize event,
// so a component that follows the breakpoint can be driven from a test the same
// way the browser drives it. Every other query keeps the old constant false.
const mediaLists = new Set<{ media: string; matches: boolean; listeners: Set<(e: MediaQueryListEvent) => void> }>()

function widthMatches(query: string): boolean {
  const max = /\(\s*max-width:\s*(\d+)px\s*\)/.exec(query)
  if (max) return window.innerWidth <= Number(max[1])
  const min = /\(\s*min-width:\s*(\d+)px\s*\)/.exec(query)
  if (min) return window.innerWidth >= Number(min[1])
  return false
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => {
    const entry = { media: query, matches: widthMatches(query), listeners: new Set<(e: MediaQueryListEvent) => void>() }
    mediaLists.add(entry)
    return {
      get matches() { return entry.matches },
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_type: string, fn: (e: MediaQueryListEvent) => void) => entry.listeners.add(fn)),
      removeEventListener: vi.fn((_type: string, fn: (e: MediaQueryListEvent) => void) => entry.listeners.delete(fn)),
      dispatchEvent: vi.fn(),
    }
  }),
});

window.addEventListener('resize', () => {
  for (const entry of mediaLists) {
    const matches = widthMatches(entry.media)
    if (matches === entry.matches) continue
    entry.matches = matches
    for (const fn of entry.listeners) fn({ matches, media: entry.media } as MediaQueryListEvent)
  }
})

// IntersectionObserver — used by lazy loading
// Must use a class or regular function (not arrow function) so 'new IntersectionObserver()' works
class _MockIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  root = null
  rootMargin = ''
  thresholds: ReadonlyArray<number> = []
  takeRecords = vi.fn(() => [])
  constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
}
globalThis.IntersectionObserver = _MockIntersectionObserver as unknown as typeof IntersectionObserver;

// ResizeObserver — used by resizable panels
class _MockResizeObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(_callback: ResizeObserverCallback) {}
}
globalThis.ResizeObserver = _MockResizeObserver as unknown as typeof ResizeObserver;

// URL.createObjectURL / revokeObjectURL — Node 22 URL.createObjectURL requires
// a native node:buffer Blob; passing a jsdom Blob throws ERR_INVALID_ARG_TYPE.
// Tests that need blob URLs should mock fetch to return node:buffer Blobs so
// the real URL.createObjectURL works. For tests that only need the method to
// exist without returning a real URL, stub it here as a vi.fn fallback.
if (typeof URL.createObjectURL === 'undefined') {
  Object.defineProperty(URL, 'createObjectURL', { writable: true, configurable: true, value: vi.fn(() => 'blob:mock') });
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, configurable: true, value: vi.fn() });
}

// Element.prototype.scrollIntoView — jsdom doesn't implement it
Element.prototype.scrollIntoView = vi.fn();
