import React from 'react'
import { Settings, SlidersHorizontal, Paintbrush, Map, Database, Info } from 'lucide-react'
import { useTranslation } from '../i18n'
import PageShell from '../components/Layout/PageShell'
import PageSidebar, { type PageSidebarTab } from '../components/Layout/PageSidebar'
import DisplaySettingsTab from '../components/Settings/DisplaySettingsTab'
import AppearanceSettingsTab from '../components/Settings/AppearanceSettingsTab'
import MapSettingsTab from '../components/Settings/MapSettingsTab'
import DataSettingsTab from '../components/Settings/DataSettingsTab'
import AboutTab from '../components/Settings/AboutTab'
import { useSettings } from './settings/useSettings'

export default function SettingsPage(): React.ReactElement {
  // ViewportRoute in App.tsx picks the branch now, so the phone screen is a
  // chunk of its own instead of a dead limb in this one.
  return <SettingsPageDesktop />
}

function SettingsPageDesktop(): React.ReactElement {
  const { t } = useTranslation()
  // Page = wiring container: version + active-tab state live in the hook.
  const { appVersion, activeTab, setActiveTab } = useSettings()

  const tabs: PageSidebarTab[] = [
    { id: 'display', label: t('settings.tabs.display'), icon: SlidersHorizontal },
    { id: 'appearance', label: t('settings.tabs.appearance'), icon: Paintbrush },
    { id: 'map', label: t('settings.tabs.map'), icon: Map },
    { id: 'data', label: t('settings.tabs.data'), icon: Database },
    ...(appVersion
      ? [{ id: 'about', label: t('settings.tabs.about'), icon: Info }]
      : []),
  ]

  return (
    <PageShell background="var(--bg-secondary)">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-surface-tertiary">
              <Settings className="w-5 h-5 text-content-secondary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-content">{t('settings.title')}</h1>
              <p className="text-sm text-content-muted">{t('settings.subtitle')}</p>
            </div>
          </div>

          {/* Sidebar layout */}
          <PageSidebar
            sidebarLabel={t('settings.title').toUpperCase()}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            footer={appVersion ? `v${appVersion}` : ''}
          >
            {activeTab === 'display' && <DisplaySettingsTab />}
            {activeTab === 'appearance' && <AppearanceSettingsTab />}
            {activeTab === 'map' && <MapSettingsTab />}
            {activeTab === 'data' && <DataSettingsTab />}
            {activeTab === 'about' && appVersion && <AboutTab appVersion={appVersion} />}
          </PageSidebar>
        </div>
    </PageShell>
  )
}
