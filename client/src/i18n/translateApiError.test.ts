import { describe, it, expect } from 'vitest'
import { translateApiError } from './translateApiError'

// Mimics the real t(): returns a translation for known keys, the key itself otherwise.
const dict: Record<string, string> = {
  'reservations.loadError': 'Could not load bookings',
  'common.unknownError': 'Something went wrong',
}
const t = (key: string) => dict[key] ?? key

describe('translateApiError', () => {
  it('resolves a server message that is a known i18n key', () => {
    const err = new Error('reservations.loadError')
    expect(translateApiError(t, err, 'common.unknownError')).toBe('Could not load bookings')
  })

  it('falls back to the generic key when the message is a plain string', () => {
    const err = new Error('Some raw server message')
    expect(translateApiError(t, err, 'common.unknownError')).toBe('Something went wrong')
  })

  it('falls back when the message is an empty string', () => {
    expect(translateApiError(t, new Error(''), 'common.unknownError')).toBe('Something went wrong')
  })

  it('falls back when the thrown value is not an Error', () => {
    expect(translateApiError(t, 'nope', 'common.unknownError')).toBe('Something went wrong')
    expect(translateApiError(t, undefined, 'common.unknownError')).toBe('Something went wrong')
  })
})
