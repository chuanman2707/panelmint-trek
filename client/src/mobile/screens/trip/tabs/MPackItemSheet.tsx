import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import MSheet from '../../../components/MSheet'
import { Eyebrow, FIELD_CLS, FormSheetFooter, FormSheetHeader } from '../sheets/PlSheetChrome'
import type { PackingItem } from '../../../../types'
import type { TripPlanner } from '../MTripShell'
import { isPackingPlaceholder } from './listsModel'

export interface MPackItemSheetProps {
  planner: TripPlanner
  open: boolean
  /** The row re-derives the live item by id each render (store-update-safe), like MTransportSheet. */
  itemId: number | null
  bagTrackingEnabled: boolean
  onClose: () => void
}

/**
 * Item editor (spec 03 §4.4 `r.edit`): name, quantity, weight (bag-tracking
 * only) and a duplicate action. The three-tier sharing control went away with
 * the hosted collaboration model — a local list has nobody to share with.
 * Category and bag stay on the row itself (colour dot / bag picker), not
 * duplicated here.
 */
export default function MPackItemSheet({
  planner, open, itemId, bagTrackingEnabled, onClose,
}: MPackItemSheetProps) {
  const { t, toast, tripId, tripActions } = planner

  const liveItem = itemId != null ? planner.packingItems.find(i => i.id === itemId) ?? null : null
  const heldRef = useRef<PackingItem | null>(null)
  if (liveItem) heldRef.current = liveItem
  const item = liveItem ?? heldRef.current

  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [weight, setWeight] = useState('')
  const [saving, setSaving] = useState(false)

  // Keyed on the item id, not the object: packingSlice swaps the object on every
  // update, and a refresh must not overwrite what is being typed.
  const heldId = item?.id
  useEffect(() => {
    if (!open || !item) return
    setName(isPackingPlaceholder(item) ? '' : item.name)
    setQuantity(String(item.quantity || 1))
    setWeight(item.weight_grams != null ? String(item.weight_grams) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, heldId])

  if (!item) {
    return <MSheet open={false} onClose={onClose} />
  }

  const isPlaceholder = isPackingPlaceholder(item)

  const cloneItem = () => {
    tripActions.clonePackingItem(tripId, item.id)
    onClose()
  }

  const handleSave = async () => {
    const trimmedName = name.trim()
    setSaving(true)
    try {
      const qty = Math.max(1, Math.min(999, Number.parseInt(quantity, 10) || 1))
      const weightVal = weight.trim() === '' ? null : Math.max(0, Number.parseInt(weight, 10) || 0)
      await tripActions.updatePackingItem(tripId, item.id, {
        name: trimmedName,
        quantity: qty,
        ...(bagTrackingEnabled ? { weight_grams: weightVal } : {}),
      })
      onClose()
    } catch {
      toast.error(t('packing.toast.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <MSheet open={open} onClose={onClose} ariaLabel={t('packing.editItem')}>
      <FormSheetHeader
        title={t('packing.editItem')}
        subtitle={item.category || t('packing.defaultCategory')}
        onClose={onClose}
        closeLabel={t('common.close')}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[6px] pt-1">
        <Eyebrow className="mb-[5px] uppercase">{t('packing.itemName')}</Eyebrow>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={isPlaceholder ? t('packing.addItemPlaceholder') : undefined}
          className={FIELD_CLS}
        />

        <div className="mt-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <Eyebrow className="mb-[5px] uppercase">{t('packing.itemQuantity')}</Eyebrow>
            <input
              type="text"
              inputMode="numeric"
              value={quantity}
              onChange={e => setQuantity(e.target.value.replace(/[^0-9]/g, ''))}
              className={`${FIELD_CLS} text-center tabular-nums`}
            />
          </div>
          {bagTrackingEnabled && (
            <div className="min-w-0 flex-1">
              <Eyebrow className="mb-[5px] uppercase">{t('packing.itemWeight')}</Eyebrow>
              <input
                type="text"
                inputMode="numeric"
                value={weight}
                onChange={e => setWeight(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="—"
                className={`${FIELD_CLS} text-center tabular-nums`}
              />
            </div>
          )}
        </div>

        {!isPlaceholder && (
          <button
            type="button"
            onClick={cloneItem}
            className="mt-4 flex w-full items-center justify-center gap-[6px] rounded-full bg-[color:var(--m-ic)] px-3 py-[9px] text-[0.75rem] font-semibold text-m-muted"
          >
            <Copy size={13} strokeWidth={2} />
            {t('packing.cloneToMine')}
          </button>
        )}
      </div>

      <FormSheetFooter
        onCancel={onClose}
        cancelLabel={t('common.cancel')}
        onSubmit={handleSave}
        submitLabel={t('common.save')}
        submitDisabled={!name.trim() || saving}
      />
    </MSheet>
  )
}
