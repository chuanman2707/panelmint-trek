import { useNavigate, useLocation, useMatch } from 'react-router'
import { useTranslation } from '../../i18n'
import { LayoutGrid, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import MFab from './MFab'

interface NavItem { to: string; label: string; icon: LucideIcon }

// The centre "+" means something different per context: inside a trip it adds a
// place (or a reservation/transport/expense matching the active tab), everywhere
// else it creates a new trip. Pages pick the intent up from the query params.
function useCreateAction(): { label: string; run: () => void } {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const inTrip = useMatch('/trips/:id')

  if (inTrip) {
    // The "+" is context-aware per active tab: Bookings → reservation,
    // Transports → transport, Costs → expense. Tabs without a create modal
    // (lists) fall through to adding a place. #1349
    const id = inTrip.params.id
    const tripTab = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(`trip-tab-${id}`) : null
    if (tripTab === 'finanzplan') return { label: t('costs.addExpense'), run: () => navigate(`/trips/${id}?create=expense`) }
    if (tripTab === 'buchungen') return { label: t('reservations.addManual'), run: () => navigate(`/trips/${id}?create=reservation`) }
    if (tripTab === 'transports') return { label: t('transport.addManual'), run: () => navigate(`/trips/${id}?create=transport`) }
    return { label: t('places.addPlace'), run: () => navigate(`/trips/${id}?create=place`) }
  }
  return { label: t('dashboard.newTrip'), run: () => navigate('/dashboard?create=1') }
}

/**
 * Floating glass dock of the mobile shell: 42px circles, the active destination
 * on the --m-act pill and a context FAB in the middle. Dashboard is the only
 * destination left; settings are reached from the dashboard user menu.
 */
export default function MBottomNav() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const create = useCreateAction()

  const dockItems: NavItem[] = [
    { to: '/dashboard', label: t('nav.myTrips'), icon: LayoutGrid },
  ]

  const isActive = (to: string) =>
    to === '/dashboard' ? location.pathname === '/dashboard' : location.pathname.startsWith(to)

  // The FAB gives way to a decorative logo slot on screens without an add
  // action (settings).
  const logoSlot = location.pathname.startsWith('/settings')

  const circleCls = (active: boolean) =>
    `flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full ${
      active ? 'bg-m-act text-m-actfg' : 'text-m-muted'
    }`

  const renderItem = ({ to, label, icon: Icon }: NavItem) => {
    const active = isActive(to)
    // Fixed sizes per slot (demo): the dashboard grid is 18/2.1, every other
    // slot 21/1.9 — independent of the active state.
    const dash = to === '/dashboard'
    return (
      <button
        key={to}
        type="button"
        onClick={() => navigate(to)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={circleCls(active)}
      >
        <Icon size={dash ? 18 : 21} strokeWidth={dash ? 2.1 : 1.9} />
      </button>
    )
  }

  return (
    <nav className="fixed left-4 right-4 z-40 flex h-[62px] items-center rounded-[31px] border border-[color:var(--m-gbr)] bg-[color:var(--m-glass)] px-3 shadow-[0_16px_44px_-14px_rgba(0,0,0,.35)] backdrop-blur-[30px] backdrop-saturate-[1.8] bottom-[calc(env(safe-area-inset-bottom,0px)+12px)]">
      <div className="flex min-w-0 flex-1 items-center justify-around">{dockItems.map(renderItem)}</div>

      {logoSlot ? (
        <span aria-hidden="true" className="mx-2 flex h-14 w-14 flex-none items-center justify-center rounded-full bg-[color:var(--m-ic)] opacity-70">
          <img src="/icons/icon-dark.svg" alt="" className="block h-6 w-6 opacity-75 dark:hidden" />
          <img src="/icons/icon-white.svg" alt="" className="hidden h-6 w-6 opacity-75 dark:block" />
        </span>
      ) : (
        <MFab onClick={create.run} ariaLabel={create.label} className="mx-2">
          <Plus size={26} strokeWidth={2.4} />
        </MFab>
      )}

      {/* Mirror column keeps the centre slot dead centre. */}
      <div className="flex min-w-0 flex-1 items-center justify-around" />
    </nav>
  )
}
