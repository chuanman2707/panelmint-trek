import { ChevronRight, Database, FileDown, FileUp } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { useDataSettings } from '../../../pages/settings/useDataSettings'
import { MSetCard, MSetHint, MSetSelectRow } from './MSettingsUi'

/**
 * "Data" section — DataSettingsTab parity: the backup surface. Export-all packs
 * every trip into one `.panelmint.json` archive, the file row imports a
 * single-trip file or an archive through `saveBundle`, and the sample row opens
 * the bundled Nha Trang itinerary through the `/import` preview. The logic sits
 * in the shared `useDataSettings` hook; this file is markup only.
 */
export default function MSettingsData() {
  const { t } = useTranslation()
  const { fileRef, pickFile, onFilePicked, exportAll, openSample } = useDataSettings()

  return (
    <MSetCard title={t('settings.data.title')} icon={Database}>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        data-testid="data-import-file"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => void onFilePicked(e)}
      />

      <MSetSelectRow
        label={t('settings.data.exportAll')}
        trailing={<FileDown size={14} strokeWidth={2} className="flex-none text-m-faint" />}
        onClick={() => void exportAll()}
      />
      <MSetHint>{t('settings.data.exportAllHint')}</MSetHint>

      <MSetSelectRow
        className="mt-[10px]"
        label={t('settings.data.importFile')}
        trailing={<FileUp size={14} strokeWidth={2} className="flex-none text-m-faint" />}
        onClick={pickFile}
      />
      <MSetHint>{t('settings.data.importFileHint')}</MSetHint>

      <MSetSelectRow
        className="mt-[10px]"
        label={t('settings.data.sample')}
        trailing={<ChevronRight size={14} strokeWidth={2} className="flex-none text-m-faint" />}
        onClick={openSample}
      />
      <MSetHint>{t('settings.data.sampleHint')}</MSetHint>
    </MSetCard>
  )
}
