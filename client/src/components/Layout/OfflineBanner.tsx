/**
 * OfflineBanner — connectivity indicator.
 *
 * There is no mutation queue any more, so the pill is a plain "offline" signal:
 * amber while the browser has no connectivity, hidden otherwise.
 *
 * Rendered as a small floating pill anchored to the bottom-center of the
 * viewport so it never competes with top navigation or sticky modal
 * headers. On mobile it hovers just above the bottom tab bar.
 */
import React from 'react'
import { WifiOff } from 'lucide-react'
import { useNetworkMode } from '../../hooks/useNetworkMode'
import { useTranslation } from '../../i18n'

export default function OfflineBanner(): React.ReactElement | null {
  const { t } = useTranslation()
  const { offline, forced } = useNetworkMode()

  if (!offline) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        // Hover above the mobile bottom nav; on desktop --bottom-nav-h is 0,
        // so the pill sits 16px from the bottom.
        bottom: 'calc(var(--bottom-nav-h) + 16px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        background: '#92400e',
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 14px',
        borderRadius: 999,
        boxShadow: '0 4px 16px rgba(0,0,0,0.18), 0 0 0 1px rgba(255,255,255,0.08)',
        fontSize: 'calc(12px * var(--fs-scale-body, 1))',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      <WifiOff size={12} />
      {forced
        ? t('settings.offline.banner.forced')
        : t('settings.offline.banner.offline')}
    </div>
  )
}
