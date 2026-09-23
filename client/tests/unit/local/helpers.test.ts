import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import {
  LocalApiError,
  apiError,
  badRequest,
  detached,
  detachedList,
  notFound,
  nowIso,
  numId,
  requireRow,
} from '../../../src/api/local/helpers'
import { db } from '../../../src/db/panelmintDb'
import { getApiErrorMessage } from '../../../src/types'
import { buildTrip } from '../../helpers/factories'

describe('api/local helpers', () => {
  it('nowIso returns a UTC ISO timestamp', () => {
    const now = nowIso()
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(now).getTime()).not.toBeNaN()
  })

  it('numId passes numbers through and parses route-param strings', () => {
    expect(numId(7)).toBe(7)
    expect(numId('42')).toBe(42)
    expect(numId('abc')).toBeNaN()
  })

  it('requireRow returns the row — a detached snapshot', async () => {
    await db.trips.put(buildTrip({ id: 5, title: 'Original' }))
    const row = await requireRow(db.trips, 5, 'Trip')
    expect(row.title).toBe('Original')

    // Mutating the snapshot must not leak into the stored row.
    row.title = 'Mutated'
    expect((await db.trips.get(5))?.title).toBe('Original')
  })

  it('requireRow throws a 404 LocalApiError a getApiErrorMessage consumer renders', async () => {
    const err = await requireRow(db.trips, 999, 'Trip').catch(e => e)
    expect(err).toBeInstanceOf(LocalApiError)
    expect(err.status).toBe(404)
    expect(err.response.status).toBe(404)
    expect(err.response.data.error).toBe('Trip not found')
    expect(getApiErrorMessage(err, 'Something broke')).toBe('Trip not found')
  })

  it('detached/detachedList return copies that cannot poison the store', () => {
    const row = { id: 1, nested: { flag: true }, list: [1, 2] }
    const copy = detached(row)
    copy.nested.flag = false
    copy.list.push(3)
    expect(row.nested.flag).toBe(true)
    expect(row.list).toHaveLength(2)

    const rows = [{ id: 1 }, { id: 2 }]
    const copies = detachedList(rows)
    expect(copies.map(r => r.id)).toEqual([1, 2])
    copies[0].id = 99
    expect(rows[0].id).toBe(1)
  })

  it('apiError/notFound/badRequest carry the axios-shaped surface', () => {
    const e404 = notFound('Day')
    expect(e404).toBeInstanceOf(Error)
    expect(getApiErrorMessage(e404, 'fallback')).toBe('Day not found')

    const e400 = badRequest('orderedIds must be a permutation of the trip day ids.')
    expect(e400.response.status).toBe(400)
    expect(e400.status).toBe(400)
    expect(getApiErrorMessage(e400, 'fallback')).toBe(
      'orderedIds must be a permutation of the trip day ids.',
    )

    const coded = apiError(409, 'conflict', 'CONSENT_REQUIRED')
    expect(coded.response.data).toEqual({ error: 'conflict', code: 'CONSENT_REQUIRED' })
  })
})
