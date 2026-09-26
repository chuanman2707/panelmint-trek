/**
 * `/import` page logic — decode the shared bundle out of the URL, preview it,
 * persist it via saveBundle on confirmation.
 *
 * Two sources: `?d=` carries the deflate+base64url token a share link embeds;
 * `?src=` points at a static same-origin file (bundled trip templates, a
 * document in the PWA's asset tree). `src` is deliberately confined to this
 * origin — an absolute or protocol-relative URL, or one that normalises into
 * one (`/\evil` collapses to `//evil`), is rejected so an import link can never
 * make the app fetch a foreign host.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { useToast } from '../../components/shared/Toast';
import { useTranslation } from '../../i18n';
import { decodeFromFile, decodeTrip, type ShareBundle } from '../../share/codec';
import { saveBundle } from '../../share/remap';

export type ImportStatus = 'loading' | 'ready' | 'saving' | 'error';

export interface ImportState {
  status: ImportStatus;
  bundle: ShareBundle | null;
  error: string | null;
}

/** `?src=` → a fetchable same-origin URL, or null when it leaves this origin. */
function resolveImportSrc(src: string, origin: string): string | null {
  if (!src.startsWith('/') || src.startsWith('//')) return null;
  try {
    const url = new URL(src, origin);
    if (url.origin !== origin) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function useImportPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const d = searchParams.get('d');
  const src = searchParams.get('src');

  const [state, setState] = useState<ImportState>({ status: 'loading', bundle: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', bundle: null, error: null });
    (async () => {
      try {
        let bundle: ShareBundle;
        if (d) {
          bundle = await decodeTrip(d);
        } else if (src) {
          const url = resolveImportSrc(src, window.location.origin);
          if (!url) throw new Error(t('import.errorInvalidSrc'));
          const res = await fetch(url);
          if (!res.ok) throw new Error(t('import.errorFetch'));
          bundle = decodeFromFile(await res.text());
        } else {
          throw new Error(t('import.errorNoData'));
        }
        if (!cancelled) setState({ status: 'ready', bundle, error: null });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            bundle: null,
            error: err instanceof Error ? err.message : t('import.errorNoData'),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [d, src, t]);

  // Double-invocation guard — a second click mid-write would otherwise import
  // the trip twice (the status update hasn't flushed yet).
  const savingRef = useRef(false);
  const save = useCallback(async () => {
    const bundle = state.bundle;
    if (savingRef.current || !bundle || state.status !== 'ready') return;
    savingRef.current = true;
    setState({ status: 'saving', bundle, error: null });
    try {
      const newId = await saveBundle(bundle);
      toast.success(t('import.saved'));
      navigate(`/trips/${newId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('import.saveError'));
      setState((s) => (s.status === 'saving' ? { status: 'ready', bundle: s.bundle, error: null } : s));
    } finally {
      savingRef.current = false;
    }
  }, [state, navigate, toast, t]);

  const back = useCallback(() => navigate('/dashboard'), [navigate]);

  return { t, state, save, back };
}
