import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '../../../helpers/render'
import { buildPlanner, buildShell } from '../../../helpers/mobileTrip'
import { buildPlace } from '../../../helpers/factories'
import type { MTripShellApi, TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import { useSettingsStore } from '../../../../src/store/settingsStore'
import { seedStore } from '../../../helpers/store'
import type { Place } from '../../../../src/types'

// FE-MOB-MAPAREA-001 to FE-MOB-MAPAREA-007
//
// The area is a thin layer over the shared MapView: it hands the planner's
// marker/route props through, wires the transport-overlay tap to the mobile
// sheet, and floats the POI bar and the trip-overview stack on the map.

const mocks = vi.hoisted(() => ({
  poi: {} as Record<string, unknown>,
  /** Last props the area handed the renderer, so its callbacks can be fired. */
  props: {} as Record<string, unknown>,
}))

// The real renderer boots Leaflet; the area only ever hands it props.
vi.mock('../../../../src/components/Map/MapView', () => ({
  MapView: (props: Record<string, unknown>) => {
    mocks.props = props
    return <div data-testid="map-renderer" />
  },
}))

vi.mock('../../../../src/components/Map/usePoiExplore', () => ({
  usePoiExplore: () => mocks.poi,
}))

vi.mock('../../../../src/components/Map/PoiCategoryPill', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="poi-pill" data-fullwidth={props.fullWidth} />
  ),
}))

vi.mock('../../../../src/components/Map/TripRouteOverview', () => ({
  TripRouteOverviewPill: (props: { active: boolean; onToggle: () => void }) => (
    <button data-testid="overview-pill" data-active={props.active} onClick={props.onToggle} />
  ),
  TripRouteOverviewPanel: (props: { selectedDayId: number | null }) => (
    <div data-testid="overview-panel" data-day={props.selectedDayId} />
  ),
}))

import MMapArea from '../../../../src/mobile/screens/trip/map/MMapArea'

function renderArea(shellOver: Partial<MTripShellApi> = {}, plannerOver: Partial<TripPlanner> = {}) {
  const planner = buildPlanner(plannerOver)
  const shell = buildShell({ view: 'map', mapFront: true, ...shellOver })
  return { planner, shell, ...render(<MMapArea planner={planner} shell={shell} />) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  mocks.poi = {
    active: new Set<string>(), pois: [], loadingKeys: new Set<string>(), errorKeys: new Set<string>(),
    moved: false, toggle: vi.fn(), searchArea: vi.fn(), onViewportChange: vi.fn(),
  }
  seedStore(useSettingsStore, { settings: { map_poi_pill_enabled: true, distance_unit: 'metric' } })
})

describe('MMapArea', () => {
  it('FE-MOB-MAPAREA-001: the POI bar takes the full width between the screen margins', () => {
    renderArea()
    expect(screen.getByTestId('poi-pill')).toHaveAttribute('data-fullwidth', 'true')
  })

  it('FE-MOB-MAPAREA-002: turning the POI bar off or covering the map drops the pill', () => {
    seedStore(useSettingsStore, { settings: { map_poi_pill_enabled: false } })
    const { unmount } = renderArea()
    expect(screen.queryByTestId('poi-pill')).not.toBeInTheDocument()
    unmount()

    renderArea({ mapFront: false })
    expect(screen.queryByTestId('poi-pill')).not.toBeInTheDocument()
  })

  it('FE-MOB-MAPAREA-003: a transport overlay tap opens the mobile transport sheet', () => {
    const { shell } = renderArea()
    ;(mocks.props.onReservationClick as (id: number) => void)(77)
    expect(shell.openSheet).toHaveBeenCalledWith('transport', { reservationId: 77 })
  })

  it('FE-MOB-MAPAREA-004: the plan tab keeps the planner marker door, map tap and selection', () => {
    const { planner } = renderArea({}, {
      mapPlaces: [buildPlace({ id: 11 }) as Place],
      selectedDayId: 3,
    })
    expect(mocks.props.places).toBe(planner.mapPlaces)
    ;(mocks.props.onMarkerClick as (id: number) => void)(11)
    expect(planner.handleMarkerClick).toHaveBeenCalledWith(11)
    ;(mocks.props.onMapClick as () => void)()
    expect(planner.handleMapClick).toHaveBeenCalled()
    // A long-press drop carries the day the chip rail names (#1998).
    const evt = { latlng: { lat: 1, lng: 2 } }
    ;(mocks.props.onMapContextMenu as (e: unknown, dayId: number) => void)(evt, 3)
    expect(planner.handleMapContextMenu).toHaveBeenCalledWith(evt, 3)
  })

  it('FE-MOB-MAPAREA-005: a POI tap opens the add-place form on the chip day', () => {
    const marker = { osm_id: 'n1', name: 'Konbini' }
    mocks.poi = { ...mocks.poi, pois: [marker] }
    const { planner } = renderArea({}, { selectedDayId: 3 })
    expect(mocks.props.pois).toEqual([marker])
    ;(mocks.props.onPoiClick as (m: unknown) => void)(marker)
    expect(planner.openAddPlaceFromPoi).toHaveBeenCalledWith(marker, 3)
  })

  it('FE-MOB-MAPAREA-006: the overview drives the route and its panel once active', () => {
    const overview = {
      days: [], loading: false,
      lines: [[[53.5, 9.9], [53.6, 10.0]]],
      lineColors: ['#123456'],
      focusPoints: [[53.5, 9.9]],
    }
    const { planner } = renderArea({}, {
      overviewActive: true,
      overviewShown: true,
      tripOverview: overview,
      selectedDayId: 2,
    } as unknown as Partial<TripPlanner>)
    expect(mocks.props.route).toEqual(overview.lines)
    expect(mocks.props.routeColors).toEqual(overview.lineColors)
    expect(mocks.props.focusPoints).toEqual(overview.focusPoints)
    expect(screen.getByTestId('overview-panel')).toHaveAttribute('data-day', '2')

    screen.getByTestId('overview-pill').click()
    expect(planner.toggleOverview).toHaveBeenCalled()
  })

  it('FE-MOB-MAPAREA-007: without the overview the planner route is drawn and no panel shows', () => {
    // `route` is a list of polylines (one per leg) — passed through verbatim.
    renderArea({}, { route: [[[1, 2], [3, 4]]] } as unknown as Partial<TripPlanner>)
    expect(mocks.props.route).toEqual([[[1, 2], [3, 4]]])
    expect(mocks.props.routeColors).toBeUndefined()
    expect(screen.queryByTestId('overview-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('overview-pill')).toHaveAttribute('data-active', 'false')
  })
})
