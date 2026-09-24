/**
 * Tests for the `shareApi` stub — every method rejects with a local
 * "not available" error until the Phase C codec (src/share/codec.ts) lands.
 * The pin that matters: rejections, not sync throws, in the axios-shaped
 * `LocalApiError` envelope.
 */
import { describe, expect, it } from 'vitest';
import { shareApi } from '../../../src/api/local/share';
import { LocalApiError } from '../../../src/api/local/helpers';

const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('shareApi stub', () => {
  it('every method rejects with a LocalApiError carrying the Phase C message', async () => {
    for (const call of [
      () => shareApi.getLink(1),
      () => shareApi.createLink(1),
      () => shareApi.createLink(1, { share_map: true }),
      () => shareApi.deleteLink(1),
      () => shareApi.getSharedTrip('tok'),
    ]) {
      const err = await fail(call());
      expect(err).toBeInstanceOf(LocalApiError);
      expect(err.response.status).toBe(501);
      expect(err.response.data.error).toBe('Share links need the Phase C codec — not available in this build');
    }
  });
});
