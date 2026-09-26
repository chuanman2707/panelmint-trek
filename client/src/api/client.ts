import axios, { AxiosInstance } from 'axios'
import type { z } from 'zod'
import { randomId } from '../utils/randomId'
import {
  type FileUpdateRequest,
  type FileLinkRequest,
  RoadtripDayTrack,
  RoadtripVia,
  RoadtripViaBatchRequest,
  RoadtripViaCreateRequest,
  RoadtripViaReanchorRequest,
  RoadtripViaUpdateRequest,
} from '@trek/shared'

/**
 * Validate a response payload against its @trek/shared Zod schema — but only in
 * dev, and never throwing. A drift between the server contract and the client's
 * expected shape is surfaced as a console warning during development; in
 * production (and on any mismatch) the data passes through untouched, so adding
 * validation can never break a working call. This is the typed-request helper
 * the FE adopts per domain as each backend module lands on @trek/shared.
 */
const API_DEV = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
export function parseInDev<S extends z.ZodTypeAny>(schema: S, data: unknown, label: string): z.infer<S> {
  if (API_DEV) {
    const result = schema.safeParse(data)
    if (!result.success) {
      console.warn(`[api] ${label}: response did not match the @trek/shared schema`, result.error.issues)
    }
  }
  return data as z.infer<S>
}
const RATE_LIMIT_MESSAGES: Record<string, string> = {
  en:      'Too many attempts. Please try again later.',
  de:      'Zu viele Versuche. Bitte versuchen Sie es später erneut.',
  es:      'Demasiados intentos. Inténtelo de nuevo más tarde.',
  fr:      'Trop de tentatives. Veuillez réessayer plus tard.',
  hu:      'Túl sok próbálkozás. Kérjük, próbálja újra később.',
  nl:      'Te veel pogingen. Probeer het later opnieuw.',
  br:      'Muitas tentativas. Tente novamente mais tarde.',
  cs:      'Příliš mnoho pokusů. Zkuste to prosím znovu.',
  pl:      'Zbyt wiele prób. Spróbuj ponownie później.',
  ru:      'Слишком много попыток. Попробуйте позже.',
  zh:      '尝试次数过多，请稍后再试。',
  'zh-TW': '嘗試次數過多，請稍後再試。',
  it:      'Troppi tentativi. Riprova più tardi.',
  tr:      'Çok fazla deneme. Lütfen daha sonra tekrar deneyin.',
  ar:      'محاولات كثيرة جدًا. يرجى المحاولة لاحقًا.',
  id:      'Terlalu banyak percobaan. Coba lagi nanti.',
  ja:      '試行回数が多すぎます。時間をおいて再度お試しください。',
  ko:      '시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  uk:      'Занадто багато спроб. Спробуйте пізніше.',
  sv:      'För många försök. Prova igen senare.',
  ca:      'Massa intents. Torneu-ho a provar més tard.',
  gr:      'Πάρα πολλές προσπάθειες. Δοκιμάστε ξανά αργότερα.',
  vi:      'Quá nhiều lần thử. Vui lòng thử lại sau.',
}

function translateRateLimit(): string {
  const fallback = RATE_LIMIT_MESSAGES['en']!
  try {
    const lang = localStorage.getItem('app_language') || 'en'
    return RATE_LIMIT_MESSAGES[lang] ?? fallback
  } catch {
    return fallback
  }
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 8000,
  headers: {
    'Content-Type': 'application/json',
  },
})

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete'])

// Request interceptor - attach a per-request idempotency key to all write
// operations so a replayed call (e.g. network blip) can be deduplicated. The
// X-Socket-Id header is gone with the websocket; there is no session to echo.
apiClient.interceptors.request.use(
    (config) => {
      const method = (config.method ?? '').toLowerCase()
      if (MUTATING_METHODS.has(method) && !config.headers['X-Idempotency-Key']) {
        config.headers['X-Idempotency-Key'] = randomId()
      }
      return config
    },
    (error) => Promise.reject(error)
)

// Response interceptor - the only rewrite left is the 429 rate-limit message.
// The 401→/login redirect, the MFA redirect and the edge-proxy reauth probe all
// went away with the server session: there is no login page to send anyone to.
apiClient.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status === 429) {
        const translated = translateRateLimit()
        const data = error.response.data
        // Only a plain object body carries an `error` field worth overwriting;
        // an array (a validation-error list) or a string is replaced outright.
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          (data as { error?: string }).error = translated
        } else {
          error.response.data = { error: translated }
        }
        error.message = translated
      }
      return Promise.reject(error)
    }
)

/**
 * POST a FormData body — the ONLY way this client should upload a file.
 *
 * The shared axios instance carries `timeout: 8000`, and axios' timeout is a whole-
 * request deadline rather than an idle one. A file upload that takes longer than 8s to
 * push its body — a phone photo on a slow uplink, a 500 MB document — is aborted
 * mid-stream, which the server reports as a multer "Request aborted" (#1495).
 *
 * Every upload therefore has to opt out with `timeout: 0`. That opt-out used to be
 * hand-written per call site, so it was forgotten on 7 of 15 — including the two 500 MB
 * endpoints (documents, backup restore). Centralizing makes the correct behavior the
 * default instead of something you have to remember.
 *
 * The Content-Type is set for clarity only: axios unsets it for FormData in the browser
 * so the platform can generate the multipart boundary.
 */
export interface UploadOptions {
  onUploadProgress?: (e: import('axios').AxiosProgressEvent) => void
  idempotencyKey?: string
  signal?: AbortSignal
}

export function postMultipart<T = any>(url: string, formData: FormData, opts?: UploadOptions): Promise<T> {
  return apiClient.post(url, formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
      ...(opts?.idempotencyKey ? { 'X-Idempotency-Key': opts.idempotencyKey } : {}),
    },
    timeout: 0,
    onUploadProgress: opts?.onUploadProgress,
    signal: opts?.signal,
  }).then(r => r.data as T)
}

// Local adapters (api/local/*) — each domain's axios object was deleted when
// its adapter landed (README.md barrel strategy, step 3).
export { tripsApi, daysApi, dashboardApi, weatherApi, airportsApi, tagsApi, tripMembersApi, shareApi, configApi, placesApi, categoriesApi, mapsApi, assignmentsApi, accommodationsApi, budgetApi, usersApi, packingApi, todoApi, dayNotesApi } from './local'

/**
 * Road-trip via points (#1797): the places a day's drive is routed through without
 * stopping. Separate from places on purpose — a via bends the route, a stop is somewhere
 * you go. Unreachable in the local build (the static addon store never enables
 * `roadtrip`); kept only until Task 20 removes the roadtrip UI.
 */
export const roadtripApi = {
  /** Every via of the trip, so all days can be routed without a request per day. */
  listVias: (tripId: number | string) =>
    apiClient.get(`/trips/${tripId}/roadtrip/vias`).then(r => r.data as { vias: RoadtripVia[]; tracks: RoadtripDayTrack[] }),
  addVia: (tripId: number | string, dayId: number | string, body: RoadtripViaCreateRequest) =>
    apiClient.post(`/trips/${tripId}/roadtrip/days/${dayId}/vias`, body).then(r => r.data as { via: RoadtripVia }),
  /**
   * Lay a chain of vias on one day in one write. Anything that derives its anchors from a
   * line produces dozens of them, and one request each would re-route the whole trip once
   * per point at better than a second apart.
   */
  addVias: (tripId: number | string, dayId: number | string, body: RoadtripViaBatchRequest) =>
    apiClient.post(`/trips/${tripId}/roadtrip/days/${dayId}/vias/batch`, body).then(r => r.data as { vias: RoadtripVia[] }),
  /**
   * Re-pin a day's vias in one write, after its stops changed shape. One request, not one
   * per via: the anchors are only correct as a set.
   */
  reanchorVias: (tripId: number | string, dayId: number | string, body: RoadtripViaReanchorRequest) =>
    apiClient.put(`/trips/${tripId}/roadtrip/days/${dayId}/vias`, body).then(r => r.data as { vias: RoadtripVia[] }),
  moveVia: (tripId: number | string, dayId: number | string, id: number, body: RoadtripViaUpdateRequest) =>
    apiClient.put(`/trips/${tripId}/roadtrip/days/${dayId}/vias/${id}`, body).then(r => r.data as { via: RoadtripVia }),
  removeVia: (tripId: number | string, dayId: number | string, id: number) =>
    apiClient.delete(`/trips/${tripId}/roadtrip/days/${dayId}/vias/${id}`).then(r => r.data),
}

export const filesApi = {
  list: (tripId: number | string, trash?: boolean) => apiClient.get(`/trips/${tripId}/files`, { params: trash ? { trash: 'true' } : {} }).then(r => r.data),
  upload: (tripId: number | string, formData: FormData, opts?: UploadOptions) => postMultipart(`/trips/${tripId}/files`, formData, opts),
  update: (tripId: number | string, id: number, data: FileUpdateRequest) => apiClient.put(`/trips/${tripId}/files/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}`).then(r => r.data),
  toggleStar: (tripId: number | string, id: number) => apiClient.patch(`/trips/${tripId}/files/${id}/star`).then(r => r.data),
  restore: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/files/${id}/restore`).then(r => r.data),
  permanentDelete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}/permanent`).then(r => r.data),
  emptyTrash: (tripId: number | string) => apiClient.delete(`/trips/${tripId}/files/trash/empty`).then(r => r.data),
  addLink: (tripId: number | string, fileId: number, data: FileLinkRequest) => apiClient.post(`/trips/${tripId}/files/${fileId}/link`, data).then(r => r.data),
  removeLink: (tripId: number | string, fileId: number, linkId: number) => apiClient.delete(`/trips/${tripId}/files/${fileId}/link/${linkId}`).then(r => r.data),
  getLinks: (tripId: number | string, fileId: number) => apiClient.get(`/trips/${tripId}/files/${fileId}/links`).then(r => r.data),
}

export { reservationsApi } from './local'

// The hosted transit router (`/api/transit/*`) and notification-channel
// endpoints (`/api/notifications/*`) went away with the server — their api
// surfaces were deleted with the planner and settings UIs that called them.

export default apiClient
