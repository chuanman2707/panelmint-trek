import { Ban } from 'lucide-react'
import { getCategoryIcon } from '../../../../components/shared/categoryIcons'
import type { TripPlanner } from '../MTripShell'

interface PlCategoryPickerProps {
  planner: TripPlanner
  /** Selected category id as string, '' = no category (form convention). */
  value: string
  onChange: (categoryId: string) => void
}

const PILL_BASE =
  'flex flex-none items-center gap-[5px] rounded-full px-[11px] py-[6px] text-[0.71875rem] font-semibold'

/**
 * Category pills of the place form: "no category" + every trip category. The
 * palette is fixed in the local build — there is no category create.
 */
export default function PlCategoryPicker({ planner, value, onChange }: PlCategoryPickerProps) {
  const { t, categories } = planner

  return (
    <div className="flex flex-wrap gap-[6px]">
      <button
        type="button"
        onClick={() => onChange('')}
        className={`${PILL_BASE} ${value === '' ? 'bg-m-act text-m-actfg' : 'bg-[color:var(--m-ic)] text-m-muted'}`}
      >
        <Ban size={13} strokeWidth={2} />
        {t('places.noCategory')}
      </button>
      {(categories || []).map(cat => {
        const active = value === String(cat.id)
        const Icon = getCategoryIcon(cat.icon)
        return (
          <button
            key={cat.id}
            type="button"
            onClick={() => onChange(String(cat.id))}
            className={`${PILL_BASE} ${active ? 'bg-m-act text-m-actfg' : 'bg-[color:var(--m-ic)] text-m-muted'}`}
          >
            <Icon size={13} strokeWidth={2} />
            {cat.name}
          </button>
        )
      })}
    </div>
  )
}
