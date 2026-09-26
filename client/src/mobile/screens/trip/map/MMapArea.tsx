import { MapView } from '../../../../components/Map/MapView'
import { TripRouteOverviewPill, TripRouteOverviewPanel } from '../../../../components/Map/TripRouteOverview'
import PoiCategoryPill from '../../../../components/Map/PoiCategoryPill'
import { usePoiExplore } from '../../../../components/Map/usePoiExplore'
import { useSettingsStore } from '../../../../store/settingsStore'
import type { MMapAreaProps } from '../MTripShell'

/**
 * Fullscreen map layer of the mobile trip screen (plan tab). Stays mounted for
 * the whole plan-tab lifetime — the plan timeline / places browser overlays
 * simply cover it — so tiles and markers stay warm across view toggles.
 *
 * The map itself is the shared Leaflet planner renderer with the full desktop
 * feature set: clusters, photo/icon markers,
 * day-order badges, dashed day route, transport overlays per booking, POI
 * explore markers and long-press → add place. Only the floating chrome is
 * mobile: the POI bar spans the full width below the day-chip rail, and the round
 * controls share one band above the dock: the map's own base-layer switcher on
 * the left, the map's built-in three-state locate button on the right, all
 * riding the --bottom-nav-h contract the map already reads so they cannot drift
 * apart. The map credit sits under that band, alone in the bottom right corner.
 *
 * Marker data honours the shared places category filter (#1541) because
 * planner.mapPlaces is derived from tripStore's placesCategoryFilter, the same
 * set the places browser renders, so the two can't desync.
 */
export default function MMapArea({ planner, shell }: MMapAreaProps) {
  const poi = usePoiExplore()
  const poiPillEnabled = useSettingsStore(s => s.settings.map_poi_pill_enabled) !== false
  const distanceUnit = useSettingsStore(s => s.settings.distance_unit)

  const mapActive = shell.mapFront

  return (
    // `isolate` keeps the map's internal z-indexes (Leaflet panes, the z-1000
    // locate button) inside this layer so they can never paint over the plan
    // timeline (z-10) or the browse/tab overlays (z-30) above it.
    //
    // --m-map-floor is the top edge of the dock, 62px tall at safe-bottom + 12.
    // The round controls sit straight on that floor and add their own 12px,
    // close enough to the thumb to reach one-handed. Everything that reads
    // --bottom-nav-h (the map's locate button and base-layer switcher, the
    // overview stack) follows on its own.
    <div
      className="absolute inset-0 isolate overflow-hidden bg-[color:var(--m-mapb)] [--m-map-floor:calc(env(safe-area-inset-bottom,0px)+74px)] [--bottom-nav-h:var(--m-map-floor)]"
    >
      <MapView
        places={planner.mapPlaces}
        dayPlaces={planner.dayPlaces}
        route={planner.overviewActive ? planner.tripOverview.lines : planner.route}
        routeColors={planner.overviewActive ? planner.tripOverview.lineColors : undefined}
        focusPoints={planner.overviewActive ? planner.tripOverview.focusPoints : undefined}
        // The route toggle belongs to one day, so the map needs that day to know
        // which automated transports may ride it (#2019).
        days={planner.days}
        selectedDayId={planner.selectedDayId}
        selectedPlaceId={planner.selectedPlaceId}
        onMarkerClick={planner.handleMarkerClick}
        // Tap on empty map = deselect, same contract as desktop.
        onMapClick={planner.handleMapClick}
        // The chip rail names a day at all times on mobile, so a place dropped on
        // the map belongs to it — the desktop map has no such context and passes
        // nothing, which keeps its pool behaviour (#1998).
        onMapContextMenu={e => planner.handleMapContextMenu(e, planner.selectedDayId)}
        // No center/zoom: the map frames itself on the trip's places at mount.
        tileUrl={planner.mapTileUrl}
        fitKey={planner.fitKey}
        dayOrderMap={planner.dayOrderMap}
        reservations={planner.reservations}
        showReservationStats={true}
        visibleConnectionIds={planner.visibleConnections}
        // Transport overlay tap → the mobile transport detail sheet (desktop
        // routes this through mapTransportDetail into the day sidebar instead).
        onReservationClick={(rid: number) => shell.openSheet('transport', { reservationId: rid })}
        pois={poi.pois}
        onPoiClick={marker => planner.openAddPlaceFromPoi(marker, planner.selectedDayId)}
        onViewportChange={poi.onViewportChange}
      />

      {/* Floating map chrome — only while the map view is front-most. The POI bar
          sits below the day-chip rail (safe-top + 50px + ~42px chip height) and
          takes the full width between the screen margins, so its segments are
          the same size as everything else the thumb aims at on this screen. */}
      {mapActive && poiPillEnabled && (
        <div className="pointer-events-none absolute left-4 right-4 z-[25] flex flex-col items-center gap-2 top-[calc(var(--m-safe-top,12px)+96px)]">
          <PoiCategoryPill
            fullWidth
            active={poi.active}
            onToggle={poi.toggle}
            loadingKeys={poi.loadingKeys}
            errorKeys={poi.errorKeys}
            moved={poi.moved}
            onSearchArea={poi.searchArea}
          />
        </div>
      )}

      {/* Whole-trip overview (#1736): the stages stack above their toggle on the
          right, clear of the round-controls band below it and of the base-layer
          switcher, which sits bottom left. */}
      {mapActive && (
        <div className="pointer-events-none absolute left-3 right-3 z-[25] flex flex-col items-end gap-2 bottom-[calc(var(--bottom-nav-h,84px)+58px)]">
          {planner.overviewActive && (
            <TripRouteOverviewPanel
              overview={planner.tripOverview}
              unit={distanceUnit}
              selectedDayId={planner.selectedDayId}
              onSelectDay={planner.handleSelectDay}
              // Tighter than the desktop card: the map is the whole screen here, so a
              // long day name ellipsizes rather than eating another 80px of it.
              maxWidth={240}
            />
          )}
          <TripRouteOverviewPill active={planner.overviewShown} onToggle={planner.toggleOverview} />
        </div>
      )}
    </div>
  )
}
