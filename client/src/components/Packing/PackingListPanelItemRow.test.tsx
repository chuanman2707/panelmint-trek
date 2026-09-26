// FE-W5ROW-001 to FE-W5ROW-056
//
// Packing writes run on the Dexie-backed local adapter — no HTTP to mock.
// Write-path tests spy on `packingRepo` for the call arguments (what the
// request body used to carry) and let the write land in `panelmintDb`.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, waitFor, within } from '../../../tests/helpers/render'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { buildUser, buildTrip, buildPackingItem } from '../../../tests/helpers/factories'
import { useAuthStore } from '../../store/authStore'
import { useTripStore } from '../../store/tripStore'
import { db } from '../../db/panelmintDb'
import { packingRepo } from '../../repo/packingRepo'
import { ArtikelZeile } from './PackingListPanelItemRow'
import type { PackingBag, PackingItem } from '../../types'

type Props = ComponentProps<typeof ArtikelZeile>

const toastSpy = vi.fn((_message: string, _type?: string, _duration?: number) => 0)

const BAGS = [
  { id: 7, name: 'Carry-on', color: '#10b981' },
  { id: 8, name: 'Trolley', color: '#ec4899' },
] as unknown as PackingBag[]

const dt = () => ({ effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') })

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    item: buildPackingItem({ id: 1, name: 'Tent', category: 'Gear' }),
    tripId: 1,
    categories: ['Gear', 'Docs'],
    onCategoryChange: () => {},
    onCreateBag: vi.fn(async () => undefined),
    ...overrides,
  }
  // The adapter 404s on an item that is not in Dexie and rejects bag_id for a
  // bag the trip does not own. Issued synchronously, the puts' implicit
  // transactions are queued before any transaction the row's click handlers
  // start later — IndexedDB runs overlapping transactions in creation order,
  // so the seed always lands first.
  void db.packingItems.put(props.item)
  props.bags?.forEach((b, i) => {
    void db.packingBags.put({
      id: b.id,
      trip_id: props.tripId,
      name: b.name,
      color: b.color ?? null,
      weight_limit_grams: b.weight_limit_grams ?? null,
      sort_order: i,
      created_at: '2025-01-01T00:00:00.000Z',
    })
  })
  const utils = render(<ArtikelZeile {...props} />)
  return { ...utils, props }
}

/** The row's own overflow menu trigger (rendered but display:none on desktop). */
function overflowTrigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('.packing-row-overflow button')!
}

/**
 * The overflow menu lives inside a display:none wrapper (it only shows on narrow
 * viewports), so every query against it has to opt into hidden elements.
 */
function menu(container: HTMLElement) {
  return within(container.querySelector<HTMLElement>('.trek-menu-enter')!)
}

function menuButton(container: HTMLElement, name: string) {
  return menu(container).getByRole('button', { name, hidden: true })
}

function fieldOf(container: HTMLElement, label: string) {
  return within(menu(container).getByText(label).parentElement!).getByRole('textbox', { hidden: true })
}

function bagButton(container: HTMLElement) {
  // The bag picker trigger is the round button right after the weight field.
  return container.querySelectorAll<HTMLButtonElement>('button[style*="border-radius: 50%"]')[0]
}

beforeEach(async () => {
  resetAllStores()
  toastSpy.mockClear()
  window.__addToast = toastSpy
  // Self (id 1) owns trip 1 — the roster the local adapters scope access by.
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'owner', is_self: 1 })
  await db.trips.put(buildTrip({ id: 1, user_id: 1 }))
  seedStore(useAuthStore, { user: buildUser({ id: 1 }), isAuthenticated: true })
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }) })
})

afterEach(() => {
  delete window.__addToast
  vi.restoreAllMocks()
})

describe('ArtikelZeile — basics', () => {
  it('FE-W5ROW-001: renders the name and checks the item off', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup()

    expect(screen.getByText('Tent')).toBeInTheDocument()
    fireEvent.click(container.querySelector('svg.lucide-square')!.closest('button')!)

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { checked: true }))
    expect((await db.packingItems.get(1))!.checked).toBe(1)
  })

  it('FE-W5ROW-002: a checked item is struck through and not editable by click', () => {
    setup({ item: buildPackingItem({ id: 1, name: 'Tent', checked: 1 }) })
    const label = screen.getByText('Tent')

    expect(label).toHaveStyle({ textDecoration: 'line-through' })
    fireEvent.click(label)

    expect(screen.queryByDisplayValue('Tent')).toBeNull()
  })

  it('FE-W5ROW-003: the placeholder row edits from an empty field', () => {
    setup({ item: buildPackingItem({ id: 1, name: '...', category: 'Gear' }) })

    fireEvent.click(screen.getByText('...'))

    const input = screen.getByPlaceholderText('...')
    expect(input).toHaveValue('')
  })

  it('FE-W5ROW-004: a read-only row hides the quantity field and the action buttons', () => {
    const { container } = setup({ canEdit: false })

    expect(screen.queryByTitle('Rename')).toBeNull()
    expect(screen.queryByTitle('Delete')).toBeNull()
    expect(container.querySelector('.packing-row-overflow')).toBeNull()
    fireEvent.click(screen.getByText('Tent'))
    expect(screen.queryByDisplayValue('Tent')).toBeNull()
  })

  it('FE-W5ROW-005: hovering the row lifts its background and dismisses open pickers', () => {
    const { container } = setup()
    const row = container.querySelector<HTMLElement>('.packing-item-row')!

    fireEvent.mouseEnter(row)
    expect(row.style.background).toBe('var(--bg-secondary)')

    fireEvent.click(screen.getByTitle('Move to List'))
    expect(screen.getByRole('button', { name: 'Docs' })).toBeInTheDocument()

    fireEvent.mouseLeave(row)
    expect(row.style.background).toBe('transparent')
    expect(screen.queryByRole('button', { name: 'Docs' })).toBeNull()
  })
})

describe('ArtikelZeile — quantity', () => {
  it('FE-W5ROW-005a: committing the inline quantity saves it', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ item: buildPackingItem({ id: 1, name: 'Tent', quantity: null } as Partial<PackingItem>) })

    const qty = container.querySelector<HTMLInputElement>('.packing-row-inline-actions input')!
    expect(qty).toHaveValue('1')
    fireEvent.change(qty, { target: { value: '3' } })
    fireEvent.blur(qty)

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { quantity: 3 }))
  })
})

describe('ArtikelZeile — renaming', () => {
  it('FE-W5ROW-006: Enter commits the new name', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    setup()
    fireEvent.click(screen.getByTitle('Rename'))

    const input = screen.getByDisplayValue('Tent')
    fireEvent.change(input, { target: { value: '  Tarp  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { name: 'Tarp' }))
    expect((await db.packingItems.get(1))!.name).toBe('Tarp')
  })

  it('FE-W5ROW-007: blurring an emptied field restores the old name', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    setup()
    fireEvent.click(screen.getByTitle('Rename'))

    const input = screen.getByDisplayValue('Tent')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.queryByDisplayValue('Tent')).toBeNull())
    expect(screen.getByText('Tent')).toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-008: Escape discards the edit', () => {
    setup()
    fireEvent.click(screen.getByText('Tent'))

    const input = screen.getByDisplayValue('Tent')
    fireEvent.change(input, { target: { value: 'Tarp' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByDisplayValue('Tarp')).toBeNull()
    expect(screen.getByText('Tent')).toBeInTheDocument()
  })

  it('FE-W5ROW-008a: a blanked placeholder row falls back to an empty field', async () => {
    setup({ item: buildPackingItem({ id: 1, name: '...', category: 'Gear' }) })
    fireEvent.click(screen.getByText('...'))

    const input = screen.getByPlaceholderText('...')
    fireEvent.change(input, { target: { value: 'Tent' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.click(screen.getByText('...'))
    expect(screen.getByPlaceholderText('...')).toHaveValue('')

    fireEvent.change(screen.getByPlaceholderText('...'), { target: { value: '   ' } })
    fireEvent.blur(screen.getByPlaceholderText('...'))

    await waitFor(() => expect(screen.getByText('...')).toBeInTheDocument())
  })

  it('FE-W5ROW-009: a failing rename surfaces a save error', async () => {
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    setup()
    fireEvent.click(screen.getByTitle('Rename'))

    fireEvent.change(screen.getByDisplayValue('Tent'), { target: { value: 'Tarp' } })
    fireEvent.keyDown(screen.getByDisplayValue('Tarp'), { key: 'Enter' })

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })
})

describe('ArtikelZeile — deleting', () => {
  it('FE-W5ROW-010: the panel handler takes over when provided', async () => {
    const onDelete = vi.fn(async () => {})
    const { props } = setup({ onDelete })

    fireEvent.click(screen.getByTitle('Delete'))

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(props.item))
  })

  it('FE-W5ROW-011: a standalone row deletes through the store', async () => {
    const del = vi.spyOn(packingRepo, 'delete')
    setup()

    fireEvent.click(screen.getByTitle('Delete'))

    await waitFor(() => expect(del).toHaveBeenCalledWith(1, 1))
    expect(await db.packingItems.get(1)).toBeUndefined()
  })

  it('FE-W5ROW-012: a failing standalone delete surfaces a delete error', async () => {
    vi.spyOn(packingRepo, 'delete').mockRejectedValue(new Error('boom'))
    setup()

    fireEvent.click(screen.getByTitle('Delete'))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to delete', 'error', undefined))
  })

  it('FE-W5ROW-013: the rename and delete buttons highlight on hover', () => {
    setup()
    const rename = screen.getByTitle('Rename')
    const remove = screen.getByTitle('Delete')

    fireEvent.mouseEnter(rename)
    expect(rename.style.color).toBe('var(--text-secondary)')
    fireEvent.mouseLeave(rename)
    expect(rename.style.color).toBe('var(--text-faint)')

    fireEvent.mouseEnter(remove)
    expect(remove.style.color).toBe('rgb(239, 68, 68)')
    fireEvent.mouseLeave(remove)
    expect(remove.style.color).toBe('var(--text-faint)')
  })
})

describe('ArtikelZeile — category picker', () => {
  it('FE-W5ROW-014: picking another list moves the item', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    setup()
    fireEvent.click(screen.getByTitle('Move to List'))

    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { category: 'Docs' }))
    expect(screen.queryByRole('button', { name: 'Docs' })).toBeNull()
  })

  it('FE-W5ROW-015: picking the current list closes the picker without a write', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    setup()
    fireEvent.click(screen.getByTitle('Move to List'))

    fireEvent.click(screen.getByRole('button', { name: 'Gear' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Docs' })).toBeNull())
    expect(update).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-016: a failing move surfaces a generic error', async () => {
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    setup()
    fireEvent.click(screen.getByTitle('Move to List'))

    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Error', 'error', undefined))
  })

  it('FE-W5ROW-017: an uncategorized item marks the default list as current', () => {
    setup({
      item: buildPackingItem({ id: 1, name: 'Soap', category: null }),
      categories: ['Other', 'Gear'],
    })
    fireEvent.click(screen.getByTitle('Move to List'))

    expect(screen.getByRole('button', { name: 'Other' })).toHaveStyle({ background: 'var(--bg-tertiary)' })
    expect(screen.getByRole('button', { name: 'Gear' })).not.toHaveStyle({ background: 'var(--bg-tertiary)' })
  })
})

// The sharing badges and the per-item share control left with the hosted
// sharing surface — there is no multi-user ownership to badge locally.

describe('ArtikelZeile — drag handle', () => {
  const drag = () => ({
    isDragging: false,
    isOver: false,
    onStart: vi.fn((_id: number) => {}),
    onOver: vi.fn((_id: number) => {}),
    onEnd: vi.fn(() => {}),
    onDrop: vi.fn((_id: number) => {}),
  })

  it('FE-W5ROW-025: starting and ending a drag reports the item id', () => {
    const d = drag()
    const { container } = setup({ drag: d })
    const handle = container.querySelector<HTMLElement>('div[draggable="true"]')!

    fireEvent.dragStart(handle, { dataTransfer: dt() })
    expect(d.onStart).toHaveBeenCalledWith(1)

    fireEvent.dragEnd(handle)
    expect(d.onEnd).toHaveBeenCalled()
  })

  it('FE-W5ROW-026: dragging over the row marks it as the drop target', () => {
    const d = drag()
    const { container } = setup({ drag: d })
    const row = container.querySelector<HTMLElement>('.packing-item-row')!

    fireEvent.dragOver(row, { dataTransfer: dt() })

    expect(d.onOver).toHaveBeenCalledWith(1)
  })

  it('FE-W5ROW-027: leaving the row clears the drop target, but moving inside it does not', () => {
    const d = drag()
    const { container } = setup({ drag: d })
    const row = container.querySelector<HTMLElement>('.packing-item-row')!
    const leave = (relatedTarget: Node) =>
      fireEvent(row, new MouseEvent('dragleave', { bubbles: true, relatedTarget }))

    leave(document.body)
    expect(d.onOver).toHaveBeenCalledWith(-1)

    d.onOver.mockClear()
    leave(screen.getByText('Tent'))
    expect(d.onOver).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-028: dropping on the row reports the target id', () => {
    const d = drag()
    const { container } = setup({ drag: d })

    fireEvent.drop(container.querySelector<HTMLElement>('.packing-item-row')!, { dataTransfer: dt() })

    expect(d.onDrop).toHaveBeenCalledWith(1)
  })

  it('FE-W5ROW-029: the dragged row fades and the hovered row shows an edge', () => {
    const { container } = setup({ drag: { ...drag(), isDragging: true, isOver: true } })
    const row = container.querySelector<HTMLElement>('.packing-item-row')!

    expect(row.style.opacity).toBe('0.4')
    expect(row.style.boxShadow).toBe('inset 3px 0 0 0 var(--accent)')
  })

  it('FE-W5ROW-030: hovering the row brings the grip to full opacity', () => {
    const { container } = setup({ drag: drag() })
    const row = container.querySelector<HTMLElement>('.packing-item-row')!
    const handle = container.querySelector<HTMLElement>('div[draggable="true"]')!

    expect(handle.style.opacity).toBe('0.35')
    fireEvent.mouseEnter(row)
    expect(handle.style.opacity).toBe('1')
  })

  it('FE-W5ROW-031: a placeholder row is not draggable', () => {
    const { container } = setup({ item: buildPackingItem({ id: 1, name: '...' }), drag: drag() })

    expect(container.querySelector('div[draggable="true"]')).toBeNull()
  })
})

describe('ArtikelZeile — weight and bag', () => {
  it('FE-W5ROW-032: entering a weight saves it in grams', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })

    fireEvent.change(container.querySelector('input[placeholder="—"]')!, { target: { value: '450' } })

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { weight_grams: 450 }))
  })

  it('FE-W5ROW-033: clearing the weight stores null', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', weight_grams: 300 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
    })

    fireEvent.change(container.querySelector('input[placeholder="—"]')!, { target: { value: '' } })

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { weight_grams: null }))
    expect((await db.packingItems.get(1))!.weight_grams).toBeNull()
  })

  it('FE-W5ROW-034: a failing weight save surfaces a save error', async () => {
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    const { container } = setup({ bagTrackingEnabled: true })

    fireEvent.change(container.querySelector('input[placeholder="—"]')!, { target: { value: '450' } })

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })

  it('FE-W5ROW-035: a read-only row ignores weight edits and never opens the bag picker', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS, canEdit: false })

    const weight = container.querySelector<HTMLInputElement>('input[placeholder="—"]')!
    expect(weight.readOnly).toBe(true)
    fireEvent.change(weight, { target: { value: '450' } })
    fireEvent.click(bagButton(container))

    await waitFor(() => expect(screen.queryByRole('button', { name: /Carry-on/ })).toBeNull())
    expect(update).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-036: picking a bag assigns it', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(bagButton(container))

    fireEvent.click(screen.getByRole('button', { name: 'Trolley' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { bag_id: 8 }))
    expect((await db.packingItems.get(1))!.bag_id).toBe(8)
  })

  it('FE-W5ROW-037: a failing bag assign surfaces a save error', async () => {
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(bagButton(container))

    fireEvent.click(screen.getByRole('button', { name: 'Trolley' }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })

  it('FE-W5ROW-038: only an assigned item offers the Unassigned entry, which clears the bag', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const unassigned = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(bagButton(unassigned.container))
    expect(screen.queryByRole('button', { name: 'Unassigned' })).toBeNull()
    unassigned.unmount()

    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', bag_id: 7 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByRole('button', { name: 'Unassigned' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { bag_id: null }))
  })

  it('FE-W5ROW-039: a failing clear surfaces a save error', async () => {
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', bag_id: 7 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })
    fireEvent.click(bagButton(container))

    fireEvent.click(screen.getByRole('button', { name: 'Unassigned' }))

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })

  it('FE-W5ROW-040: only the unselected bag entries react to hover', () => {
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', bag_id: 7 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })
    fireEvent.click(bagButton(container))
    const selected = screen.getByRole('button', { name: 'Carry-on' })
    const other = screen.getByRole('button', { name: 'Trolley' })

    fireEvent.mouseEnter(other)
    expect(other.style.background).toBe('var(--bg-tertiary)')
    fireEvent.mouseLeave(other)
    expect(other.style.background).toBe('none')

    fireEvent.mouseEnter(selected)
    fireEvent.mouseLeave(selected)
    expect(selected.style.background).toBe('var(--bg-tertiary)')
  })

  it('FE-W5ROW-040a: hovering the selected bag entry leaves it untouched', () => {
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', bag_id: 7 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })
    fireEvent.click(bagButton(container))
    const selected = screen.getByRole('button', { name: 'Carry-on' })

    fireEvent.mouseEnter(selected)
    expect(selected.style.background).toBe('var(--bg-tertiary)')
    fireEvent.mouseLeave(selected)
    expect(selected.style.background).toBe('var(--bg-tertiary)')
  })

  it('FE-W5ROW-040b: a bag id the trip no longer knows falls back to the neutral border', () => {
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', bag_id: 99 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })

    const trigger = bagButton(container)
    expect(trigger.style.border).toBe('2.5px solid var(--border-primary)')
    expect(trigger.style.background).toBe('var(--border-primary)30')
  })

  it('FE-W5ROW-041: creating a bag inline assigns it right away', async () => {
    const created = { id: 12, name: 'Duffel', color: '#f97316' } as unknown as PackingBag
    const onCreateBag = vi.fn(async () => created)
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS, onCreateBag })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))

    const input = screen.getByPlaceholderText('Bag name...')
    fireEvent.change(input, { target: { value: ' Duffel ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onCreateBag).toHaveBeenCalledWith('Duffel'))
    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { bag_id: 12 }))
  })

  it('FE-W5ROW-042: Enter on a blank inline name creates nothing', () => {
    const onCreateBag = vi.fn(async () => undefined)
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS, onCreateBag })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))

    fireEvent.keyDown(screen.getByPlaceholderText('Bag name...'), { key: 'Enter' })

    expect(onCreateBag).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-043: Escape cancels the inline bag form', () => {
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))

    fireEvent.keyDown(screen.getByPlaceholderText('Bag name...'), { key: 'Escape' })

    expect(screen.queryByPlaceholderText('Bag name...')).toBeNull()
    expect(screen.getByText('Add bag')).toBeInTheDocument()
  })

  it('FE-W5ROW-044: the inline confirm button creates the bag, and is inert while blank', async () => {
    const created = { id: 13, name: 'Crate', color: '#f97316' } as unknown as PackingBag
    const onCreateBag = vi.fn(async () => created)
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS, onCreateBag })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))
    const confirm = screen.getByPlaceholderText('Bag name...').nextElementSibling as HTMLButtonElement

    fireEvent.click(confirm)
    expect(onCreateBag).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('Bag name...'), { target: { value: 'Crate' } })
    fireEvent.click(confirm)

    await waitFor(() => expect(onCreateBag).toHaveBeenCalledWith('Crate'))
  })

  it('FE-W5ROW-045: a rejected bag creation leaves the item unassigned', async () => {
    const onCreateBag = vi.fn(async () => undefined)
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ bagTrackingEnabled: true, bags: [], onCreateBag })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))

    const input = screen.getByPlaceholderText('Bag name...')
    fireEvent.change(input, { target: { value: 'Duffel' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(onCreateBag).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByPlaceholderText('Bag name...')).toBeNull())
    expect(update).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-045a: a failing assign after an inline create surfaces a save error', async () => {
    const created = { id: 14, name: 'Duffel', color: '#f97316' } as unknown as PackingBag
    const onCreateBag = vi.fn(async () => created)
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS, onCreateBag })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))

    const input = screen.getByPlaceholderText('Bag name...')
    fireEvent.change(input, { target: { value: 'Duffel' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })

  it('FE-W5ROW-045b: the confirm button also reports a failing assign', async () => {
    const created = { id: 15, name: 'Crate', color: '#f97316' } as unknown as PackingBag
    const onCreateBag = vi.fn(async () => created)
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS, onCreateBag })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))
    const confirm = screen.getByPlaceholderText('Bag name...').nextElementSibling as HTMLButtonElement

    fireEvent.change(screen.getByPlaceholderText('Bag name...'), { target: { value: 'Crate' } })
    fireEvent.click(confirm)

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })

  it('FE-W5ROW-045c: the confirm button closes the form when creation is refused', async () => {
    const onCreateBag = vi.fn(async () => undefined)
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS, onCreateBag })
    fireEvent.click(bagButton(container))
    fireEvent.click(screen.getByText('Add bag'))
    const confirm = screen.getByPlaceholderText('Bag name...').nextElementSibling as HTMLButtonElement

    fireEvent.change(screen.getByPlaceholderText('Bag name...'), { target: { value: 'Crate' } })
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByPlaceholderText('Bag name...')).toBeNull())
    expect(update).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-046: the Add bag entry highlights on hover', () => {
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(bagButton(container))
    const add = screen.getByText('Add bag').closest('button')!

    fireEvent.mouseEnter(add)
    expect(add.style.color).toBe('var(--text-secondary)')
    fireEvent.mouseLeave(add)
    expect(add.style.color).toBe('var(--text-faint)')
  })
})

describe('ArtikelZeile — overflow menu', () => {
  it('FE-W5ROW-047: the menu renames and closes', () => {
    const { container } = setup()
    fireEvent.click(overflowTrigger(container))

    fireEvent.click(screen.getByText('Rename'))

    expect(screen.getByDisplayValue('Tent')).toBeInTheDocument()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('FE-W5ROW-048: the menu deletes through the panel handler', async () => {
    const onDelete = vi.fn(async () => {})
    const { container, props } = setup({ onDelete })
    fireEvent.click(overflowTrigger(container))

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(props.item))
  })

  it('FE-W5ROW-049: the scrim closes the menu', () => {
    const { container, baseElement } = setup()
    fireEvent.click(overflowTrigger(container))
    expect(screen.getByText('Qty')).toBeInTheDocument()

    fireEvent.click(baseElement.querySelector('div[style*="z-index: 1098"]')!)

    expect(screen.queryByText('Qty')).toBeNull()
  })

  it('FE-W5ROW-050: the menu commits a new quantity', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ item: buildPackingItem({ id: 1, name: 'Tent', quantity: null } as Partial<PackingItem>) })
    fireEvent.click(overflowTrigger(container))

    const qty = fieldOf(container, 'Qty')
    fireEvent.change(qty, { target: { value: '4' } })
    fireEvent.blur(qty)

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { quantity: 4 }))
  })

  it('FE-W5ROW-051: the menu saves a weight and reassigns the bag', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', bag_id: 7 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })
    fireEvent.click(overflowTrigger(container))

    const weight = fieldOf(container, 'Total weight')
    fireEvent.change(weight, { target: { value: '900' } })
    await waitFor(() => expect(update).toHaveBeenNthCalledWith(1, 1, 1, { weight_grams: 900 }))

    // The first entry mirrors the current bag and clears it when tapped.
    fireEvent.click(menu(container).getAllByRole('button', { name: 'Carry-on', hidden: true })[0])
    await waitFor(() => expect(update).toHaveBeenNthCalledWith(2, 1, 1, { bag_id: null }))

    fireEvent.click(menuButton(container, 'Trolley'))
    await waitFor(() => expect(update).toHaveBeenNthCalledWith(3, 1, 1, { bag_id: 8 }))
  })

  it('FE-W5ROW-052: a failing menu weight or bag change surfaces a save error', async () => {
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(overflowTrigger(container))

    fireEvent.change(fieldOf(container, 'Total weight'), { target: { value: '900' } })

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))

    toastSpy.mockClear()
    fireEvent.click(menuButton(container, 'Trolley'))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })

  it('FE-W5ROW-053: an unassigned item shows the Unassigned row without firing a write', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(overflowTrigger(container))

    fireEvent.click(menuButton(container, 'Unassigned'))

    await waitFor(() => expect(menu(container).getByText('Total weight')).toBeInTheDocument())
    expect(update).not.toHaveBeenCalled()
  })

  it('FE-W5ROW-053a: a failing clear from the menu surfaces a save error', async () => {
    vi.spyOn(packingRepo, 'update').mockRejectedValue(new Error('boom'))
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', bag_id: 7 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })
    fireEvent.click(overflowTrigger(container))

    fireEvent.click(menu(container).getAllByRole('button', { name: 'Carry-on', hidden: true })[0])

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined))
  })

  it('FE-W5ROW-053b: clearing the menu weight stores null', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Tent', weight_grams: 400 } as Partial<PackingItem>),
      bagTrackingEnabled: true,
      bags: BAGS,
    })
    fireEvent.click(overflowTrigger(container))

    fireEvent.change(fieldOf(container, 'Total weight'), { target: { value: '' } })

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { weight_grams: null }))
  })

  it('FE-W5ROW-054: the menu list submenu moves the item and can be collapsed again', async () => {
    const update = vi.spyOn(packingRepo, 'update')
    const { container } = setup()
    fireEvent.click(overflowTrigger(container))

    fireEvent.click(menuButton(container, 'Move to List'))
    expect(menuButton(container, 'Docs')).toBeInTheDocument()

    fireEvent.click(menuButton(container, 'Move to List'))
    expect(menu(container).queryByRole('button', { name: 'Docs', hidden: true })).toBeNull()

    fireEvent.click(menuButton(container, 'Move to List'))
    fireEvent.click(menuButton(container, 'Docs'))

    await waitFor(() => expect(update).toHaveBeenCalledWith(1, 1, { category: 'Docs' }))
  })

  it('FE-W5ROW-054a: an uncategorized item marks the default list in the submenu', () => {
    const { container } = setup({
      item: buildPackingItem({ id: 1, name: 'Soap', category: null }),
      categories: ['Other', 'Gear'],
    })
    fireEvent.click(overflowTrigger(container))
    fireEvent.click(menuButton(container, 'Move to List'))

    expect(menuButton(container, 'Other')).toHaveStyle({ background: 'var(--bg-tertiary)' })
    expect(menuButton(container, 'Gear')).not.toHaveStyle({ background: 'var(--bg-tertiary)' })
  })

  it('FE-W5ROW-056: menu entries highlight on hover, the active one stays put', () => {
    const { container } = setup({ bagTrackingEnabled: true, bags: BAGS })
    fireEvent.click(overflowTrigger(container))
    fireEvent.click(menuButton(container, 'Move to List'))
    // "Gear" is the item's current list, so its submenu entry renders as active.
    const active = menuButton(container, 'Gear')
    const plain = menuButton(container, 'Carry-on')
    const danger = menu(container).getByText('Delete').closest('button')!

    fireEvent.mouseEnter(plain)
    expect(plain.style.background).toBe('var(--bg-tertiary)')
    fireEvent.mouseLeave(plain)
    expect(plain.style.background).toBe('none')

    fireEvent.mouseEnter(active)
    fireEvent.mouseLeave(active)
    expect(active.style.background).toBe('var(--bg-tertiary)')

    fireEvent.mouseEnter(danger)
    expect(danger.style.background).toBe('rgb(254, 242, 242)')
  })
})
