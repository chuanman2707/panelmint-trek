import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { db } from '../../../src/db/panelmintDb'
import { bootstrapLocalData, getSelf, nextId } from '../../../src/db/bootstrap'

describe('bootstrapLocalData', () => {
  it('seeds self, settings and categories exactly once', async () => {
    await bootstrapLocalData()
    await bootstrapLocalData() // idempotent

    expect(await db.localUsers.count()).toBe(1)
    expect((await db.localUsers.get(1))?.is_self).toBe(1)
    expect(await db.categories.count()).toBe(10)
    // Instance-wide categories, like the server seeded them.
    expect((await db.categories.get(1))?.user_id).toBeNull()

    expect(await db.settings.get('dark_mode')).toEqual({ key: 'dark_mode', value: false })
    expect(await db.settings.get('__bootstrapped')).toEqual({
      key: '__bootstrapped',
      value: true,
    })
  })

  it('getSelf returns the seeded self profile, bootstrapping on demand', async () => {
    const self = await getSelf()
    expect(self).toEqual({ id: 1, name: 'Me', is_self: 1 })
  })

  it('allocates monotonically increasing ids per table', async () => {
    const a = await nextId(db.trips)
    const b = await nextId(db.trips)
    expect(b).toBeGreaterThan(a)
  })

  it('allocates above existing rows, never below', async () => {
    await db.places.put({ id: 42 } as never)
    expect(await nextId(db.places)).toBe(43)
    // ...and never reissues a freed trailing id after a delete.
    await db.places.delete(42)
    expect(await nextId(db.places)).toBe(44)
  })

  it('scopes ids per table', async () => {
    expect(await nextId(db.tags)).toBe(1)
    expect(await nextId(db.tags)).toBe(2)
    // A different table has its own counter — it starts at 1 regardless.
    expect(await nextId(db.todoItems)).toBe(1)
  })
})
