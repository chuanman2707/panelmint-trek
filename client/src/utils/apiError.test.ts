// FE-W4UTL-001 to FE-W4UTL-006
import { describe, it, expect } from 'vitest'
import { getApiErrorMessage, getErrorMessage } from './apiError'
import { LocalApiError } from '../api/local/helpers'

describe('getApiErrorMessage', () => {
  it('FE-W4UTL-001: returns the server-provided error string', () => {
    const err = { response: { data: { error: 'Places API (New) has not been used in project 42' } } }
    expect(getApiErrorMessage(err, 'fallback')).toBe('Places API (New) has not been used in project 42')
  })

  it('FE-W4UTL-002: falls back when the error field is missing', () => {
    expect(getApiErrorMessage({ response: { data: {} } }, 'fallback')).toBe('fallback')
    expect(getApiErrorMessage({ response: {} }, 'fallback')).toBe('fallback')
    expect(getApiErrorMessage({}, 'fallback')).toBe('fallback')
  })

  it('FE-W4UTL-003: falls back for null/undefined errors', () => {
    expect(getApiErrorMessage(null, 'fallback')).toBe('fallback')
    expect(getApiErrorMessage(undefined, 'fallback')).toBe('fallback')
  })

  it('FE-W4UTL-004: falls back for a whitespace-only server message', () => {
    expect(getApiErrorMessage({ response: { data: { error: '   ' } } }, 'fallback')).toBe('fallback')
    expect(getApiErrorMessage({ response: { data: { error: '' } } }, 'fallback')).toBe('fallback')
  })

  it('FE-W4UTL-005: falls back for a non-string server message', () => {
    expect(getApiErrorMessage({ response: { data: { error: { code: 500 } } } }, 'fallback')).toBe('fallback')
    expect(getApiErrorMessage({ response: { data: { error: 42 } } }, 'fallback')).toBe('fallback')
  })

  it('FE-W4UTL-006: keeps surrounding whitespace of a real message', () => {
    expect(getApiErrorMessage({ response: { data: { error: ' boom ' } } }, 'fallback')).toBe(' boom ')
  })
})

describe('getErrorMessage', () => {
  it('FE-W4UTL-007: prefers the envelope error text over everything', () => {
    const err = new LocalApiError(409, 'Tag exists')
    expect(getErrorMessage(err, 'fallback')).toBe('Tag exists')
  })

  it('FE-W4UTL-008: surfaces a plain Error message — the local adapter/Dexie reason', () => {
    expect(getErrorMessage(new Error('disk gone'), 'fallback')).toBe('disk gone')
  })

  it('FE-W4UTL-009: falls back for non-Error, non-envelope values', () => {
    expect(getErrorMessage('boom', 'fallback')).toBe('fallback')
    expect(getErrorMessage({ response: { data: {} } }, 'fallback')).toBe('fallback')
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
