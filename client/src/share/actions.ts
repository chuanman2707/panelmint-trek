/**
 * The two transports a trip leaves the device by: the `/import?d=` share link
 * (deflate + base64url, capped at SHARE_URL_MAX_CHARS) and the
 * `.panelmint.json` file download. Both thin wrappers over `codec.ts` plus the
 * project's existing clipboard/download helpers — kept here so the navbar
 * button and the export rows share one code path.
 */
import { copyText } from '../utils/clipboard';
import { downloadBlob } from '../utils/fileDownload';
import { db } from '../db/panelmintDb';
import { encodeAllToFile, encodeToFile, encodeTrip, SHARE_URL_MAX_CHARS } from './codec';

/** `<title>.panelmint.json`, with the path-hostile characters folded to `-`. */
export function tripFileName(title: string | null | undefined): string {
  const base = (title ?? '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'trip'}.panelmint.json`;
}

/** `panelmint-backup-YYYY-MM-DD.panelmint.json` — the export-all archive. */
export function allTripsFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `panelmint-backup-${day}.panelmint.json`;
}

/** Encode the trip and trigger the `.panelmint.json` download. */
export async function downloadTripFile(tripId: number, title?: string | null): Promise<void> {
  const json = await encodeToFile(tripId);
  downloadBlob(new Blob([json], { type: 'application/json' }), tripFileName(title));
}

export type DownloadAllOutcome = 'downloaded' | 'empty';

/**
 * Settings "Export all" — every trip on the device (archived included, it's a
 * backup) packed into one `panelmint-archive` `.panelmint.json`. With nothing
 * to export it answers 'empty' and downloads nothing.
 */
export async function downloadAllTripsFile(): Promise<DownloadAllOutcome> {
  if ((await db.trips.count()) === 0) return 'empty';
  const json = await encodeAllToFile();
  downloadBlob(new Blob([json], { type: 'application/json' }), allTripsFileName());
  return 'downloaded';
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
