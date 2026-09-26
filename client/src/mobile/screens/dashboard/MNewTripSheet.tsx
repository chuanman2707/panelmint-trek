import React, { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, X } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import { tripsApi } from '../../../api/client'
import { useCanDo } from '../../../store/permissionsStore'
import { useSettingsStore } from '../../../store/settingsStore'
import { useToast } from '../../../components/shared/Toast'
import { CustomDatePicker } from '../../../components/shared/CustomDateTimePicker'
import CustomSelect from '../../../components/shared/CustomSelect'
import { currenciesWith, SYMBOLS } from '../../../components/Budget/BudgetPanel.constants'
import type { DashboardTrip } from '../../../pages/dashboard/dashboardModel'
import { MAX_TRIP_DAYS, tripSpanDays, type Trip, type TripCreateRequest } from '@trek/shared'
import MSheet from '../../components/MSheet'
import MIconBtn from '../../components/MIconBtn'
import MListRow from '../../components/MListRow'

interface MNewTripSheetProps {
  open: boolean
  /** null = create, otherwise edit */
  trip: DashboardTrip | null
  onClose: () => void
  onSave: (data: TripCreateRequest) => Promise<{ trip?: Trip } | void> | void
  /** Edit mode only: archives (or restores) the trip — the grid cards have no archive button. */
  onArchive?: () => void
}

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="font-geist text-[0.5625rem] font-bold uppercase tracking-[.1em] text-m-faint">{children}</div>
  )
}

/**
 * Create/edit trip sheet — the mobile counterpart of TripFormModal's core flow:
 * title and date range. Archiving lives here in edit mode, as decided for the
 * grid cards.
 */
export default function MNewTripSheet({ open, trip, onClose, onSave, onArchive }: MNewTripSheetProps): React.ReactElement {
  const isEditing = !!trip
  const { t } = useTranslation()
  const toast = useToast()
  const can = useCanDo()
  const defaultCurrency = useSettingsStore(s => s.settings.default_currency) || 'EUR'
  const canEditTrip = !isEditing || can('trip_edit', trip)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const [error, setError] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(trip?.title || '')
    setDescription(trip?.description || '')
    setStartDate(trip?.start_date || '')
    setEndDate(trip?.end_date || '')
    setCurrency(trip?.currency || defaultCurrency)
    setError('')
  }, [trip, open])

  // Moving the start keeps the trip length (same rule as TripFormModal).
  const changeStart = (value: string) => {
    if (value && endDate && startDate && endDate >= startDate) {
      const duration = Math.round((new Date(endDate + 'T00:00:00Z').getTime() - new Date(startDate + 'T00:00:00Z').getTime()) / 86400000)
      const newEnd = new Date(value + 'T00:00:00Z')
      newEnd.setDate(newEnd.getDate() + duration)
      setEndDate(newEnd.toISOString().split('T')[0])
    } else if (value && (!endDate || endDate < value)) {
      setEndDate(value)
    }
    setStartDate(value)
  }

  const handleSave = async () => {
    setError('')
    if (!title.trim()) { setError(t('dashboard.titleRequired')); return }
    if (startDate && endDate) {
      const span = tripSpanDays(startDate, endDate)
      if (span < 1) { setError(t('dashboard.endDateError')); return }
      const datesTouched = !trip || startDate !== (trip.start_date || '') || endDate !== (trip.end_date || '')
      if (datesTouched && span > MAX_TRIP_DAYS) { setError(t('dashboard.tripTooLong', { days: MAX_TRIP_DAYS })); return }
    }
    setIsSaving(true)
    try {
      const result = await onSave({
        title: title.trim(),
        description: description.trim() || null,
        start_date: startDate || null,
        end_date: endDate || null,
        currency,
        ...(!startDate && !endDate && !isEditing ? { day_count: 7 } : {}),
      })
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('places.saveError'))
    } finally {
      setIsSaving(false)
    }
  }

  const boxCls = 'rounded-[14px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-[11px_12px]'
  const inputCls = 'w-full border-none bg-transparent pt-[2px] font-[inherit] text-[0.9375rem] font-semibold text-m-ink outline-none placeholder:text-m-faint'

  return (
    <MSheet open={open} onClose={onClose} variant="card" material="opaque" ariaLabel={isEditing ? t('dashboard.editTrip') : t('dashboard.createTrip')}>
      <div className="flex items-center gap-[11px] p-[16px_16px_0]">
        <div className="min-w-0 flex-1 truncate text-[1.0625rem] font-bold">
          {isEditing ? t('dashboard.editTrip') : t('dashboard.createTrip')}
        </div>
        <MIconBtn ariaLabel={t('common.cancel')} variant="neutral" size={34} onClick={onClose}>
          <X size={16} strokeWidth={2.2} />
        </MIconBtn>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded-[14px] bg-[color:var(--m-ic)] p-[11px_12px] text-[0.75rem] font-semibold text-[color:var(--m-st-danger)]">
            {error}
          </div>
        )}

        <div className={boxCls}>
          <FieldLabel>{t('dashboard.tripTitle')}</FieldLabel>
          <input
            value={title}
            onChange={e => canEditTrip && setTitle(e.target.value)}
            readOnly={!canEditTrip}
            placeholder={t('dashboard.tripTitlePlaceholder')}
            className={inputCls}
          />
        </div>

        <div className={`${boxCls} mt-2`}>
          <FieldLabel>{t('dashboard.tripDescription')}</FieldLabel>
          <textarea
            value={description}
            onChange={e => canEditTrip && setDescription(e.target.value)}
            readOnly={!canEditTrip}
            placeholder={t('dashboard.tripDescriptionPlaceholder')}
            rows={2}
            className={`${inputCls} resize-none text-[0.8125rem] font-medium`}
          />
        </div>

        <div className="mt-2 flex gap-2">
          <div className={`${boxCls} min-w-0 flex-1`}>
            <FieldLabel>{t('dashboard.startDate')}</FieldLabel>
            <CustomDatePicker
              value={startDate}
              onChange={v => { if (canEditTrip) changeStart(v) }}
              placeholder={t('dashboard.startDate')}
              borderless
              style={{ marginTop: 3 }}
            />
          </div>
          <div className={`${boxCls} min-w-0 flex-1`}>
            <FieldLabel>{t('dashboard.endDate')}</FieldLabel>
            <CustomDatePicker
              value={endDate}
              onChange={v => { if (canEditTrip) setEndDate(v) }}
              placeholder={t('dashboard.endDate')}
              borderless
              style={{ marginTop: 3 }}
            />
          </div>
        </div>
        {!isEditing && !startDate && !endDate && (
          <div className="mt-[6px] px-1 font-geist text-[0.625rem] text-m-faint">{t('dashboard.noDateHint')}</div>
        )}

        <div className="mt-2">
          <FieldLabel>{t('dashboard.currency')}</FieldLabel>
          <CustomSelect
            value={currency}
            onChange={v => { if (canEditTrip) setCurrency(String(v)) }}
            disabled={!canEditTrip}
            searchable
            size="sm"
            options={currenciesWith(currency).map(c => ({ value: c, label: `${c} (${SYMBOLS[c] || c})` }))}
            style={{ width: '100%', marginTop: 5 }}
          />
        </div>

        {isEditing && onArchive && (
          <div className="mt-2 rounded-[14px] bg-[color:var(--m-ic)]">
            <MListRow
              icon={trip?.is_archived ? ArchiveRestore : Archive}
              label={trip?.is_archived ? t('dashboard.restore') : t('dashboard.archive')}
              onClick={() => { onArchive(); onClose() }}
            />
          </div>
        )}
      </div>

      <div className="flex gap-2 p-[0_16px_16px]">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-full bg-[color:var(--m-ic)] py-[10px] text-[0.8125rem] font-semibold text-m-ink"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex-1 rounded-full bg-m-act py-[10px] text-[0.8125rem] font-semibold text-m-actfg disabled:opacity-50"
        >
          {isSaving ? t('common.saving') : isEditing ? t('common.update') : t('dashboard.createTrip')}
        </button>
      </div>
    </MSheet>
  )
}
