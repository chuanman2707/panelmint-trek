import React, { useEffect, useState, ReactNode, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router'
import { useAuthStore } from './store/authStore'
import { useSettingsStore } from './store/settingsStore'
import { applyAppearance } from './theme/applyAppearance'
import { useAddonStore } from './store/addonStore'
import { ToastContainer } from './components/shared/Toast'
import MobileShell from './mobile/MobileShell'
import MRouteFallback from './mobile/components/MRouteFallback'
import ErrorBoundary from './components/shared/ErrorBoundary'
import { lazyWithRetry } from './utils/lazyWithRetry'
import { useIsPhone } from './mobile/useIsPhone'
import { TranslationProvider } from './i18n'
import { tripRepo } from './repo/tripRepo'
import { readStartDestination, tripStartPath, DEFAULT_START_PAGE, DEFAULT_START_TRIP_TAB, SETTINGS_WAIT_MS } from './utils/startDestination'
import OfflineBanner from './components/Layout/OfflineBanner'

// Every page below loads on demand. lazyWithRetry rather than lazy: a chunk that
// fails once gets a second, cache-busted attempt before the route boundary reaches
// for a reload.
const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage'))
const TripPlannerPage = lazyWithRetry(() => import('./pages/TripPlannerPage'))
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage'))

// The phone screens are chunks of their own, alongside the desktop pages rather
// than inside them: a phone never loads the desktop planner, a desktop never the
// mobile shell.
const MDashboardScreen = lazyWithRetry(() => import('./mobile/screens/dashboard/MDashboard'))
const MTripScreen = lazyWithRetry(() => import('./mobile/screens/trip/MTripShell'))
const MSettingsScreen = lazyWithRetry(() => import('./mobile/screens/settings/MSettings'))

/**
 * The shell around every route. Below the md breakpoint the mobile shell owns
 * chrome (tokens, dock, sheets, toasts); from 768px up the legacy wrapper stays.
 * The boundary sits inside the shell so a broken page keeps the navigation the
 * user needs to leave it. `key` remounts the boundary per path so an error does
 * not follow the user across navigations.
 */
function RouteShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const isPhone = useIsPhone()
  return (
    <MobileShell isPhone={isPhone}>
      <ErrorBoundary
        key={location.pathname}
        boundaryId="route"
        level="route"
        variant={isPhone ? 'mobile' : 'desktop'}
      >
        {children}
      </ErrorBoundary>
    </MobileShell>
  )
}

/**
 * Picks the chunk, not just the branch. Both sides come through lazyWithRetry,
 * so exactly one of them is fetched for a given viewport.
 */
function ViewportRoute({ phone: Phone, desktop: Desktop }: {
  phone: React.ComponentType
  desktop: React.ComponentType
}): React.ReactElement {
  const isPhone = useIsPhone()
  return isPhone ? <Phone /> : <Desktop />
}

/**
 * The entry point every shortcut, bookmark and the installed PWA share
 * (manifest start_url is '/'), which is why the startup destination is decided
 * here rather than on /dashboard — landing on the dashboard directly has to keep
 * working, or there would be no way back to it.
 *
 * The startup preference comes from the settings once they have loaded; the
 * localStorage mirror answers earlier for a device that has seen it. Only
 * 'active_trip' costs the one lookup that finds the trip, and any failure along
 * the way lands on the dashboard.
 */
function RootRedirect() {
  const isLoading = useAuthStore((s) => s.isLoading)
  const settingsLoaded = useSettingsStore((s) => s.isLoaded)
  const settings = useSettingsStore((s) => s.settings)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const [target, setTarget] = useState<string | null>(null)
  // Bounds the wait below: loadSettings deliberately leaves isLoaded false on a
  // failed read so it can retry, which would otherwise strand the spinner.
  const [settingsGaveUp, setSettingsGaveUp] = useState(false)

  useEffect(() => {
    if (settingsLoaded) return
    const timer = setTimeout(() => setSettingsGaveUp(true), SETTINGS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [settingsLoaded])

  useEffect(() => {
    if (isLoading || target) return
    const mirrored = readStartDestination()
    if (!mirrored && !settingsLoaded && !settingsGaveUp) {
      // Ask for the settings instead of waiting for whoever else might. The
      // store de-dupes concurrent loads, so this is free when one is already in
      // flight.
      loadSettings()
      return
    }
    // Loaded settings are the truth; the mirror is what we knew last time.
    const { page, tab } = settingsLoaded
      ? { page: settings.start_page ?? DEFAULT_START_PAGE, tab: settings.start_trip_tab ?? DEFAULT_START_TRIP_TAB }
      : (mirrored ?? { page: DEFAULT_START_PAGE, tab: DEFAULT_START_TRIP_TAB })
    if (page !== 'active_trip') { setTarget('/dashboard'); return }
    let cancelled = false
    // Through the repo, not the api: this answers from the local database.
    tripRepo.active()
      .then(({ trip }) => { if (!cancelled) setTarget(trip ? tripStartPath(trip.id, tab) : '/dashboard') })
      .catch(() => { if (!cancelled) setTarget('/dashboard') })
    return () => { cancelled = true }
  }, [isLoading, settingsLoaded, settingsGaveUp, settings, target, loadSettings])

  if (isLoading || !target) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div className="w-10 h-10 border-4 border-edge border-t-content rounded-full animate-spin"></div>
      </div>
    )
  }

  return <Navigate to={target} replace />
}

/**
 * Shown while a route chunk is in flight. On a phone the desktop spinner on
 * bg-surface would be a foreign white sheet, so the fallback picks its palette.
 */
function RouteFallback() {
  const isPhone = useIsPhone()
  if (isPhone) return <MRouteFallback />
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="w-10 h-10 border-4 border-edge border-t-content rounded-full animate-spin"></div>
    </div>
  )
}

export default function App() {
  const { loadSettings } = useSettingsStore()
  const { loadAddons } = useAddonStore()

  // The whole boot: seed the local database, adopt the self profile, then load
  // the stores. Nothing here touches the network — PanelMint is local-first.
  useEffect(() => {
    useAuthStore.getState().bootLocal()
      .catch((err) => {
        console.error('[boot] local bootstrap failed:', err)
        useAuthStore.setState({ isLoading: false })
      })
      .finally(() => {
        loadSettings()
        loadAddons()
      })
  }, [loadSettings, loadAddons])

  const { settings } = useSettingsStore()

  useEffect(() => {
    const run = () =>
      applyAppearance({
        darkMode: settings.dark_mode,
        appearance: settings.appearance,
      })
    run()
    // Re-resolve on OS theme change while in auto mode.
    if (settings.dark_mode === 'auto') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = () => run()
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
  }, [settings.dark_mode, settings.appearance])

  return (
    <TranslationProvider>
      <ErrorBoundary boundaryId="widget:toast" fallback={null}><ToastContainer /></ErrorBoundary>
      <ErrorBoundary boundaryId="widget:offline-banner" fallback={null}><OfflineBanner /></ErrorBoundary>
      {/* One boundary for all route chunks, above <Routes> so it stays mounted
          across navigations. react-router runs location updates inside a transition,
          so a mounted boundary keeps the current page on screen instead of flashing
          a spinner on every jump — the spinner is for the first paint of a deep link. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="/dashboard"
            element={
              <RouteShell>
                <ViewportRoute phone={MDashboardScreen} desktop={DashboardPage} />
              </RouteShell>
            }
          />
          <Route
            path="/trips/:id"
            element={
              <RouteShell>
                <ViewportRoute phone={MTripScreen} desktop={TripPlannerPage} />
              </RouteShell>
            }
          />
          <Route
            path="/settings"
            element={
              <RouteShell>
                <ViewportRoute phone={MSettingsScreen} desktop={SettingsPage} />
              </RouteShell>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </TranslationProvider>
  )
}
