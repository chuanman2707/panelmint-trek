import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useAuthStore } from '../../store/authStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { packingApi, tripsApi } from '../../api/client'
import { useAddonStore } from '../../store/addonStore'
import type { PackingItem, PackingBag } from '../../types'
import { BAG_COLORS, PACKING_PLACEHOLDER_NAME } from './packingListPanel.constants'

export interface TripMember {
  id: number
  username: string
  avatar?: string | null
  avatar_url?: string | null
  is_guest?: boolean
}

export interface CategoryAssignee {
  user_id: number
  username: string
  avatar?: string | null
  is_guest?: boolean
}

export interface PackingListPanelProps {
  tripId: number
  items: PackingItem[]
  clearCheckedSignal?: number
  inlineHeader?: boolean
}

/**
 * Packing list state: trip members + per-category assignees, category grouping
 * and progress, item/category CRUD and bag tracking (weights + members). The
 * sections below render header, filters, the grouped list and the bag
 * sidebar/modal.
 */
export function usePackingList({ tripId, items, clearCheckedSignal = 0, inlineHeader = true }: PackingListPanelProps) {
  const [filter, setFilter] = useState('alle') // 'alle' | 'offen' | 'erledigt'
  // Common vs personal list (#858): 'common' = the group pool, 'personal' =
  // the viewer's private items. A local, single-user app still has both.
  const [view, setView] = useState<'common' | 'personal'>('common')
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const { addPackingItem, updatePackingItem, deletePackingItem, togglePackingItem, reorderPackingItems,
    clonePackingItem } = useTripStore()
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const canEdit = can('packing_edit', trip)
  const currentUserId = useAuthStore((s) => s.user?.id)
  const toast = useToast()
  const { t } = useTranslation()

  // Trip members & category assignees
  const [tripMembers, setTripMembers] = useState<TripMember[]>([])
  const [categoryAssignees, setCategoryAssignees] = useState<Record<string, CategoryAssignee[]>>({})

  useEffect(() => {
    let cancelled = false
    tripsApi.getMembers(tripId).then(data => {
      if (cancelled) return
      const all: TripMember[] = []
      if (data.owner) all.push({ id: data.owner.id, username: data.owner.username, avatar: data.owner.avatar_url, is_guest: false })
      if (data.members) all.push(...data.members.map((m) => ({ id: m.id, username: m.username, avatar: m.avatar_url, is_guest: !!m.is_guest })))
      setTripMembers(all)
    }).catch(() => {
      // A failed roster read leaves the assignee pickers empty — the rest of
      // the panel still works, so this degrades instead of toasting on mount.
      if (!cancelled) setTripMembers([])
    })
    packingApi.getCategoryAssignees(tripId).then(data => {
      if (!cancelled) setCategoryAssignees(data.assignees || {})
    }).catch(() => {
      if (!cancelled) setCategoryAssignees({})
    })
    return () => { cancelled = true }
  }, [tripId])

  const handleSetAssignees = async (category: string, userIds: number[]) => {
    try {
      const data = await packingApi.setCategoryAssignees(tripId, category, userIds)
      setCategoryAssignees(prev => ({ ...prev, [category]: data.assignees || [] }))
    } catch {
      toast.error(t('packing.toast.saveError'))
    }
  }

  // Split by the active view: Common = group pool (is_private 0), Personal =
  // the viewer's private items (is_private 1).
  const viewItems = useMemo(
    () => items.filter(i => (view === 'common' ? !i.is_private : !!i.is_private)),
    [items, view],
  )

  const allCategories = useMemo(() => {
    const seen: string[] = []
    for (const item of viewItems) {
      const cat = item.category || t('packing.defaultCategory')
      if (!seen.includes(cat)) seen.push(cat)
    }
    return seen
  }, [viewItems, t])

  const gruppiert = useMemo(() => {
    const filtered = viewItems.filter(i => {
      if (filter === 'offen') return !i.checked
      if (filter === 'erledigt') return i.checked
      return true
    })
    const groups: Record<string, PackingItem[]> = {}
    for (const item of filtered) {
      const kat = item.category || t('packing.defaultCategory')
      if (!groups[kat]) groups[kat] = []
      groups[kat].push(item)
    }
    return groups
  }, [viewItems, filter, t])

  const abgehakt = viewItems.filter(i => i.checked).length
  const fortschritt = viewItems.length > 0 ? Math.round((abgehakt / viewItems.length) * 100) : 0

  const handleAddItemToCategory = async (category: string, name: string) => {
    try {
      // Reuse the '...' placeholder slot when the category already has one, so a
      // freshly-emptied category keeps its position (and therefore its colour)
      // instead of the new item being appended to the end of the list.
      const placeholder = useTripStore.getState().packingItems.find(
        i => i.category === category && i.name === PACKING_PLACEHOLDER_NAME
      )
      if (placeholder) {
        await updatePackingItem(tripId, placeholder.id, { name })
      } else {
        // New items inherit the active view's tier: Personal in "my list", Common otherwise.
        await addPackingItem(tripId, { name, category, visibility: view === 'personal' ? 'personal' : 'common' } as Parameters<typeof addPackingItem>[1])
      }
    } catch { toast.error(t('packing.toast.addError')) }
  }

  // Deleting an item from a row. When it is the last item of a user-created
  // category, turn that row back into the '...' placeholder in place rather than
  // deleting it (#1289). Updating the row keeps its id, list position and colour,
  // so the category neither disappears nor jumps to the end. The default
  // (uncategorized) group and the placeholder row itself are deleted normally —
  // removing the placeholder is how an empty category is dismissed.
  const handleDeleteItem = async (item: PackingItem) => {
    const category = item.category
    const isLastInCategory = !!category
      && item.name !== PACKING_PLACEHOLDER_NAME
      && !items.some(i => i.id !== item.id && i.category === category)
    try {
      if (isLastInCategory) {
        if (item.checked) await togglePackingItem(tripId, item.id, false)
        await updatePackingItem(tripId, item.id, {
          name: PACKING_PLACEHOLDER_NAME, weight_grams: null, bag_id: null, quantity: 1,
        })
      } else {
        await deletePackingItem(tripId, item.id)
      }
    } catch {
      toast.error(t('packing.toast.deleteError'))
    }
  }

  const handleAddNewCategory = async () => {
    if (!newCatName.trim()) return
    let catName = newCatName.trim()
    // Allow duplicate display names — append invisible zero-width spaces to make unique internally
    while (allCategories.includes(catName)) {
      catName += '​'
    }
    try {
      await addPackingItem(tripId, { name: '...', category: catName, visibility: view === 'personal' ? 'personal' : 'common' } as Parameters<typeof addPackingItem>[1])
      setNewCatName('')
      setAddingCategory(false)
    } catch { toast.error(t('packing.toast.addError')) }
  }

  const handleRenameCategory = async (oldName: string, newName: string) => {
    const toUpdate = items.filter(i => (i.category || t('packing.defaultCategory')) === oldName)
    for (const item of toUpdate) {
      await updatePackingItem(tripId, item.id, { category: newName })
    }
  }

  const handleDeleteCategory = async (catItems: PackingItem[]) => {
    let failed = false
    for (const item of catItems) {
      try { await deletePackingItem(tripId, item.id) } catch { failed = true }
    }
    if (failed) toast.error(t('packing.toast.deleteError'))
  }

  const handleClearChecked = useCallback(async () => {
    if (!confirm(t('packing.confirm.clearChecked', { count: abgehakt }))) return
    let failed = false
    for (const item of items.filter(i => i.checked)) {
      try { await deletePackingItem(tripId, item.id) } catch { failed = true }
    }
    if (failed) toast.error(t('packing.toast.deleteError'))
  }, [t, abgehakt, items, deletePackingItem, tripId, toast])

  // Bag tracking — the global toggle is a packing sub-flag surfaced via the
  // addon store (loaded on app start).
  const bagTrackingEnabled = useAddonStore(s => s.bagTracking)
  const addonsLoaded = useAddonStore(s => s.loaded)
  const loadAddons = useAddonStore(s => s.loadAddons)
  const [bags, setBags] = useState<PackingBag[]>([])
  /** Adapter-summed weight of everything in no bag (#2191); null until the first load. */
  const [unassignedWeightGrams, setUnassignedWeightGrams] = useState<number | null>(null)
  const [newBagName, setNewBagName] = useState('')
  const [showAddBag, setShowAddBag] = useState(false)
  const [showBagModal, setShowBagModal] = useState(false)

  useEffect(() => {
    if (!addonsLoaded) loadAddons()
  }, [addonsLoaded, loadAddons])

  const reloadBags = useCallback(async () => {
    if (!bagTrackingEnabled) return
    try {
      const r = await packingApi.listBags(tripId)
      setBags(r.bags || [])
      setUnassignedWeightGrams(r.unassigned_weight_grams ?? null)
    } catch {
      // A failed read leaves the previous totals on screen; the surfaces fall
      // back to the local sum for any bag missing them.
    }
  }, [tripId, bagTrackingEnabled])

  useEffect(() => { void reloadBags() }, [reloadBags])

  const handleCreateBag = async () => {
    if (!newBagName.trim()) return
    try {
      const data = await packingApi.createBag(tripId, { name: newBagName.trim(), color: BAG_COLORS[bags.length % BAG_COLORS.length] })
      setBags(prev => [...prev, data.bag])
      setNewBagName(''); setShowAddBag(false)
    } catch { toast.error(t('packing.toast.saveError')) }
  }

  const handleCreateBagByName = async (name: string): Promise<PackingBag | undefined> => {
    try {
      const data = await packingApi.createBag(tripId, { name, color: BAG_COLORS[bags.length % BAG_COLORS.length] })
      setBags(prev => [...prev, data.bag])
      return data.bag
    } catch { toast.error(t('packing.toast.saveError')); return undefined }
  }

  const handleDeleteBag = async (bagId: number) => {
    try {
      await packingApi.deleteBag(tripId, bagId)
      setBags(prev => prev.filter(b => b.id !== bagId))
    } catch { toast.error(t('packing.toast.deleteError')) }
  }

  const handleUpdateBag = async (bagId: number, data: Record<string, any>) => {
    try {
      const result = await packingApi.updateBag(tripId, bagId, data)
      setBags(prev => prev.map(b => b.id === bagId ? { ...b, ...result.bag } : b))
    } catch { toast.error(t('common.error')) }
  }

  const handleSetBagMembers = async (bagId: number, userIds: number[]) => {
    try {
      const result = await packingApi.setBagMembers(tripId, bagId, userIds)
      setBags(prev => prev.map(b => b.id === bagId ? { ...b, members: result.members } : b))
    } catch { toast.error(t('common.error')) }
  }

  // The page-level "clear checked" button bumps this signal.
  const lastHandledClearSignal = useRef(clearCheckedSignal)

  useEffect(() => {
    if (clearCheckedSignal !== lastHandledClearSignal.current && clearCheckedSignal > 0) {
      void handleClearChecked()
    }
    lastHandledClearSignal.current = clearCheckedSignal
  }, [clearCheckedSignal, handleClearChecked])

  const font = { fontFamily: "var(--font-system)" }

  const handleCloneItem = (id: number) => clonePackingItem(tripId, id)

  return {
    view, setView, currentUserId,
    handleCloneItem,
    tripId, items, inlineHeader, t, canEdit, font, reorderPackingItems,
    filter, setFilter, addingCategory, setAddingCategory, newCatName, setNewCatName,
    tripMembers, categoryAssignees, handleSetAssignees, allCategories, gruppiert, abgehakt, fortschritt,
    handleAddItemToCategory, handleAddNewCategory, handleRenameCategory, handleDeleteCategory, handleDeleteItem, handleClearChecked,
    bagTrackingEnabled, bags, unassignedWeightGrams, newBagName, setNewBagName, showAddBag, setShowAddBag, showBagModal, setShowBagModal,
    handleCreateBag, handleCreateBagByName, handleDeleteBag, handleUpdateBag, handleSetBagMembers,
  }
}

export type PackingState = ReturnType<typeof usePackingList>
