import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Map, Save } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { useSettingsStore } from '../../../store/settingsStore'
import { useToast } from '../../../components/shared/Toast'
import { MapView } from '../../../components/Map/MapView'
import type { Place } from '../../../types'
import { withTileApiKey } from '../../../utils/tileUrl'
import { AMAP_ROAD, AMAP_SATELLITE } from '../../../constants/mapDefaults'
import { MSetCard, MSetEyebrow, MSetSelectRow, MSetInput, MSetButton, MSetHint } from './MSettingsUi'
import MSetPickerSheet from './MSetPickerSheet'

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

// A recognisable city so the preview shows label density.
const PREVIEW_CENTER: [number, number] = [48.8566, 2.3522]

/**
 * "Map" section — MapSettingsTab parity: raster tiles, CARTO key and a live
 * preview. PanelMint is Leaflet-only: the provider picker, GL style/3D/quality
 * controls and the GL preview went away with the map_provider/mapbox_*
 * settings.
 */
export default function MSettingsMap() {
  const { settings, updateSettings } = useSettingsStore()
  const { t } = useTranslation()
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const [mapTileUrl, setMapTileUrl] = useState<string>(settings.map_tile_url || '')
  const [cartoKey, setCartoKey] = useState<string>(settings.carto_api_key || '')
  const [presetOpen, setPresetOpen] = useState(false)

  useEffect(() => {
    setMapTileUrl(settings.map_tile_url || '')
    setCartoKey(settings.carto_api_key || '')
  }, [settings])

  const previewPlaces = useMemo(
    (): Place[] => [
      {
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
      },
    ],
    [],
  )

  const save = async (): Promise<void> => {
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

  const chevron = <ChevronDown size={13} strokeWidth={2} className="flex-none text-m-faint" />

  return (
    <MSetCard title={t('settings.map')} icon={Map}>
      <MSetEyebrow className="mb-[5px]">{t('settings.mapTemplate')}</MSetEyebrow>
      <MSetSelectRow
        label={MAP_PRESETS.find((p) => p.url === mapTileUrl)?.name || t('settings.mapTemplatePlaceholder.select')}
        trailing={chevron}
        onClick={() => setPresetOpen(true)}
      />
      <MSetInput
        mono
        className="mt-[6px]"
        value={mapTileUrl}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMapTileUrl(e.target.value)}
        placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MSetHint>{t('settings.mapDefaultHint')}</MSetHint>

      <MSetEyebrow className="mb-[5px] mt-[14px]">{t('settings.mapCartoKey')}</MSetEyebrow>
      <MSetInput
        mono
        value={cartoKey}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCartoKey(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
      <MSetHint>
        {t('settings.mapCartoKeyHint')}{' '}
        <a href="https://carto.com/basemaps/apikey/" target="_blank" rel="noreferrer" className="underline">
          {t('settings.mapCartoKeyLink')}
        </a>
      </MSetHint>
      {cartoNeedsKey && (
        <p className="mt-[6px] font-geist text-[0.625rem] leading-relaxed text-[color:var(--m-st-pending)]">
          {t('settings.mapCartoKeyMissing')}
        </p>
      )}

      <div className="relative mt-3 h-[200px] w-full overflow-hidden rounded-xl">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {React.createElement(MapView as any, {
          places: previewPlaces,
          dayPlaces: [],
          route: null,
          selectedPlaceId: null,
          onMarkerClick: null,
          onMapClick: null,
          onMapContextMenu: null,
          // As on the desktop tab: the field holds what is being edited, so the
          // key goes back on before the preview resolves the template.
          tileUrl: withTileApiKey(mapTileUrl, cartoKey),
          fitKey: null,
          dayOrderMap: [],
          leftWidth: 0,
          rightWidth: 0,
          hasInspector: false,
        })}
      </div>

      <MSetButton className="mt-3" onClick={save} disabled={saving}>
        <Save size={14} />
        {t('settings.saveMap')}
      </MSetButton>

      <MSetPickerSheet
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title={t('settings.mapTemplate')}
        value={mapTileUrl}
        onSelect={setMapTileUrl}
        options={MAP_PRESETS.map((p) => ({ value: p.url, label: p.name }))}
      />
    </MSetCard>
  )
}
