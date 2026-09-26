import { describe, expect, it } from 'vitest'
import { DOCK_CAP, DOCK_PRIORITY, dockTabIds, pickDockTabs } from './dockTabs'

// FE-MOB-DOCK-001 to FE-MOB-DOCK-008

/** Everything a fully equipped trip can offer, in dock order. */
const ALL = ['plan', 'transports', 'buchungen', 'finanzplan', 'listen']

const ids = (enabled: string[]) => pickDockTabs(new Set(enabled)).map((tab) => tab.id)

describe('pickDockTabs', () => {
  it('FE-MOB-DOCK-001: five seats beside More — the whole set fits', () => {
    // Ein sechster Kreis laesst 3px Abstand, auf die kein Daumen zielt.
    expect(DOCK_CAP).toBe(5)
    expect(ids(ALL)).toEqual(ALL)
  })

  it('FE-MOB-DOCK-002: a disabled section frees its seat', () => {
    expect(ids(ALL.filter((id) => id !== 'transports'))).toEqual([
      'plan',
      'buchungen',
      'finanzplan',
      'listen',
    ])
  })

  it('FE-MOB-DOCK-003: priority decides who is cut, not the order the tabs were enabled', () => {
    const scrambled = ['listen', 'finanzplan', 'transports', 'plan']
    expect(ids(scrambled)).toEqual(['plan', 'transports', 'finanzplan', 'listen'])
  })

  it('FE-MOB-DOCK-004: a trip with few sections gets few seats, never padded', () => {
    expect(ids(['plan', 'listen'])).toEqual(['plan', 'listen'])
    expect(ids([])).toEqual([])
  })

  it('FE-MOB-DOCK-005: an unknown tab never takes a seat', () => {
    expect(ids(['bogus-tab', 'plan'])).toEqual(['plan'])
    expect(ids(['bogus-a', 'bogus-b'])).toEqual([])
  })

  it('FE-MOB-DOCK-006: a seat is the priority entry itself, icon and all', () => {
    // Das Dock zeichnet den Kreis aus tab.icon; eine umgebaute Kopie ohne Icon bliebe leer.
    expect(pickDockTabs(new Set(ALL))).toEqual(DOCK_PRIORITY.slice(0, DOCK_CAP))
    expect(pickDockTabs(new Set(ALL))[1]).toBe(DOCK_PRIORITY[1])
  })
})

describe('dockTabIds', () => {
  it('FE-MOB-DOCK-007: names exactly the ids that got a seat, so the More sheet leaves them out', () => {
    const enabled = new Set(ALL.filter(id => id !== 'listen'))
    expect([...dockTabIds(enabled)]).toEqual(pickDockTabs(enabled).map((tab) => tab.id))
    expect(dockTabIds(enabled).has('listen')).toBe(false)
    expect(dockTabIds(enabled).has('transports')).toBe(true)
  })

  it('FE-MOB-DOCK-008: never names more than the dock can hold', () => {
    expect(dockTabIds(new Set([...ALL, 'bogus-tab'])).size).toBe(DOCK_CAP)
  })
})
