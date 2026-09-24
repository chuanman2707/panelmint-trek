import { useState, type ReactNode } from 'react'
import { ChevronRight, Download, FileText, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Modal from '../shared/Modal'
import { useToast } from '../shared/Toast'
import type { Trip, Day, Place, Category, AssignmentsMap, Reservation, DayNote } from '../../types'
import { useSettingsStore } from '../../store/settingsStore'
import { useRoadtripSettings } from '../../hooks/useRoadtripSettings'

interface TripExportModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: number
  trip: Trip
  days: Day[]
  places: Place[]
  categories: Category[]
  assignments: AssignmentsMap
  reservations: Reservation[]
  dayNotes: Record<string, DayNote[]>
  t: (key: string, params?: Record<string, any>) => string
  locale: string
  toast: ReturnType<typeof useToast>
}

/**
 * Every way a trip leaves PanelMint, in one dialog. The hosted formats — ICS
 * download, calendar feed subscription, GPX export — hit server endpoints and
 * are cut in the local build; the day plan as a PDF is rendered client-side
 * and stays.
 */
export function TripExportModal({
  isOpen, onClose, tripId, trip, days, places, categories, assignments, reservations, dayNotes,
  t, locale, toast,
}: TripExportModalProps) {
  // Which row is working, so the dialog can say so instead of looking inert
  // while a 226 kB PDF builder is fetched and a document is rendered.
  const [busy, setBusy] = useState<string | null>(null)
  // The PDF is built outside React, so it cannot read this itself (#2066).
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const distanceUnit = useSettingsStore(s => s.settings.distance_unit)
  // The export gets the store's assignments and applies the day plan's own filter to
  // them, so it needs the same switch the plan reads.
  const showServiceStops = useRoadtripSettings(s => s.roadtrip_service_stops_in_days !== false, tripId)

  const exportPdf = async () => {
    if (busy) return
    setBusy('pdf')
    const flatNotes = Object.entries(dayNotes).flatMap(([dayId, notes]) =>
      notes.map(n => ({ ...n, day_id: Number(dayId) })),
    )
    try {
      // Loaded on click: the PDF builder is ~226 kB and hangs off the days
      // sidebar, so every trip used to pay for it whether or not anyone
      // exported. A missing chunk lands in the catch and shows the same error
      // the export already had.
      const { downloadTripPDF } = await import('../PDF/TripPDF')
      await downloadTripPDF({ trip, days, places, assignments, categories, dayNotes: flatNotes, reservations, t, locale, timeFormat, distanceUnit, showServiceStops })
      onClose()
    } catch (e) {
      console.error('PDF error:', e)
      toast.error(`${t('dayplan.pdfError')}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent-subtle text-accent-on">
              <Download size={16} strokeWidth={2} />
            </span>
            {t('dayplan.export')}
          </span>
        }
      >
        <p className="-mt-1 mb-5 text-caption text-content-muted">{t('dayplan.exportIntro')}</p>

        <Section label={t('dayplan.exportDocument')}>
          <ExportRow
            icon={FileText}
            title={t('dayplan.pdf')}
            sub={t('dayplan.pdfTooltip')}
            busy={busy === 'pdf'}
            disabled={busy != null}
            onClick={exportPdf}
          />
        </Section>
      </Modal>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 px-1 text-caption font-bold uppercase tracking-[0.07em] text-content-faint">{label}</h3>
      <div className="divide-y divide-edge-faint overflow-hidden rounded-xl border border-edge-faint bg-surface">
        {children}
      </div>
    </section>
  )
}

function ExportRow({ icon: Icon, title, sub, busy = false, disabled = false, onClick }: {
  icon: LucideIcon
  title: string
  sub?: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover disabled:cursor-default disabled:opacity-50"
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-surface-tertiary text-content-secondary transition-colors group-enabled:group-hover:bg-accent-subtle group-enabled:group-hover:text-accent-on">
        {busy ? <Loader2 size={16} strokeWidth={2} className="animate-spin" /> : <Icon size={16} strokeWidth={1.9} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold text-content">{title}</span>
        {sub && <span className="block truncate text-caption text-content-muted">{sub}</span>}
      </span>
      <ChevronRight
        size={15}
        strokeWidth={2}
        className="flex-none text-content-faint transition-transform group-enabled:group-hover:translate-x-0.5"
      />
    </button>
  )
}
