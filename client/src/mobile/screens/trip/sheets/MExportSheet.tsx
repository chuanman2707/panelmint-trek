import { useState, type ReactNode } from 'react'
import { ChevronRight, FileDown } from 'lucide-react'
import MSheet from '../../../components/MSheet'
import { useTripStore } from '../../../../store/tripStore'
import { useSettingsStore } from '../../../../store/settingsStore'
import { useRoadtripSettings } from '../../../../hooks/useRoadtripSettings'
import { useTranslation } from '../../../../i18n'
import { INNER_CLS, TileHeader } from './MTripSheetUi'
import type { MTripSheetsProps } from '../MTripShell'
import type { LucideIcon } from 'lucide-react'

/**
 * Export sheet ('export', opened from the Mehr sheet): the desktop day-plan
 * toolbar's PDF export. The ICS download/subscribe and GPX download were
 * hosted endpoints and are cut in the local build.
 */
export default function MExportSheet({ planner, shell }: MTripSheetsProps) {
  const { t, locale } = useTranslation()
  // The PDF is built outside React, so it cannot read this itself (#2066).
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const distanceUnit = useSettingsStore(s => s.settings.distance_unit)
  // Fed the way the desktop dialog feeds it: the store's assignments and the switch,
  // and the export applies the day plan's filter itself, so both shells print the same.
  const showServiceStops = useRoadtripSettings(s => s.roadtrip_service_stops_in_days !== false, planner.tripId)
  const open = shell.sheet?.id === 'export'
  const dayNotes = useTripStore(s => s.dayNotes)
  const [pdfBusy, setPdfBusy] = useState(false)

  const exportPdf = async () => {
    if (!planner.trip || pdfBusy) return
    const flatNotes = Object.entries(dayNotes).flatMap(([dayId, notes]) =>
      notes.map(n => ({ ...n, day_id: Number(dayId) })),
    )
    setPdfBusy(true)
    try {
      // See DayPlanSidebarToolbar: loaded on demand, not with the trip.
      const { downloadTripPDF } = await import('../../../../components/PDF/TripPDF')
      await downloadTripPDF({
        trip: planner.trip,
        days: planner.days,
        places: planner.places,
        assignments: planner.storedAssignments,
        categories: planner.categories,
        dayNotes: flatNotes,
        reservations: planner.reservations,
        t,
        locale,
        timeFormat,
        distanceUnit,
        showServiceStops,
      })
    } catch (e) {
      planner.toast.error(`${t('dayplan.pdfError')}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPdfBusy(false)
    }
  }

  return (
    <MSheet open={open} onClose={shell.closeSheet} variant="card" material="glass" ariaLabel={t('mobileTrip.export')}>
      <div className="flex-none px-[18px] pt-4">
        <TileHeader
          icon={<FileDown size={19} strokeWidth={1.8} />}
          title={t('mobileTrip.export')}
          onClose={shell.closeSheet}
          closeLabel={t('common.close')}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[18px] pt-3">
        <div className="flex flex-col gap-2">
          <ExportRow
            icon={FileDown}
            title={pdfBusy ? t('common.loading') : t('dayplan.pdf')}
            sub={t('dayplan.pdfTooltip')}
            onClick={() => void exportPdf()}
          />
        </div>
      </div>
    </MSheet>
  )
}

function ExportRow({ icon: Icon, title, sub, onClick }: {
  icon: LucideIcon
  title: ReactNode
  sub: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-[13px] rounded-[16px] px-3 py-[11px] text-left ${INNER_CLS}`}
    >
      <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-[color:var(--m-ic)]">
        <Icon size={16} strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.84375rem] font-semibold">{title}</span>
        <span className="block truncate font-geist text-[0.65625rem] text-m-muted">{sub}</span>
      </span>
      <ChevronRight size={15} strokeWidth={2} className="flex-none text-m-faint" />
    </button>
  )
}
