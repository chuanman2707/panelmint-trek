// Shared types for the TREK travel planner.
//
// Domain entity/response types are now sourced from @trek/shared — the single
// source of truth shared with the server. The Zod schemas there are built to
// match the REAL server response shapes (see shared/src/<domain>/*.schema.ts,
// each documented against the producing service). Re-exported here so the rest
// of the client keeps importing from '../types' unchanged.
import type {
  TrekWsEventName,
  TrekWsPluginEventName,
  Trip,
  TripMember,
  Day,
  DayNote,
  Place,
  AssignmentPlace,
  PlaceCategory,
  Assignment,
  AssignmentParticipant,
  PackingItem,
  PackingBag,
  PackingBagMember,
  BudgetItem,
  BudgetItemMember,
  BudgetSettlement,
  Reservation,
  ReservationEndpoint,
  Accommodation,
  Tag,
  Category,
  AppearanceConfig,
} from '@trek/shared'

export type {
  Trip,
  TripMember,
  Day,
  DayNote,
  Place,
  AssignmentPlace,
  PlaceCategory,
  Assignment,
  AssignmentParticipant,
  PackingItem,
  PackingBag,
  PackingBagMember,
  BudgetItem,
  BudgetItemMember,
  BudgetSettlement,
  Reservation,
  ReservationEndpoint,
  Accommodation,
  Tag,
  Category,
  AppearanceConfig,
}

export interface User {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
  avatar_url: string | null
  maps_api_key: string | null
  created_at: string
  /** Present after load; true when TOTP MFA is enabled for password login */
  mfa_enabled?: boolean
  /** True when a password change is required before the user can continue */
  must_change_password?: boolean
}

export interface TodoItem {
  id: number
  trip_id: number
  name: string
  category: string | null
  checked: number
  sort_order: number
  due_date: string | null
  description: string | null
  assigned_user_id: number | null
  priority: number
  /** The server's created_at column — `SELECT *` carried it and the list
   *  orders by it; older local rows may lack it. */
  created_at?: string
}

export type DistanceUnit = 'metric' | 'imperial'

export interface Settings {
  map_tile_url: string
  /**
   * Base URL of a self-hosted routing engine (#1797). Empty falls back to the public
   * FOSSGIS hosts, which allow about one request a second.
   */
  routing_base_url?: string
  /**
   * Base URL of the Valhalla asked for the avoidance questions OSRM cannot answer.
   * Undefined means the public FOSSGIS instance TREK ships with; empty means an
   * operator turned the second engine off and "other ways" goes back to OSRM alone.
   */
  valhalla_base_url?: string
  dark_mode: boolean | string
  /** Display currency for Costs. Empty/null = follow each trip's own currency. */
  default_currency: string | null
  language: string
  temperature_unit: string
  distance_unit?: DistanceUnit
  time_format: string
  show_place_description: boolean
  blur_booking_codes?: boolean
  map_booking_labels?: boolean
  map_poi_pill_enabled?: boolean
  map_always_show_routes?: boolean
  optimize_from_accommodation?: boolean
  /** Leaflet base layer: default street tiles or a satellite/aerial view. */
  map_base_layer?: 'default' | 'satellite'
  /** CARTO basemaps watermark keyless tiles; the key is appended as ?key= (#2054). */
  carto_api_key?: string
  // Dashboard widget prefs — persisted so a reinstall/refresh keeps them (#1311).
  dashboard_fx_from?: string
  dashboard_fx_to?: string
  dashboard_timezones?: string[]
  /** Where opening TREK lands: the dashboard, or straight in the active trip. */
  start_page?: 'dashboard' | 'active_trip'
  /** Which planner tab 'active_trip' opens on — a TripTabId (constants/tripTabs). */
  start_trip_tab?: string
  /** Per-user appearance/customization config (theming, transparency, typography, dashboard widgets). */
  appearance?: AppearanceConfig
}

export interface AssignmentsMap {
  [dayId: string]: Assignment[]
}

export interface DayNotesMap {
  [dayId: string]: DayNote[]
}

export interface RouteSegment {
  mid: [number, number]
  from: [number, number]
  to: [number, number]
  distance: number
  duration: number
  walkingText: string
  drivingText: string
  distanceText: string
  durationText?: string
  /** Extra text a plugin route attached to this leg (e.g. "25 min charge"). */
  noteText?: string
  /** The travel mode this leg was routed with (#1281) — drives the connector icon. */
  mode?: string
}

/** An intermediate stop a plugin route places on the drawn line (charging stop, rest area). */
export interface RouteVia {
  hoverCard?: boolean
  nightPause?: { day: number; atPlace: boolean; position?: number; manual?: boolean; minPosition?: number; maxPosition?: number }
  lat: number
  lng: number
  label?: string
  tone: 'default' | 'success' | 'warn' | 'danger'
  dwellSeconds?: number
}

/**
 * Where the router put a waypoint we asked about, and how far that is from where we asked.
 *
 * Every routing engine snaps a coordinate to the nearest road before it starts, and OSRM
 * does it with no distance limit at all. A place set back from the road — a viewpoint, a
 * farmhouse, a marina — is therefore driven to from somewhere else entirely, and the drawn
 * line starts at that somewhere else without saying so.
 */
export interface SnappedWaypoint {
  /** The coordinate that was asked for, unchanged. */
  asked: [number, number]
  /** The point on the road network the router actually used. */
  at: [number, number]
  /** Straight-line metres between the two. */
  meters: number
}

export interface RouteWithLegs {
  coordinates: [number, number][]
  distance: number
  duration: number
  legs: RouteSegment[]
  /** Present on plugin-provided routes only. */
  vias?: RouteVia[]
  /** One entry per REQUESTED waypoint, in request order. Absent on plugin routes. */
  snapped?: SnappedWaypoint[]
  /**
   * What was asked to be left out, and what the road actually left out.
   *
   * The two differ, and that is the point. Valhalla weights a class away rather than
   * banning it, so a drive with no untolled connection comes back on a toll road and
   * says so. Present only on a route that was asked to avoid something, so `undefined`
   * means the question was never put rather than "avoided nothing".
   */
  avoidance?: { asked: RouteAvoidClass[]; achieved: RouteAvoidClass[] }
}

/** A road class a route can be asked to leave out. */
export type RouteAvoidClass = 'motorway' | 'toll' | 'ferry'

export interface RouteResult {
  coordinates: [number, number][]
  distance: number
  duration: number
  distanceText: string
  durationText: string
  walkingText: string
  drivingText: string
}

export interface Waypoint {
  lat: number
  lng: number
}

// Optional fixed start/end points for route optimization (e.g. the day's accommodation).
export interface RouteAnchors {
  start?: Waypoint
  end?: Waypoint
}

// Translation function type
export type TranslationFn = (key: string, params?: Record<string, string | number | null>) => string

// WebSocket event type — `type` is derived from the shared WS event registry
// (TREK_WS_EVENTS): a registered name, the reserved plugin namespace, or (via
// the `string & {}` widening) a transport control frame the registry
// deliberately excludes (welcome/joined/left/error). Payload fields stay
// index-typed at this boundary; per-event payload contracts live in
// TrekWsPayload<E> from @trek/shared.
export interface WebSocketEvent {
  type: TrekWsEventName | TrekWsPluginEventName | (string & {})
  [key: string]: unknown
}

// MergedItem used in day notes hook
export interface MergedItem {
  type: 'assignment' | 'note' | 'place' | 'transport'
  sortKey: number
  data: Assignment | DayNote | Reservation
}

// ── PanelMint local-database rows ────────────────────────────────────────────
// Types for the `panelmint` Dexie database (src/db/panelmintDb.ts) — the system
// of record now that there is no server. Junction rows mirror the columns of
// the server tables they replace (server/src/db/schema.ts / migrations.ts), so
// ported code maps onto them field-for-field; snake_case is deliberate.

/** The local roster: the seeded self profile plus named guests created in the
 *  member/traveler/payer pickers. `is_self` marks the single self row (id 1)
 *  the way the server's users table marked the account owner. */
export interface LocalUser {
  id: number
  name: string
  is_self: 0 | 1
  /** Guests carry the `guest-*@guests.invalid` placeholder the server's users
   *  row generated — surfaced by the member list the way the server emitted it. */
  email?: string
}

/** packing_bag_members — PRIMARY KEY (bag_id, user_id), no surrogate id. */
export interface PackingBagMemberRow {
  bag_id: number
  user_id: number
}

/** packing_category_assignees — UNIQUE(trip_id, category_name, user_id). */
export interface PackingCategoryAssigneeRow {
  id: number
  trip_id: number
  category_name: string
  user_id: number
}

/** todo_category_assignees — UNIQUE(trip_id, category_name, user_id). */
export interface TodoCategoryAssigneeRow {
  id: number
  trip_id: number
  category_name: string
  user_id: number
}

/** reservation_travelers — UNIQUE(reservation_id, user_id). */
export interface ReservationTravelerRow {
  id: number
  reservation_id: number
  user_id: number
}

/** assignment_participants — UNIQUE(assignment_id, user_id). */
export interface AssignmentParticipantRow {
  id: number
  assignment_id: number
  user_id: number
}
