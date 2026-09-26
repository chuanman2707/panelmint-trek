// FE-W5HOOK-001 to FE-W5HOOK-058
//
// The hook runs on the Dexie-backed local adapter: members come from
// trip_membership rows, assignees/bags from their junction tables and item
// CRUD lands in `db.packingItems`. Mutation tests seed the rows they act on
// and assert the persisted state; failures are injected by spying the
// repo/api methods. The hosted-only branches (templates, bulk import, the
// import/save signals and the sharing/contributor handlers) are gone.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { TranslationProvider } from '../../i18n/TranslationContext'
import { resetAllStores, seedStore } from '../../../tests/helpers/store'
import { buildUser, buildAdmin, buildTrip, buildPackingItem } from '../../../tests/helpers/factories'
import { useAuthStore } from '../../store/authStore'
import { useTripStore } from '../../store/tripStore'
import { useAddonStore } from '../../store/addonStore'
import { usePermissionsStore } from '../../store/permissionsStore'
import { usePackingList, type PackingListPanelProps } from './usePackingListPanel'
import { db, type LocalTripMember } from '../../db/panelmintDb'
import { tripsApi, packingApi } from '../../api/client'
import { packingRepo } from '../../repo/packingRepo'
import { LocalApiError } from '../../api/local/helpers'
import type { PackingItem, PackingBag } from '../../types'

const wrapper = ({ children }: { children: ReactNode }) => <TranslationProvider>{children}</TranslationProvider>

const toastSpy = vi.fn((_message: string, _type?: string, _duration?: number) => 0)

function renderPanel(props: Partial<PackingListPanelProps> = {}) {
  return renderHook((p: PackingListPanelProps) => usePackingList(p), {
    wrapper,
    initialProps: { tripId: 1, items: [], ...props },
  })
}

/** Waits for the mount effects (members, assignees, bags) to settle. */
async function settled() {
  await act(async () => { await Promise.resolve() })
}

/** A roster member: trip_membership row + the localUsers row the wire joins. */
async function withMember(id: number, username: string) {
  await db.localUsers.put({ id, name: username, is_self: 0 })
  await db.tripMembers.put({
    tripId: 1, id, username, role: 'member',
    added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'owner', is_guest: false,
  } as LocalTripMember)
}

function buildBag(overrides: Partial<PackingBag> = {}): PackingBag {
  return {
    id: 1, trip_id: 1, name: 'Bag', color: '#6366f1',
    weight_limit_grams: null, sort_order: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(async () => {
  resetAllStores()
  toastSpy.mockClear()
  window.__addToast = toastSpy
  // The roster is Dexie now — the default trip 1 has owner 'owner' (self) alone.
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'owner', is_self: 1 })
  await db.trips.put(buildTrip({ id: 1, user_id: 1 }))
  seedStore(useAuthStore, { user: buildUser({ id: 1 }), isAuthenticated: true })
  seedStore(useTripStore, { trip: buildTrip({ id: 1, user_id: 1 }) })
})

afterEach(() => {
  delete window.__addToast
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('usePackingList — members & assignees', () => {
  it('FE-W5HOOK-001: merges the owner and the members into one member list', async () => {
    // alice as a guest: is_self:0 roster row + a membership on trip 1.
    await db.localUsers.put({ id: 2, name: 'alice', is_self: 0 })
    await db.tripMembers.put({
      tripId: 1, id: 2, username: 'alice', role: 'member',
      added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'owner', is_guest: true,
    } as LocalTripMember)
    const { result } = renderPanel()

    await waitFor(() => expect(result.current.tripMembers).toHaveLength(2))
    // Local wire rows carry no avatars — the tiles fall back to initials.
    expect(result.current.tripMembers[0]).toEqual({ id: 1, username: 'owner', avatar: null, is_guest: false })
    expect(result.current.tripMembers[1]).toEqual({ id: 2, username: 'alice', avatar: null, is_guest: true })
  })

  it('FE-W5HOOK-002: a trip whose owner is not on the roster yields no members', async () => {
    // Point the trip at an absent roster row — owner resolves to null, no members.
    await db.trips.update(1, { user_id: 99 })
    const { result } = renderPanel()

    await settled()
    expect(result.current.tripMembers).toEqual([])
  })

  it('FE-W5HOOK-003: a failing members request leaves the list empty', async () => {
    vi.spyOn(tripsApi, 'getMembers').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    await settled()
    expect(result.current.tripMembers).toEqual([])
  })

  it('FE-W5HOOK-004: a trip without assignees falls back to an empty record', async () => {
    const { result } = renderPanel()

    await settled()
    expect(result.current.categoryAssignees).toEqual({})
  })

  it('FE-W5HOOK-005: setting assignees stores the returned list for that category', async () => {
    await withMember(2, 'alice')
    await db.packingCategoryAssignees.put({ id: 1, trip_id: 1, category_name: 'Docs', user_id: 1 })
    const { result } = renderPanel()
    await waitFor(() => expect(result.current.categoryAssignees.Docs).toHaveLength(1))

    await act(async () => { await result.current.handleSetAssignees('Gear', [2]) })

    expect(result.current.categoryAssignees.Gear).toEqual([
      { user_id: 2, username: 'alice', avatar: null, is_guest: undefined },
    ])
    // The junction rows are the write, not just the hook state.
    const rows = (await db.packingCategoryAssignees.toArray()).filter(r => r.category_name === 'Gear')
    expect(rows).toEqual([expect.objectContaining({ trip_id: 1, user_id: 2 })])
    // The existing categories survive the merge.
    expect(result.current.categoryAssignees.Docs).toHaveLength(1)
  })

  it('FE-W5HOOK-006: an assignee response without a list stores an empty array', async () => {
    vi.spyOn(packingApi, 'setCategoryAssignees').mockResolvedValue({} as Awaited<ReturnType<typeof packingApi.setCategoryAssignees>>)
    const { result } = renderPanel()
    await settled()

    await act(async () => { await result.current.handleSetAssignees('Gear', [2]) })

    expect(result.current.categoryAssignees.Gear).toEqual([])
  })

  it('FE-W5HOOK-007: a failing assignee update surfaces a save error', async () => {
    vi.spyOn(packingApi, 'setCategoryAssignees').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    await act(async () => { await result.current.handleSetAssignees('Gear', [2]) })

    expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined)
  })
})

describe('usePackingList — grouping, filtering and progress', () => {
  const items = [
    buildPackingItem({ id: 1, name: 'Tent', category: 'Gear', checked: 1 }),
    buildPackingItem({ id: 2, name: 'Rope', category: 'Gear', checked: 0 }),
    buildPackingItem({ id: 3, name: 'Soap', category: null, checked: 0 }),
    buildPackingItem({ id: 4, name: 'Diary', category: 'Gear', is_private: 1 } as Partial<PackingItem>),
  ]

  it('FE-W5HOOK-008: the common view hides private items and buckets by category', async () => {
    const { result } = renderPanel({ items })
    await settled()

    expect(result.current.allCategories).toEqual(['Gear', 'Other'])
    expect(result.current.gruppiert.Gear.map(i => i.name)).toEqual(['Tent', 'Rope'])
    expect(result.current.gruppiert.Other.map(i => i.name)).toEqual(['Soap'])
  })

  it('FE-W5HOOK-009: the personal view shows only private items', async () => {
    const { result } = renderPanel({ items })
    await settled()

    act(() => result.current.setView('personal'))

    expect(result.current.view).toBe('personal')
    expect(result.current.gruppiert.Gear.map(i => i.name)).toEqual(['Diary'])
  })

  it('FE-W5HOOK-010: the "offen" filter keeps only unchecked items', async () => {
    const { result } = renderPanel({ items })
    await settled()

    act(() => result.current.setFilter('offen'))

    expect(result.current.gruppiert.Gear.map(i => i.name)).toEqual(['Rope'])
  })

  it('FE-W5HOOK-011: the "erledigt" filter keeps only checked items', async () => {
    const { result } = renderPanel({ items })
    await settled()

    act(() => result.current.setFilter('erledigt'))

    expect(result.current.gruppiert.Gear.map(i => i.name)).toEqual(['Tent'])
    expect(result.current.gruppiert.Other).toBeUndefined()
  })

  it('FE-W5HOOK-012: progress is the checked share of the active view', async () => {
    const { result } = renderPanel({ items })
    await settled()

    expect(result.current.abgehakt).toBe(1)
    expect(result.current.fortschritt).toBe(33)
  })

  it('FE-W5HOOK-013: an empty view reports zero progress instead of NaN', async () => {
    const { result } = renderPanel()
    await settled()

    expect(result.current.fortschritt).toBe(0)
  })

  it('FE-W5HOOK-014: the view defaults to the common pool and flips locally', async () => {
    const { result } = renderPanel({ items })
    await settled()

    // The view is local state now — no controlled prop, no callback upward.
    expect(result.current.view).toBe('common')
    expect(result.current.gruppiert.Gear.map(i => i.name)).toEqual(['Tent', 'Rope'])

    act(() => result.current.setView('personal'))
    act(() => result.current.setView('common'))

    expect(result.current.view).toBe('common')
    expect(result.current.gruppiert.Gear.map(i => i.name)).toEqual(['Tent', 'Rope'])
  })
})

describe('usePackingList — item and category CRUD', () => {
  it('FE-W5HOOK-015: adding to a category reuses its placeholder row', async () => {
    const placeholder = buildPackingItem({ id: 9, name: '...', category: 'Gear' })
    seedStore(useTripStore, { packingItems: [placeholder] })
    await db.packingItems.put(placeholder)
    const { result } = renderPanel({ items: [placeholder] })

    await act(async () => { await result.current.handleAddItemToCategory('Gear', 'Tent') })

    // The same row is renamed — no new row is appended.
    await waitFor(async () => {
      expect((await db.packingItems.get(9))!.name).toBe('Tent')
    })
    expect(await db.packingItems.toArray()).toHaveLength(1)
  })

  it('FE-W5HOOK-016: a new item in the personal view is created as personal', async () => {
    const { result } = renderPanel()
    await settled()
    act(() => result.current.setView('personal'))

    await act(async () => { await result.current.handleAddItemToCategory('Gear', 'Tent') })

    await waitFor(async () => {
      const rows = await db.packingItems.toArray()
      expect(rows).toEqual([expect.objectContaining({ name: 'Tent', category: 'Gear', is_private: 1 })])
    })
  })

  it('FE-W5HOOK-017: a failing add surfaces an add error', async () => {
    vi.spyOn(packingRepo, 'create').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    await act(async () => { await result.current.handleAddItemToCategory('Gear', 'Tent') })

    expect(toastSpy).toHaveBeenCalledWith('Failed to add', 'error', undefined)
  })

  it('FE-W5HOOK-018: deleting the last item of a category unchecks it and converts it to a placeholder', async () => {
    const item = buildPackingItem({ id: 11, name: 'Tent', category: 'Gear', checked: 1 })
    await db.packingItems.put(item)
    const { result } = renderPanel({ items: [item] })

    await act(async () => { await result.current.handleDeleteItem(item) })

    await waitFor(async () => {
      expect(await db.packingItems.get(11)).toMatchObject({
        name: '...', checked: 0, weight_grams: null, bag_id: null, quantity: 1,
      })
    })
  })

  it('FE-W5HOOK-018a: the last item of a category is converted without an extra uncheck', async () => {
    const item = buildPackingItem({ id: 14, name: 'Tent', category: 'Gear', checked: 0 })
    await db.packingItems.put(item)
    const updateSpy = vi.spyOn(packingRepo, 'update')
    const { result } = renderPanel({ items: [item] })

    await act(async () => { await result.current.handleDeleteItem(item) })

    await waitFor(async () => {
      expect((await db.packingItems.get(14))!.name).toBe('...')
    })
    // Unchecked already: one update call converts the row in place.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith(1, 14, expect.objectContaining({ name: '...' }))
  })

  it('FE-W5HOOK-018b: an item with siblings in its category is deleted outright', async () => {
    const item = buildPackingItem({ id: 15, name: 'Tent', category: 'Gear' })
    const sibling = buildPackingItem({ id: 16, name: 'Rope', category: 'Gear' })
    await db.packingItems.bulkPut([item, sibling])
    const { result } = renderPanel({ items: [item, sibling] })

    await act(async () => { await result.current.handleDeleteItem(item) })

    await waitFor(async () => {
      expect(await db.packingItems.get(15)).toBeUndefined()
      expect(await db.packingItems.get(16)).toBeTruthy()
    })
  })

  it('FE-W5HOOK-019: an uncategorized item is deleted outright', async () => {
    const item = buildPackingItem({ id: 12, name: 'Soap', category: null })
    await db.packingItems.put(item)
    const { result } = renderPanel({ items: [item] })

    await act(async () => { await result.current.handleDeleteItem(item) })

    await waitFor(async () => {
      expect(await db.packingItems.get(12)).toBeUndefined()
    })
  })

  it('FE-W5HOOK-020: a failing delete surfaces a delete error', async () => {
    const item = buildPackingItem({ id: 13, name: 'Soap', category: null })
    vi.spyOn(packingRepo, 'delete').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel({ items: [item] })

    await act(async () => { await result.current.handleDeleteItem(item) })

    expect(toastSpy).toHaveBeenCalledWith('Failed to delete', 'error', undefined)
  })

  it('FE-W5HOOK-021: adding a category without a name does nothing', async () => {
    const { result } = renderPanel()

    act(() => result.current.setNewCatName('   '))
    await act(async () => { await result.current.handleAddNewCategory() })

    expect(await db.packingItems.toArray()).toEqual([])
  })

  it('FE-W5HOOK-022: a duplicate category name gets a zero-width suffix so it stays distinct', async () => {
    const { result } = renderPanel({ items: [buildPackingItem({ id: 20, category: 'Gear' })] })
    await settled()

    act(() => result.current.setNewCatName('Gear'))
    await act(async () => { await result.current.handleAddNewCategory() })

    await waitFor(async () => {
      const rows = await db.packingItems.toArray()
      expect(rows).toEqual([expect.objectContaining({ name: '...', category: 'Gear​', is_private: 0 })])
    })
    expect(result.current.newCatName).toBe('')
    expect(result.current.addingCategory).toBe(false)
  })

  it('FE-W5HOOK-022a: a category added from the personal view is created as personal', async () => {
    const { result } = renderPanel()
    await settled()
    act(() => result.current.setView('personal'))

    act(() => result.current.setNewCatName('Gear'))
    await act(async () => { await result.current.handleAddNewCategory() })

    await waitFor(async () => {
      const rows = await db.packingItems.toArray()
      expect(rows).toEqual([expect.objectContaining({ category: 'Gear', is_private: 1 })])
    })
  })

  it('FE-W5HOOK-023: a failing category add surfaces an add error', async () => {
    vi.spyOn(packingRepo, 'create').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    act(() => result.current.setNewCatName('Gear'))
    await act(async () => { await result.current.handleAddNewCategory() })

    expect(toastSpy).toHaveBeenCalledWith('Failed to add', 'error', undefined)
  })

  it('FE-W5HOOK-024: renaming the default category moves every uncategorized item', async () => {
    const items = [
      buildPackingItem({ id: 31, category: null }),
      buildPackingItem({ id: 32, category: 'Gear' }),
    ]
    await db.packingItems.bulkPut(items)
    const { result } = renderPanel({ items })

    await act(async () => { await result.current.handleRenameCategory('Other', 'Misc') })

    await waitFor(async () => {
      expect((await db.packingItems.get(31))!.category).toBe('Misc')
    })
    expect((await db.packingItems.get(32))!.category).toBe('Gear')
  })

  it('FE-W5HOOK-025: a partly failing category delete surfaces a delete error', async () => {
    const items = [buildPackingItem({ id: 41 }), buildPackingItem({ id: 42 })]
    await db.packingItems.bulkPut(items)
    const deleteSpy = vi.spyOn(packingRepo, 'delete')
    deleteSpy.mockRejectedValueOnce(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel({ items })

    await act(async () => { await result.current.handleDeleteCategory(items) })

    expect(toastSpy).toHaveBeenCalledWith('Failed to delete', 'error', undefined)
    // The second item still went through.
    expect(await db.packingItems.get(42)).toBeUndefined()
  })

  it('FE-W5HOOK-025a: a clean category delete stays quiet', async () => {
    const items = [buildPackingItem({ id: 43 }), buildPackingItem({ id: 44 })]
    await db.packingItems.bulkPut(items)
    const { result } = renderPanel({ items })

    await act(async () => { await result.current.handleDeleteCategory(items) })

    await waitFor(async () => {
      expect(await db.packingItems.toArray()).toEqual([])
    })
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('FE-W5HOOK-026: declining the clear-checked confirmation deletes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const item = buildPackingItem({ id: 51, checked: 1 })
    await db.packingItems.put(item)
    const { result } = renderPanel({ items: [item] })

    await act(async () => { await result.current.handleClearChecked() })

    expect(await db.packingItems.get(51)).toBeTruthy()
  })

  it('FE-W5HOOK-027: a failing clear-checked delete surfaces a delete error', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(packingRepo, 'delete').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel({ items: [buildPackingItem({ id: 52, checked: 1 })] })

    await act(async () => { await result.current.handleClearChecked() })

    expect(toastSpy).toHaveBeenCalledWith('Failed to delete', 'error', undefined)
  })
})

describe('usePackingList — bags', () => {
  beforeEach(() => {
    seedStore(useAddonStore, { bagTracking: true, loaded: true })
  })

  it('FE-W5HOOK-028: a trip without bags falls back to an empty list', async () => {
    const { result } = renderPanel()

    await settled()
    expect(result.current.bagTrackingEnabled).toBe(true)
    expect(result.current.bags).toEqual([])
  })

  it('FE-W5HOOK-029: creating a bag without a name does nothing', async () => {
    const { result } = renderPanel()

    act(() => result.current.setNewBagName('  '))
    await act(async () => { await result.current.handleCreateBag() })

    expect(await db.packingBags.toArray()).toEqual([])
  })

  it('FE-W5HOOK-030: creating a bag appends it and clears the form', async () => {
    const { result } = renderPanel()
    await settled()

    act(() => { result.current.setNewBagName('Duffel'); result.current.setShowAddBag(true) })
    await act(async () => { await result.current.handleCreateBag() })

    expect(result.current.bags.map(b => b.name)).toEqual(['Duffel'])
    expect(result.current.newBagName).toBe('')
    expect(result.current.showAddBag).toBe(false)
    expect((await db.packingBags.toArray()).map(b => b.name)).toEqual(['Duffel'])
  })

  it('FE-W5HOOK-031: a failing bag create surfaces a save error', async () => {
    vi.spyOn(packingApi, 'createBag').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    act(() => result.current.setNewBagName('Duffel'))
    await act(async () => { await result.current.handleCreateBag() })

    expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined)
  })

  it('FE-W5HOOK-032: creating a bag by name returns the new bag', async () => {
    const { result } = renderPanel()
    await settled()

    let created: unknown
    await act(async () => { created = await result.current.handleCreateBagByName('Crate') })

    expect(created).toMatchObject({ name: 'Crate' })
    expect(result.current.bags).toHaveLength(1)
  })

  it('FE-W5HOOK-033: a failing create-by-name returns undefined and warns', async () => {
    vi.spyOn(packingApi, 'createBag').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    let created: unknown = 'unset'
    await act(async () => { created = await result.current.handleCreateBagByName('Crate') })

    expect(created).toBeUndefined()
    expect(toastSpy).toHaveBeenCalledWith('Failed to save', 'error', undefined)
  })

  it('FE-W5HOOK-034: deleting a bag drops it from the list', async () => {
    await db.packingBags.bulkPut([buildBag({ id: 5, name: 'A' }), buildBag({ id: 6, name: 'B' })])
    const { result } = renderPanel()
    await waitFor(() => expect(result.current.bags).toHaveLength(2))

    await act(async () => { await result.current.handleDeleteBag(5) })

    expect(result.current.bags.map(b => b.id)).toEqual([6])
    expect(await db.packingBags.get(5)).toBeUndefined()
  })

  it('FE-W5HOOK-035: a failing bag delete surfaces a delete error', async () => {
    vi.spyOn(packingApi, 'deleteBag').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    await act(async () => { await result.current.handleDeleteBag(5) })

    expect(toastSpy).toHaveBeenCalledWith('Failed to delete', 'error', undefined)
  })

  it('FE-W5HOOK-036: updating a bag merges the response into that bag only', async () => {
    await db.packingBags.bulkPut([buildBag({ id: 5, name: 'A' }), buildBag({ id: 6, name: 'B' })])
    const { result } = renderPanel()
    await waitFor(() => expect(result.current.bags).toHaveLength(2))

    await act(async () => { await result.current.handleUpdateBag(6, { name: 'Renamed' }) })

    expect(result.current.bags.map(b => b.name)).toEqual(['A', 'Renamed'])
    expect((await db.packingBags.get(6))!.name).toBe('Renamed')
  })

  it('FE-W5HOOK-037: a failing bag update surfaces a generic error', async () => {
    vi.spyOn(packingApi, 'updateBag').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    await act(async () => { await result.current.handleUpdateBag(6, { name: 'X' }) })

    expect(toastSpy).toHaveBeenCalledWith('Error', 'error', undefined)
  })

  it('FE-W5HOOK-038: setting bag members replaces that bag members', async () => {
    await withMember(2, 'alice')
    await db.packingBags.bulkPut([buildBag({ id: 5, name: 'A' }), buildBag({ id: 6, name: 'B' })])
    const { result } = renderPanel()
    await waitFor(() => expect(result.current.bags).toHaveLength(2))

    await act(async () => { await result.current.handleSetBagMembers(5, [2]) })

    expect(result.current.bags[0].members).toEqual([{ user_id: 2, username: 'alice', avatar: null }])
    expect(result.current.bags[1].members).toEqual([])
    expect(await db.packingBagMembers.toArray()).toEqual([
      expect.objectContaining({ bag_id: 5, user_id: 2 }),
    ])
  })

  it('FE-W5HOOK-039: a failing member update surfaces a generic error', async () => {
    vi.spyOn(packingApi, 'setBagMembers').mockRejectedValue(new LocalApiError(500, 'Server error'))
    const { result } = renderPanel()

    await act(async () => { await result.current.handleSetBagMembers(5, [2]) })

    expect(toastSpy).toHaveBeenCalledWith('Error', 'error', undefined)
  })
})

describe('usePackingList — signals', () => {
  it('FE-W5HOOK-054: a raised clear-checked signal runs the bulk delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const items = [buildPackingItem({ id: 81, checked: 1 })]
    await db.packingItems.bulkPut(items)
    const { rerender } = renderPanel({ items, clearCheckedSignal: 0 })
    await settled()

    await act(async () => { rerender({ tripId: 1, items, clearCheckedSignal: 1 }) })

    await waitFor(async () => {
      expect(await db.packingItems.get(81)).toBeUndefined()
    })
  })
})

describe('usePackingList — permissions and clone', () => {
  it('FE-W5HOOK-056: a restricted packing_edit permission removes edit rights', async () => {
    usePermissionsStore.setState({ permissions: { packing_edit: 'admin' } })
    seedStore(useAuthStore, { user: buildUser({ id: 2 }), isAuthenticated: true })
    const { result } = renderPanel()

    await settled()
    expect(result.current.canEdit).toBe(false)
  })

  it('FE-W5HOOK-057: an admin keeps edit rights', async () => {
    usePermissionsStore.setState({ permissions: { packing_edit: 'admin' } })
    seedStore(useAuthStore, { user: buildAdmin({ id: 3 }), isAuthenticated: true })
    const { result } = renderPanel()

    await settled()
    expect(result.current.canEdit).toBe(true)
    expect(result.current.currentUserId).toBe(3)
  })

  it('FE-W5HOOK-058: cloning an item stores a private copy beside the original', async () => {
    const item = buildPackingItem({ id: 91, name: 'Stove' })
    seedStore(useTripStore, { packingItems: [item] })
    await db.packingItems.put(item)
    const { result } = renderPanel({ items: [item] })

    await act(async () => { await result.current.handleCloneItem(91) })

    await waitFor(async () => {
      const rows = await db.packingItems.toArray()
      expect(rows).toHaveLength(2)
      const clone = rows.find(r => r.id !== 91)!
      // Clones are personal copies named after the original.
      expect(clone).toMatchObject({ name: 'Stove', is_private: 1 })
    })
    expect(useTripStore.getState().packingItems).toHaveLength(2)
  })
})
