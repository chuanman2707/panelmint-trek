import { MapView } from './MapView'
import { useRoadtripHazards } from './useRoadtripHazards'

// Auto-selects the map renderer. PanelMint ships Leaflet only — the
// map_provider setting and the GL engine are gone (the GL modules themselves
// are removed in Task 19); this wrapper remains as the seam callers already
// import. Atlas is not affected — it imports Leaflet directly.
//
// Offline maps: the Leaflet renderer supports full pre-download (raster tiles
// via sync/tilePrefetcher.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function MapViewAuto(props: any) {
  const hazards = useRoadtripHazards(props.tripId, !!props.clusterLoosely)
  // `dawarichTrack` arrives as a prop rather than being fetched here: the pill
  // that switches it on lives at page level and needs the load status, so the
  // fetch sits in useTripPlanner and both shells read the same one.
  const mapProps = { ...props, hazards: hazards.feed?.hazards }
  return <MapView {...mapProps} />
}
