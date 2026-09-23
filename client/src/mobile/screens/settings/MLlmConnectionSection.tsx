import React, { useMemo, useState } from 'react'
import { Sparkles, Save, ChevronDown } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { useToast } from '../../../components/shared/Toast'
import { MSetCard, MSetEyebrow, MSetSelectRow, MSetRow, MSetInput, MSetButton, MSetHint } from './MSettingsUi'
import MToggle from '../../components/MToggle'
import MSetPickerSheet from './MSetPickerSheet'

type Provider = 'openai' | 'anthropic'

/**
 * Mobile-native twin of components/Settings/LlmConnectionSection.
 *
 * PanelMint has no server, so the LLM booking-import feature is gone with it —
 * the llm_* settings keys were pruned and nothing here persists. The section
 * is inert UI pending removal with the rest of the cut feature surface (its
 * mount is gated on the llm_parsing addon flag, which the static addon set
 * never enables).
 */
export default function MLlmConnectionSection(): React.ReactElement {
  const { t } = useTranslation()
  const toast = useToast()

  const [provider, setProvider] = useState<Provider>('openai')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [multimodal, setMultimodal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)

  const providerOptions = useMemo(
    () => [
      { value: 'openai', label: t('settings.aiParsing.providerOpenai') },
      { value: 'anthropic', label: t('settings.aiParsing.providerAnthropic') },
    ],
    [t],
  )
  const providerLabel = providerOptions.find(o => o.value === provider)?.label ?? provider

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
    <MSetCard title={t('settings.aiParsing.title')} icon={Sparkles} className="mt-3">
      <MSetHint className="mb-3">{t('settings.aiParsing.hint')}</MSetHint>

      <MSetEyebrow className="mb-[5px]">{t('settings.aiParsing.provider')}</MSetEyebrow>
      <MSetSelectRow
        label={providerLabel}
        trailing={<ChevronDown size={13} strokeWidth={2} className="flex-none text-m-faint" />}
        onClick={() => setProviderOpen(true)}
      />
      <MSetHint>{t('settings.aiParsing.localAdminOnly')}</MSetHint>

      <MSetEyebrow className="mb-[5px] mt-[14px]">{t('settings.aiParsing.model')}</MSetEyebrow>
      <MSetInput
        type="text"
        autoComplete="off"
        value={model}
        onChange={e => setModel(e.target.value)}
        placeholder="qwen3:8b"
      />

      <MSetEyebrow className="mb-[5px] mt-[14px]">{t('settings.aiParsing.apiKey')}</MSetEyebrow>
      <MSetInput
        type="password"
        value={apiKey}
        onChange={e => setApiKey(e.target.value)}
        autoComplete="off"
        placeholder={t('settings.aiParsing.apiKey')}
      />
      <MSetHint>{t('settings.aiParsing.apiKeyHint')}</MSetHint>

      <div className="mt-3">
        <MSetRow
          first
          label={t('settings.aiParsing.multimodal')}
          sub={t('settings.aiParsing.multimodalHint')}
          trailing={
            <MToggle
              checked={multimodal}
              onChange={() => setMultimodal(v => !v)}
              ariaLabel={t('settings.aiParsing.multimodal')}
            />
          }
        />
      </div>

      <div className="mt-3">
        <MSetButton variant="primary" onClick={handleSave} disabled={saving}>
          <Save size={14} /> {t('common.save')}
        </MSetButton>
      </div>

      <MSetPickerSheet
        open={providerOpen}
        onClose={() => setProviderOpen(false)}
        title={t('settings.aiParsing.provider')}
        value={provider}
        onSelect={v => setProvider(v as Provider)}
        options={providerOptions}
      />
    </MSetCard>
  )
}
