import React, { useMemo, useState } from 'react'
import { Sparkles, Save } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import Section from './Section'
import ToggleSwitch from './ToggleSwitch'
import CustomSelect from '../shared/CustomSelect'

type Provider = 'openai' | 'anthropic'

/**
 * Settings → Integrations → AI parsing.
 *
 * PanelMint has no server, so the LLM booking-import feature is gone with it —
 * the llm_* settings keys were pruned and nothing here persists. The section
 * is inert UI pending removal with the rest of the cut feature surface
 * (its mount is gated on the llm_parsing addon flag, which the static addon
 * set never enables).
 */
export default function LlmConnectionSection(): React.ReactElement {
  const { t } = useTranslation()
  const toast = useToast()

  const [provider, setProvider] = useState<Provider>('openai')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [multimodal, setMultimodal] = useState(false)
  const [saving, setSaving] = useState(false)

  const providerOptions = useMemo(
    () => [
      { value: 'openai', label: t('settings.aiParsing.providerOpenai') },
      { value: 'anthropic', label: t('settings.aiParsing.providerAnthropic') },
    ],
    [t],
  )

  const handleSave = async () => {
    // There is no backing store for these fields any more; surface the refusal
    // instead of pretending the form saved.
    setSaving(true)
    try {
      toast.error(t('settings.aiParsing.toast.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title={t('settings.aiParsing.title')} icon={Sparkles}>
      <div className="space-y-3">
        <p className="text-xs text-content-secondary">{t('settings.aiParsing.hint')}</p>

        <div>
          <label className="block text-sm font-medium mb-1.5 text-content-secondary">{t('settings.aiParsing.provider')}</label>
          <CustomSelect
            value={provider}
            onChange={v => setProvider(v as Provider)}
            options={providerOptions}
          />
          <p className="mt-1 text-xs text-content-faint">{t('settings.aiParsing.localAdminOnly')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5 text-content-secondary">{t('settings.aiParsing.model')}</label>
          <input
            type="text"
            autoComplete="off"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="qwen3:8b"
            className="w-full px-3 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 border-edge bg-surface-secondary text-content"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5 text-content-secondary">{t('settings.aiParsing.apiKey')}</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            autoComplete="off"
            placeholder={t('settings.aiParsing.apiKey')}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 border-edge bg-surface-secondary text-content"
          />
          <p className="mt-1 text-xs text-content-faint">{t('settings.aiParsing.apiKeyHint')}</p>
        </div>

        <div>
          <div className="flex items-center gap-3">
            <ToggleSwitch on={multimodal} onToggle={() => setMultimodal(v => !v)} />
            <span className="text-sm font-medium text-content-secondary">{t('settings.aiParsing.multimodal')}</span>
          </div>
          <p className="mt-1 text-xs text-content-faint">{t('settings.aiParsing.multimodalHint')}</p>
        </div>

        <button type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-slate-900 hover:bg-slate-700 disabled:opacity-50"
        >
          <Save className="w-4 h-4" /> {t('common.save')}
        </button>
      </div>
    </Section>
  )
}
