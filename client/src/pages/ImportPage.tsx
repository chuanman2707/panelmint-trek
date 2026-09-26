import { AlertTriangle, ArrowLeft, Download } from 'lucide-react';

import Navbar from '../components/Layout/Navbar';
import { useTranslation } from '../i18n';
import ImportPreview from './import/ImportPreview';
import { useImportPage } from './import/useImportPage';

/**
 * `/import` — the landing page for share links (`?d=`) and static bundle files
 * (`?src=`). One component serves every viewport: the Navbar renders md+ only
 * and the mobile chrome comes from MobileShell, so the page carries its own
 * phone-sized header/back row under the `md:hidden` line.
 */
export default function ImportPage() {
  const { locale } = useTranslation();
  const { t, state, save, back } = useImportPage();

  return (
    <div className="min-h-screen bg-surface text-content">
      <Navbar showBack onBack={back} />

      {/* Phone header — Navbar above is hidden below md, the dock owns the
          bottom edge, so the way back out lives here. */}
      <div className="flex items-center gap-2 px-4 pt-4 md:hidden">
        <button
          type="button"
          onClick={back}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-content-muted transition-colors hover:bg-surface-hover"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common.back')}
        </button>
      </div>

      <main className="mx-auto w-full max-w-xl px-4 pb-24 pt-5 md:pt-[calc(var(--nav-h)+3rem)]">
        <header className="mb-5">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold">
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent-subtle text-accent-on">
              <Download size={17} strokeWidth={2} />
            </span>
            {t('import.title')}
          </h1>
          <p className="mt-2 text-sm text-content-muted">{t('import.subtitle')}</p>
        </header>

        {state.status === 'loading' && (
          <div
            className="flex items-center justify-center rounded-2xl border border-edge-faint bg-surface-card py-16"
            role="status"
          >
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-edge border-t-content" />
            <span className="sr-only">{t('import.loading')}</span>
          </div>
        )}

        {state.status === 'error' && (
          <div className="rounded-2xl border border-edge-faint bg-surface-card p-5" role="alert">
            <p className="flex items-start gap-2.5 text-sm text-content">
              <AlertTriangle size={17} strokeWidth={2} className="mt-0.5 flex-none text-danger" />
              <span>{state.error ?? t('import.errorNoData')}</span>
            </p>
            <button
              type="button"
              onClick={back}
              className="mt-4 rounded-lg border border-edge px-3.5 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-surface-hover"
            >
              {t('common.back')}
            </button>
          </div>
        )}

        {(state.status === 'ready' || state.status === 'saving') && state.bundle && (
          <>
            <ImportPreview bundle={state.bundle} t={t} locale={locale} />
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={back}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-content-muted transition-colors hover:bg-surface-hover"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={state.status === 'saving'}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {state.status === 'saving' ? t('import.saving') : t('import.save')}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
