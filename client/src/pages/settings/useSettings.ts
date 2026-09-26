import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useAuthStore } from '../../store/authStore'

/**
 * Settings page logic — reads the app version and tracks the active tab.
 * SettingsPage stays a wiring container that builds the (t-dependent) tab
 * list and renders the tab bodies. Addons are loaded once at boot by App.tsx,
 * so there is nothing to warm up here.
 */
export function useSettings() {
  const [searchParams] = useSearchParams()

  // The build version is baked into the auth store — no app-config request left.
  const appVersion = useAuthStore(s => s.appVersion) || null
  const [activeTab, setActiveTab] = useState('display')

  // Deep link into a tab: /settings?tab=map. Lets one surface point at a
  // specific section instead of just naming the place.
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab) setActiveTab(tab)
  }, [searchParams])

  return { appVersion, activeTab, setActiveTab }
}
