import axios, { AxiosInstance } from 'axios'
import type { z } from 'zod'
import type { Place } from '../types'
import { randomId } from '../utils/randomId'
import {
  weatherResultSchema,
  type WeatherResult,
  mapsSearchResultSchema,
  mapsAutocompleteResultSchema,
  mapsPlaceDetailsResultSchema,
  mapsPlacePhotoResultSchema,
  mapsReverseResultSchema,
  mapsResolveUrlResultSchema,
  mapsPlaceEnrichmentResultSchema,
  type SettingUpsertRequest,
  type SettingsBulkRequest,
  type AssignmentReorderRequest,
  type PackingReorderRequest,
  type PackingCreateBagRequest,
  type TodoReorderRequest,
  type PlaceCreateRequest,
  type PlaceUpdateRequest,
  type ReservationCreateRequest,
  type ReservationUpdateRequest,
  type AccommodationCreateRequest,
  type AccommodationUpdateRequest,
  type BudgetCreateItemRequest,
  type BudgetUpdateItemRequest,
  type PackingCreateItemRequest,
  type PackingUpdateItemRequest,
  type PackingSetSharingRequest,
  type TodoCreateItemRequest,
  type TodoUpdateItemRequest,
  type AssignmentCreateRequest,
  type AssignmentNotesRequest,
  type AssignmentParticipantsRequest,
  type AssignmentTimeRequest,
  type AssignmentTransportRequest,
  type PlaceBulkDeleteRequest,
  type PlaceBulkUpdateRequest,
  type DayNoteCreateRequest,
  type DayNoteUpdateRequest,
  type PackingImportRequest,
  type PackingBagMembersRequest,
  type PackingUpdateBagRequest,
  type PackingCategoryAssigneesRequest,
  type PackingApplyTemplateRequest,
  type BudgetUpdateMembersRequest,
  type BudgetToggleMemberPaidRequest,
  type BudgetReorderCategoriesRequest,
  type TodoCategoryAssigneesRequest,
  type FileUpdateRequest,
  type FileLinkRequest,
  type CreateTagRequest,
  type UpdateTagRequest,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
  type PlaceImportListRequest,
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

/**
 * Same dev-only drift check as parseInDev, but passes the payload straight
 * through with its original inferred type instead of the schema type. Use this
 * for endpoints whose existing consumers rely on the loose `r.data` type — it
 * adds the development contract-drift warning without retyping the public
 * surface (so it can never break a consumer that worked before).
 */
function checkInDev<T>(schema: z.ZodTypeAny, data: T, label: string): T {
  if (API_DEV) {
    const result = schema.safeParse(data)
    if (!result.success) {
      console.warn(`[api] ${label}: response did not match the @trek/shared schema`, result.error.issues)
    }
  }
  return data
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
    const lang = localStorage.getItem('app_language') || localStorage.getItem('app_language_server') || 'en'
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

// tripsApi/daysApi are local (api/local/*) — the axios objects were deleted
// when their adapters landed (README.md barrel strategy, step 3).
export { tripsApi, daysApi, dashboardApi } from './local'

export const placesApi = {
  list: (tripId: number | string, params?: Record<string, unknown>) => apiClient.get(`/trips/${tripId}/places`, { params }).then(r => r.data),
  // Typed: an untyped `r.data` is what let `{ place }` be read as a bare place,
  // so every hotel booking minted an unlinked duplicate (#2243).
  create: (tripId: number | string, data: PlaceCreateRequest): Promise<{ place: Place }> =>
    apiClient.post(`/trips/${tripId}/places`, data).then(r => r.data),
  get: (tripId: number | string, id: number | string) => apiClient.get(`/trips/${tripId}/places/${id}`).then(r => r.data),
  update: (tripId: number | string, id: number | string, data: PlaceUpdateRequest) => apiClient.put(`/trips/${tripId}/places/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number | string) => apiClient.delete(`/trips/${tripId}/places/${id}`).then(r => r.data),
  searchImage: (tripId: number | string, id: number | string) => apiClient.get(`/trips/${tripId}/places/${id}/image`).then(r => r.data),
  uploadImage: (tripId: number | string, id: number | string, file: File) => {
    const fd = new FormData()
    fd.append('image', file)
    return postMultipart<{ place: Place }>(`/trips/${tripId}/places/${id}/image`, fd)
  },
  rate: (tripId: number | string, id: number | string, rating: number | null): Promise<{ place: Place }> =>
    rating === null
      ? apiClient.delete(`/trips/${tripId}/places/${id}/rating`).then(r => r.data)
      : apiClient.put(`/trips/${tripId}/places/${id}/rating`, { rating }).then(r => r.data),
  importGpx: (tripId: number | string, file: File, opts?: { waypoints?: boolean; routes?: boolean; tracks?: boolean }) => {
    const fd = new FormData()
    fd.append('file', file)
    if (opts?.waypoints !== undefined) fd.append('importWaypoints', String(opts.waypoints))
    if (opts?.routes !== undefined) fd.append('importRoutes', String(opts.routes))
    if (opts?.tracks !== undefined) fd.append('importTracks', String(opts.tracks))
    return postMultipart(`/trips/${tripId}/places/import/gpx`, fd)
  },
  importMapFile: (tripId: number | string, file: File, opts?: { points?: boolean; paths?: boolean }) => {
    const fd = new FormData()
    fd.append('file', file)
    if (opts?.points !== undefined) fd.append('importPoints', String(opts.points))
    if (opts?.paths !== undefined) fd.append('importPaths', String(opts.paths))
    return postMultipart(`/trips/${tripId}/places/import/map`, fd)
  },
  // A longer timeout than the shared 8 s, like the other routes here that wait
  // on somebody else's service. A directions link whose stops are only named
  // has to be geocoded one at a time behind a 1.1 s throttle, so a route with
  // eight stops needs about ten seconds. Giving up at eight left the server
  // finishing the import and writing the places while the browser reported a
  // failure, and a retry then spent the whole geocoding budget again only to
  // have the dedupe skip every stop.
  importGoogleList: (tripId: number | string, url: string, enrich?: boolean) =>
      apiClient.post(`/trips/${tripId}/places/import/google-list`, { url, enrich } satisfies PlaceImportListRequest, { timeout: 60000 }).then(r => r.data),
  importNaverList: (tripId: number | string, url: string, enrich?: boolean) =>
      apiClient.post(`/trips/${tripId}/places/import/naver-list`, { url, enrich } satisfies PlaceImportListRequest).then(r => r.data),
  bulkDelete: (tripId: number | string, ids: number[]) =>
      apiClient.post(`/trips/${tripId}/places/bulk-delete`, { ids } satisfies PlaceBulkDeleteRequest).then(r => r.data),
  bulkUpdate: (tripId: number | string, ids: number[], data: Omit<PlaceBulkUpdateRequest, 'ids'>) =>
      apiClient.post(`/trips/${tripId}/places/bulk-update`, { ids, ...data } satisfies PlaceBulkUpdateRequest).then(r => r.data),
}

export const assignmentsApi = {
  list: (tripId: number | string, dayId: number | string) => apiClient.get(`/trips/${tripId}/days/${dayId}/assignments`).then(r => r.data),
  create: (tripId: number | string, dayId: number | string, data: AssignmentCreateRequest) => apiClient.post(`/trips/${tripId}/days/${dayId}/assignments`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/days/${dayId}/assignments/${id}`).then(r => r.data),
  reorder: (tripId: number | string, dayId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/days/${dayId}/assignments/reorder`, { orderedIds } satisfies AssignmentReorderRequest).then(r => r.data),
  move: (tripId: number | string, assignmentId: number, newDayId: number | string, orderIndex: number | null) => apiClient.put(`/trips/${tripId}/assignments/${assignmentId}/move`, { new_day_id: newDayId, order_index: orderIndex }).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/days/${dayId}/assignments/${id}`, data).then(r => r.data),
  getParticipants: (tripId: number | string, id: number) => apiClient.get(`/trips/${tripId}/assignments/${id}/participants`).then(r => r.data),
  setParticipants: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/assignments/${id}/participants`, { user_ids: userIds } satisfies AssignmentParticipantsRequest).then(r => r.data),
  updateTime: (tripId: number | string, id: number, times: AssignmentTimeRequest) => apiClient.put(`/trips/${tripId}/assignments/${id}/time`, times).then(r => r.data),
  // Day-specific note on an assignment (#2163) — null clears it.
  updateNotes: (tripId: number | string, id: number, data: AssignmentNotesRequest) => apiClient.put(`/trips/${tripId}/assignments/${id}/notes`, data).then(r => r.data),
  // Per-segment travel mode (#1281): mode of the leg leaving this stop (null = inherit day default).
  // direction defaults to 'outgoing' server-side, so only send it for the incoming (boundary-leg) case
  // and keep the outgoing payload byte-for-byte identical to the pre-#1281 shape.
  updateTransport: (tripId: number | string, id: number, mode: string | null, direction: 'outgoing' | 'incoming' = 'outgoing') => apiClient.put(`/trips/${tripId}/assignments/${id}/transport`, (direction === 'incoming' ? { transport_mode: mode, direction } : { transport_mode: mode }) satisfies Partial<AssignmentTransportRequest>).then(r => r.data),
}

export const packingApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing`).then(r => r.data),
  create: (tripId: number | string, data: PackingCreateItemRequest) => apiClient.post(`/trips/${tripId}/packing`, data).then(r => r.data),
  bulkImport: (tripId: number | string, items: { name: string; category?: string; quantity?: number }[]) => apiClient.post(`/trips/${tripId}/packing/import`, { items } satisfies PackingImportRequest).then(r => r.data),
  update: (tripId: number | string, id: number, data: PackingUpdateItemRequest) => apiClient.put(`/trips/${tripId}/packing/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/packing/${id}`).then(r => r.data),
  reorder: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/packing/reorder`, { orderedIds } satisfies PackingReorderRequest).then(r => r.data),
  setSharing: (tripId: number | string, id: number, data: PackingSetSharingRequest) => apiClient.put(`/trips/${tripId}/packing/${id}/sharing`, data).then(r => r.data),
  clone: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/packing/${id}/clone`).then(r => r.data),
  addContributor: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/packing/${id}/contributors`).then(r => r.data),
  removeContributor: (tripId: number | string, id: number, userId: number) => apiClient.delete(`/trips/${tripId}/packing/${id}/contributors/${userId}`).then(r => r.data),
  getCategoryAssignees: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/category-assignees`).then(r => r.data),
  setCategoryAssignees: (tripId: number | string, categoryName: string, userIds: number[]) => apiClient.put(`/trips/${tripId}/packing/category-assignees/${encodeURIComponent(categoryName)}`, { user_ids: userIds } satisfies PackingCategoryAssigneesRequest).then(r => r.data),
  listTemplates: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/templates`).then(r => r.data),
  applyTemplate: (tripId: number | string, templateId: number, visibility: 'common' | 'personal' = 'common') => apiClient.post(`/trips/${tripId}/packing/apply-template/${templateId}`, { visibility } satisfies PackingApplyTemplateRequest).then(r => r.data),
  saveAsTemplate: (tripId: number | string, name: string) => apiClient.post(`/trips/${tripId}/packing/save-as-template`, { name }).then(r => r.data),
  setBagMembers: (tripId: number | string, bagId: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/packing/bags/${bagId}/members`, { user_ids: userIds } satisfies PackingBagMembersRequest).then(r => r.data),
  listBags: (tripId: number | string) => apiClient.get(`/trips/${tripId}/packing/bags`).then(r => r.data),
  createBag: (tripId: number | string, data: PackingCreateBagRequest) => apiClient.post(`/trips/${tripId}/packing/bags`, data).then(r => r.data),
  updateBag: (tripId: number | string, bagId: number, data: PackingUpdateBagRequest) => apiClient.put(`/trips/${tripId}/packing/bags/${bagId}`, data).then(r => r.data),
  deleteBag: (tripId: number | string, bagId: number) => apiClient.delete(`/trips/${tripId}/packing/bags/${bagId}`).then(r => r.data),
}

export const todoApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/todo`).then(r => r.data),
  create: (tripId: number | string, data: TodoCreateItemRequest) => apiClient.post(`/trips/${tripId}/todo`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: TodoUpdateItemRequest) => apiClient.put(`/trips/${tripId}/todo/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/todo/${id}`).then(r => r.data),
  reorder: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/todo/reorder`, { orderedIds } satisfies TodoReorderRequest).then(r => r.data),
  getCategoryAssignees: (tripId: number | string) => apiClient.get(`/trips/${tripId}/todo/category-assignees`).then(r => r.data),
  setCategoryAssignees: (tripId: number | string, categoryName: string, userIds: number[]) => apiClient.put(`/trips/${tripId}/todo/category-assignees/${encodeURIComponent(categoryName)}`, { user_ids: userIds } satisfies TodoCategoryAssigneesRequest).then(r => r.data),
}

export const tagsApi = {
  list: () => apiClient.get('/tags').then(r => r.data),
  create: (data: CreateTagRequest) => apiClient.post('/tags', data).then(r => r.data),
  update: (id: number, data: UpdateTagRequest) => apiClient.put(`/tags/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/tags/${id}`).then(r => r.data),
}

export const categoriesApi = {
  list: () => apiClient.get('/categories').then(r => r.data),
  create: (data: CreateCategoryRequest) => apiClient.post('/categories', data).then(r => r.data),
  update: (id: number, data: UpdateCategoryRequest) => apiClient.put(`/categories/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/categories/${id}`).then(r => r.data),
}

export const mapsApi = {
  /**
   * `locationBias` is what tells the search which "Hase-dera" is meant, and it
   * is the difference between finding the temple the user stands next to and
   * one 400km away. The route has always accepted it; nothing passed it.
   *
   * It also decides whether the index answers at all: a common single word
   * without coordinates is refused upstream as too expensive, and the search
   * then falls back to Nominatim alone.
   *
   * `provider: 'google'` sends this one search to Google alone, the "search Google
   * instead" link under a list the index answered with the wrong place. The server
   * ignores it unless Google holds the keyed slot: without a Google key, or with
   * Amap or OpenStreetMap picked as the provider, the index answers as usual.
   */
  search: (query: string, lang?: string, locationBias?: { lat: number; lng: number; radius?: number }, provider?: 'google') =>
    apiClient.post(`/maps/search?lang=${lang || 'en'}`, { query, locationBias, ...(provider ? { provider } : {}) }).then(r => checkInDev(mapsSearchResultSchema, r.data, 'maps.search')),
  autocomplete: (input: string, lang?: string, locationBias?: { low: { lat: number; lng: number }; high: { lat: number; lng: number } }, signal?: AbortSignal, sessionToken?: string) =>
    apiClient.post('/maps/autocomplete', { input, lang, locationBias, sessionToken }, { signal }).then(r => checkInDev(mapsAutocompleteResultSchema, r.data, 'maps.autocomplete')),
  details: (placeId: string, lang?: string, sessionToken?: string) =>
    apiClient.get(`/maps/details/${encodeURIComponent(placeId)}`, { params: { lang, sessionToken } })
      .then(r => checkInDev(mapsPlaceDetailsResultSchema, r.data, 'maps.details')),
  // Pictures and a description for a place that is being looked at but not yet
  // saved. Fans out to several providers server-side, so it takes a signal and
  // the caller is expected to abort it when the selection changes, and a longer
  // timeout than the global 8s — a cold Wikimedia connection alone can eat that.
  placeEnrichment: (
    body: { placeId?: string; lat: number; lng: number; name: string; lang?: string; details?: Record<string, unknown> },
    signal?: AbortSignal,
  ) => apiClient.post('/maps/enrichment', body, { signal, timeout: 25000 })
      .then(r => checkInDev(mapsPlaceEnrichmentResultSchema, r.data, 'maps.placeEnrichment')),
  // Author + licence for a picture already stored in the photo cache, keyed by
  // the cache key embedded in its proxy URL. Local read, no provider call.
  placePhotoCredit: (key: string) =>
    apiClient.get(`/maps/enrichment/credit/${encodeURIComponent(key)}`).then(r => r.data as { credit: string | null }),
  placePhoto: (placeId: string, lat?: number, lng?: number, name?: string) => apiClient.get(`/maps/place-photo/${encodeURIComponent(placeId)}`, { params: { lat, lng, name } }).then(r => checkInDev(mapsPlacePhotoResultSchema, r.data, 'maps.placePhoto')),
  reverse: (lat: number, lng: number, lang?: string) => apiClient.get('/maps/reverse', { params: { lat, lng, lang } }).then(r => checkInDev(mapsReverseResultSchema, r.data, 'maps.reverse')),
  resolveUrl: (url: string) => apiClient.post('/maps/resolve-url', { url }).then(r => checkInDev(mapsResolveUrlResultSchema, r.data, 'maps.resolveUrl')),
  // OSM-only POI explore: places of a category within the current map viewport bbox.
  // Overpass can be slow on a fresh (uncached) area, so this call gets a longer
  // timeout than the global default instead of aborting at 8s and showing nothing.
  /**
   * Every place in a box, for the offline cache. One call per trip area, not
   * per keystroke, so the timeout is generous where the search ones are short.
   */
  area: (
    bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
    limit?: number,
    signal?: AbortSignal,
  ) =>
    apiClient
      .get('/maps/area', { params: { ...bbox, limit }, signal, timeout: 30000 })
      .then(
        (r) =>
          r.data as {
            results: Record<string, unknown>[]
            truncated: boolean
            unavailable?: boolean
          },
      ),

  pois: (category: string, bbox: { south: number; west: number; north: number; east: number }, lang?: string, signal?: AbortSignal) =>
    apiClient.get('/maps/pois', { params: { category, ...bbox, lang }, signal, timeout: 20000 }).then(r => r.data as { pois: import('../components/Map/poiCategories').Poi[]; source: string; truncated: boolean; clamped?: boolean }),
}

/**
 * Road-trip via points (#1797): the places a day's drive is routed through without
 * stopping. Separate from places on purpose — a via bends the route, a stop is somewhere
 * you go.
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

export const airportsApi = {
  search: (q: string, signal?: AbortSignal) => apiClient.get('/airports/search', { params: { q }, signal }).then(r => r.data),
  byIata: (iata: string) => apiClient.get(`/airports/${encodeURIComponent(iata)}`).then(r => r.data),
}

export const budgetApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget`).then(r => r.data),
  create: (tripId: number | string, data: BudgetCreateItemRequest) => apiClient.post(`/trips/${tripId}/budget`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: BudgetUpdateItemRequest) => apiClient.put(`/trips/${tripId}/budget/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/budget/${id}`).then(r => r.data),
  setMembers: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/budget/${id}/members`, { user_ids: userIds } satisfies BudgetUpdateMembersRequest).then(r => r.data),
  togglePaid: (tripId: number | string, id: number, userId: number, paid: boolean) => apiClient.put(`/trips/${tripId}/budget/${id}/members/${userId}/paid`, { paid } satisfies BudgetToggleMemberPaidRequest).then(r => r.data),
  setPayers: (tripId: number | string, id: number, payers: { user_id: number; amount: number }[]) => apiClient.put(`/trips/${tripId}/budget/${id}/payers`, { payers }).then(r => r.data),
  perPersonSummary: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget/summary/per-person`).then(r => r.data),
  settlement: (tripId: number | string, base?: string) => apiClient.get(`/trips/${tripId}/budget/settlement`, base ? { params: { base } } : undefined).then(r => r.data),
  createSettlement: (tripId: number | string, data: { from_user_id: number; to_user_id: number; amount: number; currency?: string; settled_at?: string | null }) => apiClient.post(`/trips/${tripId}/budget/settlements`, data).then(r => r.data),
  updateSettlement: (tripId: number | string, settlementId: number, data: { from_user_id: number; to_user_id: number; amount: number; currency?: string; settled_at?: string | null }) => apiClient.put(`/trips/${tripId}/budget/settlements/${settlementId}`, data).then(r => r.data),
  deleteSettlement: (tripId: number | string, settlementId: number) => apiClient.delete(`/trips/${tripId}/budget/settlements/${settlementId}`).then(r => r.data),
  reorderItems: (tripId: number | string, orderedIds: number[]) => apiClient.put(`/trips/${tripId}/budget/reorder/items`, { orderedIds }).then(r => r.data),
  reorderCategories: (tripId: number | string, orderedCategories: string[]) => apiClient.put(`/trips/${tripId}/budget/reorder/categories`, { orderedCategories } satisfies BudgetReorderCategoriesRequest).then(r => r.data),
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

export const reservationsApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/reservations`).then(r => r.data),
  create: (tripId: number | string, data: ReservationCreateRequest) => apiClient.post(`/trips/${tripId}/reservations`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: ReservationUpdateRequest) => apiClient.put(`/trips/${tripId}/reservations/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/reservations/${id}`).then(r => r.data),
  // Assign trip members / named guests to a booking (#1517).
  setTravelers: (tripId: number | string, id: number, userIds: number[]) => apiClient.put(`/trips/${tripId}/reservations/${id}/travelers`, { user_ids: userIds }).then(r => r.data),
  updatePositions: (tripId: number | string, positions: { id: number; day_plan_position: number }[], dayId?: number) => apiClient.put(`/trips/${tripId}/reservations/positions`, { positions, day_id: dayId }).then(r => r.data),
}

export const weatherApi = {
  // `time` (HH:MM) makes a past date answer for that hour instead of the day (#1614).
  // `lang` localizes the description; when omitted the server keeps its own default (#2167).
  get: (lat: number, lng: number, date: string, lang?: string, time?: string): Promise<WeatherResult> => apiClient.get('/weather', { params: { lat, lng, date, lang, time } }).then(r => parseInDev(weatherResultSchema, r.data, 'weather.get')),
  getCurrent: (lat: number, lng: number, lang?: string): Promise<WeatherResult> => apiClient.get('/weather', { params: { lat, lng, lang } }).then(r => parseInDev(weatherResultSchema, r.data, 'weather.getCurrent')),
  getDetailed: (lat: number, lng: number, date: string, lang?: string): Promise<WeatherResult> => apiClient.get('/weather/detailed', { params: { lat, lng, date, lang } }).then(r => parseInDev(weatherResultSchema, r.data, 'weather.getDetailed')),
}

export const settingsApi = {
  get: () => apiClient.get('/settings').then(r => r.data),
  set: (key: string, value: unknown) => {
    const body: SettingUpsertRequest = { key, value }
    return apiClient.put('/settings', body).then(r => r.data)
  },
  setBulk: (settings: Record<string, unknown>) => {
    const body: SettingsBulkRequest = { settings }
    return apiClient.post('/settings/bulk', body).then(r => r.data)
  },
}

export const accommodationsApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/accommodations`).then(r => r.data),
  create: (tripId: number | string, data: AccommodationCreateRequest) => apiClient.post(`/trips/${tripId}/accommodations`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: AccommodationUpdateRequest) => apiClient.put(`/trips/${tripId}/accommodations/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number, opts?: { keepStop?: boolean }) => apiClient.delete(`/trips/${tripId}/accommodations/${id}`, opts?.keepStop ? { params: { keepStop: 'true' } } : undefined).then(r => r.data),
}

export const dayNotesApi = {
  list: (tripId: number | string, dayId: number | string) => apiClient.get(`/trips/${tripId}/days/${dayId}/notes`).then(r => r.data),
  create: (tripId: number | string, dayId: number | string, data: DayNoteCreateRequest) => apiClient.post(`/trips/${tripId}/days/${dayId}/notes`, data).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, id: number, data: DayNoteUpdateRequest) => apiClient.put(`/trips/${tripId}/days/${dayId}/notes/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/days/${dayId}/notes/${id}`).then(r => r.data),
}

// The hosted transit router (`/api/transit/*`) and notification-channel
// endpoints (`/api/notifications/*`) went away with the server — their api
// surfaces were deleted with the planner and settings UIs that called them.

export default apiClient
