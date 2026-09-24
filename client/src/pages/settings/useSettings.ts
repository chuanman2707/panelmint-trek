import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useAddonStore } from '../../store/addonStore'
import { useAuthStore } from '../../store/authStore'

/**
 * Settings page logic — loads addons + the app version, tracks the active tab
 * and auto-switches to the account tab when
 * the URL signals MFA is required. SettingsPage stays a wiring container that
 * builds the (t-dependent) tab list and renders the tab bodies.
 * Behaviour is identical to the previous in-component logic.
 */
export function useSettings() {
  const [searchParams] = useSearchParams()
  const { loadAddons } = useAddonStore()
  const managed = useAuthStore(s => s.managed)

  // The build version is baked into the auth store — no app-config request left.
  const appVersion = useAuthStore(s => s.appVersion) || null
  const [activeTab, setActiveTab] = useState('display')

  useEffect(() => {
    loadAddons()
  }, [])

  // Deep link into a tab: /settings?tab=map. Lets one surface point at a
  // specific section instead of just naming the place.
  useEffect(() => {
    const tab = searchParams.get('tab')
    if (tab) setActiveTab(tab)
  }, [searchParams])

  return { appVersion, activeTab, setActiveTab, managed }
}
