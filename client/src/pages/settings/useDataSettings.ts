/**
 * Settings "Data" section logic — shared by the desktop `DataSettingsTab` and
 * its mobile twin `MSettingsData`, so the two shells keep only markup.
 *
 * Three actions: export every trip as one `panelmint-archive` `.panelmint.json`
 * (the share codec over all trips), import a picked `.panelmint.json` back —
 * single-trip file or archive — through `saveBundle`, and open the bundled
 * sample itinerary through the `/import?src=` preview.
 */
import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate } from 'react-router';

import { useToast } from '../../components/shared/Toast';
import { useTranslation } from '../../i18n';
import { downloadAllTripsFile } from '../../share/actions';
import { decodeBundlesFromFile, type ShareBundle } from '../../share/codec';
import { saveBundle } from '../../share/remap';

/** The bundled sample itinerary lives in `public/` and reaches the preview
 *  through the same `?src=` transport any static bundle file uses. */
const SAMPLE_SRC = `${import.meta.env.BASE_URL}templates/nha-trang-3n2d.json`;

export function useDataSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  // Ref twin of `busy` — a second tap must not re-enter before the state write
  // has flushed (same double-import guard the /import page runs).
  const busyRef = useRef(false);

  const exclusive = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const exportAll = useCallback(
    () =>
      exclusive(async () => {
        try {
          if ((await downloadAllTripsFile()) === 'empty') {
            toast.info(t('settings.data.exportEmpty'));
          } else {
            toast.success(t('settings.data.exportDone'));
          }
        } catch {
          // Export failures toast the localized key — raw system/Dexie messages
          // stay out of the UI (unlike import decode, where the codec's own
          // friendly strings are the spec'd surface).
          toast.error(t('settings.data.exportError'));
        }
      }),
    [exclusive, t, toast]
  );

  const importFile = useCallback(
    async (file: File) => {
      let bundles: ShareBundle[];
      try {
        bundles = decodeBundlesFromFile(await file.text());
      } catch (err: unknown) {
        // The codec's own message (malformed file, newer format) says more than
        // the generic failure would.
        toast.error(err instanceof Error ? err.message : t('settings.data.importError'));
        return;
      }
      let imported = 0;
      for (const bundle of bundles) {
        try {
          await saveBundle(bundle);
          imported += 1;
        } catch {
          // Each saveBundle is atomic per trip — the ones that already landed
          // stay, and the toast says how many made it.
          toast.error(t('settings.data.importPartial', { count: imported }));
          return;
        }
      }
      toast.success(t('settings.data.importDone', { count: imported }));
    },
    [t, toast]
  );

  const pickFile = useCallback(() => fileRef.current?.click(), []);

  const onFilePicked = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Clear the pick so choosing the same file again still fires `change`.
      e.target.value = '';
      if (!file) return;
      return exclusive(() => importFile(file));
    },
    [exclusive, importFile]
  );

  const openSample = useCallback(() => {
    navigate(`/import?src=${encodeURIComponent(SAMPLE_SRC)}`);
  }, [navigate]);

  return { busy, fileRef, pickFile, onFilePicked, exportAll, openSample };
}
