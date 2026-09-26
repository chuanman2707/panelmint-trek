import { Bug, Code2, ExternalLink, Heart, Info, Lightbulb, Scale } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../i18n';
import Section from './Section';

interface Props {
  appVersion: string;
}

/**
 * The local build's About: what PanelMint is, where its source lives (the AGPL
 * §13 source offer — the version badge above it stays for the same reason),
 * and where to report things. The donation cards, the upstream Discord and the
 * wiki link went away with the fork: they belong to TREK upstream, not here.
 */
export default function AboutTab({ appVersion }: Props): React.ReactElement {
  const { t } = useTranslation();

  return (
    <Section title={t('settings.about')} icon={Info}>
      <style>{`
        @keyframes heartPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.15); }
        }
      `}</style>
      <p
        className="text-content-secondary"
        style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', lineHeight: 1.6, marginBottom: 6, marginTop: -4 }}
      >
        {t('settings.about.description')}
      </p>
      <p
        className="text-content-faint"
        style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', lineHeight: 1.6, marginBottom: 16 }}
      >
        {t('settings.about.madeWith')}{' '}
        <Heart
          size={11}
          fill="#991b1b"
          stroke="#991b1b"
          style={{ display: 'inline-block', verticalAlign: '-1px', animation: 'heartPulse 1.5s ease-in-out infinite' }}
        />{' '}
        {t('settings.about.madeBy')}{' '}
        <span
          className="bg-surface-tertiary text-content-faint"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 99,
            padding: '1px 7px',
            fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
            fontWeight: 600,
            verticalAlign: '1px',
          }}
        >
          v{appVersion}
        </span>
      </p>

      {/* The source offer first: AGPL wants it prominent for anyone using the
          app, and the whole card doubles as the license notice. */}
      <a
        href="https://github.com/chuanman2707/panelmint-trek"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-4 overflow-hidden rounded-xl border border-edge bg-surface-card px-5 py-4 no-underline transition-colors hover:border-accent"
      >
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-accent-subtle text-accent">
          <Code2 size={20} />
        </div>
        <div>
          <div className="text-sm font-semibold text-content">{t('settings.about.sourceCode')}</div>
          <div className="text-xs text-content-faint">{t('settings.about.sourceCodeHint')}</div>
        </div>
        <ExternalLink size={14} className="ml-auto flex-shrink-0 text-content-faint" />
      </a>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-content-faint">
        <Scale size={11} className="flex-shrink-0" />
        {t('settings.about.license')}
      </p>
      {/* Spec §17 caveat: tabs share the Dexie db but not the store — edits made
          elsewhere land here on refocus, not live. */}
      <p className="mt-1.5 text-xs text-content-faint">{t('settings.about.multiTabNote')}</p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <a
          href="https://github.com/chuanman2707/panelmint-trek/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 overflow-hidden rounded-xl border border-edge bg-surface-card px-5 py-4 no-underline transition-colors hover:border-danger"
        >
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-danger-soft text-danger">
            <Bug size={20} />
          </div>
          <div>
            <div className="text-sm font-semibold text-content">{t('settings.about.reportBug')}</div>
            <div className="text-xs text-content-faint">{t('settings.about.reportBugHint')}</div>
          </div>
          <ExternalLink size={14} className="ml-auto flex-shrink-0 text-content-faint" />
        </a>
        <a
          href="https://github.com/chuanman2707/panelmint-trek/issues/new?labels=enhancement"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 overflow-hidden rounded-xl border border-edge bg-surface-card px-5 py-4 no-underline transition-colors hover:border-warning"
        >
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-warning-soft text-warning">
            <Lightbulb size={20} />
          </div>
          <div>
            <div className="text-sm font-semibold text-content">{t('settings.about.featureRequest')}</div>
            <div className="text-xs text-content-faint">{t('settings.about.featureRequestHint')}</div>
          </div>
          <ExternalLink size={14} className="ml-auto flex-shrink-0 text-content-faint" />
        </a>
      </div>
    </Section>
  );
}
