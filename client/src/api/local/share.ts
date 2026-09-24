/**
 * `shareApi` — stub until Phase C.
 *
 * The hosted share routes (`POST/GET/DELETE /api/trips/:tripId/share-link`,
 * `GET /api/shared/:token`) minted and served a public token — a server-side
 * concept with no local equivalent. PanelMint's share story is the URL/file
 * codec (plan Task 21: `src/share/codec.ts` → `encodeTrip`/`decodeTrip`/
 * `encodeToFile`/`decodeFromFile`, wired into the members modal by Task 22).
 * Until that lands, the method surface stays so imports compile, and every
 * method throws the same local error instead of silently pretending a link
 * exists.
 */
import { apiError, type LocalApiError } from './helpers';

const NOT_AVAILABLE =
  'Share links need the Phase C codec — not available in this build';

/** Every stubbed method rejects with this — axios-parity shape, never a
 *  synchronous throw. */
function unavailable(): Promise<never> {
  const err: LocalApiError = apiError(501, NOT_AVAILABLE);
  return Promise.reject(err);
}

export const shareApi = {
  getLink: (_tripId: number | string): Promise<never> => unavailable(),
  createLink: (_tripId: number | string, _perms?: Record<string, boolean>): Promise<never> =>
    unavailable(),
  deleteLink: (_tripId: number | string): Promise<never> => unavailable(),
  getSharedTrip: (_token: string): Promise<never> => unavailable(),
};
