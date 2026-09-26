/**
 * Frames a set of places: turns their coordinates into the camera (center + zoom) a map
 * should open at, so a trip in Japan opens on Japan instead of on the world view followed
 * by a fitBounds flight across the planet.
 *
 * MapView calls this once, at construction. Returns null when no point has usable
 * coordinates (a brand-new trip), leaving the caller to fall back to
 * DEFAULT_MAP_CENTER / DEFAULT_MAP_ZOOM.
 *
 * The bbox padding + minimum-span rules here are tuned for framing a camera —
 * keep them local and dependency-free so a map's render path (and a pure-math
 * unit test) never pulls in a storage module.
 */

/** Web Mercator diverges at the poles — projections clamp latitude to this. */
const MERCATOR_MAX_LAT = 85.0511

/** Leaflet measures zoom against a 256px world tile. */
export const TILE_SIZE_RASTER = 256

/**
 * Match the maxZoom the fitBounds in MapView already clamps to (16), so the opening
 * camera and any later fit agree instead of fighting.
 */
export const MAX_ZOOM_RASTER = 16

/**
 * One place (or several at the same spot) has no extent to fit, so zoom is a choice rather
 * than a calculation: city level, showing the surroundings rather than just the pin.
 */
export const SINGLE_PLACE_ZOOM_RASTER = 12

export interface MapViewport {
  /** [lat, lng] — the order MapView takes it as a prop. */
  center: [number, number]
  zoom: number
}

/** Anything with coordinates: a Place, a CollectionPlace, a bare {lat, lng}. */
export interface GeoPointish {
  lat?: number | null
  lng?: number | null
}

export interface ViewportPadding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface ViewportOptions {
  /** Pixels per world tile at zoom 0 (Leaflet: 256). Drives the zoom scale. */
  tileSize?: number
  /** Map container size in CSS px. Defaults to the window, then to 1024x768 (SSR/jsdom). */
  width?: number
  height?: number
  /** Chrome overlaying the map (side panels). Shifts the center so places stay visible. */
  padding?: Partial<ViewportPadding>
  maxZoom?: number
  singlePlaceZoom?: number
}

const NO_PADDING: ViewportPadding = { top: 0, right: 0, bottom: 0, left: 0 }

const clampLat = (lat: number): number =>
  Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat))

/** Wrap into [-180, 180) so a center computed across the antimeridian stays a real longitude. */
const normalizeLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180

/**
 * Keep only points we can actually project. Note the Number.isFinite test: `lat && lng`
 * would silently drop Null Island, the equator and the prime meridian — 0 is a coordinate.
 */
function usablePoints(points: readonly GeoPointish[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const point of points || []) {
    const lat = point?.lat
    const lng = point?.lng
    if (typeof lat !== 'number' || typeof lng !== 'number') continue
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue
    out.push([clampLat(lat), lng])
  }
  return out
}

/** Mercator y as a fraction of the world, in the [-π, π] convention the zoom math expects. */
function latRad(lat: number): number {
  const sin = Math.sin((clampLat(lat) * Math.PI) / 180)
  const rad = Math.log((1 + sin) / (1 - sin)) / 2
  return Math.max(-Math.PI, Math.min(Math.PI, rad)) / 2
}

/**
 * The plain min..max arc of longitude — the long way round across the antimeridian.
 *
 * Leaflet draws a single world and places markers at their absolute position, so a centre
 * reached "the short way" across the antimeridian would leave markers on the far side of
 * the one world it drew, off-screen entirely. This is also what L.latLngBounds would do.
 */
function lngExtent(lngs: number[]): { west: number; east: number; span: number } {
  const sorted = [...lngs].sort((a, b) => a - b)
  return { west: sorted[0], east: sorted[sorted.length - 1], span: sorted[sorted.length - 1] - sorted[0] }
}

/** Zoom at which a span covering `fraction` of the world fills `px` pixels. */
function zoomForFraction(px: number, tileSize: number, fraction: number, maxZoom: number): number {
  // A zero fraction (identical coordinates) would divide by zero and yield Infinity.
  if (!(fraction > 0)) return maxZoom
  const zoom = Math.log2(px / tileSize / fraction)
  return Number.isFinite(zoom) ? zoom : maxZoom
}

function project(lat: number, lng: number, zoom: number, tileSize: number): { x: number; y: number } {
  const scale = tileSize * Math.pow(2, zoom)
  const sin = Math.sin((clampLat(lat) * Math.PI) / 180)
  return {
    x: scale * (lng / 360 + 0.5),
    y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  }
}

function unproject(x: number, y: number, zoom: number, tileSize: number): [number, number] {
  const scale = tileSize * Math.pow(2, zoom)
  const lng = (x / scale - 0.5) * 360
  const n = Math.PI * (1 - 2 * (y / scale))
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n))
  return [lat, normalizeLng(lng)]
}

/**
 * The map renders its center at the middle of the container, but padding (side panels)
 * means the *visible* middle sits elsewhere. Pull the center back by half the padding
 * delta so the places land in the part of the map the user can actually see — the same
 * thing fitBounds' padding option does.
 */
function offsetForPadding(
  center: [number, number],
  zoom: number,
  tileSize: number,
  padding: ViewportPadding,
): [number, number] {
  const { top, right, bottom, left } = padding
  if (!top && !right && !bottom && !left) return center
  const { x, y } = project(center[0], center[1], zoom, tileSize)
  return unproject(x - (left - right) / 2, y - (top - bottom) / 2, zoom, tileSize)
}

function defaultWidth(): number {
  return typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1024
}

function defaultHeight(): number {
  return typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 768
}

/**
 * The camera that frames `points`, or null when none of them have coordinates.
 */
export function computeMapViewport(
  points: readonly GeoPointish[],
  options: ViewportOptions = {},
): MapViewport | null {
  const pts = usablePoints(points)
  if (pts.length === 0) return null

  const tileSize = options.tileSize ?? TILE_SIZE_RASTER
  const maxZoom = options.maxZoom ?? MAX_ZOOM_RASTER
  const singlePlaceZoom = options.singlePlaceZoom ?? SINGLE_PLACE_ZOOM_RASTER

  const padding: ViewportPadding = { ...NO_PADDING, ...options.padding }
  const rawWidth = options.width ?? defaultWidth()
  const rawHeight = options.height ?? defaultHeight()
  // Padding wider than the box leaves a sliver, and the camera is then framed for
  // THAT — a continent instead of the trip. Two 300px planner panels on an 860px
  // foldable did exactly this (#2247). Never surrender more than two thirds; the
  // centre offset still uses the real padding, so the framing stays where it was.
  const width = Math.max(1, rawWidth / 3, rawWidth - padding.left - padding.right)
  const height = Math.max(1, rawHeight / 3, rawHeight - padding.top - padding.bottom)

  const lats = pts.map(p => p[0])
  const south = Math.min(...lats)
  const north = Math.max(...lats)
  const { west, east, span } = lngExtent(pts.map(p => p[1]))

  const latFraction = (latRad(north) - latRad(south)) / Math.PI
  const lngFraction = span / 360

  // No extent in either axis: one place, or several stacked on the same spot.
  const zoom = latFraction <= 0 && lngFraction <= 0
    ? Math.min(singlePlaceZoom, maxZoom)
    : Math.min(
      zoomForFraction(height, tileSize, latFraction, maxZoom),
      zoomForFraction(width, tileSize, lngFraction, maxZoom),
      maxZoom,
    )

  // Floor rather than round: Leaflet snaps zoom to integers, and rounding up would crop
  // the very places we are framing.
  const safeZoom = Number.isFinite(zoom) ? Math.max(0, Math.floor(zoom * 100) / 100) : maxZoom

  // Take the midpoint in *projected* space, not the average of the latitudes: Mercator
  // stretches towards the poles, so a geographic mid-latitude sits off-centre on screen and
  // pushes the northernmost place out of frame. Projecting also carries the antimeridian
  // handling for free — `east` may exceed 180, and unproject wraps it back.
  const northWest = project(north, west, safeZoom, tileSize)
  const southEast = project(south, east, safeZoom, tileSize)
  const center = unproject(
    (northWest.x + southEast.x) / 2,
    (northWest.y + southEast.y) / 2,
    safeZoom,
    tileSize,
  )

  return { center: offsetForPadding(center, safeZoom, tileSize, padding), zoom: safeZoom }
}
