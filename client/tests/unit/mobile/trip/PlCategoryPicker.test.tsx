import { describe, expect, it, vi } from 'vitest'
import PlCategoryPicker from '../../../../src/mobile/screens/trip/sheets/PlCategoryPicker'
import type { Category } from '../../../../src/types'
import type { TripPlanner } from '../../../../src/mobile/screens/trip/MTripShell'
import { buildPlanner } from '../../../helpers/mobileTrip'
import { fireEvent, render, screen } from '../../../helpers/render'

// planner.t echoes the key, so every visible label is asserted as its key.

const CATEGORIES = [
  { id: 3, name: 'Food', color: '#ef4444', icon: 'Coffee', user_id: 1 },
  { id: 4, name: 'Museums', color: '#22c55e', icon: 'Landmark', user_id: 1 },
] as unknown as Category[]

function setup(plannerOverrides: Partial<TripPlanner> = {}, value = '') {
  const onChange = vi.fn()
  const planner = buildPlanner({ categories: CATEGORIES, ...plannerOverrides })
  const view = render(<PlCategoryPicker planner={planner} value={value} onChange={onChange} />)
  return { ...view, planner, onChange }
}

describe('PlCategoryPicker', () => {
  it('FE-MOB-PLCAT-001: renders the no-category pill plus one pill per trip category', () => {
    setup()
    expect(screen.getByRole('button', { name: /places\.noCategory/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Food/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Museums/ })).toBeInTheDocument()
    // The local palette is fixed — no create affordance.
    expect(screen.queryByRole('button', { name: /mobileTrip\.newCategory/ })).not.toBeInTheDocument()
  })

  it('FE-MOB-PLCAT-002: marks the no-category pill active for the empty value', () => {
    setup()
    expect(screen.getByRole('button', { name: /places\.noCategory/ }).className).toContain('bg-m-act')
    expect(screen.getByRole('button', { name: /Food/ }).className).not.toContain('bg-m-act')
  })

  it('FE-MOB-PLCAT-003: marks the pill of the selected id active', () => {
    setup({}, '4')
    expect(screen.getByRole('button', { name: /Museums/ }).className).toContain('bg-m-act')
    expect(screen.getByRole('button', { name: /places\.noCategory/ }).className).not.toContain('bg-m-act')
  })

  it('FE-MOB-PLCAT-004: reports the picked category id as a string', () => {
    const { onChange } = setup({}, '')
    fireEvent.click(screen.getByRole('button', { name: /Food/ }))
    expect(onChange).toHaveBeenCalledWith('3')
  })

  it('FE-MOB-PLCAT-005: reports the empty value when the category is cleared', () => {
    const { onChange } = setup({}, '3')
    fireEvent.click(screen.getByRole('button', { name: /places\.noCategory/ }))
    expect(onChange).toHaveBeenCalledWith('')
  })
})
