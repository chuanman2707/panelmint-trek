// API error shape shared by axios rejections and the local adapters' LocalApiError.
export interface ApiErrorShape {
  response?: {
    data?: {
      error?: unknown
    }
    status?: number
  }
  message: string
}

/**
 * Pulls the server-provided error string out of an axios-style error so the UI can
 * surface the real reason (e.g. a Google Places API message such as "Places API (New)
 * has not been used in project … or it is disabled") instead of a generic fallback.
 * Axios' own message ("Request failed with status code 500") is untranslated
 * boilerplate, so only the envelope's error text beats the localized fallback.
 */
export function getApiErrorMessage(err: unknown, fallback: string): string {
  const server = (err as ApiErrorShape | undefined)?.response?.data?.error
  return typeof server === 'string' && server.trim() ? server : fallback
}

/**
 * Safely extracts a message from an unknown catch value for the store slices: the
 * envelope's error text first, then — for a plain `Error` like a Dexie failure —
 * its own `message`, which is the real reason the write failed. Anything else gets
 * the fallback.
 */
export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const server = (err as ApiErrorShape).response?.data?.error
    // An envelope without error text means axios boilerplate ("Request failed
    // with status code …") — the localized fallback reads better.
    return typeof server === 'string' && server.trim() ? server : fallback
  }
  if (err instanceof Error) return err.message
  return fallback
}
