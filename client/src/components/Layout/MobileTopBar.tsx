import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { Settings } from 'lucide-react'

// Mobile-only: a slim strip at the very top of the dashboard with the
// profile icon (right-aligned). Scrolls with the page.
export default function MobileTopBar() {
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const [showProfile, setShowProfile] = useState(false)

  return (
    <>
      <div
        className="md:hidden flex items-center justify-end gap-2 px-4"
        style={{ paddingTop: 'calc(10px + env(safe-area-inset-top, 0px))', paddingBottom: 10 }}
      >
        <button type="button"
          onClick={() => setShowProfile(true)}
          aria-label={t('nav.profile')}
          className="grid place-items-center rounded-full text-white font-semibold text-[12px] active:scale-95 transition-transform"
          style={{ width: 34, height: 34, background: 'linear-gradient(135deg, oklch(0.7 0.14 38), oklch(0.55 0.13 25))' }}
        >
          {(user?.username || '?')[0].toUpperCase()}
        </button>
      </div>

      {showProfile && createPortal(<ProfileSheet onClose={() => setShowProfile(false)} />, document.body)}
    </>
  )
}

function ProfileSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const navigate = useNavigate()

  const handleNav = (path: string) => { onClose(); navigate(path) }

  return (
    <div className="fixed inset-0 z-[300] md:hidden" role="presentation" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="absolute bottom-0 left-0 right-0 bg-white dark:bg-zinc-900 rounded-t-2xl overflow-hidden"
        style={{ animation: 'slideUp 0.25s ease-out', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        role="presentation"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>

        <div className="px-6 pb-4 pt-1">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 flex items-center justify-center text-[16px] font-bold">
              {(user?.username || '?')[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-semibold text-zinc-900 dark:text-white">{user?.username}</p>
              <p className="text-[12px] text-zinc-500 truncate">{user?.email}</p>
            </div>
          </div>
        </div>

        <div className="h-px bg-zinc-100 dark:bg-zinc-800 mx-4" />

        <div className="py-2 px-2">
          <button type="button"
            onClick={() => handleNav('/settings')}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 active:bg-zinc-100 dark:active:bg-zinc-800 transition-colors"
          >
            <Settings size={18} className="text-zinc-500" />
            <span className="text-[14px] font-medium text-zinc-900 dark:text-white">{t('nav.bottomSettings')}</span>
          </button>
        </div>

        <div className="h-4" />
      </div>
    </div>
  )
}
