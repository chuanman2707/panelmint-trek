// FE-APISURF-001 to FE-APISURF-057
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AxiosResponse } from 'axios'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { db } from '../db/panelmintDb'
import { buildDay, buildBudgetItem, buildPlace, buildReservation, buildTag, buildTrip } from '../../tests/helpers/factories'
import type { DayRow, StoredAssignment } from './local/dexieStore'
import type { LocalTripMember } from '../db/panelmintDb'
import { clearWeatherCache } from './ext/openmeteo'

// tripsApi's currency rebase and budgetApi's FX freeze fetch live rates for
// their transactions — keep the surface suite offline.
vi.mock('./ext/fx', () => ({ fetchExchangeRates: vi.fn().mockResolvedValue(null) }))
import {
  apiClient,
  tripsApi, daysApi, placesApi, assignmentsApi, packingApi, todoApi,
  tagsApi, categoriesApi,
  airportsApi, budgetApi, filesApi, reservationsApi, weatherApi,
  accommodationsApi, dayNotesApi, usersApi,
} from './client'
import { fetchExchangeRates } from './ext/fx'

interface Recorded { method: string; url: string; body: unknown }

let log: Recorded[] = []

/** One record per outgoing request: verb, path+query and (parsed) JSON body. */
function recorder() {
  return http.all(/\/api\//, async ({ request }) => {
    const url = new URL(request.url)
    const raw = await request.text()
    let body: unknown
    if (raw) {
      try { body = JSON.parse(raw) } catch { body = raw }
    }
    log.push({ method: request.method, url: url.pathname + url.search, body })
    return HttpResponse.json({ ok: true })
  })
}

beforeEach(async () => {
  log = []
  server.use(recorder())
  // parseInDev/checkInDev warn on every stub payload that doesn't match its
  // @trek/shared schema — expected here, so keep the output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // tripsApi/daysApi are the Dexie-backed local adapters — start every test
  // from a clean `panelmint` db with just the self roster row.
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear()
  })
  await db.localUsers.put({ id: 1, name: 'Me', is_self: 1 })
  // The ported Open-Meteo module caches answers module-wide — a response one
  // case fetches must not leak into the next.
  clearWeatherCache()
})

/** Trip 3 owned by self + three day rows on trip 1 for the nested-day calls. */
async function seedTripAndDays() {
  await db.trips.put(buildTrip({ id: 3 }))
  await db.trips.put(buildTrip({ id: 1 }))
  await db.days.bulkPut([1, 2, 3].map((i) => ({
    ...buildDay({ id: i, trip_id: 1, day_number: i, date: `2025-06-0${i}` }),
    vias: [],
  })) as DayRow[])
}

/** A roster member row (guest or second profile) on trip 3. */
async function seedMemberRow(userId: number, name: string, isSelf: 0 | 1, email?: string) {
  await db.localUsers.put({ id: userId, name, is_self: isSelf, email })
  await db.tripMembers.put({
    tripId: 3, id: userId, username: name, role: 'member',
    added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: isSelf !== 1,
  } as LocalTripMember)
}

afterEach(() => {
  vi.restoreAllMocks()
})

interface Call { n: string; r: () => Promise<unknown>; e: string }

/**
 * Runs every call in isolation and checks the verb + path it produced.
 * `e === 'local'` marks a Dexie-backed tripsApi/daysApi call: it must resolve
 * and emit ZERO HTTP requests — that is the wiring contract post-migration.
 */
async function assertCalls(calls: Call[]): Promise<void> {
  for (const c of calls) {
    log = []
    await c.r()
    if (c.e === 'local') {
      expect(log.length, `${c.n}: local adapter emitted an HTTP request`).toBe(0)
      continue
    }
    expect(log.length, `${c.n}: expected exactly one request`).toBe(1)
    const rec = log[0]
    const [path] = rec.url.split('?')
    expect(`${rec.method} ${path}`, c.n).toBe(c.e)
  }
}

/** Runs one call and returns the request it produced. */
async function traceOne(run: () => Promise<unknown>): Promise<Recorded> {
  log = []
  await run()
  expect(log).toHaveLength(1)
  return log[0]
}

describe('client > endpoint wiring', () => {
  it('FE-APISURF-003: tripsApi covers the trip, member and guest surface locally', async () => {
    // Every call resolves against the seeded panelmint db and emits no HTTP —
    // the pre-migration version asserted verb+path on /api/trips*.
    await assertCalls([
      { n: 'list', r: () => tripsApi.list(), e: 'local' },
      { n: 'create', r: () => tripsApi.create({ title: 'Rome' }), e: 'local' },
      { n: 'get', r: async () => { await seedTripAndDays(); return tripsApi.get(3) }, e: 'local' },
      { n: 'update', r: async () => { await seedTripAndDays(); return tripsApi.update(3, { title: 'Rome 2' }) }, e: 'local' },
      { n: 'delete', r: async () => { await seedTripAndDays(); return tripsApi.delete(3) }, e: 'local' },
      { n: 'searchCoverImages', r: () => tripsApi.searchCoverImages('rome'), e: 'local' },
      { n: 'archive', r: async () => { await seedTripAndDays(); return tripsApi.archive(3) }, e: 'local' },
      { n: 'unarchive', r: async () => { await seedTripAndDays(); return tripsApi.unarchive(3) }, e: 'local' },
      { n: 'getMembers', r: async () => { await seedTripAndDays(); return tripsApi.getMembers(3) }, e: 'local' },
      // addMember resolves a roster row by name — 'bob' must exist as a
      // non-guest localUser (locally the only non-guest rows are self-type).
      {
        n: 'addMember',
        r: async () => {
          await seedTripAndDays()
          await db.localUsers.put({ id: 9, name: 'bob', is_self: 1 })
          return tripsApi.addMember(3, 'bob')
        },
        e: 'local',
      },
      { n: 'removeMember', r: async () => { await seedTripAndDays(); await seedMemberRow(9, 'bob', 0); return tripsApi.removeMember(3, 9) }, e: 'local' },
      {
        n: 'transferOwnership',
        r: async () => {
          await seedTripAndDays()
          await seedMemberRow(9, 'bob', 1)
          return tripsApi.transferOwnership(3, 9)
        },
        e: 'local',
      },
      // The guest roster moved to usersApi — the member surface of it.
      { n: 'users.list', r: async () => { await seedTripAndDays(); return usersApi.list(3) }, e: 'local' },
      { n: 'users.create', r: async () => { await seedTripAndDays(); return usersApi.create(3, 'Anna') }, e: 'local' },
      { n: 'users.rename', r: async () => { await seedTripAndDays(); await seedMemberRow(9, 'Anna', 0); return usersApi.rename(3, 9, 'Ana') }, e: 'local' },
      { n: 'users.delete', r: async () => { await seedTripAndDays(); await seedMemberRow(9, 'Anna', 0); return usersApi.delete(3, 9) }, e: 'local' },
      { n: 'copy', r: async () => { await seedTripAndDays(); return tripsApi.copy(3, { title: 'Copy' }) }, e: 'local' },
      { n: 'bundle', r: async () => { await seedTripAndDays(); return tripsApi.bundle(3) }, e: 'local' },
    ])
  })

  it('FE-APISURF-004: daysApi runs locally while dayNotesApi maps its nested endpoints', async () => {
    await assertCalls([
      { n: 'days.list', r: async () => { await seedTripAndDays(); return daysApi.list(1) }, e: 'local' },
      { n: 'days.create', r: async () => { await seedTripAndDays(); return daysApi.create(1, { date: '2026-06-01' }) }, e: 'local' },
      { n: 'days.update', r: async () => { await seedTripAndDays(); return daysApi.update(1, 2, { notes: 'hi' }) }, e: 'local' },
      { n: 'days.updateTransport', r: async () => { await seedTripAndDays(); return daysApi.updateTransport(1, 2, 'car') }, e: 'local' },
      { n: 'days.delete', r: async () => { await seedTripAndDays(); return daysApi.delete(1, 2) }, e: 'local' },
      {
        n: 'days.reorder',
        // Earlier runners in this test created/deleted rows — reorder wants a
        // full permutation of whatever trip 1 holds right now.
        r: async () => {
          await seedTripAndDays()
          const ids = (await db.days.where('trip_id').equals(1).toArray()).map((d) => d.id).reverse()
          return daysApi.reorder(1, ids)
        },
        e: 'local',
      },
      { n: 'dayNotes.list', r: () => dayNotesApi.list(1, 2), e: 'GET /api/trips/1/days/2/notes' },
      { n: 'dayNotes.create', r: () => dayNotesApi.create(1, 2, { text: 'note' }), e: 'POST /api/trips/1/days/2/notes' },
      { n: 'dayNotes.update', r: () => dayNotesApi.update(1, 2, 5, { text: 'edit' }), e: 'PUT /api/trips/1/days/2/notes/5' },
      { n: 'dayNotes.delete', r: () => dayNotesApi.delete(1, 2, 5), e: 'DELETE /api/trips/1/days/2/notes/5' },
    ])
  })

  it('FE-APISURF-005: placesApi runs locally (Dexie-backed, zero HTTP)', async () => {
    // The adapter's own suite pins method behavior; here we only assert that
    // the facade resolves without touching the axios layer.
    const seedTrip = () => db.trips.put(buildTrip({ id: 1 }))
    await seedTrip()
    await assertCalls([
      { n: 'list', r: () => placesApi.list(1), e: 'local' },
      { n: 'bulkDelete', r: () => placesApi.bulkDelete(1, []), e: 'local' },
      { n: 'bulkUpdate', r: () => placesApi.bulkUpdate(1, [], { category_id: 2 }), e: 'local' },
    ])
  })

  it('FE-APISURF-006: assignmentsApi runs locally (Dexie-backed, zero HTTP)', async () => {
    // The adapter's own suite (tests/unit/local/assignments.test.ts) pins
    // envelopes, guards and the updateTime side channels; here each method
    // only has to resolve over seeded rows without emitting a request.
    const seedAssignmentWorld = async () => {
      await seedTripAndDays() // trips 1+3; days 1,2,3 on trip 1
      await db.places.put(buildPlace({ id: 5, trip_id: 1 }))
      const day = (await db.days.get(2)) as DayRow
      day.assignments = [{
        id: 7, day_id: 2, place_id: 5, order_index: 0, notes: null,
        reservation_status: 'none', reservation_notes: null, reservation_datetime: null,
        assignment_time: null, assignment_end_time: null, end_day: 0,
        accommodation_id: null, leg_transport_mode: null, incoming_leg_transport_mode: null,
        created_at: '2025-01-01T00:00:00.000Z',
      } as StoredAssignment] as never
      await db.days.put(day)
    }
    await assertCalls([
      { n: 'list', r: async () => { await seedAssignmentWorld(); return assignmentsApi.list(1, 2) }, e: 'local' },
      { n: 'create', r: async () => { await seedAssignmentWorld(); return assignmentsApi.create(1, 2, { place_id: 5 }) }, e: 'local' },
      { n: 'delete', r: async () => { await seedAssignmentWorld(); return assignmentsApi.delete(1, 2, 7) }, e: 'local' },
      { n: 'reorder', r: async () => { await seedAssignmentWorld(); return assignmentsApi.reorder(1, 2, [7, 8]) }, e: 'local' },
      { n: 'move', r: async () => { await seedAssignmentWorld(); return assignmentsApi.move(1, 7, 3, 0) }, e: 'local' },
      { n: 'update', r: async () => { await seedAssignmentWorld(); return assignmentsApi.update(1, 2, 7, { notes: 'x' }) }, e: 'local' },
      { n: 'getParticipants', r: async () => { await seedAssignmentWorld(); return assignmentsApi.getParticipants(1, 7) }, e: 'local' },
      { n: 'setParticipants', r: async () => { await seedAssignmentWorld(); return assignmentsApi.setParticipants(1, 7, [4]) }, e: 'local' },
      { n: 'updateTime', r: async () => { await seedAssignmentWorld(); return assignmentsApi.updateTime(1, 7, { place_time: '09:00' }) }, e: 'local' },
      { n: 'updateTransport', r: async () => { await seedAssignmentWorld(); return assignmentsApi.updateTransport(1, 7, null) }, e: 'local' },
      { n: 'updateNotes', r: async () => { await seedAssignmentWorld(); return assignmentsApi.updateNotes(1, 7, { notes: 'n' }) }, e: 'local' },
      { n: 'setEndDay', r: async () => { await seedAssignmentWorld(); return assignmentsApi.setEndDay(1, 7, { end_day: true }) }, e: 'local' },
    ])
  })

  it('FE-APISURF-007: packingApi maps item, bag and template endpoints', async () => {
    await assertCalls([
      { n: 'list', r: () => packingApi.list(1), e: 'GET /api/trips/1/packing' },
      { n: 'create', r: () => packingApi.create(1, { name: 'Towel' }), e: 'POST /api/trips/1/packing' },
      { n: 'bulkImport', r: () => packingApi.bulkImport(1, [{ name: 'Socks' }]), e: 'POST /api/trips/1/packing/import' },
      { n: 'update', r: () => packingApi.update(1, 4, { checked: true }), e: 'PUT /api/trips/1/packing/4' },
      { n: 'delete', r: () => packingApi.delete(1, 4), e: 'DELETE /api/trips/1/packing/4' },
      { n: 'reorder', r: () => packingApi.reorder(1, [4, 5]), e: 'PUT /api/trips/1/packing/reorder' },
      { n: 'setSharing', r: () => packingApi.setSharing(1, 4, { visibility: 'shared' }), e: 'PUT /api/trips/1/packing/4/sharing' },
      { n: 'clone', r: () => packingApi.clone(1, 4), e: 'POST /api/trips/1/packing/4/clone' },
      { n: 'addContributor', r: () => packingApi.addContributor(1, 4), e: 'POST /api/trips/1/packing/4/contributors' },
      { n: 'removeContributor', r: () => packingApi.removeContributor(1, 4, 9), e: 'DELETE /api/trips/1/packing/4/contributors/9' },
      { n: 'getCategoryAssignees', r: () => packingApi.getCategoryAssignees(1), e: 'GET /api/trips/1/packing/category-assignees' },
      { n: 'listTemplates', r: () => packingApi.listTemplates(1), e: 'GET /api/trips/1/packing/templates' },
      { n: 'applyTemplate', r: () => packingApi.applyTemplate(1, 6), e: 'POST /api/trips/1/packing/apply-template/6' },
      { n: 'saveAsTemplate', r: () => packingApi.saveAsTemplate(1, 'Beach'), e: 'POST /api/trips/1/packing/save-as-template' },
      { n: 'setBagMembers', r: () => packingApi.setBagMembers(1, 2, [9]), e: 'PUT /api/trips/1/packing/bags/2/members' },
      { n: 'listBags', r: () => packingApi.listBags(1), e: 'GET /api/trips/1/packing/bags' },
      { n: 'createBag', r: () => packingApi.createBag(1, { name: 'Carry-on' }), e: 'POST /api/trips/1/packing/bags' },
      { n: 'updateBag', r: () => packingApi.updateBag(1, 2, { name: 'Hold' }), e: 'PUT /api/trips/1/packing/bags/2' },
      { n: 'deleteBag', r: () => packingApi.deleteBag(1, 2), e: 'DELETE /api/trips/1/packing/bags/2' },
    ])
  })

  it('FE-APISURF-008: todoApi maps todo endpoints', async () => {
    await assertCalls([
      { n: 'list', r: () => todoApi.list(1), e: 'GET /api/trips/1/todo' },
      { n: 'create', r: () => todoApi.create(1, { name: 'Book train' }), e: 'POST /api/trips/1/todo' },
      { n: 'update', r: () => todoApi.update(1, 3, { checked: true }), e: 'PUT /api/trips/1/todo/3' },
      { n: 'delete', r: () => todoApi.delete(1, 3), e: 'DELETE /api/trips/1/todo/3' },
      { n: 'reorder', r: () => todoApi.reorder(1, [3, 4]), e: 'PUT /api/trips/1/todo/reorder' },
      { n: 'getCategoryAssignees', r: () => todoApi.getCategoryAssignees(1), e: 'GET /api/trips/1/todo/category-assignees' },
    ])
  })

  it('FE-APISURF-009: tagsApi and categoriesApi run locally (zero HTTP)', async () => {
    // tagsApi is Dexie-backed now ('local' = resolves with zero HTTP requests);
    // update/delete need a self-owned row to act on, so seed it first.
    // categoriesApi is a seeded read palette — mutations reject local 403, so
    // only list is exercised here; the adapter's own suite pins the rest.
    const seedTag = () => db.tags.put(buildTag({ id: 2, user_id: 1 }))
    await assertCalls([
      { n: 'tags.list', r: () => tagsApi.list(), e: 'local' },
      { n: 'tags.create', r: () => tagsApi.create({ name: 'Food' }), e: 'local' },
      { n: 'tags.update', r: async () => { await seedTag(); return tagsApi.update(2, { name: 'Eat' }) }, e: 'local' },
      { n: 'tags.delete', r: async () => { await seedTag(); return tagsApi.delete(2) }, e: 'local' },
      { n: 'categories.list', r: () => categoriesApi.list(), e: 'local' },
    ])
  })

  it('FE-APISURF-016: airportsApi reads the bundled dataset', async () => {
    await assertCalls([
      // airportsApi reads the bundled dataset (src/data/airports.json) — BER is
      // a real row, so both calls resolve with no request at all.
      { n: 'airports.search', r: () => airportsApi.search('BER'), e: 'local' },
      { n: 'airports.byIata', r: () => airportsApi.byIata('BER'), e: 'local' },
    ])
  })

  it('FE-APISURF-017: budgetApi runs locally (Dexie-backed, zero HTTP)', async () => {
    // The adapter's own suite (tests/unit/local/budget.test.ts) pins envelopes,
    // the ledger arithmetic and error strings; here each method only has to
    // resolve over seeded rows without emitting a request.
    const seedBudgetWorld = async () => {
      await db.trips.put(buildTrip({ id: 1 }))
      await db.localUsers.put({ id: 4, name: 'ann', is_self: 0 })
      await db.tripMembers.put({
        tripId: 1, id: 4, username: 'ann', role: 'member',
        added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
      } as LocalTripMember)
      await db.budgetItems.put(buildBudgetItem({ id: 2, trip_id: 1, members: [{ user_id: 4, paid: 0, amount: null, username: 'ann' }] }))
      await db.budgetSettlements.put({
        id: 6, trip_id: 1, from_user_id: 4, to_user_id: 1, amount: 5,
        created_at: '2025-01-01T00:00:00.000Z',
      } as never)
    }
    await assertCalls([
      { n: 'list', r: async () => { await seedBudgetWorld(); return budgetApi.list(1) }, e: 'local' },
      { n: 'create', r: async () => { await seedBudgetWorld(); return budgetApi.create(1, { name: 'Hotel' }) }, e: 'local' },
      { n: 'update', r: async () => { await seedBudgetWorld(); return budgetApi.update(1, 2, { name: 'Hostel' }) }, e: 'local' },
      { n: 'delete', r: async () => { await seedBudgetWorld(); return budgetApi.delete(1, 2) }, e: 'local' },
      { n: 'setMembers', r: async () => { await seedBudgetWorld(); return budgetApi.setMembers(1, 2, [4]) }, e: 'local' },
      { n: 'togglePaid', r: async () => { await seedBudgetWorld(); return budgetApi.togglePaid(1, 2, 4, true) }, e: 'local' },
      { n: 'setPayers', r: async () => { await seedBudgetWorld(); return budgetApi.setPayers(1, 2, [{ user_id: 4, amount: 10 }]) }, e: 'local' },
      { n: 'perPersonSummary', r: async () => { await seedBudgetWorld(); return budgetApi.perPersonSummary(1) }, e: 'local' },
      { n: 'settlement', r: async () => { await seedBudgetWorld(); return budgetApi.settlement(1) }, e: 'local' },
      { n: 'createSettlement', r: async () => { await seedBudgetWorld(); return budgetApi.createSettlement(1, { from_user_id: 4, to_user_id: 1, amount: 10 }) }, e: 'local' },
      { n: 'updateSettlement', r: async () => { await seedBudgetWorld(); return budgetApi.updateSettlement(1, 6, { from_user_id: 4, to_user_id: 1, amount: 12 }) }, e: 'local' },
      { n: 'deleteSettlement', r: async () => { await seedBudgetWorld(); return budgetApi.deleteSettlement(1, 6) }, e: 'local' },
      { n: 'reorderItems', r: async () => { await seedBudgetWorld(); return budgetApi.reorderItems(1, [2, 3]) }, e: 'local' },
      { n: 'reorderCategories', r: async () => { await seedBudgetWorld(); return budgetApi.reorderCategories(1, ['Food']) }, e: 'local' },
    ])
  })

  it('FE-APISURF-018: filesApi maps file, trash and link endpoints', async () => {
    await assertCalls([
      { n: 'list', r: () => filesApi.list(1), e: 'GET /api/trips/1/files' },
      { n: 'update', r: () => filesApi.update(1, 3, { description: 'x' }), e: 'PUT /api/trips/1/files/3' },
      { n: 'delete', r: () => filesApi.delete(1, 3), e: 'DELETE /api/trips/1/files/3' },
      { n: 'toggleStar', r: () => filesApi.toggleStar(1, 3), e: 'PATCH /api/trips/1/files/3/star' },
      { n: 'restore', r: () => filesApi.restore(1, 3), e: 'POST /api/trips/1/files/3/restore' },
      { n: 'permanentDelete', r: () => filesApi.permanentDelete(1, 3), e: 'DELETE /api/trips/1/files/3/permanent' },
      { n: 'emptyTrash', r: () => filesApi.emptyTrash(1), e: 'DELETE /api/trips/1/files/trash/empty' },
      { n: 'addLink', r: () => filesApi.addLink(1, 3, { place_id: 5 }), e: 'POST /api/trips/1/files/3/link' },
      { n: 'removeLink', r: () => filesApi.removeLink(1, 3, 7), e: 'DELETE /api/trips/1/files/3/link/7' },
      { n: 'getLinks', r: () => filesApi.getLinks(1, 3), e: 'GET /api/trips/1/files/3/links' },
    ])
  })

  it('FE-APISURF-019: reservationsApi runs locally (Dexie-backed, zero HTTP)', async () => {
    // The adapter's own suite (tests/unit/local/reservations.test.ts) pins the
    // envelopes, cascades and error strings; here each method only has to
    // resolve over seeded rows without emitting a request.
    const seedResWorld = async () => {
      await seedTripAndDays() // trips 1+3; days 1,2,3 on trip 1
      await db.reservations.put(buildReservation({ id: 2, trip_id: 1 }))
      await db.localUsers.put({ id: 4, name: 'ann', is_self: 0 })
      await db.tripMembers.put({
        tripId: 1, id: 4, username: 'ann', role: 'member',
        added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
      } as LocalTripMember)
    }
    await assertCalls([
      { n: 'reservations.list', r: async () => { await seedResWorld(); return reservationsApi.list(1) }, e: 'local' },
      { n: 'reservations.create', r: async () => { await seedResWorld(); return reservationsApi.create(1, { title: 'Hotel' }) }, e: 'local' },
      { n: 'reservations.update', r: async () => { await seedResWorld(); return reservationsApi.update(1, 2, { title: 'Hostel' }) }, e: 'local' },
      { n: 'reservations.delete', r: async () => { await seedResWorld(); return reservationsApi.delete(1, 2) }, e: 'local' },
      { n: 'reservations.setTravelers', r: async () => { await seedResWorld(); return reservationsApi.setTravelers(1, 2, [4]) }, e: 'local' },
      { n: 'reservations.updatePositions', r: async () => { await seedResWorld(); return reservationsApi.updatePositions(1, [{ id: 2, day_plan_position: 0 }], 3) }, e: 'local' },
    ])
  })

  it('FE-APISURF-020: accommodationsApi runs locally (Dexie-backed, zero HTTP)', async () => {
    // The adapter's own suite (tests/unit/local/accommodations.test.ts) pins the
    // envelopes, error strings and the night-seat side channels; here each
    // method only has to resolve over seeded rows without emitting a request.
    const seedStayWorld = async () => {
      await seedTripAndDays() // trips 1+3; days 1,2,3 on trip 1
      await db.places.put(buildPlace({ id: 5, trip_id: 1 }))
      await db.accommodations.put({
        id: 4, trip_id: 1, place_id: 5, start_day_id: 1, end_day_id: 2,
        check_in: '15:00', check_in_end: null, check_out: '11:00',
        confirmation: null, notes: null, created_at: '2025-01-01T00:00:00.000Z',
      } as never)
    }
    await assertCalls([
      { n: 'accommodations.list', r: async () => { await seedStayWorld(); return accommodationsApi.list(1) }, e: 'local' },
      { n: 'accommodations.create', r: async () => { await seedStayWorld(); return accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 2 }) }, e: 'local' },
      { n: 'accommodations.update', r: async () => { await seedStayWorld(); return accommodationsApi.update(1, 4, { end_day_id: 3 }) }, e: 'local' },
      { n: 'accommodations.delete', r: async () => { await seedStayWorld(); return accommodationsApi.delete(1, 4) }, e: 'local' },
    ])
  })

  it('FE-APISURF-021: weatherApi is served locally — nothing reaches /api', async () => {
    // The adapter fetches Open-Meteo directly (a past date lands on the archive
    // host, current/detailed on the forecast host). Answer both so the calls
    // resolve; 'local' then proves no /api/* request was emitted for any.
    server.use(
      http.get('https://api.open-meteo.com/v1/forecast', () =>
        HttpResponse.json({ current: { temperature_2m: 20, weathercode: 0 }, daily: { time: [] }, hourly: { time: [] } })),
      http.get('https://archive-api.open-meteo.com/v1/archive', () =>
        HttpResponse.json({ daily: { time: [] }, hourly: { time: [] } })),
    )
    await assertCalls([
      { n: 'weather.get', r: () => weatherApi.get(41.9, 12.5, '2026-06-01'), e: 'local' },
      { n: 'weather.getCurrent', r: () => weatherApi.getCurrent(41.9, 12.5), e: 'local' },
      { n: 'weather.getDetailed', r: () => weatherApi.getDetailed(41.9, 12.5, '2026-06-01'), e: 'local' },
    ])
  })
})

describe('client > request payloads', () => {
  it('FE-APISURF-022: reorder helpers wrap their ids in the contract field', async () => {
    // daysApi is local — the "wrap" is the orderedIds argument itself; assert
    // the permutation persisted instead of a wire body.
    await seedTripAndDays()
    await daysApi.reorder(1, [3, 1, 2])
    const stored = (await db.days.where('trip_id').equals(1).toArray())
      .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0))
      .map((d) => d.id)
    expect(stored).toEqual([3, 1, 2])
    expect(log).toHaveLength(0)
    expect((await traceOne(() => packingApi.reorder(1, [2, 1]))).body).toEqual({ orderedIds: [2, 1] })
    expect((await traceOne(() => todoApi.reorder(1, [9]))).body).toEqual({ orderedIds: [9] })
    // budgetApi's reorders are local too — assert the persisted positions the
    // wire body's orderedIds / orderedCategories fields used to set.
    await db.trips.put(buildTrip({ id: 1 }))
    await db.budgetItems.bulkPut([
      buildBudgetItem({ id: 4, trip_id: 1, sort_order: 0 }),
      buildBudgetItem({ id: 5, trip_id: 1, sort_order: 1 }),
    ])
    await budgetApi.reorderItems(1, [5, 4])
    expect((await db.budgetItems.get(5))!.sort_order).toBe(0)
    expect((await db.budgetItems.get(4))!.sort_order).toBe(1)
    await budgetApi.reorderCategories(1, ['Food', 'Fun'])
    const catOrder = await db.budgetCategoryOrder.where('trip_id').equals(1).toArray()
    expect(catOrder.map((r) => [r.category, r.sort_order])).toEqual([['Food', 0], ['Fun', 1]])
    // The local reorder block above emitted no request — reset the log the
    // HTTP traceOne calls just filled.
    expect(log.filter((r) => r.url.includes('budget'))).toHaveLength(0)
  })

  it('FE-APISURF-023: user-id collections are sent as user_ids', async () => {
    // setParticipants is local — its "body" is the junction rewrite the wire
    // user_ids used to cause, filtered to the trip roster (4 is a member, 5
    // is off-roster and drops like the server's scope filter did).
    await seedTripAndDays()
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }))
    await db.localUsers.put({ id: 4, name: 'ann', is_self: 0 })
    await db.tripMembers.put({
      tripId: 1, id: 4, username: 'ann', role: 'member',
      added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
    } as LocalTripMember)
    const day = (await db.days.get(2)) as DayRow
    day.assignments = [{
      id: 7, day_id: 2, place_id: 5, order_index: 0, notes: null,
      reservation_status: 'none', reservation_notes: null, reservation_datetime: null,
      assignment_time: null, assignment_end_time: null, end_day: 0,
      accommodation_id: null, leg_transport_mode: null, incoming_leg_transport_mode: null,
      created_at: '2025-01-01T00:00:00.000Z',
    } as StoredAssignment] as never
    await db.days.put(day)
    log = []
    const { participants } = await assignmentsApi.setParticipants(1, 7, [4, 5])
    expect(participants).toEqual([{ user_id: 4, username: 'ann', avatar: null }])
    expect((await db.assignmentParticipants.toArray()).map((r) => r.user_id)).toEqual([4])
    expect(log).toHaveLength(0)
    // budgetApi.setMembers is local — its "body" is the member rewrite the
    // wire user_ids used to cause, roster-filtered like the others.
    await db.budgetItems.put(buildBudgetItem({ id: 2, trip_id: 1 }))
    log = []
    const { members } = await budgetApi.setMembers(1, 2, [4, 5])
    expect(members.map((m) => m.user_id)).toEqual([4])
    expect((await db.budgetItems.get(2))!.members!.map((m) => m.user_id)).toEqual([4])
    expect(log).toHaveLength(0)
    expect((await traceOne(() => packingApi.setBagMembers(1, 2, [6]))).body).toEqual({ user_ids: [6] })
    // reservationsApi.setTravelers is local — its "body" is the junction
    // rewrite filtered to the trip roster (4 is a member, 6 is off-roster).
    await db.reservations.put(buildReservation({ id: 2, trip_id: 1 }))
    log = []
    const { travelers } = await reservationsApi.setTravelers(1, 2, [4, 6])
    expect(travelers.map((t) => t.user_id)).toEqual([4])
    expect((await db.reservationTravelers.toArray()).map((r) => r.user_id)).toEqual([4])
    expect(log).toHaveLength(0)
  })

  it('FE-APISURF-024: single-value helpers wrap their argument in the documented key', async () => {
    // tripsApi/daysApi are local — assert the argument lands in the row the
    // server's documented field used to set.
    log = []
    await db.trips.put(buildTrip({ id: 1 }))
    await db.localUsers.put({ id: 9, name: 'bob@x.test', is_self: 1 })
    await tripsApi.addMember(1, 'bob@x.test')
    expect(await db.tripMembers.get([1, 9])).toMatchObject({ username: 'bob@x.test' })
    await tripsApi.transferOwnership(1, 9)
    expect((await db.trips.get(1))?.user_id).toBe(9)
    await db.trips.put(buildTrip({ id: 1 }))
    await usersApi.create(1, 'Anna')
    expect((await db.localUsers.toArray()).some((u) => u.name === 'Anna' && u.is_self === 0)).toBe(true)
    await db.days.put({ ...buildDay({ id: 2, trip_id: 1 }), vias: [] } as DayRow)
    await daysApi.updateTransport(1, 2, 'walk')
    expect((await db.days.get(2))?.default_transport_mode).toBe('walk')
    // assignmentsApi.updateTransport is local too — the "body" is the stored
    // leg_transport_mode column the transport_mode wire key used to set.
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }))
    const aDay = (await db.days.get(2)) as DayRow
    aDay.assignments = [{
      id: 7, day_id: 2, place_id: 5, order_index: 0, notes: null,
      reservation_status: 'none', reservation_notes: null, reservation_datetime: null,
      assignment_time: null, assignment_end_time: null, end_day: 0,
      accommodation_id: null, leg_transport_mode: 'walking', incoming_leg_transport_mode: null,
      created_at: '2025-01-01T00:00:00.000Z',
    } as StoredAssignment] as never
    await db.days.put(aDay)
    await assignmentsApi.updateTransport(1, 7, null)
    const after = ((await db.days.get(2)) as DayRow).assignments as unknown as StoredAssignment[]
    expect(after[0].leg_transport_mode).toBeNull()
    // budgetApi.togglePaid is local — its "body" is the member.paid column the
    // wire {paid} used to set.
    await db.localUsers.put({ id: 4, name: 'ann', is_self: 0 })
    await db.tripMembers.put({
      tripId: 1, id: 4, username: 'ann', role: 'member',
      added_at: '2025-01-01T00:00:00.000Z', invited_by_username: 'Me', is_guest: true,
    } as LocalTripMember)
    await db.budgetItems.put(buildBudgetItem({ id: 2, trip_id: 1, members: [{ user_id: 4, paid: 1, amount: null, username: 'ann' }] }))
    log = []
    const { member } = await budgetApi.togglePaid(1, 2, 4, false)
    expect(member).toMatchObject({ user_id: 4, paid: 0 })
    expect((await db.budgetItems.get(2))!.members![0].paid).toBe(0)
    expect(log).toHaveLength(0)
  })

  it('FE-APISURF-025: tripsApi.archive/unarchive flip the stored is_archived flag', async () => {
    // Local adapter: assert the row state instead of a PUT body.
    await db.trips.put(buildTrip({ id: 3 }))
    await tripsApi.archive(3)
    expect((await db.trips.get(3))?.is_archived).toBe(1)
    await tripsApi.unarchive(3)
    expect((await db.trips.get(3))?.is_archived).toBe(0)
    expect(log).toHaveLength(0)
  })

  it('FE-APISURF-033: tripsApi.copy clones the trip locally with no request', async () => {
    // Local copy: no request body exists — assert the no-arg call clones trip 3.
    await seedTripAndDays()
    const { trip: copy } = await tripsApi.copy(3)
    expect(copy.id).not.toBe(3)
    expect(await db.trips.get(copy.id)).toBeDefined()
    expect(log).toHaveLength(0)
  })

})

describe('client > query parameters', () => {
  it('FE-APISURF-035: tripsApi.list honours the archived filter locally', async () => {
    // The axios version forwarded filters as query params; the local adapter
    // applies them over Dexie — assert the filter effect, not the URL.
    await db.trips.bulkPut([
      buildTrip({ id: 1, title: 'Rome', is_archived: 0 }),
      buildTrip({ id: 2, title: 'Done', is_archived: 1 }),
    ])
    log = []
    const all = await tripsApi.list()
    expect(all.trips.map((t) => t.id)).toEqual([1])
    // The controller's `archived === '1'` flag, applied over Dexie.
    const archived = await tripsApi.list({ archived: '1' })
    expect(archived.trips.map((t) => t.id)).toEqual([2])
    expect(log).toHaveLength(0)
  })

  it('FE-APISURF-036: filesApi.list only sets the trash flag when asked', async () => {
    expect((await traceOne(() => filesApi.list(1))).url).toBe('/api/trips/1/files')
    expect((await traceOne(() => filesApi.list(1, true))).url).toBe('/api/trips/1/files?trash=true')
  })

  it('FE-APISURF-037: budgetApi.settlement selects the FX base currency the param asked for', async () => {
    // The axios version forwarded ?base= on the wire; the local adapter uses
    // the same base to fetch live rates and convert — assert the selection,
    // not the URL.
    const mockRates = vi.mocked(fetchExchangeRates)
    await db.trips.put(buildTrip({ id: 1, currency: 'EUR' }))
    log = []
    await budgetApi.settlement(1)
    expect(mockRates).toHaveBeenCalledWith('EUR')
    mockRates.mockClear()
    await budgetApi.settlement(1, 'USD')
    expect(mockRates).toHaveBeenCalledWith('USD')
    expect(log).toHaveLength(0)
  })

  it('FE-APISURF-042: weatherApi forwards lat/lng plus the date or language to Open-Meteo', async () => {
    // The adapter calls Open-Meteo itself — record the provider URLs instead of
    // /api traffic. A past date rides the archive host with the day spelled as
    // the start/end range.
    const urls: string[] = []
    server.use(
      http.get('https://archive-api.open-meteo.com/v1/archive', ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json({ daily: { time: [] }, hourly: { time: [] } })
      }),
      http.get('https://api.open-meteo.com/v1/forecast', ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json({ current: { temperature_2m: 20, weathercode: 0 }, daily: { time: [] }, hourly: { time: [] } })
      }),
    )

    await weatherApi.get(41.9, 12.5, '2026-06-01')
    const archiveQ = new URL(urls.find((u) => u.includes('archive-api'))!).searchParams
    expect([
      archiveQ.get('latitude'),
      archiveQ.get('longitude'),
      archiveQ.get('start_date'),
      archiveQ.get('end_date'),
    ]).toEqual(['41.9', '12.5', '2026-06-01', '2026-06-01'])

    // `lang` is not a wire param anymore — it selects the WMO description
    // table instead, so 'de' answers with the German text.
    const current = await weatherApi.getCurrent(41.9, 12.5, 'de')
    expect(current.description).toBe('Klar')
  })

  it('FE-APISURF-044: packing/todo category assignees encode the category name', async () => {
    const packing = await traceOne(() => packingApi.setCategoryAssignees(1, 'Rain gear/Wet', [4]))
    expect(packing.url).toBe('/api/trips/1/packing/category-assignees/Rain%20gear%2FWet')
    expect(packing.body).toEqual({ user_ids: [4] })

    const todo = await traceOne(() => todoApi.setCategoryAssignees(1, 'Before & after', [5]))
    expect(todo.url).toBe('/api/trips/1/todo/category-assignees/Before%20%26%20after')
    expect(todo.body).toEqual({ user_ids: [5] })
  })

})

describe('client > multipart uploads', () => {
  // jsdom FormData bodies deadlock inside MSW, so uploads are asserted at the
  // axios boundary instead (same approach as tests/integration/api/client.test.ts).
  function spyPost() {
    return vi.spyOn(apiClient, 'post')
      .mockResolvedValue({ data: { ok: true } } as unknown as AxiosResponse)
  }

  it('FE-APISURF-046: every upload opts out of the 8s global timeout', async () => {
    const post = spyPost()
    const fd = new FormData()

    // tripsApi.uploadCover is local — the file lands on the trip row as a
    // data: URL, no axios call is made.
    await db.trips.put(buildTrip({ id: 3 }))
    const coverFd = new FormData()
    coverFd.append('cover', new File(['x'], 'cover.png', { type: 'image/png' }))
    const cover = await tripsApi.uploadCover(3, coverFd)
    expect(cover.cover_image).toMatch(/^data:image\/png/)
    expect((await db.trips.get(3))?.cover_image).toBe(cover.cover_image)
    await filesApi.upload(1, fd)

    expect(post.mock.calls.map(c => c[0])).toEqual([
      '/trips/1/files',
    ])
    for (const call of post.mock.calls) {
      expect(call[1]).toBeInstanceOf(FormData)
      expect(call[2]).toMatchObject({ timeout: 0 })
      expect((call[2] as { headers: Record<string, string> }).headers['Content-Type']).toBe('multipart/form-data')
    }
  })

  it('FE-APISURF-047: postMultipart forwards progress, abort signal and idempotency key', async () => {
    const post = spyPost()
    const onUploadProgress = vi.fn((_e: unknown) => {})
    const controller = new AbortController()

    await filesApi.upload(1, new FormData(), {
      onUploadProgress,
      signal: controller.signal,
      idempotencyKey: 'fixed-key',
    })

    const config = post.mock.calls[0][2] as {
      headers: Record<string, string>
      onUploadProgress?: unknown
      signal?: AbortSignal
      timeout: number
    }
    expect(config.headers['X-Idempotency-Key']).toBe('fixed-key')
    expect(config.onUploadProgress).toBe(onUploadProgress)
    expect(config.signal).toBe(controller.signal)
    expect(config.timeout).toBe(0)
  })

})
