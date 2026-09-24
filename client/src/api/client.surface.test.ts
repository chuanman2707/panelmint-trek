// FE-APISURF-001 to FE-APISURF-057
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AxiosResponse } from 'axios'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { db } from '../db/panelmintDb'
import { buildDay, buildTag, buildTrip } from '../../tests/helpers/factories'
import type { DayRow } from './local/dexieStore'
import type { LocalTripMember } from '../db/panelmintDb'
import { clearWeatherCache } from './ext/openmeteo'

// tripsApi.create/update fetch live FX rates for the currency rebase — keep the
// surface suite offline.
vi.mock('../hooks/useExchangeRates', () => ({ fetchExchangeRates: vi.fn().mockResolvedValue(null) }))
import {
  apiClient,
  tripsApi, daysApi, placesApi, assignmentsApi, packingApi, todoApi,
  tagsApi, categoriesApi,
  mapsApi, airportsApi, budgetApi, filesApi, reservationsApi, weatherApi,
  accommodationsApi, dayNotesApi,
} from './client'

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
      { n: 'createGuest', r: async () => { await seedTripAndDays(); return tripsApi.createGuest(3, 'Anna') }, e: 'local' },
      { n: 'renameGuest', r: async () => { await seedTripAndDays(); await seedMemberRow(9, 'Anna', 0); return tripsApi.renameGuest(3, 9, 'Ana') }, e: 'local' },
      { n: 'deleteGuest', r: async () => { await seedTripAndDays(); await seedMemberRow(9, 'Anna', 0); return tripsApi.deleteGuest(3, 9) }, e: 'local' },
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

  it('FE-APISURF-005: placesApi maps CRUD, rating and list-import endpoints', async () => {
    await assertCalls([
      { n: 'list', r: () => placesApi.list(1), e: 'GET /api/trips/1/places' },
      { n: 'create', r: () => placesApi.create(1, { name: 'Colosseum' }), e: 'POST /api/trips/1/places' },
      { n: 'get', r: () => placesApi.get(1, 5), e: 'GET /api/trips/1/places/5' },
      { n: 'update', r: () => placesApi.update(1, 5, { name: 'Forum' }), e: 'PUT /api/trips/1/places/5' },
      { n: 'delete', r: () => placesApi.delete(1, 5), e: 'DELETE /api/trips/1/places/5' },
      { n: 'searchImage', r: () => placesApi.searchImage(1, 5), e: 'GET /api/trips/1/places/5/image' },
      { n: 'importGoogleList', r: () => placesApi.importGoogleList(1, 'https://maps.app/x'), e: 'POST /api/trips/1/places/import/google-list' },
      { n: 'importNaverList', r: () => placesApi.importNaverList(1, 'https://naver/x'), e: 'POST /api/trips/1/places/import/naver-list' },
      { n: 'bulkDelete', r: () => placesApi.bulkDelete(1, [5, 6]), e: 'POST /api/trips/1/places/bulk-delete' },
      { n: 'bulkUpdate', r: () => placesApi.bulkUpdate(1, [5], { category_id: 2 }), e: 'POST /api/trips/1/places/bulk-update' },
    ])
  })

  it('FE-APISURF-006: assignmentsApi maps day-plan endpoints', async () => {
    await assertCalls([
      { n: 'list', r: () => assignmentsApi.list(1, 2), e: 'GET /api/trips/1/days/2/assignments' },
      { n: 'create', r: () => assignmentsApi.create(1, 2, { place_id: 5 }), e: 'POST /api/trips/1/days/2/assignments' },
      { n: 'delete', r: () => assignmentsApi.delete(1, 2, 7), e: 'DELETE /api/trips/1/days/2/assignments/7' },
      { n: 'reorder', r: () => assignmentsApi.reorder(1, 2, [7, 8]), e: 'PUT /api/trips/1/days/2/assignments/reorder' },
      { n: 'move', r: () => assignmentsApi.move(1, 7, 3, 0), e: 'PUT /api/trips/1/assignments/7/move' },
      { n: 'update', r: () => assignmentsApi.update(1, 2, 7, { notes: 'x' }), e: 'PUT /api/trips/1/days/2/assignments/7' },
      { n: 'getParticipants', r: () => assignmentsApi.getParticipants(1, 7), e: 'GET /api/trips/1/assignments/7/participants' },
      { n: 'setParticipants', r: () => assignmentsApi.setParticipants(1, 7, [4]), e: 'PUT /api/trips/1/assignments/7/participants' },
      { n: 'updateTime', r: () => assignmentsApi.updateTime(1, 7, { place_time: '09:00' }), e: 'PUT /api/trips/1/assignments/7/time' },
      { n: 'updateTransport', r: () => assignmentsApi.updateTransport(1, 7, null), e: 'PUT /api/trips/1/assignments/7/transport' },
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

  it('FE-APISURF-009: tagsApi runs locally while categoriesApi maps its global endpoints', async () => {
    // tagsApi is Dexie-backed now ('local' = resolves with zero HTTP requests);
    // update/delete need a self-owned row to act on, so seed it first.
    const seedTag = () => db.tags.put(buildTag({ id: 2, user_id: 1 }))
    await assertCalls([
      { n: 'tags.list', r: () => tagsApi.list(), e: 'local' },
      { n: 'tags.create', r: () => tagsApi.create({ name: 'Food' }), e: 'local' },
      { n: 'tags.update', r: async () => { await seedTag(); return tagsApi.update(2, { name: 'Eat' }) }, e: 'local' },
      { n: 'tags.delete', r: async () => { await seedTag(); return tagsApi.delete(2) }, e: 'local' },
      { n: 'categories.list', r: () => categoriesApi.list(), e: 'GET /api/categories' },
      { n: 'categories.create', r: () => categoriesApi.create({ name: 'Museum' }), e: 'POST /api/categories' },
      { n: 'categories.update', r: () => categoriesApi.update(2, { name: 'Art' }), e: 'PUT /api/categories/2' },
      { n: 'categories.delete', r: () => categoriesApi.delete(2), e: 'DELETE /api/categories/2' },
    ])
  })

  it('FE-APISURF-055: mapsApi.search asks only the core index — plugin providers are gone', async () => {
    log = []
    await mapsApi.search('Rome')
    expect(log.map(r => `${r.method} ${r.url.split('?')[0]}`)).toEqual([
      'POST /api/maps/search',
    ])
  })

  it('FE-APISURF-016: mapsApi and airportsApi map the geo endpoints', async () => {
    await assertCalls([
      { n: 'maps.autocomplete', r: () => mapsApi.autocomplete('Rom'), e: 'POST /api/maps/autocomplete' },
      { n: 'maps.details', r: () => mapsApi.details('place/1'), e: 'GET /api/maps/details/place%2F1' },
      { n: 'maps.placePhoto', r: () => mapsApi.placePhoto('place/1'), e: 'GET /api/maps/place-photo/place%2F1' },
      { n: 'maps.reverse', r: () => mapsApi.reverse(41.9, 12.5), e: 'GET /api/maps/reverse' },
      { n: 'maps.resolveUrl', r: () => mapsApi.resolveUrl('https://maps.app.goo.gl/x'), e: 'POST /api/maps/resolve-url' },
      { n: 'maps.pois', r: () => mapsApi.pois('cafe', { south: 1, west: 2, north: 3, east: 4 }), e: 'GET /api/maps/pois' },
      // airportsApi reads the bundled dataset (src/data/airports.json) — BER is
      // a real row, so both calls resolve with no request at all.
      { n: 'airports.search', r: () => airportsApi.search('BER'), e: 'local' },
      { n: 'airports.byIata', r: () => airportsApi.byIata('BER'), e: 'local' },
    ])
  })

  it('FE-APISURF-017: budgetApi maps item, member and settlement endpoints', async () => {
    await assertCalls([
      { n: 'list', r: () => budgetApi.list(1), e: 'GET /api/trips/1/budget' },
      { n: 'create', r: () => budgetApi.create(1, { name: 'Hotel' }), e: 'POST /api/trips/1/budget' },
      { n: 'update', r: () => budgetApi.update(1, 2, { name: 'Hostel' }), e: 'PUT /api/trips/1/budget/2' },
      { n: 'delete', r: () => budgetApi.delete(1, 2), e: 'DELETE /api/trips/1/budget/2' },
      { n: 'setMembers', r: () => budgetApi.setMembers(1, 2, [4, 5]), e: 'PUT /api/trips/1/budget/2/members' },
      { n: 'togglePaid', r: () => budgetApi.togglePaid(1, 2, 4, true), e: 'PUT /api/trips/1/budget/2/members/4/paid' },
      { n: 'setPayers', r: () => budgetApi.setPayers(1, 2, [{ user_id: 4, amount: 10 }]), e: 'PUT /api/trips/1/budget/2/payers' },
      { n: 'perPersonSummary', r: () => budgetApi.perPersonSummary(1), e: 'GET /api/trips/1/budget/summary/per-person' },
      { n: 'settlement', r: () => budgetApi.settlement(1), e: 'GET /api/trips/1/budget/settlement' },
      { n: 'createSettlement', r: () => budgetApi.createSettlement(1, { from_user_id: 4, to_user_id: 5, amount: 10 }), e: 'POST /api/trips/1/budget/settlements' },
      { n: 'updateSettlement', r: () => budgetApi.updateSettlement(1, 6, { from_user_id: 4, to_user_id: 5, amount: 12 }), e: 'PUT /api/trips/1/budget/settlements/6' },
      { n: 'deleteSettlement', r: () => budgetApi.deleteSettlement(1, 6), e: 'DELETE /api/trips/1/budget/settlements/6' },
      { n: 'reorderItems', r: () => budgetApi.reorderItems(1, [2, 3]), e: 'PUT /api/trips/1/budget/reorder/items' },
      { n: 'reorderCategories', r: () => budgetApi.reorderCategories(1, ['Food']), e: 'PUT /api/trips/1/budget/reorder/categories' },
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

  it('FE-APISURF-019: reservationsApi and accommodationsApi map booking endpoints', async () => {
    await assertCalls([
      { n: 'reservations.list', r: () => reservationsApi.list(1), e: 'GET /api/trips/1/reservations' },
      { n: 'reservations.create', r: () => reservationsApi.create(1, { title: 'Hotel' }), e: 'POST /api/trips/1/reservations' },
      { n: 'reservations.update', r: () => reservationsApi.update(1, 2, { title: 'Hostel' }), e: 'PUT /api/trips/1/reservations/2' },
      { n: 'reservations.delete', r: () => reservationsApi.delete(1, 2), e: 'DELETE /api/trips/1/reservations/2' },
      { n: 'reservations.setTravelers', r: () => reservationsApi.setTravelers(1, 2, [4]), e: 'PUT /api/trips/1/reservations/2/travelers' },
      { n: 'reservations.updatePositions', r: () => reservationsApi.updatePositions(1, [{ id: 2, day_plan_position: 0 }], 3), e: 'PUT /api/trips/1/reservations/positions' },
      { n: 'accommodations.list', r: () => accommodationsApi.list(1), e: 'GET /api/trips/1/accommodations' },
      { n: 'accommodations.create', r: () => accommodationsApi.create(1, { place_id: 5, start_day_id: 1, end_day_id: 2 }), e: 'POST /api/trips/1/accommodations' },
      { n: 'accommodations.update', r: () => accommodationsApi.update(1, 4, { end_day_id: 3 }), e: 'PUT /api/trips/1/accommodations/4' },
      { n: 'accommodations.delete', r: () => accommodationsApi.delete(1, 4), e: 'DELETE /api/trips/1/accommodations/4' },
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
    expect((await traceOne(() => budgetApi.reorderItems(1, [4, 5]))).body).toEqual({ orderedIds: [4, 5] })
    expect((await traceOne(() => budgetApi.reorderCategories(1, ['Food', 'Fun']))).body)
      .toEqual({ orderedCategories: ['Food', 'Fun'] })
  })

  it('FE-APISURF-023: user-id collections are sent as user_ids', async () => {
    expect((await traceOne(() => assignmentsApi.setParticipants(1, 7, [4, 5]))).body).toEqual({ user_ids: [4, 5] })
    expect((await traceOne(() => budgetApi.setMembers(1, 2, [4]))).body).toEqual({ user_ids: [4] })
    expect((await traceOne(() => packingApi.setBagMembers(1, 2, [6]))).body).toEqual({ user_ids: [6] })
    expect((await traceOne(() => reservationsApi.setTravelers(1, 2, [4, 6]))).body).toEqual({ user_ids: [4, 6] })
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
    await tripsApi.createGuest(1, 'Anna')
    expect((await db.localUsers.toArray()).some((u) => u.name === 'Anna' && u.is_self === 0)).toBe(true)
    await db.days.put({ ...buildDay({ id: 2, trip_id: 1 }), vias: [] } as DayRow)
    await daysApi.updateTransport(1, 2, 'walk')
    expect((await db.days.get(2))?.default_transport_mode).toBe('walk')
    expect(log).toHaveLength(0)
    expect((await traceOne(() => assignmentsApi.updateTransport(1, 7, null))).body).toEqual({ transport_mode: null })
    expect((await traceOne(() => budgetApi.togglePaid(1, 2, 4, false))).body).toEqual({ paid: false })
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

  it('FE-APISURF-026: placesApi bulk operations merge ids with the patch', async () => {
    expect((await traceOne(() => placesApi.bulkDelete(1, [5, 6]))).body).toEqual({ ids: [5, 6] })
    expect((await traceOne(() => placesApi.bulkUpdate(1, [5], { category_id: null }))).body)
      .toEqual({ ids: [5], category_id: null })
  })

  it('FE-APISURF-027: placesApi.rate deletes on null and PUTs the value otherwise', async () => {
    const cleared = await traceOne(() => placesApi.rate(1, 5, null))
    expect(cleared.method).toBe('DELETE')
    expect(cleared.url).toBe('/api/trips/1/places/5/rating')

    const set = await traceOne(() => placesApi.rate(1, 5, 4))
    expect(set.method).toBe('PUT')
    expect(set.url).toBe('/api/trips/1/places/5/rating')
    expect(set.body).toEqual({ rating: 4 })
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

  it('FE-APISURF-037: budgetApi.settlement adds the base currency only when given', async () => {
    expect((await traceOne(() => budgetApi.settlement(1))).url).toBe('/api/trips/1/budget/settlement')
    expect((await traceOne(() => budgetApi.settlement(1, 'EUR'))).url).toBe('/api/trips/1/budget/settlement?base=EUR')
  })

  it('FE-APISURF-041: mapsApi flattens the POI bbox into the query string', async () => {
    const rec = await traceOne(() => mapsApi.pois('cafe', { south: 41.8, west: 12.4, north: 42.0, east: 12.6 }, 'de'))
    const qs = new URLSearchParams(rec.url.split('?')[1])
    expect(qs.get('category')).toBe('cafe')
    expect(qs.get('south')).toBe('41.8')
    expect(qs.get('west')).toBe('12.4')
    expect(qs.get('north')).toBe('42')
    expect(qs.get('east')).toBe('12.6')
    expect(qs.get('lang')).toBe('de')
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

  it('FE-APISURF-048: placesApi.uploadImage posts the file under the image field', async () => {
    const post = spyPost()
    const file = new File(['bytes'], 'shot.jpg', { type: 'image/jpeg' })

    await placesApi.uploadImage(1, 5, file)

    expect(post.mock.calls[0][0]).toBe('/trips/1/places/5/image')
    const fd = post.mock.calls[0][1] as FormData
    expect((fd.get('image') as File).name).toBe('shot.jpg')
  })

  it('FE-APISURF-049: placesApi.importGpx only appends the flags it was given', async () => {
    const post = spyPost()
    const file = new File(['<gpx/>'], 'track.gpx')

    await placesApi.importGpx(1, file)
    expect(post.mock.calls[0][0]).toBe('/trips/1/places/import/gpx')
    const bare = post.mock.calls[0][1] as FormData
    expect(bare.get('importWaypoints')).toBeNull()
    expect(bare.get('importRoutes')).toBeNull()
    expect(bare.get('importTracks')).toBeNull()

    await placesApi.importGpx(1, file, { waypoints: true, routes: false, tracks: true })
    const flagged = post.mock.calls[1][1] as FormData
    expect(flagged.get('importWaypoints')).toBe('true')
    expect(flagged.get('importRoutes')).toBe('false')
    expect(flagged.get('importTracks')).toBe('true')
  })

  it('FE-APISURF-050: placesApi.importMapFile appends the point/path flags', async () => {
    const post = spyPost()
    const file = new File(['{}'], 'map.kml')

    await placesApi.importMapFile(1, file)
    expect(post.mock.calls[0][0]).toBe('/trips/1/places/import/map')
    expect((post.mock.calls[0][1] as FormData).get('importPoints')).toBeNull()

    await placesApi.importMapFile(1, file, { points: true, paths: false })
    const flagged = post.mock.calls[1][1] as FormData
    expect(flagged.get('importPoints')).toBe('true')
    expect(flagged.get('importPaths')).toBe('false')
  })

})
