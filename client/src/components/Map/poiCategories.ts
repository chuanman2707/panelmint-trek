import { Utensils, Coffee, Wine, BedDouble, Camera, Landmark, Trees, Ticket, type LucideIcon } from 'lucide-react'

// The POI categories shown in the map "explore" pill. The `key` is the contract
// with the Overpass query builder in api/ext/overpass.ts — label/icon/colour
// live here. `color` doubles as the active-pill fill AND the marker colour, so
// the pill and the map agree visually.
export interface PoiCategory {
  key: string
  labelKey: string
  Icon: LucideIcon
  color: string
}

export const POI_CATEGORIES: PoiCategory[] = [
  { key: 'restaurant', labelKey: 'poi.cat.restaurants', Icon: Utensils, color: '#EF4444' },
  { key: 'cafe', labelKey: 'poi.cat.cafes', Icon: Coffee, color: '#B45309' },
  { key: 'bar', labelKey: 'poi.cat.bars', Icon: Wine, color: '#A855F7' },
  { key: 'hotel', labelKey: 'poi.cat.hotels', Icon: BedDouble, color: '#2563EB' },
  { key: 'sights', labelKey: 'poi.cat.sights', Icon: Camera, color: '#EC4899' },
  { key: 'museum', labelKey: 'poi.cat.museums', Icon: Landmark, color: '#6366F1' },
  { key: 'nature', labelKey: 'poi.cat.nature', Icon: Trees, color: '#16A34A' },
  { key: 'activity', labelKey: 'poi.cat.activities', Icon: Ticket, color: '#F59E0B' },
]

export const POI_CATEGORY_BY_KEY: Record<string, PoiCategory> = Object.fromEntries(
  POI_CATEGORIES.map(c => [c.key, c]),
)

// One POI result from the Overpass search (api/ext/overpass.ts).
export interface Poi {
  osm_id: string
  name: string
  lat: number
  lng: number
  category: string
  poi_type: string
  /** Brand name and its Wikidata id, when OSM carries them (road categories mostly do). */
  brand?: string | null
  brand_wikidata?: string | null
  address: string | null
  website: string | null
  phone: string | null
  opening_hours: string | null
  cuisine: string | null
  source: string
  rating?: number | null
}
