import React, { useState, useEffect, useMemo } from 'react'
import { Map, Save } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../shared/Toast'
import CustomSelect from '../shared/CustomSelect'
import { MapView } from '../Map/MapView'
import Section from './Section'
import { withTileApiKey } from '../../utils/tileUrl'
import { AMAP_ROAD, AMAP_SATELLITE } from '../../constants/mapDefaults'
import type { Place } from '../../types'

interface MapPreset {
  name: string
  url: string
}

const MAP_PRESETS: MapPreset[] = [
  { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
  { name: 'OpenStreetMap DE', url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png' },
  // CARTO watermarks keyless tiles since 26.08.2026 and issues keys by mail, so
  // these two need one; without it the map falls back to the default (#2054).
  { name: 'CartoDB Light', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' },
  { name: 'CartoDB Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' },
  { name: 'Stadia Smooth', url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png' },
  // Amap (高德). GCJ-02 tiles — the map switches to a shifted projection for
  // these so markers still land on the right street (see gcj02Crs.ts). The only
  // basemap here that is genuinely good inside mainland China.
  { name: '高德地图 (Amap)', url: AMAP_ROAD },
  { name: '高德卫星 (Amap Satellite)', url: AMAP_SATELLITE },
]

/**
 * Somewhere recognisable for the preview to render. A city shows off label
 * density in a way open ocean cannot — it is not a user setting, and no map
 * opens here: each map frames itself on its own places.
 */
const PREVIEW_CENTER: [number, number] = [48.8566, 2.3522]

// PanelMint is Leaflet-only: the provider picker, the GL style/3D/quality
// fields and the GL preview went away with the map_provider/mapbox_* settings.
export default function MapSettingsTab(): React.ReactElement {
  const { settings, updateSettings } = useSettingsStore()
  const { t } = useTranslation()
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const [mapTileUrl, setMapTileUrl] = useState<string>(settings.map_tile_url || '')
  const [cartoKey, setCartoKey] = useState<string>(settings.carto_api_key || '')

  useEffect(() => {
    setMapTileUrl(settings.map_tile_url || '')
    setCartoKey(settings.carto_api_key || '')
  }, [settings])

  const previewPlaces = useMemo((): Place[] => [{
    id: 1,
    trip_id: 1,
    name: 'Preview',
    description: '',
    lat: PREVIEW_CENTER[0],
    lng: PREVIEW_CENTER[1],
    address: '',
    category_id: 0,
    price: null,
    image_url: null,
    google_place_id: null,
    osm_id: null,
    route_geometry: null,
    place_time: null,
    end_time: null,
    created_at: String(new Date()),
  }], [])

  const saveMapSettings = async (): Promise<void> => {
    setSaving(true)
    try {
      await updateSettings({
        map_tile_url: mapTileUrl,
        carto_api_key: cartoKey,
      })
      toast.success(t('settings.toast.mapSaved'))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  // Only CARTO burns a watermark into keyless tiles, so the nudge is scoped to its hosts.
  const cartoNeedsKey = mapTileUrl.includes('basemaps.cartocdn.com') && !cartoKey.trim()

  return (
    <Section title={t('settings.map')} icon={Map}>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.mapTemplate')}</label>
        <CustomSelect
          value={mapTileUrl}
          onChange={(value: string) => { if (value) setMapTileUrl(value) }}
          placeholder={t('settings.mapTemplatePlaceholder.select')}
          options={MAP_PRESETS.map(p => ({ value: p.url, label: p.name }))}
          size="sm"
          style={{ marginBottom: 8 }}
        />
        <input
          type="text"
          value={mapTileUrl}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMapTileUrl(e.target.value)}
          placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-slate-400 focus:border-transparent"
        />
        <p className="text-xs text-slate-400 mt-1">{t('settings.mapDefaultHint')}</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">{t('settings.mapCartoKey')}</label>
        <input
          type="text"
          value={cartoKey}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCartoKey(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-slate-400 focus:border-transparent"
        />
        <p className="text-xs text-slate-400 mt-1">
          {t('settings.mapCartoKeyHint')}{' '}
          <a href="https://carto.com/basemaps/apikey/" target="_blank" rel="noreferrer" className="underline">
            {t('settings.mapCartoKeyLink')}
          </a>
        </p>
        {cartoNeedsKey && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{t('settings.mapCartoKeyMissing')}</p>
        )}
      </div>

      <div>
        <div style={{ position: 'relative', inset: 0, height: '200px', width: '100%' }}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {React.createElement(MapView as any, {
            places: previewPlaces,
            dayPlaces: [],
            route: null,
            selectedPlaceId: null,
            onMarkerClick: null,
            onMapClick: null,
            onMapContextMenu: null,
            // With the key on it, or the preview resolves the template as a
            // keyless CARTO one and quietly shows the app default instead of
            // the basemap being configured. The fields hold what the user is
            // editing rather than what useTileUrl already resolved, so the key
            // has to be put back on here.
            tileUrl: withTileApiKey(mapTileUrl, cartoKey),
            fitKey: null,
            dayOrderMap: [],
            leftWidth: 0,
            rightWidth: 0,
            hasInspector: false,
          })}
        </div>
      </div>

      <button type="button"
        onClick={saveMapSettings}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm hover:bg-slate-700 disabled:bg-slate-400"
      >
        {saving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
        {t('settings.saveMap')}
      </button>
    </Section>
  )
}
