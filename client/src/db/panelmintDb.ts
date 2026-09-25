// The `panelmint` Dexie database — the system of record for the client-only app.
//
// offlineDb.ts is a per-user *cache* of server state: scoped database names, a
// mutation queue, eviction. This database is the opposite — one fixed name, one
// local roster, no sync machinery. With no server left, these rows ARE the
// data, so the schema mirrors the server tables the ported `api/local` code
// was written against (server/src/db/schema.ts, migrations.ts): junction
// tables keep their snake_case columns and UNIQUE constraints.
import Dexie, { type Table } from 'dexie'
import type {
  Accommodation,
  AssignmentParticipantRow,
  BudgetItem,
  BudgetSettlement,
  Category,
  Day,
  LocalUser,
  PackingBag,
  PackingBagMemberRow,
  PackingCategoryAssigneeRow,
  PackingItem,
  Place,
  Reservation,
  ReservationTravelerRow,
  Tag,
  TodoCategoryAssigneeRow,
  TodoItem,
  Trip,
  TripMember,
} from '../types'
import type { SyncMeta } from './offlineDb'

// Tile/file prefetch state for a trip — the same shape offlineDb's syncMeta
// carried (tripId, lastSyncedAt, tilesBbox, filesCachedCount, areaPlacesKey).
// Re-exported so the prefetchers rewire to this database against one
// definition instead of a drifting copy.
export type { SyncMeta }

/**
 * tripMembers links a trip to localUsers roster entries. `tripId` is the
 * Dexie-side scope key — camelCase deliberately, matching the CachedTripMember
 * convention from offlineDb so repo code ports unchanged.
 */
export interface LocalTripMember extends TripMember {
  tripId: number
}

/**
 * places gains `my_rating`: the server's per-user `place_ratings` table folds
 * into a single column when there is exactly one rater (design §4).
 */
export interface LocalPlace extends Place {
  my_rating?: number | null
}

/** settings is a plain key/value store replacing the server-backed settingsApi. */
export interface SettingsRow {
  key: string
  value: unknown
}

/**
 * The server's `budget_category_order` table: one row per (trip, category)
 * carrying the group's sort position (server schema.ts — PRIMARY KEY
 * (trip_id, category)). A surrogate `id` keeps the DexieStore seam's numeric
 * key handling intact; the UNIQUE pair rides on the `&[trip_id+category]`
 * index like the other junction tables.
 */
export interface BudgetCategoryOrderRow {
  id: number
  trip_id: number
  category: string
  sort_order: number
}

export class PanelmintDb extends Dexie {
  trips!: Table<Trip, number>
  days!: Table<Day, number>
  places!: Table<LocalPlace, number>
  packingItems!: Table<PackingItem, number>
  todoItems!: Table<TodoItem, number>
  budgetItems!: Table<BudgetItem, number>
  budgetSettlements!: Table<BudgetSettlement, number>
  budgetCategoryOrder!: Table<BudgetCategoryOrderRow, number>
  reservations!: Table<Reservation, number>
  accommodations!: Table<Accommodation, number>
  tripMembers!: Table<LocalTripMember, [number, number]>
  tags!: Table<Tag, number>
  categories!: Table<Category, number>
  localUsers!: Table<LocalUser, number>
  settings!: Table<SettingsRow, string>
  packingBags!: Table<PackingBag, number>
  packingBagMembers!: Table<PackingBagMemberRow, [number, number]>
  packingCategoryAssignees!: Table<PackingCategoryAssigneeRow, number>
  todoCategoryAssignees!: Table<TodoCategoryAssigneeRow, number>
  reservationTravelers!: Table<ReservationTravelerRow, number>
  assignmentParticipants!: Table<AssignmentParticipantRow, number>
  syncMeta!: Table<SyncMeta, number>

  constructor() {
    super('panelmint')

    // Index notes:
    // - `trip_id` on every trip-scoped table — the dominant filter, same rule
    //   offlineDb followed.
    // - `days` mirrors UNIQUE(trip_id, day_number) — the ported day-ops
    //   two-phase renumber exists precisely because that constraint holds.
    // - Junction tables mirror their server counterparts: packing_bag_members
    //   has no surrogate id (natural PK bag_id+user_id); the assignee /
    //   traveler / participant tables keep surrogate ids plus their UNIQUE
    //   grouping as a unique compound index, so the ported
    //   delete-then-INSERT-OR-IGNORE sequences keep their semantics.
    // - No `mapTiles` table: raster tiles live in the Service Worker's Cache
    //   Storage; `syncMeta` carries the prefetch bookkeeping that survives.
    this.version(1).stores({
      trips: 'id',
      days: 'id, trip_id, &[trip_id+day_number]',
      places: 'id, trip_id',
      packingItems: 'id, trip_id',
      todoItems: 'id, trip_id',
      budgetItems: 'id, trip_id',
      budgetSettlements: 'id, trip_id',
      reservations: 'id, trip_id',
      accommodations: 'id, trip_id',
      tripMembers: '[tripId+id], tripId',
      tags: 'id',
      categories: 'id',
      localUsers: 'id',
      settings: 'key',
      packingBags: 'id, trip_id',
      packingBagMembers: '[bag_id+user_id], bag_id, user_id',
      packingCategoryAssignees: 'id, trip_id, &[trip_id+category_name+user_id]',
      todoCategoryAssignees: 'id, trip_id, &[trip_id+category_name+user_id]',
      reservationTravelers: 'id, reservation_id, user_id, &[reservation_id+user_id]',
      assignmentParticipants: 'id, assignment_id, &[assignment_id+user_id]',
      syncMeta: 'tripId',
    })

    // v2 adds the budget category order — the server kept it as its own table
    // (budget_category_order, PK (trip_id, category)); folding it into
    // budget_items.sort_order can't express "an item joins an existing group
    // at its stored rank" or remember a group order after its last item is
    // deleted, so the port keeps the table verbatim.
    this.version(2).stores({
      budgetCategoryOrder: 'id, trip_id, &[trip_id+category]',
    })
  }
}

/** The single database instance every `api/local/*` module and `repo/*` uses. */
export const db = new PanelmintDb()
