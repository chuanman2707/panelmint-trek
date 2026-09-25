import axios, { AxiosInstance } from 'axios'
import type { z } from 'zod'
import { randomId } from '../utils/randomId'
import {
  type PackingReorderRequest,
  type PackingCreateBagRequest,
  type TodoReorderRequest,
  type BudgetCreateItemRequest,
  type BudgetUpdateItemRequest,
  type PackingCreateItemRequest,
  type PackingUpdateItemRequest,
  type PackingSetSharingRequest,
  type TodoCreateItemRequest,
  type TodoUpdateItemRequest,
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
export { tripsApi, daysApi, dashboardApi, weatherApi, airportsApi, tagsApi, tripMembersApi, shareApi, configApi, placesApi, categoriesApi, mapsApi, assignmentsApi, accommodationsApi } from './local'

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

export { reservationsApi } from './local'

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
