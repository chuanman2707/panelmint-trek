/**
 * The two transports a trip leaves the device by: the `/import?d=` share link
 * (deflate + base64url, capped at SHARE_URL_MAX_CHARS) and the
 * `.panelmint.json` file download. Both thin wrappers over `codec.ts` plus the
 * project's existing clipboard/download helpers — kept here so the navbar
 * button and the export rows share one code path.
 */
import { copyText } from '../utils/clipboard';
import { downloadBlob } from '../utils/fileDownload';
import { encodeToFile, encodeTrip, SHARE_URL_MAX_CHARS } from './codec';

/** `<title>.panelmint.json`, with the path-hostile characters folded to `-`. */
export function tripFileName(title: string | null | undefined): string {
  const base = (title ?? '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'trip'}.panelmint.json`;
}

/** Encode the trip and trigger the `.panelmint.json` download. */
export async function downloadTripFile(tripId: number, title?: string | null): Promise<void> {
  const json = await encodeToFile(tripId);
  downloadBlob(new Blob([json], { type: 'application/json' }), tripFileName(title));
}

/** Absolute `/import?d=` URL under the app's configured base path. */
function importUrl(token: string): string {
  const url = new URL(`${import.meta.env.BASE_URL}import`, window.location.origin);
  url.searchParams.set('d', token);
  return url.toString();
}

export type ShareOutcome = 'copied' | 'file' | 'copy-failed';

/**
 * Encode → link → clipboard. Past the URL ceiling the trip can't ride a link —
 * the file export takes over (the caller toasts which transport won). A
 * refused clipboard answers 'copy-failed' rather than throwing.
 */
export async function shareTripLink(tripId: number, title?: string | null): Promise<ShareOutcome> {
  const url = importUrl(await encodeTrip(tripId));
  if (url.length > SHARE_URL_MAX_CHARS) {
    await downloadTripFile(tripId, title);
    return 'file';
  }
  return (await copyText(url)) ? 'copied' : 'copy-failed';
}
