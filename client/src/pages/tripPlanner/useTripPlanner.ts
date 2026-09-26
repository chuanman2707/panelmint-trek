import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router'
import { useTripStore, type TripStoreState } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../../components/shared/Toast'
import { Map, Ticket, PackageCheck, Wallet, Train } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { accommodationsApi, tripsApi, assignmentsApi, mapsApi } from '../../api/client'
import { applyLocalEffect } from '../../store/localEffects'
import { TRANSPORT_TYPES } from '../../utils/dayMerge'
import { accommodationRepo } from '../../repo/accommodationRepo'
import { isEffectivelyOffline } from '../../sync/networkMode'
import { useAddonStore } from '../../store/addonStore'
import { useResizablePanels } from '../../hooks/useResizablePanels'
import { useRouteCalculation } from '../../hooks/useRouteCalculation'
import { useTripRouteOverview } from '../../components/Map/useTripRouteOverview'
import { usePlaceSelection } from '../../hooks/usePlaceSelection'
import { usePlannerHistory } from '../../hooks/usePlannerHistory'
import { useIsTouch } from '../../hooks/useIsTouch'
import type { Accommodation, TripMember, Day, Place, Reservation } from '../../types'
import { RASTER_FALLBACK_TILE_URL, DEFAULT_MAP_LAT, DEFAULT_MAP_LNG, DEFAULT_MAP_ZOOM } from '../../constants/mapDefaults'
import { useTileUrl } from '../../hooks/useTileUrl'
import { resolvePoolAssignmentId } from './tripPlannerModel'
import { isDeepLinkableTripTab, TRIP_TAB_LABEL_KEYS } from '../../constants/tripTabs'
import { isRoutableReservation } from '../../utils/reservationRoutes'
import {
  parseStoredConnections, resolveEffectiveConnections, resolveVisibleConnectionIds,
  toggleConnectionId, toggleAllConnections as flipAllConnectionsMode,
  type StoredConnections,
} from '../../utils/connectionsVisibility'
import { plannedPlaceIds, plannedPlaceIdsForDay } from '../../utils/plannedPlaces'

/**
 * Trip planner page logic — the big one. Owns the trip store wiring, addon
 * gating, accommodations/members loading, the tab + resizable-panel + selection
 * state, every place/assignment/reservation/transport CRUD handler (with undo),
 * the map filters/derivations and the splash gate. TripPlannerPage stays a
 * wiring container that lays out the day/map/places panes and modals.
 * Behaviour is identical to the previous in-component logic.
 */
export function useTripPlanner() {
  const { id } = useParams<{ id: string }>()
  // The route param is a string; convert once here so every downstream component
  // prop and store call gets a real number. An absent/invalid id becomes NaN,
  // which stays falsy in the `if (tripId)` guards below.
  const tripId = id ? Number(id) : Number.NaN
  const navigate = useNavigate()
  const toast = useToast()
  const { t, language, locale } = useTranslation()
  const { settings } = useSettingsStore()
  const trip = useTripStore(s => s.trip)
  const days = useTripStore(s => s.days)
  const places = useTripStore(s => s.places)
  const assignments = useTripStore(s => s.assignments)
  const packingItems = useTripStore(s => s.packingItems)
  const todoItems = useTripStore(s => s.todoItems)
  const categories = useTripStore(s => s.categories)
  const reservations = useTripStore(s => s.reservations)
  const budgetItems = useTripStore(s => s.budgetItems)
  const selectedDayId = useTripStore(s => s.selectedDayId)
  const isLoading = useTripStore(s => s.isLoading)
  // Actions — stable references, don't cause re-renders
  const tripActions = useRef(useTripStore.getState()).current
  const can = useCanDo()
  const { pushUndo, undo, canUndo, lastActionLabel } = usePlannerHistory()

  const handleUndo = useCallback(async () => {
    const label = lastActionLabel
    await undo()
    toast.info(t('undo.done', { action: label ?? '' }))
  }, [undo, lastActionLabel, toast])

  // The addon set is static (packing + budget, see store/addonStore) — no feed
  // to wait on, so the tab guard below can trust enabledAddons from the start.
  const addonEnabled = useAddonStore(s => s.isEnabled)
  const enabledAddons = useMemo(() => ({
    packing: addonEnabled('packing'),
    budget: addonEnabled('budget'),
  }), [addonEnabled])
  // Declared here rather than with the other layout state further down, because
  // the assignment and place lists below are decided on it. One subscriber for
  // the whole hook.
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  const [tripAccommodations, setTripAccommodations] = useState<Accommodation[]>([])
  const [tripMembers, setTripMembers] = useState<TripMember[]>([])

  // Re-fetch the trip roster so consumers (Costs participants, …) pick up a
  // just-added guest or member without a full page reload. The roster is a
  // local adapter read — it resolves offline too, so there is no online gate.
  const refreshMembers = useCallback(() => {
    if (!tripId) return
    tripsApi.getMembers(tripId).then(d => {
      const all = [d.owner, ...(d.members || [])].filter(Boolean)
      setTripMembers(all)
    }).catch(err => toast.error(err instanceof Error ? err.message : t('common.unknownError')))
  }, [tripId, toast, t])

  const loadAccommodations = useCallback(() => {
    if (tripId) {
      accommodationRepo.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
      tripActions.loadReservations(tripId)
    }
  }, [tripId])

  const TRIP_TABS = [
    { id: 'plan', label: t(TRIP_TAB_LABEL_KEYS.plan), icon: Map },
    { id: 'transports', label: t(TRIP_TAB_LABEL_KEYS.transports), icon: Train },
    { id: 'buchungen', label: t(TRIP_TAB_LABEL_KEYS.buchungen), shortLabel: t('trip.tabs.reservationsShort'), icon: Ticket },
    ...(enabledAddons.packing ? [{ id: 'listen', label: t(TRIP_TAB_LABEL_KEYS.listen), shortLabel: t('trip.tabs.listsShort'), icon: PackageCheck }] : []),
    ...(enabledAddons.budget ? [{ id: 'finanzplan', label: t(TRIP_TAB_LABEL_KEYS.finanzplan), icon: Wallet }] : []),
  ]

  const [searchParams, setSearchParams] = useSearchParams()

  // ?tab=<id> opens the trip straight on that tab (the startup destination
  // setting, a browser shortcut, a wrapper app). It beats the session's last
  // tab because it is an explicit request for this one, and it is read in the
  // initializer rather than an effect so the planner never paints the plan view
  // first and swaps a frame later.
  const [activeTab, setActiveTab] = useState<string>(() => {
    const requested = searchParams.get('tab')
    // Validate against the tabs that actually exist right now — a deep-linked or
    // saved id for a removed surface (files, collab, a plugin) starts on plan
    // instead of mounting for one frame and being evicted by the effect below.
    if (requested && isDeepLinkableTripTab(requested) && TRIP_TABS.some(t => t.id === requested)) return requested
    const saved = sessionStorage.getItem(`trip-tab-${tripId}`)
    return saved && TRIP_TABS.some(t => t.id === saved) ? saved : 'plan'
  })

  useEffect(() => {
    const validTabIds = TRIP_TABS.map(t => t.id)
    if (!validTabIds.includes(activeTab)) {
      setActiveTab('plan')
      sessionStorage.setItem(`trip-tab-${tripId}`, 'plan')
    }
  }, [activeTab, enabledAddons])

  const handleTabChange = (tabId: string): void => {
    setActiveTab(tabId)
    sessionStorage.setItem(`trip-tab-${tripId}`, tabId)
    if (tabId === 'finanzplan') tripActions.loadBudgetItems?.(tripId)
  }

  // handleTabChange is where a tab's lazy load and its session memory happen, and
  // the tab we *start* on never goes through it — neither a ?tab= deep link nor a
  // tab restored from a previous visit. Catch both up once per trip, or opening
  // straight into Files shows an empty list.
  const startTabSettled = useRef<number | null>(null)
  useEffect(() => {
    if (!tripId || startTabSettled.current === tripId) return
    startTabSettled.current = tripId
    sessionStorage.setItem(`trip-tab-${tripId}`, activeTab)
    if (activeTab === 'finanzplan') tripActions.loadBudgetItems?.(tripId)
  }, [tripId])
  const {
    leftWidth, rightWidth, leftCollapsed, rightCollapsed, setLeftCollapsed, setRightCollapsed,
    leftHidden, rightHidden, toggleLeft, toggleRight, narrow: narrowPanels,
    startResizeLeft, startResizeRight,
  } = useResizablePanels()
  const { selectedPlaceId, selectedAssignmentId, setSelectedPlaceId, selectAssignment } = usePlaceSelection()
  const [showDayDetail, setShowDayDetail] = useState<Day | null>(null)
  const [dayDetailCollapsed, setDayDetailCollapsed] = useState(false)
  const [showPlaceForm, setShowPlaceForm] = useState<boolean>(false)
  const [editingPlace, setEditingPlace] = useState<Place | null>(null)
  const [prefillCoords, setPrefillCoords] = useState<{ lat: number; lng: number; name?: string; address?: string; website?: string; phone?: string; osm_id?: string } | null>(null)
  const [editingAssignmentId, setEditingAssignmentId] = useState<number | null>(null)
  // Day context of the open form. Set only by the day-scoped entry points (the
  // mobile day toolbar, a long-press on the mobile map); every other opener
  // clears it, so a place added from the pool still lands in the pool (#1998).
  const [placeFormDayId, setPlaceFormDayId] = useState<number | null>(null)
  /**
   * Where in the day the place being added belongs, when the caller knows.
   * Null means the old behaviour: the server appends it at the end.
   */
  const [placeFormPosition, setPlaceFormPosition] = useState<number | null>(null)
  // The position belongs to the form it was opened with and to nothing after it. The
  // day-scoped openers set the day, the form's close clears the coordinates, but the
  // position is written by one opener and read by every save, so a stop handed to the
  // form once left the next add from any day landing at that same index. Tied to the
  // form being open, the only time it means anything.
  useEffect(() => {
    if (!showPlaceForm) setPlaceFormPosition(null)
  }, [showPlaceForm])
  const [reservationModalDayId, setReservationModalDayId] = useState<number | null>(null)

  // The bottom-nav "+" opens the new-place form via ?create=place.
  useEffect(() => {
    if (searchParams.get('create') === 'place') {
      setEditingPlace(null); setEditingAssignmentId(null); setPlaceFormDayId(null); setShowPlaceForm(true)
      setSearchParams(p => { p.delete('create'); return p }, { replace: true })
    }
  }, [searchParams])

  // ?tab= has done its job in the state initializer above — drop it so the URL
  // stops claiming a tab the user may have since switched away from. The session
  // memory keeps the choice across a reload.
  useEffect(() => {
    if (searchParams.get('tab') === null) return
    setSearchParams(p => { p.delete('tab'); return p }, { replace: true })
  }, [searchParams])
  const [showTripForm, setShowTripForm] = useState<boolean>(false)
  const [showReservationModal, setShowReservationModal] = useState<boolean>(false)
  const [editingReservation, setEditingReservation] = useState<Reservation | null>(null)
  const [bookingForAssignmentId, setBookingForAssignmentId] = useState<number | null>(null)
  const [showTransportModal, setShowTransportModal] = useState<boolean>(false)
  const [editingTransport, setEditingTransport] = useState<Reservation | null>(null)
  const [transportModalDayId, setTransportModalDayId] = useState<number | null>(null)

  // The bottom-nav "+" is context-aware per tab: on the Bookings / Transports tabs
  // it opens the booking / transport modal via ?create=reservation|transport
  // (place is handled above, expense in CostsPanel). #1349
  useEffect(() => {
    const intent = searchParams.get('create')
    if (intent === 'reservation') {
      setEditingReservation(null); setBookingForAssignmentId(null); setShowReservationModal(true)
      setSearchParams(p => { p.delete('create'); return p }, { replace: true })
    } else if (intent === 'transport') {
      setEditingTransport(null); setTransportModalDayId(null); setShowTransportModal(true)
      setSearchParams(p => { p.delete('create'); return p }, { replace: true })
    }
  }, [searchParams])
  // Manual route planning: off by default, toggled from the day-plan footer. Mode
  // is per-session and selects which travel time the connectors show — a built-in
  // OSRM profile.
  // Per-trip route visibility. `null` = the user has never said anything, which
  // is what lets the mobile map switch it on by default; an explicit false has to
  // survive every later map entry, and it used to be clobbered on each one (#2003).
  const routeStorageKey = tripId ? `trek:day-route:${tripId}` : null
  const [routeChoice, setRouteChoice] = useState<boolean | null>(() => {
    if (typeof window === 'undefined' || !routeStorageKey) return null
    const raw = window.localStorage.getItem(routeStorageKey)
    return raw === 'true' ? true : raw === 'false' ? false : null
  })
  const routeShown = routeChoice === true
  const setRouteShown = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setRouteChoice(prev => {
      const next = typeof v === 'function' ? v(prev === true) : v
      if (routeStorageKey && typeof window !== 'undefined') {
        window.localStorage.setItem(routeStorageKey, String(next))
      }
      return next
    })
  }, [routeStorageKey])
  // The mobile map opens with the day's route drawn — a default, not a choice, so
  // it never overwrites an explicit off and is never written to storage itself.
  const autoShowRoute = useCallback(() => {
    setRouteChoice(prev => (prev === null ? true : prev))
  }, [])
  const [routeProfile, setRouteProfile] = useState<string>('driving')
  // Whole-trip route overview (#1736): every day's route at once, each in its own
  // colour. Per trip and per session — it answers "what does the whole thing look
  // like", which is a question you ask of one trip, not a preference.
  const [overviewShown, setOverviewShown] = useState<boolean>(() => sessionStorage.getItem(`trip-overview-${tripId}`) === '1')
  const toggleOverview = useCallback(() => {
    setOverviewShown(prev => {
      const next = !prev
      sessionStorage.setItem(`trip-overview-${tripId}`, next ? '1' : '0')
      return next
    })
  }, [tripId])
  const overviewActive = overviewShown
  const tripOverview = useTripRouteOverview(tripId, days, assignments, reservations, tripAccommodations, routeProfile, overviewActive)
  const [fitKey, setFitKey] = useState<number>(0)
  const initialFitTripId = useRef<number | null>(null)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState<'left' | 'right' | null>(null)
  const mobilePlanScrollTopRef = useRef<number>(0)
  const mobilePlacesScrollTopRef = useRef<number>(0)
  const [deletePlaceId, setDeletePlaceId] = useState<number | null>(null)
  const [deletePlaceIds, setDeletePlaceIds] = useState<number[] | null>(null)
  /**
   * The sentence the delete question adds when a night is booked at one of the places.
   *
   * The server takes a booked night down with its place, and with the night the
   * booking made for it and the expense written against that booking. The question
   * itself only names the place, and those are the rows the traveller least expects
   * to lose, so the dialog says so before the yes. The expense list is loaded with
   * the costs tab, not here, so the sentence speaks of any expense rather than
   * counting them. Null when nothing beyond the place is at stake.
   */
  const bookedNightsNote = useCallback((placeIds: number[]): string | null => {
    const stays = tripAccommodations.filter(stay => stay.place_id != null && placeIds.includes(stay.place_id))
    if (stays.length === 0) return null
    const names = [...new Set(stays.map(stay => places.find(p => p.id === stay.place_id)?.name ?? stay.place_name ?? ''))]
      .filter(Boolean)
    const bookings = stays
      .map(stay => reservations.find(r => r.accommodation_id != null && Number(r.accommodation_id) === stay.id)?.title
        ?? stay.reservation_title ?? null)
      .filter((title): title is string => !!title)
    const name = names.join(', ')
    return bookings.length > 0
      ? t('trip.confirm.deletePlaceBooked', { name, booking: bookings.join(', ') })
      : t('trip.confirm.deletePlaceNight', { name })
  }, [tripAccommodations, places, reservations, t])
  const deletePlaceNote = useMemo(
    () => (deletePlaceId ? bookedNightsNote([deletePlaceId]) : null),
    [deletePlaceId, bookedNightsNote],
  )
  const deletePlacesNote = useMemo(
    () => (deletePlaceIds?.length ? bookedNightsNote(deletePlaceIds) : null),
    [deletePlaceIds, bookedNightsNote],
  )

  useEffect(() => {
    if (!trip) return
    if (initialFitTripId.current === trip.id) return
    const hasGeoPlaces = places.some(p => p.lat != null && p.lng != null)
    if (!hasGeoPlaces) return
    initialFitTripId.current = trip.id
    setFitKey(k => k + 1)
  }, [trip, places])

  const connectionsStorageKey = tripId ? `trek:visible-connections:${tripId}` : null
  // Per-trip route-visibility preference — null means "never touched", which
  // falls back to the account-wide map_always_show_routes default (see
  // connectionsVisibility.ts). That fallback is purely computed, never
  // written, so flipping the account setting later doesn't silently override
  // a trip you've already made an explicit choice on.
  const [storedConnections, setStoredConnections] = useState<StoredConnections | null>(() => {
    if (typeof window === 'undefined' || !connectionsStorageKey) return null
    return parseStoredConnections(window.localStorage.getItem(connectionsStorageKey))
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !connectionsStorageKey || !storedConnections) return
    window.localStorage.setItem(connectionsStorageKey, JSON.stringify(storedConnections))
  }, [connectionsStorageKey, storedConnections])
  const alwaysShowRoutesDefault = settings.map_always_show_routes === true
  const routableReservationIds = useMemo(
    () => reservations.filter(isRoutableReservation).map(r => r.id),
    [reservations]
  )
  const effectiveConnections = useMemo(
    () => resolveEffectiveConnections(storedConnections, alwaysShowRoutesDefault),
    [storedConnections, alwaysShowRoutesDefault]
  )
  const visibleConnections = useMemo(
    () => resolveVisibleConnectionIds(effectiveConnections, routableReservationIds),
    [effectiveConnections, routableReservationIds]
  )
  const allConnectionsShown = effectiveConnections.mode === 'all-except'
  const toggleConnection = useCallback((id: number) => {
    setStoredConnections(prev => toggleConnectionId(prev, alwaysShowRoutesDefault, id))
  }, [alwaysShowRoutesDefault])
  const toggleAllConnections = useCallback(() => {
    setStoredConnections(prev => flipAllConnectionsMode(prev, alwaysShowRoutesDefault))
  }, [alwaysShowRoutesDefault])
  const [mapTransportDetail, setMapTransportDetail] = useState<Reservation | null>(null)

  // Layout is width-driven (isMobile); the drag bridge is pointer-driven (isTouch).
  // Conflating them is what left a tablet's places list undraggable-but-unscrollable (#1432).
  const isTouch = useIsTouch()

  // Load the trip. loadTrip hydrates every trip-scoped slice (days, places,
  // packing, todo, budget, reservations) so offline hydration is uniform
  // and there's no cross-trip bleed; members/accommodations load alongside.
  useEffect(() => {
    if (tripId) {
      tripActions.loadTrip(tripId).catch(() => { toast.error(t('trip.toast.loadError')); navigate('/dashboard') })
      loadAccommodations()
      refreshMembers()
    }
  }, [tripId])

  // Accommodations live in this hook's local state, so store-level refreshes
  // (remote trip date change, reconnect hydration) nudge us via this event (#1288).
  useEffect(() => {
    const onRefresh = () => loadAccommodations()
    window.addEventListener('accommodations:refresh', onRefresh)
    return () => window.removeEventListener('accommodations:refresh', onRefresh)
  }, [loadAccommodations])

  // Same filter the places sidebar renders — shared via the store so tab
  // switches can't desync the marker set from the filter UI (#1541).
  const placesFilter = useTripStore((s) => s.placesFilter)
  const placesCategoryFilter = useTripStore((s) => s.placesCategoryFilter)

  const [expandedDayIds, setExpandedDayIds] = useState<Set<number> | null>(null)

  const mapPlaces = useMemo(() => {
    // Build set of place IDs assigned to collapsed days
    const hiddenPlaceIds = new Set<number>()
    if (expandedDayIds) {
      for (const [dayId, dayAssignments] of Object.entries(assignments)) {
        if (!expandedDayIds.has(Number(dayId))) {
          for (const a of dayAssignments) {
            if (a.place?.id) hiddenPlaceIds.add(a.place.id)
          }
        }
      }
      // Don't hide places that are also assigned to an expanded day
      for (const [dayId, dayAssignments] of Object.entries(assignments)) {
        if (expandedDayIds.has(Number(dayId))) {
          for (const a of dayAssignments) {
            if (a.place?.id) hiddenPlaceIds.delete(a.place.id)
          }
        }
      }
    }

    // Planned place IDs — needed by both the 'unplanned' filter (exclude them) and
    // the new 'planned' filter (keep only them). With a day selected, 'planned'
    // follows it like the other filters do; with no day selected it keeps showing
    // the whole plan (#2024). 'unplanned' always uses the whole-trip set — a place
    // assigned to any day is not unplanned.
    const plannedIds = placesFilter === 'unplanned' || placesFilter === 'planned'
      ? (placesFilter === 'planned' && selectedDayId
        ? plannedPlaceIdsForDay(selectedDayId, days, { assignments, accommodations: tripAccommodations, reservations })
        : plannedPlaceIds({ assignments, accommodations: tripAccommodations, reservations }))
      : null

    return places.filter(p => {
      if (!p.lat || !p.lng) return false
      if (placesFilter === 'tracks' && !p.route_geometry) return false
      if (placesCategoryFilter.size > 0) {
        if (p.category_id == null) {
          if (!placesCategoryFilter.has('uncategorized')) return false
        } else if (!placesCategoryFilter.has(String(p.category_id))) return false
      }
      // Collapsed-day declutter hides a day's stops on every filter EXCEPT 'planned':
      // there the user asked to see the whole plan on the map, so a collapsed day
      // must not drop its planned places.
      if (placesFilter !== 'planned' && hiddenPlaceIds.has(p.id)) return false
      if (placesFilter === 'unplanned' && plannedIds && plannedIds.has(p.id)) return false
      if (placesFilter === 'planned' && plannedIds && !plannedIds.has(p.id)) return false
      return true
    })
  }, [places, placesCategoryFilter, placesFilter, assignments, expandedDayIds, selectedDayId, days, tripAccommodations, reservations])

  const { route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay } = useRouteCalculation({ assignments } as TripStoreState, selectedDayId, routeShown, routeProfile, tripAccommodations)

  const handleSelectDay = useCallback((dayId: number | null, skipFit?: boolean) => {
    tripActions.setSelectedDay(dayId)
    if (!skipFit) setFitKey(k => k + 1)
    setMobileSidebarOpen(null)
    updateRouteForDay(dayId)
  }, [updateRouteForDay])

  const handlePlaceClick = useCallback((placeId: number | null, assignmentId?: number | null) => {
    if (assignmentId) {
      selectAssignment(assignmentId, placeId)
    } else {
      setSelectedPlaceId(placeId)
    }
    if (placeId) { setShowDayDetail(null); setLeftCollapsed(false); setRightCollapsed(false) }
  }, [selectAssignment, setSelectedPlaceId])

  const handleMarkerClick = useCallback((placeId?: number) => {
    if (placeId === undefined) {
      setSelectedPlaceId(null)
      return
    }
    // Find every assignment for this place (same place can sit on several
    // days / be planned twice in one day). Cycle through them on repeated
    // marker clicks so the sidebar highlight jumps to the next occurrence
    // instead of leaving the user confused.
    const allAssignments = Object.values(useTripStore.getState().assignments || {}).flat()
    const matching = allAssignments.filter(a => a?.place?.id === placeId)

    if (matching.length === 0) {
      setSelectedPlaceId(selectedPlaceId === placeId ? null : placeId)
    } else if (matching.length === 1) {
      const only = matching[0]
      if (selectedAssignmentId === only.id) {
        setSelectedPlaceId(null)
      } else {
        selectAssignment(only.id, placeId)
      }
    } else {
      const currentIdx = matching.findIndex(a => a.id === selectedAssignmentId)
      const nextIdx = currentIdx === -1 ? 0 : currentIdx + 1
      if (nextIdx >= matching.length) {
        // cycled past the last occurrence — clear selection so the next
        // click starts fresh at occurrence 0.
        setSelectedPlaceId(null)
      } else {
        selectAssignment(matching[nextIdx].id, placeId)
      }
    }
    setLeftCollapsed(false); setRightCollapsed(false)
  }, [selectAssignment, selectedAssignmentId, selectedPlaceId, setSelectedPlaceId])

  const handleMapClick = useCallback(() => {
    setSelectedPlaceId(null)
  }, [])

  const handleMapContextMenu = useCallback(async (e, dayId?: number | null) => {
    if (!can('place_edit', trip)) return
    e.originalEvent?.preventDefault()
    const { lat, lng } = e.latlng
    setPrefillCoords({ lat, lng })
    setEditingPlace(null)
    setEditingAssignmentId(null)
    setPlaceFormDayId(dayId ?? null)
    setShowPlaceForm(true)
    try {
      const { mapsApi } = await import('../../api/client')
      const data = await mapsApi.reverse(lat, lng, language)
      if (data.name || data.address) {
        setPrefillCoords(prev => prev ? { ...prev, name: data.name || '', address: data.address || '' } : prev)
      }
    } catch { /* best effort */ }
  }, [language])

  // Open the Add-Place form pre-filled from an OSM "explore" POI marker — all the
  // data already comes from the POI, so no reverse-geocode is needed.
  const openAddPlaceFromPoi = useCallback((
    poi: { lat: number; lng: number; name: string; address: string | null; website: string | null; phone: string | null; osm_id: string },
    dayId?: number | null,
    /** Index within that day. Omitted, the place is appended, which is what every caller did before. */
    position?: number | null,
  ) => {
    if (!can('place_edit', trip)) return
    setPrefillCoords({
      lat: poi.lat,
      lng: poi.lng,
      name: poi.name,
      address: poi.address || '',
      website: poi.website || undefined,
      phone: poi.phone || undefined,
      osm_id: poi.osm_id,
    })
    setEditingPlace(null)
    setEditingAssignmentId(null)
    setPlaceFormDayId(dayId ?? null)
    setPlaceFormPosition(position ?? null)
    setShowPlaceForm(true)
  }, [trip])

  const handlePoiClick = useCallback((poi: Parameters<typeof openAddPlaceFromPoi>[0]) => {
    openAddPlaceFromPoi(poi)
  }, [openAddPlaceFromPoi])

  const handleSavePlace = useCallback(async (data) => {
    if (editingPlace) {
      // Always strip time fields from place update — time is per-assignment only.
      // Same for the day-specific note (#2163): it belongs to the assignment,
      // never to the pool place.
      const { place_time, end_time, assignment_notes, ...placeData } = data
      await tripActions.updatePlace(tripId, editingPlace.id, placeData)
      // If editing from assignment context, save time per-assignment
      if (editingAssignmentId) {
        const timeRes = await assignmentsApi.updateTime(tripId, editingAssignmentId, { place_time: place_time || null, end_time: end_time || null })
        // The local adapter answers the day re-sort the server used to
        // broadcast — replay it through the store before refreshDays re-reads.
        applyLocalEffect('assignment:reordered', timeRes.reordered)
        // The form only includes assignment_notes when the user changed it, so
        // an untouched note never produces a PUT (#2163). '' clears like null.
        if (assignment_notes !== undefined) {
          await assignmentsApi.updateNotes(tripId, editingAssignmentId, { notes: assignment_notes || null })
        }
        await tripActions.refreshDays(tripId)
      }
      toast.success(t('trip.toast.placeUpdated'))
      return { id: editingPlace.id }
    } else {
      const place = await tripActions.addPlace(tripId, data)
      const dayId = placeFormDayId
      const position = placeFormPosition
      // Added from inside a day? Then it belongs to that day. Without this the
      // place drops into the unplanned pool and, on mobile, into a different
      // screen entirely — which reads as "it wasn't saved" (#1998).
      if (place?.id && dayId != null) {
        try {
          // With a position the stop lands where it will be driven past, not at the end
          // of the day. The slice has taken one all along; nothing ever passed it.
          await tripActions.assignPlaceToDay(tripId, dayId, place.id, position)
          updateRouteForDay(dayId)
        } catch (err: unknown) {
          // The place itself exists; only the day link failed.
          toast.error(err instanceof Error ? err.message : t('common.unknownError'))
        }
      }
      toast.success(t('trip.toast.placeAdded'))
      if (place?.id) {
        const capturedId = place.id
        pushUndo(t('undo.addPlace'), async () => {
          await tripActions.deletePlace(tripId, capturedId)
        })
      }
      // Handed back so the form can link an expense to a place that did not
      // exist a moment ago (#1298), the same way the booking modals work.
      return place?.id ? { id: place.id } : undefined
    }
  }, [editingPlace, editingAssignmentId, placeFormDayId, placeFormPosition, tripId, toast, pushUndo, updateRouteForDay])

  // Open the place editor from any entry point (Places pool, inspector, map).
  // Times live per day-assignment, so when no day is in context resolve the
  // place's lone assignment to hydrate & persist its times; with 0 or 2+
  // assignments the time is ambiguous and the modal hides the fields (#1247).
  const openPlaceEditor = useCallback((place: Place, preferredAssignmentId: number | null = null) => {
    if (!can('place_edit', trip)) return
    setEditingPlace(place)
    setEditingAssignmentId(preferredAssignmentId ?? resolvePoolAssignmentId(assignments, place.id))
    setPlaceFormDayId(null)
    setShowPlaceForm(true)
  }, [can, trip, assignments])

  const handleDeletePlace = useCallback((placeId) => {
    if (!can('place_edit', trip)) return
    setDeletePlaceId(placeId)
  }, [can, trip])

  const confirmDeletePlace = useCallback(async () => {
    if (!deletePlaceId) return
    const state = useTripStore.getState()
    const capturedPlace = state.places.find(p => p.id === deletePlaceId)
    const capturedAssignments = Object.entries(state.assignments).flatMap(([dayId, as]) =>
      as.filter(a => a.place?.id === deletePlaceId).map(a => ({ dayId: Number(dayId), orderIndex: a.order_index }))
    )
    try {
      await tripActions.deletePlace(tripId, deletePlaceId)
      if (selectedPlaceId === deletePlaceId) setSelectedPlaceId(null)
      updateRouteForDay(selectedDayId)
      toast.success(t('trip.toast.placeDeleted'))
      if (capturedPlace) {
        pushUndo(t('undo.deletePlace'), async () => {
          const newPlace = await tripActions.addPlace(tripId, {
            name: capturedPlace.name,
            description: capturedPlace.description,
            lat: capturedPlace.lat,
            lng: capturedPlace.lng,
            address: capturedPlace.address,
            category_id: capturedPlace.category_id,
            price: capturedPlace.price,
            // An undone track has to come back as a track, not a bare point.
            route_geometry: capturedPlace.route_geometry,
            route_color: capturedPlace.route_color,
          })
          for (const { dayId, orderIndex } of capturedAssignments) {
            await tripActions.assignPlaceToDay(tripId, dayId, newPlace.id, orderIndex)
          }
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [deletePlaceId, tripId, toast, selectedPlaceId, selectedDayId, updateRouteForDay, pushUndo])

  const confirmDeletePlaces = useCallback(async (ids?: number[]) => {
    const targetIds = ids ?? deletePlaceIds
    if (!targetIds?.length) return
    const state = useTripStore.getState()
    const capturedPlaces = state.places.filter(p => targetIds.includes(p.id))
    const capturedAssignments = Object.entries(state.assignments).flatMap(([dayId, as]) =>
      as.filter(a => a.place?.id != null && targetIds.includes(a.place.id)).map(a => ({ dayId: Number(dayId), placeId: a.place!.id, orderIndex: a.order_index }))
    )
    try {
      await tripActions.deletePlacesMany(tripId, targetIds)
      if (selectedPlaceId != null && targetIds.includes(selectedPlaceId)) setSelectedPlaceId(null)
      if (!ids) setDeletePlaceIds(null)
      updateRouteForDay(selectedDayId)
      toast.success(t('trip.toast.placesDeleted', { count: capturedPlaces.length }))
      if (capturedPlaces.length > 0) {
        pushUndo(t('undo.deletePlaces'), async () => {
          for (const place of capturedPlaces) {
            const newPlace = await tripActions.addPlace(tripId, {
              name: place.name, description: place.description,
              lat: place.lat, lng: place.lng, address: place.address,
              category_id: place.category_id, price: place.price,
              route_geometry: place.route_geometry, route_color: place.route_color,
            })
            for (const a of capturedAssignments.filter(x => x.placeId === place.id)) {
              await tripActions.assignPlaceToDay(tripId, a.dayId, newPlace.id, a.orderIndex)
            }
          }
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [deletePlaceIds, tripId, toast, selectedPlaceId, selectedDayId, updateRouteForDay, pushUndo])

  const confirmChangeCategory = useCallback(async (ids: number[], categoryId: number | null) => {
    if (!ids.length) return
    const state = useTripStore.getState()
    // Capture each place's prior category so undo can restore them per group.
    const captured = state.places.filter(p => ids.includes(p.id)).map(p => ({ id: p.id, prev: p.category_id ?? null }))
    try {
      await tripActions.updatePlacesMany(tripId, ids, { category_id: categoryId })
      toast.success(t('places.categoryChanged', { count: ids.length }))
      if (captured.length > 0) {
        pushUndo(t('undo.changeCategory'), async () => {
          // Group the captured ids by their prior category so each set is restored
          // in one call ('null' key = previously uncategorized). Map is shadowed by
          // the lucide icon import in this file, so use a plain object.
          const byPrev: Record<string, number[]> = {}
          for (const { id, prev } of captured) {
            const key = prev === null ? 'null' : String(prev)
            ;(byPrev[key] ??= []).push(id)
          }
          for (const [key, group] of Object.entries(byPrev)) {
            await tripActions.updatePlacesMany(tripId, group, { category_id: key === 'null' ? null : Number(key) })
          }
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [tripId, toast, pushUndo])

  const handleAssignToDay = useCallback(async (placeId: number, dayId?: number, position?: number) => {
    const target = dayId || selectedDayId
    if (!target) { toast.error(t('trip.toast.selectDay')); return }
    try {
      const assignment = await tripActions.assignPlaceToDay(tripId, target, placeId, position)
      toast.success(t('trip.toast.assignedToDay'))
      updateRouteForDay(target)
      if (assignment?.id) {
        const capturedAssignmentId = assignment.id
        const capturedTarget = target
        pushUndo(t('undo.assignPlace'), async () => {
          await tripActions.removeAssignment(tripId, capturedTarget, capturedAssignmentId)
        })
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [selectedDayId, tripId, toast, updateRouteForDay, pushUndo, t])

  const handleRemoveAssignment = useCallback(async (dayId: number, assignmentId: number) => {
    const state = useTripStore.getState()
    const capturedAssignment = (state.assignments[String(dayId)] || []).find(a => a.id === assignmentId)
    const capturedPlaceId = capturedAssignment?.place?.id
    const capturedOrderIndex = capturedAssignment?.order_index ?? 0
    try {
      await tripActions.removeAssignment(tripId, dayId, assignmentId)
      updateRouteForDay(dayId)
      if (capturedPlaceId != null) {
        const capturedDayId = dayId
        const capturedPos = capturedOrderIndex
        pushUndo(t('undo.removeAssignment'), async () => {
          await tripActions.assignPlaceToDay(tripId, capturedDayId, capturedPlaceId, capturedPos)
        })
      }
    }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [tripId, toast, updateRouteForDay, pushUndo, t])

  const handleReorder = useCallback((dayId: number, orderedIds: number[]) => {
    const prevIds = (useTripStore.getState().assignments[String(dayId)] || [])
      .slice().sort((a, b) => a.order_index - b.order_index).map(a => a.id)
    const visible = new Set(orderedIds)
    let nextVisible = 0
    const completeOrder = prevIds.map(id => visible.has(id) ? orderedIds[nextVisible++] : id)
    try {
      tripActions.reorderAssignments(tripId, dayId, completeOrder)
        .then(async () => {
          const capturedDayId = dayId
          const capturedPrevIds = prevIds
          pushUndo(t('undo.reorder'), async () => {
            await tripActions.reorderAssignments(tripId, capturedDayId, capturedPrevIds)
          })
        })
        .catch(err => toast.error(err instanceof Error ? err.message : t('trip.toast.reorderError')))
      updateRouteForDay(dayId)
    }
    catch { toast.error(t('trip.toast.reorderError')) }
  }, [tripId, toast, pushUndo, updateRouteForDay, t])

  const handleUpdateDayTitle = useCallback(async (dayId, title) => {
    try { await tripActions.updateDayTitle(tripId, dayId, title) }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }, [tripId, toast])

  const handleReorderDays = useCallback((orderedIds: number[]) => {
    const prevIds = (useTripStore.getState().days || [])
      .slice().sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0)).map(d => d.id)
    tripActions.reorderDays(tripId, orderedIds)
      .then(() => {
        pushUndo(t('dayplan.reorderUndo'), async () => {
          await tripActions.reorderDays(tripId, prevIds)
        })
      })
      .catch(err => toast.error(err instanceof Error ? err.message : t('dayplan.reorderError')))
  }, [tripId, toast, pushUndo])

  const handleAddDay = useCallback((position?: number) => {
    tripActions.insertDay(tripId, position)
      .catch(err => toast.error(err instanceof Error ? err.message : t('dayplan.addDayError')))
  }, [tripId, toast])

  const handleSaveReservation = async (data: Record<string, string | number | null> & { title: string }) => {
    try {
      // Imported hotel with a reviewed address but no existing place picked: match
      // an existing place by name, else geocode the address and create one, then link it.
      const acc = (data as Record<string, any>).create_accommodation
      if (data.type === 'hotel' && acc && acc.venue && !acc.place_id) {
        acc.place_id = (await resolveImportedPlace(acc.venue)) ?? undefined
        delete acc.venue
      }
      // A hotel's address lives on the linked place. Write an edited address
      // through to it, otherwise the typed value was silently dropped and the
      // old one reappeared on the next open (#1496).
      if (data.type === 'hotel' && acc && typeof acc.address === 'string') {
        const address = acc.address.trim()
        const linkedPlace = acc.place_id ? places.find(p => p.id === Number(acc.place_id)) : undefined
        if (address && linkedPlace && (linkedPlace.address || '') !== address) {
          try { await tripActions.updatePlace(tripId, linkedPlace.id, { address }) }
          catch { /* keep saving the booking; the address still lands in location */ }
        }
        delete acc.address
      }
      if (editingReservation) {
        // Don't force a day here. The old code pinned it to the (often empty)
        // selected day, which dropped the booking out of the Plan; preserving the
        // old day_id instead left it stale when the date changed. Omitting it lets
        // the server derive the day from the booking's date, or keep the current
        // one when there is no date.
        const r = await tripActions.updateReservation(tripId, editingReservation.id, data)
        toast.success(t('trip.toast.reservationUpdated'))
        setShowReservationModal(false)
        setEditingReservation(null)
        if (data.type === 'hotel') {
          accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
        }
        return r
      } else {
        const r = await tripActions.addReservation(tripId, { ...data, day_id: selectedDayId || null })
        toast.success(t('trip.toast.reservationAdded'))
        setShowReservationModal(false)
        // A payload carrying create_budget_entry auto-creates a linked cost in the
        // local adapter; the saving client gets no budget:created echo, so refresh
        // the budget items here to surface it without a reload.
        if ((data as Record<string, unknown>).create_budget_entry) await tripActions.loadBudgetItems?.(tripId)
        // Refresh accommodations if hotel was created
        if (data.type === 'hotel') {
          accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
        }
        return r
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }

  const handleSaveTransport = async (data: Record<string, any> & { title: string }) => {
    try {
      if (editingTransport) {
        const r = await tripActions.updateReservation(tripId, editingTransport.id, data)
        toast.success(t('trip.toast.reservationUpdated'))
        setShowTransportModal(false)
        setEditingTransport(null)
        setTransportModalDayId(null)
        return r
      } else {
        const r = await tripActions.addReservation(tripId, data)
        toast.success(t('trip.toast.reservationAdded'))
        setShowTransportModal(false)
        setEditingTransport(null)
        setTransportModalDayId(null)
        // Surface the auto-created linked cost without a reload (no budget:created echo to us).
        if (data.create_budget_entry) await tripActions.loadBudgetItems?.(tripId)
        return r
      }
    } catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }

  const handleDeleteReservation = async (id) => {
    try {
      await tripActions.deleteReservation(tripId, id)
      toast.success(t('trip.toast.deleted'))
      // Refresh accommodations in case a hotel booking was deleted
      accommodationsApi.list(tripId).then(d => setTripAccommodations(d.accommodations || [])).catch(() => {})
    }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : t('common.unknownError')) }
  }

  // ── Review-before-save booking import ───────────────────────────────────────
  // Match an existing trip place by name, else geocode the reviewed address and
  // create one. Returns the place id (or null if even creation failed).
  const resolveImportedPlace = async (venue: { name?: string; address?: string | null }): Promise<number | null> => {
    const name = (venue.name || '').trim()
    const n = name.toLowerCase()
    if (n) {
      const existing = places.find(p => p.name?.trim().toLowerCase() === n)
        ?? places.find(p => p.name && (p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase())))
      // Only a server-side id may be linked. A negative id is an offline temp id
      // (mutationQueue.nextTempId): the reservation write is online-only, the queue
      // rewrites temp ids in a URL but never inside another entity's body, and
      // day_accommodations.place_id carries a foreign key — so a temp id here is a
      // rolled-back insert and a 500 instead of a saved booking.
      if (existing && existing.id > 0) return existing.id
    }
    // Offline the booking itself cannot be written (reservations are online-only),
    // so minting a place here would only leave an orphan behind on the next flush
    // — and its temp id could never be linked anyway. Link nothing, and skip the
    // geocode round-trip too; the retry online matches this venue by name.
    if (isEffectivelyOffline()) return null
    let lat: number | null = null
    let lng: number | null = null
    let address: string | null = venue.address ?? null
    try {
      const query = venue.address ? `${name} ${venue.address}`.trim() : name
      if (query) {
        const res = await mapsApi.search(query)
        const hit = res?.places?.[0] as { lat?: number; lng?: number; address?: string } | undefined
        if (hit && hit.lat != null && hit.lng != null) {
          lat = hit.lat; lng = hit.lng
          if (!address && hit.address) address = hit.address
        }
      }
    } catch { /* geocode failure is non-fatal — create the place without coords */ }
    try {
      // Through the store, not placesApi directly: the API answers { place },
      // and reading .id off that wrapper linked nothing — every save of the
      // hotel then minted another orphan place, because the store never
      // learned about the previous one and the name match above could not
      // find it. addPlace unwraps the response and puts the place into
      // `places`, so the next save reuses it.
      const place = await tripActions.addPlace(tripId, { name: name || address || 'Accommodation', lat, lng, address })
      return place && place.id > 0 ? place.id : null
    } catch { return null }
  }

  const selectedPlace = selectedPlaceId ? places.find(p => p.id === selectedPlaceId) : null

  // Build placeId → order-number map from the selected day's assignments.
  const dayOrderMap = useMemo(() => {
    if (!selectedDayId) return {}
    const da = assignments[String(selectedDayId)] || []
    const sorted = [...da].sort((a, b) => a.order_index - b.order_index)
    const map = {}
    let counted = 0
    sorted.forEach(a => {
      if (!a.place?.id) return
      counted += 1
      if (!map[a.place.id]) map[a.place.id] = []
      map[a.place.id].push(counted)
    })
    return map
  }, [selectedDayId, assignments])

  // Places assigned to selected day (with coords) — used for map fitting
  const dayPlaces = useMemo(() => {
    if (!selectedDayId) return []
    const da = assignments[String(selectedDayId)] || []
    return da.map(a => a.place).filter(p => p?.lat && p?.lng)
  }, [selectedDayId, assignments])

  const mapTileUrl = useTileUrl(RASTER_FALLBACK_TILE_URL)

  const fontStyle = { fontFamily: "var(--font-system)" }

  // Splash screen — show for initial load + a brief moment for photos to start loading
  const [splashDone, setSplashDone] = useState(false)
  useEffect(() => {
    if (!isLoading && trip) {
      const timer = setTimeout(() => setSplashDone(true), 1500)
      return () => clearTimeout(timer)
    }
  }, [isLoading, trip])

  return {
    tripId, navigate, toast, t, language, locale, settings, trip, days, places, assignments, storedAssignments: assignments, packingItems, todoItems, categories, reservations, budgetItems,
    selectedDayId, isLoading, tripActions, can,
    pushUndo, undo, canUndo, lastActionLabel, handleUndo,
    enabledAddons, tripAccommodations, setTripAccommodations,
    overviewShown, toggleOverview, overviewActive, tripOverview,
    tripMembers, setTripMembers, refreshMembers, loadAccommodations,
    TRANSPORT_TYPES, TRIP_TABS, activeTab, setActiveTab, handleTabChange,
    leftWidth, rightWidth, leftCollapsed, rightCollapsed, setLeftCollapsed, setRightCollapsed,
    leftHidden, rightHidden, toggleLeft, toggleRight, narrowPanels,
    startResizeLeft, startResizeRight,
    selectedPlaceId, selectedAssignmentId, setSelectedPlaceId, selectAssignment,
    showDayDetail, setShowDayDetail, dayDetailCollapsed, setDayDetailCollapsed,
    showPlaceForm, setShowPlaceForm, editingPlace, setEditingPlace,
    prefillCoords, setPrefillCoords, editingAssignmentId, setEditingAssignmentId,
    placeFormDayId, setPlaceFormDayId, reservationModalDayId, setReservationModalDayId,
    showTripForm, setShowTripForm,
    showReservationModal, setShowReservationModal, editingReservation, setEditingReservation,
    bookingForAssignmentId, setBookingForAssignmentId,
    showTransportModal, setShowTransportModal, editingTransport, setEditingTransport,
    transportModalDayId, setTransportModalDayId,
    routeShown, setRouteShown, autoShowRoute, routeProfile, setRouteProfile, fitKey, setFitKey,
    mobileSidebarOpen, setMobileSidebarOpen, mobilePlanScrollTopRef, mobilePlacesScrollTopRef,
    deletePlaceId, setDeletePlaceId, deletePlaceIds, setDeletePlaceIds, deletePlaceNote, deletePlacesNote,
    visibleConnections, toggleConnection, allConnectionsShown, toggleAllConnections, mapTransportDetail, setMapTransportDetail,
    isMobile, isTouch,
    expandedDayIds, setExpandedDayIds, mapPlaces,
    route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay,
    handleSelectDay, handlePlaceClick, handleMarkerClick, handleMapClick, handleMapContextMenu, openAddPlaceFromPoi, handlePoiClick,
    handleSavePlace, openPlaceEditor, handleDeletePlace, confirmDeletePlace, confirmDeletePlaces, confirmChangeCategory,
    handleAssignToDay, handleRemoveAssignment, handleReorder, handleReorderDays, handleAddDay, handleUpdateDayTitle,
    handleSaveReservation, handleSaveTransport, handleDeleteReservation,
    selectedPlace, dayOrderMap, dayPlaces,
    mapTileUrl, fontStyle, splashDone,
  }
}

