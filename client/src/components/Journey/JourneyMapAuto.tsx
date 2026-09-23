import { useImperativeHandle, useRef, type Ref } from 'react'
import JourneyMap, { type JourneyMapHandle } from './JourneyMap'
import type { JourneyTrack } from '@trek/shared'

// PanelMint ships Leaflet only — the map_provider setting and the GL engine
// are gone (the GL modules themselves are removed in Task 19); this wrapper
// remains as the seam callers already import.

// Unified handle.
export type JourneyMapAutoHandle = JourneyMapHandle

interface MapEntry {
  id: string
  lat: number
  lng: number
  title?: string | null
  location_name?: string | null
  mood?: string | null
  entry_date: string
  dayColor?: string
  dayLabel?: number
}

interface Props {
  ref?: Ref<JourneyMapAutoHandle>
  checkins: unknown[]
  entries: MapEntry[]
  trail?: { lat: number; lng: number }[]
  tracks?: JourneyTrack[]
  height?: number
  dark?: boolean
  activeMarkerId?: string | null
  onMarkerClick?: (id: string, type?: string) => void
  fullScreen?: boolean
  paddingBottom?: number
  hideMarkerTooltip?: boolean
  /** Open an entry's photos from the marker card's thumbnail strip. GL renderer only. */
  onMarkerPhotoClick?: (entryId: string, photoIndex: number) => void
}

function JourneyMapAuto({ ref, ...props }: Props) {
  const leafletRef = useRef<JourneyMapHandle>(null)

  useImperativeHandle(ref, () => ({
    highlightMarker: (id) => leafletRef.current?.highlightMarker(id),
    focusMarker: (id) => leafletRef.current?.focusMarker(id),
    invalidateSize: () => leafletRef.current?.invalidateSize(),
  }), [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <JourneyMap ref={leafletRef} {...(props as any)} />
}

export default JourneyMapAuto
