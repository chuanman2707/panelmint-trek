// Shared helpers for the `api/local/*` adapters — the pieces every domain
// module needs so the conventions in ./README.md stay one import away.
//
// Error shape contract: callers render failures through `getErrorMessage` /
// `getApiErrorMessage` (src/utils/apiError.ts) and read `err.response?.status`
// the way they did with axios.
// `LocalApiError` carries both surfaces — `message`, `.status` and
// `.response.data.error` — so an error thrown here is indistinguishable
// downstream from an HTTP error the server used to produce.
import type { Table } from 'dexie'
import type { z, ZodType } from 'zod'

/** UTC now as an ISO string — what every server-side `created_at` used. */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * An API error with no HTTP layer: an Error carrying the axios-compatible
 * `response.status` / `response.data.error` plus a bare `.status` for
 * consumers that read it directly. The apiError helpers find `response` and
 * returns `data.error` — the same string the server's error envelope sent —
 * and status checks like `err.response?.status === 404` keep working.
 */
export class LocalApiError extends Error {
  readonly status: number
  readonly response: { status: number; data: { error: string; code?: string } }

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'LocalApiError'
    this.status = status
    this.response = { status, data: code ? { error: message, code } : { error: message } }
  }
}

/** Build a `LocalApiError`; `message` must be the string the server returned. */
export function apiError(status: number, message: string, code?: string): LocalApiError {
  return new LocalApiError(status, message, code)
}

/** 404 — `what` is the entity noun, so 'Trip' produces 'Trip not found'. */
export function notFound(what: string): LocalApiError {
  return apiError(404, `${what} not found`)
}

/** 400 — validation failures the server rejected with a plain error string. */
export function badRequest(message: string, code?: string): LocalApiError {
  return apiError(400, message, code)
}

/**
 * `table.get(id)` or a 404. A non-finite id is the local form of a route param
 * that coerced to NaN: the server's `Number(:id)` bound as NULL, matched no
 * row, and hit the same 'X not found' 404 (`idParamSchema` exists in shared
 * but is not wired to path params — controllers pass raw strings). Guarded
 * here because `table.get(NaN)` would instead throw a raw IndexedDB
 * `DataError` that no consumer renders.
 *
 * The returned row is a detached snapshot (structuredClone), matching what a
 * server SELECT handed the ported code — mutating it must never leak into the
 * store or a later read in the same transaction.
 */
export async function requireRow<T>(table: Table<T, number>, id: number, what: string): Promise<T> {
  if (!Number.isFinite(id)) throw notFound(what)
  const row = await table.get(id)
  if (!row) throw notFound(what)
  return structuredClone(row)
}

/**
 * Detached copy of one row. Every seam `list*`/`get*` read returns snapshots
 * like this: the server's `SELECT` rows were plain data the ported code
 * scribbles on as bookkeeping (e.g. `resyncAccommodationDays` rewrites
 * `stay.start_day_id`), and a shared or frozen store row must not observe
 * that. Structured-clone so embedded arrays (a day's assignments) detach too.
 */
export function detached<T>(row: T): T {
  return structuredClone(row)
}

/** Detached copy of a list — one clone per row, order preserved. */
export function detachedList<T>(rows: readonly T[]): T[] {
  return rows.map(row => structuredClone(row))
}

/**
 * Route-param id to Dexie key. Api methods take `number | string` the way the
 * REST path params arrived; the `panelmint` tables are keyed by number.
 *
 * An unparseable id yields NaN — a "matches nothing" value that `requireRow`
 * converts into the same 404 the server's NULL-bound lookup produced. Do NOT
 * feed it into `where().equals()`/`get()` directly: IndexedDB keys reject NaN
 * with a raw `DataError`. Verify the parent row with `requireRow` first, which
 * is also what the server's trip-access guard did.
 */
export function numId(id: number | string): number {
  return typeof id === 'string' ? Number(id) : id
}

/**
 * The server's `ZodValidationPipe` (nest/common/zod-validation.pipe.ts) for a
 * request body: run the shared contract schema, and on failure format the same
 * `'path: message; path: message'` error the pipe raised (root issues labeled
 * `body`, `Validation failed` when no issues were produced). Adapters validate
 * through the same zod schemas so error strings stay single-sourced.
 */
export function parseBody<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`)
      .join('; ')
    throw badRequest(message || 'Validation failed')
  }
  return result.data
}
