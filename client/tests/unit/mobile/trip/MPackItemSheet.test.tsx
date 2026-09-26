import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import MPackItemSheet from '../../../../src/mobile/screens/trip/tabs/MPackItemSheet'
import type { PackingItem } from '../../../../src/types'
import { buildPlanner } from '../../../helpers/mobileTrip'
import { fireEvent, render, screen, waitFor } from '../../../helpers/render'

// FE-MOB-PACKITEM-001 to FE-MOB-PACKITEM-024
//
// The sheet edits name, quantity and weight (bag tracking only) plus the
// clone action — the three-tier sharing UI is gone with the hosted
// collaboration model, so the member/share assertions went with it.

const ME = 7

function packItem(overrides: Partial<PackingItem> = {}): PackingItem {
  return {
    id: 1, trip_id: 3, name: 'Rain jacket', checked: 0, category: 'Clothing', sort_order: 0,
    quantity: 2, weight_grams: 450, is_private: 0, owner_id: ME,
    ...overrides,
  } as PackingItem
}

function setup(overrides: Partial<ComponentProps<typeof MPackItemSheet>> = {}, items: PackingItem[] = [packItem()]) {
  const planner = buildPlanner({ tripId: 3, packingItems: items })
  const props: ComponentProps<typeof MPackItemSheet> = {
    planner,
    open: true,
    itemId: 1,
    bagTrackingEnabled: true,
    onClose: vi.fn(),
    ...overrides,
  }
  const view = render(<MPackItemSheet {...props} />)
  return { ...props, planner, view }
}

describe('MPackItemSheet', () => {
  it('FE-MOB-PACKITEM-001: renders nothing without a resolvable item', () => {
    setup({ itemId: null })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('FE-MOB-PACKITEM-002: renders nothing when the id is unknown', () => {
    setup({ itemId: 99 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('FE-MOB-PACKITEM-003: prefills name, quantity and weight', () => {
    setup()
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'packing.editItem')
    expect(screen.getByText('Clothing')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Rain jacket')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2')).toBeInTheDocument()
    expect(screen.getByDisplayValue('450')).toBeInTheDocument()
  })

  it('FE-MOB-PACKITEM-004: falls back to the default category in the subtitle', () => {
    setup({}, [packItem({ category: null })])
    expect(screen.getByText('packing.defaultCategory')).toBeInTheDocument()
  })

  it('FE-MOB-PACKITEM-005: hides the weight field when bag tracking is off', () => {
    setup({ bagTrackingEnabled: false })
    expect(screen.queryByText('packing.itemWeight')).toBeNull()
    expect(screen.queryByDisplayValue('450')).toBeNull()
  })

  it('FE-MOB-PACKITEM-006: starts a placeholder row with an empty name and no clone action', () => {
    setup({}, [packItem({ name: '...', quantity: 1, weight_grams: null })])
    const name = screen.getByPlaceholderText('packing.addItemPlaceholder')
    expect(name).toHaveValue('')
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'packing.cloneToMine' })).toBeNull()
  })

  it('FE-MOB-PACKITEM-007: strips non-digits from quantity and weight', () => {
    setup()

    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '1a2' } })
    fireEvent.change(screen.getByDisplayValue('450'), { target: { value: '4x5' } })

    expect(screen.getByDisplayValue('12')).toBeInTheDocument()
    expect(screen.getByDisplayValue('45')).toBeInTheDocument()
  })

  it('FE-MOB-PACKITEM-008: saves name, clamped quantity and weight', async () => {
    const { planner, onClose } = setup()

    fireEvent.change(screen.getByDisplayValue('Rain jacket'), { target: { value: '  Poncho  ' } })
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '1500' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(planner.tripActions.updatePackingItem).toHaveBeenCalledWith(3, 1, {
      name: 'Poncho', quantity: 999, weight_grams: 450,
    })
  })

  it('FE-MOB-PACKITEM-009: treats an empty quantity as 1 and an empty weight as null', async () => {
    const { planner } = setup()

    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '' } })
    fireEvent.change(screen.getByDisplayValue('450'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(planner.tripActions.updatePackingItem).toHaveBeenCalledWith(3, 1, {
      name: 'Rain jacket', quantity: 1, weight_grams: null,
    }))
  })

  it('FE-MOB-PACKITEM-010: omits weight entirely without bag tracking', async () => {
    const { planner } = setup({ bagTrackingEnabled: false })

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(planner.tripActions.updatePackingItem).toHaveBeenCalledWith(3, 1, {
      name: 'Rain jacket', quantity: 2,
    }))
  })

  it('FE-MOB-PACKITEM-011: reports a failed save and keeps the sheet open', async () => {
    const { planner, onClose } = setup()
    const update = planner.tripActions.updatePackingItem as unknown as ReturnType<typeof vi.fn>
    update.mockRejectedValueOnce(new Error('nope'))

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(planner.toast.error).toHaveBeenCalledWith('packing.toast.saveError'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('FE-MOB-PACKITEM-012: disables save for a blank name', () => {
    setup()

    fireEvent.change(screen.getByDisplayValue('Rain jacket'), { target: { value: '   ' } })

    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled()
  })

  it('FE-MOB-PACKITEM-013: keeps rendering the last item after it disappears from the store', () => {
    const { view, planner, ...props } = setup()
    const drained = buildPlanner({ tripId: 3, packingItems: [], t: planner.t })

    view.rerender(<MPackItemSheet {...props} planner={drained} />)

    expect(screen.getByDisplayValue('Rain jacket')).toBeInTheDocument()
  })

  it('FE-MOB-PACKITEM-019: the clone action duplicates the item and closes the sheet', () => {
    const { planner, onClose } = setup()

    fireEvent.click(screen.getByRole('button', { name: 'packing.cloneToMine' }))
    expect(planner.tripActions.clonePackingItem).toHaveBeenCalledWith(3, 1)
    expect(onClose).toHaveBeenCalled()
  })

  it('FE-MOB-PACKITEM-023: closes from the header and the cancel button', () => {
    const { onClose } = setup()

    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))

    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('FE-MOB-PACKITEM-024: a store refresh of the open item keeps the typed draft', () => {
    const { view, planner, ...props } = setup()
    fireEvent.change(screen.getByDisplayValue('Rain jacket'), { target: { value: 'Rain shell' } })
    // packingSlice replaces the item object on every update, so a refresh of
    // the same id must not reseed the fields.
    const refreshed = buildPlanner({ tripId: 3, packingItems: [packItem()], t: planner.t })
    view.rerender(<MPackItemSheet {...props} planner={refreshed} />)

    expect(screen.getByDisplayValue('Rain shell')).toBeInTheDocument()
  })
})
