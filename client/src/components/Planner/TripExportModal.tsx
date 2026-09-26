import type { ReactNode } from 'react'
import { ChevronRight, Download, FileDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import Modal from '../shared/Modal'
import type { useToast } from '../shared/Toast'

interface TripExportModalProps {
  isOpen: boolean
  onClose: () => void
  t: (key: string, params?: Record<string, unknown>) => string
  toast: ReturnType<typeof useToast>
}

/**
 * Every way a trip leaves PanelMint, in one dialog. The hosted formats — ICS
 * download, calendar feed subscription, GPX, the server-rendered PDF — are cut
 * in the local build. The one remaining row is the file export, a stub until
 * Phase C wires the `.panelmint.json` codec (`src/share/codec.ts`).
 */
export function TripExportModal({
  isOpen, onClose, t, toast,
}: TripExportModalProps) {
  // Stub: the codec lands in Phase C; until then the row reports that instead
  // of silently doing nothing.
  const exportFile = () => {
    toast.info(t('dayplan.exportFileTooltip'))
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
            icon={FileDown}
            title={t('dayplan.exportFile')}
            sub={t('dayplan.exportFileTooltip')}
            onClick={exportFile}
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

function ExportRow({ icon: Icon, title, sub, onClick }: {
  icon: LucideIcon
  title: string
  sub?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-surface-tertiary text-content-secondary transition-colors group-enabled:group-hover:bg-accent-subtle group-enabled:group-hover:text-accent-on">
        <Icon size={16} strokeWidth={1.9} />
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
