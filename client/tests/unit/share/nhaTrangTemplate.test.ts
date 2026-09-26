/**
 * The bundled sample trip — `public/templates/nha-trang-3n2d.json`, the
 * "Sample trip" row in Settings ▸ Data. This file is user-facing: it must
 * stay a valid ShareBundle that decodes through the file transport
 * (decodeFromFile), the link transport (deflate-raw + base64url → decodeTrip)
 * and imports through saveBundle with every relationship remapped — 3 days,
 * the Bình An Hotel stay, and the POI assignments.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../../../src/db/panelmintDb';
import { decodeBundlesFromFile, decodeFromFile, decodeTrip } from '../../../src/share/codec';
import { saveBundle } from '../../../src/share/remap';
import type { LocalUser } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

// vitest runs with cwd = client/, so the public asset is one read off disk.
const TEMPLATE_JSON = readFileSync(join(process.cwd(), 'public/templates/nha-trang-3n2d.json'), 'utf8');

/** deflate-raw + base64url of the raw file bytes — the `/import?d=` token a
 *  static bundle would ride if it were shared as a link. */
async function fileToken(json: string): Promise<string> {
  const bytes = new TextEncoder().encode(json);
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const writeAll = writer.write(bytes as BufferSource).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await writeAll;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  let binary = '';
  for (const b of out) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
});

describe('Nha Trang 3N2Đ template', () => {
  it('decodes as a ShareBundle through the file transport', () => {
    const bundle = decodeFromFile(TEMPLATE_JSON);
    expect(bundle.trip.title).toBe('Nha Trang 3N2Đ');
    expect(bundle.trip.start_date).toBe('2025-06-06');
    expect(bundle.trip.end_date).toBe('2025-06-08');
    expect(bundle.days).toHaveLength(3);
    expect(bundle.places).toHaveLength(8);
    expect(bundle.accommodations).toHaveLength(1);
    // The accommodation references resolve inside the bundle itself.
    const stay = bundle.accommodations[0];
    expect(bundle.places.find((p) => p.id === stay.place_id)?.name).toBe('Bình An Hotel');
    expect(bundle.days.map((d) => d.id)).toEqual(expect.arrayContaining([stay.start_day_id, stay.end_day_id]));
    // Every assignment points at a place the bundle carries.
    for (const day of bundle.days) {
      for (const a of day.assignments ?? []) {
        expect(bundle.places.some((p) => p.id === a.place_id)).toBe(true);
      }
    }
    // …and a one-element archive decode agrees with the single-bundle path.
    expect(decodeBundlesFromFile(TEMPLATE_JSON)).toEqual([bundle]);
  });

  it('decodes through the deflate/base64url link transport too', async () => {
    const viaLink = await decodeTrip(await fileToken(TEMPLATE_JSON));
    const viaFile = decodeFromFile(TEMPLATE_JSON);
    expect(viaLink.trip.title).toBe('Nha Trang 3N2Đ');
    expect(viaLink).toEqual(viaFile);
  });

  it('imports through saveBundle with every relationship remapped', async () => {
    const bundle = decodeFromFile(TEMPLATE_JSON);
    const tripId = await saveBundle(bundle);

    // One new trip owned by self.
    expect(await db.trips.count()).toBe(1);
    const trip = await db.trips.get(tripId);
    expect(trip?.title).toBe('Nha Trang 3N2Đ');
    expect(trip?.user_id).toBe(SELF.id);

    // Three days renumbered 1..3.
    const days = await db.days.where('trip_id').equals(tripId).sortBy('day_number');
    expect(days).toHaveLength(3);
    expect(days.map((d) => d.day_number)).toEqual([1, 2, 3]);

    // The Bình An Hotel stay resolves to the imported place and its day span
    // points at the remapped day rows.
    const places = await db.places.where('trip_id').equals(tripId).toArray();
    expect(places).toHaveLength(8);
    const hotel = places.find((p) => p.name === 'Bình An Hotel');
    expect(hotel).toBeDefined();
    const [stay] = await db.accommodations.where('trip_id').equals(tripId).toArray();
    expect(stay.place_id).toBe(hotel!.id);
    expect(stay.start_day_id).toBe(days[0].id);
    expect(stay.end_day_id).toBe(days[2].id);

    // POI stops landed on their days, remapped onto the imported place ids.
    const placeIds = new Set(places.map((p) => p.id));
    const perDay = days.map((d) => (d.assignments ?? []).length);
    expect(perDay).toEqual([3, 3, 2]);
    const names = new Set(places.map((p) => p.name));
    for (const poi of [
      'Nha Trang Cathedral',
      'Đầm Market',
      'Nha Trang Beach',
      'Po Nagar Cham Towers',
      'Hòn Chồng Promontory',
      'Long Sơn Pagoda',
      'Trầm Hương Tower',
    ]) {
      expect(names).toContain(poi);
    }
    for (const day of days) {
      for (const a of day.assignments ?? []) {
        expect(a.day_id).toBe(day.id);
        expect(placeIds.has(a.place_id)).toBe(true);
      }
    }
  });
});
