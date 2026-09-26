import type { ReactNode } from 'react'
import { ChevronRight, FileDown } from 'lucide-react'
import MSheet from '../../../components/MSheet'
import { useTranslation } from '../../../../i18n'
import { downloadTripFile } from '../../../../share/actions'
import { INNER_CLS, TileHeader } from './MTripSheetUi'
import type { MTripSheetsProps } from '../MTripShell'
import type { LucideIcon } from 'lucide-react'

/**
 * Export sheet ('export', opened from the Mehr sheet). The hosted formats — ICS
 * download/subscribe, GPX, the server-rendered PDF — are cut in the local build.
 * The remaining row is the file export: the share codec (`src/share/codec.ts`)
 * packs the trip into a `.panelmint.json` the /import page can read back.
 */
export default function MExportSheet({ planner, shell }: MTripSheetsProps) {
  const { t } = useTranslation()
  const open = shell.sheet?.id === 'export'

  const exportFile = async () => {
    if (!planner.trip) return
    try {
      await downloadTripFile(planner.trip.id, planner.trip.title)
      planner.toast.success(t('dayplan.exportFileDone'))
      shell.closeSheet()
    } catch (err: unknown) {
      planner.toast.error(err instanceof Error ? err.message : t('dayplan.exportFileError'))
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
            title={t('dayplan.exportFile')}
            sub={t('dayplan.exportFileTooltip')}
            onClick={exportFile}
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
