import { create } from 'zustand'
import type { StoreApi } from 'zustand'
import { tripsApi, tagsApi, categoriesApi } from '../api/client'
import { tripRepo } from '../repo/tripRepo'
import { dayRepo } from '../repo/dayRepo'
import { placeRepo } from '../repo/placeRepo'
import { packingRepo } from '../repo/packingRepo'
import { todoRepo } from '../repo/todoRepo'
import { budgetRepo } from '../repo/budgetRepo'
import { reservationRepo } from '../repo/reservationRepo'
import { createPlacesSlice } from './slices/placesSlice'
import { createAssignmentsSlice } from './slices/assignmentsSlice'
import { createDaysSlice } from './slices/daysSlice'
import { createDayNotesSlice } from './slices/dayNotesSlice'
import { createPackingSlice } from './slices/packingSlice'
import { createTodoSlice } from './slices/todoSlice'
import { createBudgetSlice } from './slices/budgetSlice'
import { createReservationsSlice } from './slices/reservationsSlice'
import { handleRemoteEvent } from './slices/remoteEventHandler'
import type { TrekWsTripEventName } from '@trek/shared'
import type {
  Trip, Day, Place, Assignment, DayNote, PackingItem, TodoItem,
  Tag, Category, BudgetItem, Reservation,
  AssignmentsMap, DayNotesMap, WebSocketEvent,
} from '../types'
import { getApiErrorMessage } from '../types'
import type { PlacesSlice } from './slices/placesSlice'
import type { AssignmentsSlice } from './slices/assignmentsSlice'
import type { DaysSlice } from './slices/daysSlice'
import type { DayNotesSlice } from './slices/dayNotesSlice'
import type { PackingSlice } from './slices/packingSlice'
import type { TodoSlice } from './slices/todoSlice'
import type { BudgetSlice } from './slices/budgetSlice'
import type { ReservationsSlice } from './slices/reservationsSlice'

export interface TripStoreState
  extends PlacesSlice,
    AssignmentsSlice,
    DaysSlice,
    DayNotesSlice,
    PackingSlice,
    TodoSlice,
    BudgetSlice,
    ReservationsSlice {
  trip: Trip | null
  days: Day[]
  places: Place[]
  assignments: AssignmentsMap
  dayNotes: DayNotesMap
  packingItems: PackingItem[]
  todoItems: TodoItem[]
  tags: Tag[]
  categories: Category[]
  budgetItems: BudgetItem[]
  reservations: Reservation[]
  selectedDayId: number | null
  // Places filter (list + map markers). Lives here, not in the sidebar, so the
  // applied filter and the filter UI can never drift apart when the Plan tab
  // unmounts and remounts (#1541).
  placesFilter: string
  placesCategoryFilter: Set<string>
  isLoading: boolean
  error: string | null

  setSelectedDay: (dayId: number | null) => void
  setPlacesFilter: (filter: string) => void
  setPlacesCategoryFilter: (categoryIds: Set<string>) => void
  handleRemoteEvent: (event: WebSocketEvent) => void
  /**
   * The local-mode counterpart of the socket echo: replays the effect a local
   * `api/local/*` adapter returned (its side-channel fields are the payloads
   * the server used to broadcast) through `handleRemoteEvent`, so the store
   * update and the Dexie write-through are the same code path a remote event
   * would have taken. Callers without `get()` import the bound
   * `applyLocalEffect` from './localEffects' — same method, one mechanism.
   */
  applyLocalEffect: (type: TrekWsTripEventName, payload?: object | null) => void
  resetTrip: () => void
  loadTrip: (tripId: number | string) => Promise<void>
  hydrateActiveTrip: (tripId: number | string) => Promise<void>
  refreshDays: (tripId: number | string) => Promise<void>
  updateTrip: (tripId: number | string, data: Partial<Trip> & { date_shift_mode?: 'keep_bookings' | 'shift_all' }) => Promise<Trip>
  addTag: (data: Partial<Tag> & { name: string }) => Promise<Tag>
}

export const useTripStore = create<TripStoreState>((set, get) => ({
  trip: null,
  days: [],
  places: [],
  assignments: {},
  dayNotes: {},
  packingItems: [],
  todoItems: [],
  tags: [],
  categories: [],
  budgetItems: [],
  reservations: [],
  selectedDayId: null,
  placesFilter: 'all',
  placesCategoryFilter: new Set<string>(),
  isLoading: false,
  error: null,

  setSelectedDay: (dayId: number | null) => set({ selectedDayId: dayId }),
  setPlacesFilter: (filter: string) => set({ placesFilter: filter }),
  setPlacesCategoryFilter: (categoryIds: Set<string>) => set({ placesCategoryFilter: categoryIds }),

  handleRemoteEvent: (event: WebSocketEvent) => handleRemoteEvent(set, get, event),
  applyLocalEffect: (type, payload = {}) =>
    handleRemoteEvent(set, get, { type, ...((payload ?? {}) as Record<string, unknown>) }),

  // Clear every trip-scoped slice so switching trips (or losing access to one)
  // can never leave a previous trip's data visible. Global tags/categories are
  // left intact. Called at the top of loadTrip.
  resetTrip: () => set({
    trip: null,
    days: [],
    places: [],
    assignments: {},
    dayNotes: {},
    packingItems: [],
    todoItems: [],
    budgetItems: [],
    reservations: [],
    selectedDayId: null,
    placesFilter: 'all',
    placesCategoryFilter: new Set<string>(),
    error: null,
  }),

  loadTrip: async (tripId: number | string) => {
    get().resetTrip()
    set({ isLoading: true, error: null })
    try {
      const [tripData, daysData, placesData, packingData, todoData, budgetData, reservationsData, tagsData, categoriesData] = await Promise.all([
        tripRepo.get(tripId),
        dayRepo.list(tripId),
        placeRepo.list(tripId),
        packingRepo.list(tripId),
        todoRepo.list(tripId),
        // Budget / reservations are hydrated here too so the offline
        // path is uniform (no separate tab-gated effects). Non-fatal: a failure
        // in any of these must not blank the whole trip.
        budgetRepo.list(tripId).catch(() => ({ items: [] as BudgetItem[] })),
        reservationRepo.list(tripId).catch(() => ({ reservations: [] as Reservation[] })),
        // Tags and categories are local Dexie reads like the rest — no online
        // gate, and a failure is non-fatal (the pickers they feed recover on
        // the next loadTrip).
        tagsApi.list().catch(() => ({ tags: [] as Tag[] })),
        categoriesApi.list().catch(() => ({ categories: [] as Category[] })),
      ])

      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }

      set({
        trip: tripData.trip,
        days: daysData.days,
        places: placesData.places,
        assignments: assignmentsMap,
        dayNotes: dayNotesMap,
        packingItems: packingData.items,
        todoItems: todoData.items,
        budgetItems: budgetData.items,
        reservations: reservationsData.reservations,
        tags: tagsData.tags,
        categories: categoriesData.categories,
        isLoading: false,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      set({ isLoading: false, error: message })
      throw err
    }
  },

  // Silently re-fetch the active trip's collaborative state into the store after
  // the network comes back (WS reconnect or `online` event) so edits missed while
  // offline appear in place — no splash, no resetTrip. Each resource is
  // best-effort; a failure on one must not wipe the others.
  hydrateActiveTrip: async (tripId: number | string) => {
    await Promise.all([
      get().refreshDays(tripId),
      placeRepo.list(tripId).then(d => set({ places: d.places })).catch(() => {}),
      packingRepo.list(tripId).then(d => set({ packingItems: d.items })).catch(() => {}),
      todoRepo.list(tripId).then(d => set({ todoItems: d.items })).catch(() => {}),
      get().loadBudgetItems(tripId),
      get().loadReservations(tripId),
    ])
    // Accommodations live in planner-local state, not this store — nudge the
    // planner to reload them too (e.g. a trip date change made while offline).
    window.dispatchEvent(new CustomEvent('accommodations:refresh'))
  },

  refreshDays: async (tripId: number | string) => {
    try {
      const daysData = await dayRepo.list(tripId)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
    } catch (err: unknown) {
      console.error('Failed to refresh days:', err)
    }
  },

  updateTrip: async (tripId: number | string, data: Partial<Trip> & { date_shift_mode?: 'keep_bookings' | 'shift_all' }) => {
    try {
      const result = await tripsApi.update(tripId, data)
      set({ trip: result.trip })
      const daysData = await dayRepo.list(tripId)
      const assignmentsMap: AssignmentsMap = {}
      const dayNotesMap: DayNotesMap = {}
      for (const day of daysData.days) {
        assignmentsMap[String(day.id)] = day.assignments || []
        dayNotesMap[String(day.id)] = day.notes_items || []
      }
      set({ days: daysData.days, assignments: assignmentsMap, dayNotes: dayNotesMap })
      // A date change re-anchors bookings server-side (#1288); the socket echo is
      // suppressed for this client, so pull the fresh reservations here.
      await get().loadReservations(tripId)
      return result.trip
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error updating trip'))
    }
  },

  addTag: async (data: Partial<Tag> & { name: string }) => {
    try {
      const result = await tagsApi.create(data)
      set((state) => ({ tags: [...state.tags, result.tag] }))
      return result.tag
    } catch (err: unknown) {
      throw new Error(getApiErrorMessage(err, 'Error creating tag'))
    }
  },

  ...createPlacesSlice(set, get),
  ...createAssignmentsSlice(set, get),
  ...createDaysSlice(set, get),
  ...createDayNotesSlice(set, get),
  ...createPackingSlice(set, get),
  ...createTodoSlice(set, get),
  ...createBudgetSlice(set, get),
  ...createReservationsSlice(set, get),
}))
