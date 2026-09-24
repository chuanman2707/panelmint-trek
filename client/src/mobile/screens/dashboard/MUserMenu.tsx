import React from 'react'
import { useNavigate } from 'react-router'
import { Moon, Settings2, Sun, SunMoon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { useAuthStore } from '../../../store/authStore'
import { useSettingsStore } from '../../../store/settingsStore'
import MDropdownPanel from '../../components/MDropdownPanel'
import MListRow from '../../components/MListRow'

type ThemeMode = 'dark' | 'light' | 'auto'

const THEME_ICON: Record<ThemeMode, LucideIcon> = {
  dark: Moon,
  light: Sun,
  auto: SunMoon,
}

// dark_mode is boolean in old accounts and 'light' | 'dark' | 'auto' since the
// setting grew the auto state — normalize before cycling.
function resolveMode(darkMode: boolean | string | undefined): ThemeMode {
  if (darkMode === true || darkMode === 'dark') return 'dark'
  if (darkMode === 'auto') return 'auto'
  return 'light'
}

const NEXT_MODE: Record<ThemeMode, ThemeMode> = { dark: 'light', light: 'auto', auto: 'dark' }

interface MUserMenuProps {
  open: boolean
  onClose: () => void
}

/**
 * Avatar popover of the mobile top bar: profile header, settings, and the
 * dark/light/auto theme cycle. There is no sign-out — the local profile never
 * ends a session.
 */
export default function MUserMenu({ open, onClose }: MUserMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const darkMode = useSettingsStore(s => s.settings.dark_mode)
  const updateSetting = useSettingsStore(s => s.updateSetting)

  const mode = resolveMode(darkMode)
  const ThemeIcon = THEME_ICON[mode]
  const modeLabel = t(`settings.${mode}`)

  const go = (path: string) => { onClose(); navigate(path) }
  const cycleTheme = () => { updateSetting('dark_mode', NEXT_MODE[mode]).catch(() => {}) }

  return (
    <MDropdownPanel open={open} onClose={onClose} className="right-4 top-[calc(var(--m-safe-top,12px)+68px)]">
      <div className="flex items-center gap-[10px] p-[10px_10px_12px]">
        <span className="flex h-10 w-10 flex-none items-center justify-center overflow-hidden rounded-full bg-[image:linear-gradient(135deg,#6A6A74,#1A1A1E)] text-[0.9375rem] font-bold text-white">
          {user?.avatar_url
            ? <img src={user.avatar_url} alt="" className="h-full w-full object-cover" />
            : (user?.username || '?')[0].toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[6px]">
            <span className="truncate text-[0.875rem] font-bold">{user?.username}</span>
          </div>
          <div className="truncate font-geist text-[0.65625rem] text-m-muted">{user?.email}</div>
        </div>
      </div>
      <MListRow icon={Settings2} label={t('nav.bottomSettings')} onClick={() => go('/settings')} />
      <MListRow
        icon={ThemeIcon}
        label={t('settings.colorMode')}
        onClick={cycleTheme}
        trailing={<span className="flex-none font-geist text-[0.65625rem] text-m-muted">{modeLabel}</span>}
      />
    </MDropdownPanel>
  )
}
