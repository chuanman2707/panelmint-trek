// FE-APIWIRE-001 to FE-APIWIRE-036
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { weatherResultSchema } from '@trek/shared'

const { apiClient, mapsApi, parseInDev } = await import('./client')

interface FakeLocation {
  href: string
  origin: string
  pathname: string
  search: string
  hash: string
  reload: () => void
}

let reload: ReturnType<typeof vi.fn<() => void>>

function setLocation(pathname: string, search = '', hash = ''): FakeLocation {
  reload = vi.fn<() => void>()
  const loc: FakeLocation = {
    href: `http://localhost:3000${pathname}${search}${hash}`,
    origin: 'http://localhost:3000',
    pathname,
    search,
    hash,
    reload,
  }
  Object.defineProperty(window, 'location', { writable: true, configurable: true, value: loc })
  return loc
}

const realLocation = window.location

/** Records the outgoing config and answers 200 without touching the network. */
function okAdapter(sink: InternalAxiosRequestConfig[]): AxiosAdapter {
  return (config) => {
    sink.push(config)
    return Promise.resolve({
      data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config,
    } as AxiosResponse)
  }
}

async function captureError(run: () => Promise<unknown>): Promise<AxiosError> {
  const err = await run().then(() => null, (e: unknown) => e as AxiosError)
  expect(err, 'expected the request to reject').not.toBeNull()
  return err as AxiosError
}

beforeEach(() => {
  setLocation('/dashboard')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'location', { writable: true, configurable: true, value: realLocation })
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
})

describe('client > request interceptor', () => {
  it('FE-APIWIRE-001: mutating requests get an idempotency key, reads do not', async () => {
    const sink: InternalAxiosRequestConfig[] = []
    const adapter = okAdapter(sink)

    await apiClient.get('/probe', { adapter })
    await apiClient.post('/probe', {}, { adapter })
    await apiClient.put('/probe', {}, { adapter })
    await apiClient.patch('/probe', {}, { adapter })
    await apiClient.delete('/probe', { adapter })

    const keys = sink.map(c => c.headers['X-Idempotency-Key'])
    expect(keys[0]).toBeUndefined()
    for (const key of keys.slice(1)) expect(typeof key).toBe('string')
  })

  it('FE-APIWIRE-002: each write gets its own key so retries can be deduplicated', async () => {
    const sink: InternalAxiosRequestConfig[] = []
    const adapter = okAdapter(sink)

    await apiClient.post('/probe', {}, { adapter })
    await apiClient.post('/probe', {}, { adapter })

    expect(sink[0].headers['X-Idempotency-Key']).not.toBe(sink[1].headers['X-Idempotency-Key'])
  })

  it('FE-APIWIRE-003: a pre-generated key from the mutation queue is left alone', async () => {
    const sink: InternalAxiosRequestConfig[] = []

    await apiClient.post('/probe', {}, {
      adapter: okAdapter(sink),
      headers: { 'X-Idempotency-Key': 'queued-key' },
    })

    expect(sink[0].headers['X-Idempotency-Key']).toBe('queued-key')
  })

  it('FE-APIWIRE-004: falls back to getRandomValues when crypto.randomUUID is missing', async () => {
    const realCrypto = globalThis.crypto
    vi.stubGlobal('crypto', {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    } as unknown as Crypto)

    const sink: InternalAxiosRequestConfig[] = []
    await apiClient.post('/probe', {}, { adapter: okAdapter(sink) })

    // randomUUID needs a secure context, so on the plain-http installs the
    // README documents this branch is what actually runs. getRandomValues has no
    // such requirement, so the fallback is still a full v4 UUID.
    expect(String(sink[0].headers['X-Idempotency-Key'])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('FE-APIWIRE-004b: the last-resort key is never degenerate, even with no Web Crypto at all', async () => {
    vi.stubGlobal('crypto', undefined)

    const keys = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const sink: InternalAxiosRequestConfig[] = []
      await apiClient.post('/probe', {}, { adapter: okAdapter(sink) })
      keys.add(String(sink[0].headers['X-Idempotency-Key']))
    }

    // The old fallback was Math.random().toString(36).slice(2), which is not
    // length-stable: 0.5 yields a single character and 0 yields the empty string.
    // An empty key makes the server skip deduplication entirely, so a retried
    // write applies twice.
    for (const k of keys) expect(k.length).toBeGreaterThan(16)
    expect(keys.size).toBe(50)
  })

  it('FE-APIWIRE-005: the socket id header is omitted while no socket is connected', async () => {
    const sink: InternalAxiosRequestConfig[] = []
    await apiClient.get('/probe', { adapter: okAdapter(sink) })
    expect(sink[0].headers['X-Socket-Id']).toBeUndefined()
  })

  it('FE-APIWIRE-034: a rejection from an earlier request interceptor is passed on untouched', async () => {
    const boom = new Error('interceptor refused the request')
    const id = apiClient.interceptors.request.use(() => Promise.reject(boom))
    const sink: InternalAxiosRequestConfig[] = []

    try {
      await expect(apiClient.post('/probe', {}, { adapter: okAdapter(sink) })).rejects.toBe(boom)
    } finally {
      apiClient.interceptors.request.eject(id)
    }

    expect(sink).toHaveLength(0)
  })
})

describe('client > rate-limit translation', () => {
  beforeEach(() => {
    server.use(http.get('/api/limited', () => HttpResponse.json({ error: 'Too Many Requests' }, { status: 429 })))
  })

  it('FE-APIWIRE-006: a 429 is rewritten in the stored app language', async () => {
    localStorage.setItem('app_language', 'de')
    const err = await captureError(() => apiClient.get('/limited'))

    expect(err.message).toBe('Zu viele Versuche. Bitte versuchen Sie es später erneut.')
    expect((err.response?.data as { error: string }).error)
      .toBe('Zu viele Versuche. Bitte versuchen Sie es später erneut.')
  })

  it('FE-APIWIRE-007: an unsupported language falls back to English', async () => {
    localStorage.setItem('app_language', 'kl')
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.message).toBe('Too many attempts. Please try again later.')
  })

  it('FE-APIWIRE-008: no stored language falls back to English', async () => {
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.message).toBe('Too many attempts. Please try again later.')
  })

  it('FE-APIWIRE-009: a blocked localStorage still yields the English message', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.message).toBe('Too many attempts. Please try again later.')
  })

  it('FE-APIWIRE-010: a non-object 429 body is replaced with the translated error object', async () => {
    server.use(http.get('/api/limited', () => new HttpResponse('slow down', { status: 429 })))
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.response?.data).toEqual({ error: 'Too many attempts. Please try again later.' })
  })

  it('FE-APIWIRE-035: an array 429 body is replaced, not grafted onto', async () => {
    server.use(http.get('/api/limited', () => HttpResponse.json([{ field: 'email' }], { status: 429 })))
    const err = await captureError(() => apiClient.get('/limited'))
    expect(err.response?.data).toEqual({ error: 'Too many attempts. Please try again later.' })
  })

  it('FE-APIWIRE-036: Catalan, Greek and Vietnamese have their own 429 message', async () => {
    for (const lang of ['ca', 'gr', 'vi']) {
      localStorage.setItem('app_language', lang)
      const err = await captureError(() => apiClient.get('/limited'))
      expect(err.message).not.toBe('Too many attempts. Please try again later.')
    }
  })
})

describe('client > dev-only contract drift checks', () => {
  it('FE-APIWIRE-021: parseInDev passes a matching payload straight through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = { temp: 21, main: 'Clear', description: 'clear sky', type: 'sun' }

    expect(parseInDev(weatherResultSchema, payload, 'weather.get')).toBe(payload)
    expect(warn).not.toHaveBeenCalled()
  })

  it('FE-APIWIRE-022: parseInDev warns but still returns a drifting payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = { temp: 'warm', main: 'Clear', description: 'clear sky', type: 'sun' }

    expect(parseInDev(weatherResultSchema, payload, 'weather.get')).toBe(payload)
    expect(warn).toHaveBeenCalledWith(
      '[api] weather.get: response did not match the @trek/shared schema',
      expect.anything(),
    )
  })

  it('FE-APIWIRE-023: a drifting maps response is reported under its own label', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    server.use(http.post('/api/maps/search', () => HttpResponse.json({ nonsense: true })))

    await expect(mapsApi.search('Rome')).resolves.toEqual({ nonsense: true })
    expect(warn).toHaveBeenCalledWith(
      '[api] maps.search: response did not match the @trek/shared schema',
      expect.anything(),
    )
  })
})
