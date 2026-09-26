import React from 'react';
import { ChevronRight, Database, FileDown, FileUp, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { useDataSettings } from '../../pages/settings/useDataSettings';
import Section from './Section';

/**
 * The "Data" settings tab — the backup surface. "Export all" packs every trip
 * on the device into one `.panelmint.json` archive (the share codec's
 * panelmint-archive envelope), "Import from file" reads a single-trip file or
 * an archive back through `saveBundle`, and the sample trip opens the bundled
 * Nha Trang itinerary through the `/import` preview. All of it lives in
 * `useDataSettings`, shared with the mobile twin `MSettingsData`.
 */
export default function DataSettingsTab(): React.ReactElement {
  const { t } = useTranslation();
  const { busy, fileRef, pickFile, onFilePicked, exportAll, openSample } = useDataSettings();

  return (
    <Section title={t('settings.data.title')} icon={Database}>
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
      <div className="divide-y divide-edge-faint overflow-hidden rounded-xl border border-edge-faint">
        <DataRow
          icon={FileDown}
          title={t('settings.data.exportAll')}
          sub={t('settings.data.exportAllHint')}
          onClick={() => void exportAll()}
          disabled={busy}
        />
        <DataRow
          icon={FileUp}
          title={t('settings.data.importFile')}
          sub={t('settings.data.importFileHint')}
          onClick={pickFile}
          disabled={busy}
        />
        <DataRow
          icon={Sparkles}
          title={t('settings.data.sample')}
          sub={t('settings.data.sampleHint')}
          onClick={openSample}
        />
      </div>
    </Section>
  );
}

function DataRow({
  icon: Icon,
  title,
  sub,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  title: string;
  sub?: string;
  onClick: () => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover disabled:opacity-50"
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-surface-tertiary text-content-secondary transition-colors group-enabled:group-hover:bg-accent-subtle group-enabled:group-hover:text-accent-on">
        <Icon size={16} strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-content">{title}</span>
        {sub && <span className="mt-0.5 block text-caption text-content-muted">{sub}</span>}
      </span>
      <ChevronRight
        size={15}
        strokeWidth={2}
        className="flex-none text-content-faint transition-transform group-enabled:group-hover:translate-x-0.5"
      />
    </button>
  );
}
