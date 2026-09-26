/**
 * Tests for the share codec (src/share/codec.ts) — the v1 envelope's roundtrip
 * fidelity over the real Dexie `panelmint` database (fake-indexeddb), the
 * junction embeds, the server-URL strip, version rejection, unknown-field
 * tolerance and the SHARE_URL_MAX_CHARS signal that pushes a big trip onto the
 * file transport.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DayRow, StoredAssignment } from '../../../src/api/local/dexieStore';
import { db, type LocalTripMember } from '../../../src/db/panelmintDb';
import {
  buildBundle,
  decodeBundlesFromFile,
  decodeFromFile,
  decodeTrip,
  encodeAllToFile,
  encodeToFile,
  encodeTrip,
  SHARE_URL_MAX_CHARS,
} from '../../../src/share/codec';
import type { BudgetSettlement, LocalUser } from '../../../src/types';
import {
  buildBudgetItem,
  buildCategory,
  buildDay,
  buildDayNote,
  buildPackingItem,
  buildPlace,
  buildReservation,
  buildTag,
  buildTodoItem,
  buildTrip,
} from '../../helpers/factories';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
}

beforeEach(resetDb);

const seedMember = (userId: number, name: string) =>
  db.tripMembers.put({
    tripId: 1,
    id: userId,
    username: name,
    role: 'member',
    added_at: '2025-01-01T00:00:00.000Z',
    invited_by_username: 'Me',
    is_guest: true,
  } as LocalTripMember);

/** The `api/local` write path's embedded assignment — bare server columns, no
 *  `place` join, `end_day` as SQLite 0/1. */
const storedAssignment = (over: Partial<StoredAssignment> = {}): StoredAssignment => ({
  id: 10,
  day_id: 1,
  place_id: 5,
  order_index: 0,
  notes: null,
  reservation_status: null,
  reservation_notes: null,
  reservation_datetime: null,
  assignment_time: null,
  assignment_end_time: null,
  end_day: 0,
  accommodation_id: null,
  leg_transport_mode: null,
  incoming_leg_transport_mode: null,
  created_at: '2025-01-01T00:00:00.000Z',
  ...over,
});

/**
 * deflate-raw + base64url of a JSON payload — a foreign producer, so
 * `decodeTrip` is exercised against bytes this codec never emitted.
 */
async function craftToken(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
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

const randomText = (n: number): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

describe('share codec', () => {
  it('SHARE-001 — roundtrips every envelope collection byte-identically, junctions embedded', async () => {
    await db.trips.put(buildTrip({ id: 1, cover_image: 'gradient:emerald' }));
    await db.localUsers.put({ id: 2, name: 'Ana', is_self: 0 });
    await seedMember(2, 'Ana');

    const day1Assignment = storedAssignment({ id: 10, day_id: 1, place_id: 5 });
    const day1 = {
      ...buildDay({ id: 1, trip_id: 1, day_number: 1, date: '2025-06-01' }),
      vias: [{ id: 3, day_id: 1, after_order_index: 0, sequence: 0, lat: 10, lng: 20 }],
      assignments: [day1Assignment],
      notes_items: [buildDayNote({ id: 30, day_id: 1, text: 'early start' })],
    } as unknown as DayRow;
    // Day 2 carries a wire-shaped assignment (place embedded, end_day boolean)
    // — the shape remoteEventHandler persists.
    const wireAssignment = {
      id: 11,
      day_id: 2,
      place_id: 6,
      order_index: 0,
      notes: 'wire',
      assignment_time: '10:00',
      assignment_end_time: null,
      end_day: true,
      accommodation_id: null,
      leg_transport_mode: 'walking',
      incoming_leg_transport_mode: null,
      // Stale embedded row — the junction (user 1) is the source of truth.
      participants: [{ user_id: 2, username: 'Ana', avatar: null }],
      created_at: '2025-01-02T00:00:00.000Z',
      place: {
        id: 6,
        name: 'Museum',
        description: null,
        lat: 1.5,
        lng: 2.5,
        address: null,
        category_id: null,
        price: null,
        currency: null,
        place_time: null,
        end_time: null,
        duration_minutes: 60,
        notes: null,
        image_url: null,
        transport_mode: null,
        google_place_id: null,
        google_ftid: null,
        osm_id: null,
        amap_poi_id: null,
        website: null,
        phone: null,
        stop_type: null,
        fill_percent: null,
        category: null,
        tags: [],
      },
    };
    const day2 = {
      ...buildDay({ id: 2, trip_id: 1, day_number: 2, date: '2025-06-02' }),
      vias: [],
      assignments: [wireAssignment],
      notes_items: [],
    } as unknown as DayRow;
    await db.days.bulkPut([day1, day2]);

    // Junction rows — assignmentParticipants embed onto the assignment, the
    // junction is authoritative over any stale copy on the day row.
    await db.assignmentParticipants.bulkPut([
      { id: 1, assignment_id: 10, user_id: 1 },
      { id: 2, assignment_id: 10, user_id: 2 },
      { id: 3, assignment_id: 11, user_id: 1 },
    ]);

    const placeRow = {
      ...buildPlace({ id: 5, trip_id: 1, category_id: 7 }),
      my_rating: 4,
      tags: [{ id: 9, name: 'Must-see', color: '#ff0000', user_id: 1 }],
    };
    await db.places.put(placeRow);
    await db.places.put(buildPlace({ id: 6, trip_id: 1, name: 'Museum' }));

    const reservationRow = {
      ...buildReservation({
        id: 20,
        trip_id: 1,
        day_id: 1,
        place_id: 5,
        url: 'https://booking.example/x',
      }),
      ingest_state: 'live',
      day_positions: { '1': 2 },
      day_plan_position: 1,
      endpoints: [
        {
          id: 1,
          reservation_id: 20,
          role: 'from' as const,
          sequence: 0,
          name: 'Frankfurt (FRA)',
          code: 'FRA',
          lat: 50.03,
          lng: 8.57,
          timezone: 'Europe/Berlin',
          local_time: '10:00',
          local_date: '2025-06-01',
        },
      ],
    };
    await db.reservations.put(reservationRow);
    await db.reservationTravelers.put({ id: 5, reservation_id: 20, user_id: 2 });

    const accommodationRow = {
      id: 8,
      trip_id: 1,
      place_id: 5,
      start_day_id: 1,
      end_day_id: 2,
      check_in: '15:00',
      check_in_end: null,
      check_out: '11:00',
      confirmation: 'ABC123',
      notes: null,
      created_at: '2025-01-01T00:00:00.000Z',
    };
    await db.accommodations.put(accommodationRow);

    const budgetRow = {
      ...buildBudgetItem({ id: 40, trip_id: 1, category: 'food' }),
      currency: 'EUR',
      exchange_rate: 1,
      persons: 2,
      reservation_id: 20,
      place_id: null,
      paid_by_user_id: 1,
      ticket_json: null,
      members: [
        { user_id: 1, paid: 1, amount: null, username: 'Me' },
        { user_id: 2, paid: 0, amount: 25, username: 'Ana' },
      ],
      payers: [{ user_id: 1, amount: 100 }],
      receipts: [
        {
          id: 3,
          filename: 'x.pdf',
          original_name: 'x.pdf',
          file_size: 123,
          mime_type: 'application/pdf',
          url: 'https://cdn.example/x.pdf',
        },
      ],
    };
    await db.budgetItems.put(budgetRow);

    const settlementRow = {
      id: 50,
      trip_id: 1,
      from_user_id: 2,
      to_user_id: 1,
      amount: 25,
      currency: 'EUR',
      exchange_rate: 1,
      settled_at: '2025-06-03',
      created_by_user_id: 1,
      created_at: '2025-01-03T00:00:00.000Z',
    };
    await db.budgetSettlements.put(settlementRow);

    const packingRow = {
      ...buildPackingItem({ id: 60, trip_id: 1 }),
      weight_grams: 500,
      bag_id: 70,
      quantity: 2,
      is_private: 0,
      owner_id: 1,
      recipients: [{ user_id: 2, username: 'Ana' }],
      contributors: [],
    };
    await db.packingItems.put(packingRow);

    const bagRow = {
      id: 70,
      trip_id: 1,
      name: 'Carry-on',
      color: '#00ffcc',
      weight_limit_grams: 7000,
      sort_order: 0,
      user_id: 2,
      created_at: '2025-01-01T00:00:00.000Z',
    };
    await db.packingBags.put(bagRow);
    await db.packingBagMembers.put({ bag_id: 70, user_id: 2 });

    const todoRow = buildTodoItem({ id: 80, trip_id: 1, assigned_user_id: 2 });
    await db.todoItems.put(todoRow);

    const categoryRow = buildCategory({ id: 7, name: 'Sights', user_id: null });
    await db.categories.put(categoryRow);

    const bundle = await decodeTrip(await encodeTrip(1));

    expect(bundle.v).toBe(1);
    expect(typeof bundle.exported_at).toBe('string');
    expect(bundle.trip).toEqual(await db.trips.get(1));
    expect(bundle.places).toEqual([placeRow, buildPlace({ id: 6, trip_id: 1, name: 'Museum' })]);
    expect(bundle.days).toEqual([
      {
        ...day1,
        assignments: [
          {
            ...day1Assignment,
            participants: [
              { user_id: 1, username: 'Me', avatar: null },
              { user_id: 2, username: 'Ana', avatar: null },
            ],
          },
        ],
      },
      {
        ...day2,
        assignments: [
          {
            ...wireAssignment,
            // The junction (user 1) replaced the stale embedded row (user 2).
            participants: [{ user_id: 1, username: 'Me', avatar: null }],
          },
        ],
      },
    ]);
    expect(bundle.reservations).toEqual([reservationRow]);
    expect(bundle.reservationTravelers).toEqual([{ id: 5, reservation_id: 20, user_id: 2 }]);
    expect(bundle.accommodations).toEqual([accommodationRow]);
    expect(bundle.budgetItems).toEqual([budgetRow]);
    expect(bundle.budgetSettlements).toEqual([settlementRow]);
    expect(bundle.packingItems).toEqual([packingRow]);
    expect(bundle.packingBags).toEqual([{ ...bagRow, members: [{ user_id: 2, username: 'Ana', avatar: null }] }]);
    expect(bundle.todoItems).toEqual([todoRow]);
    expect(bundle.categories).toEqual([categoryRow]);
    // The trip's roster: the member-linked users plus the owner (trip.user_id
    // is 1 — the self row is roster even without a tripMembers row).
    expect(bundle.users).toEqual([SELF, { id: 2, name: 'Ana', is_self: 0 }]);
  });

  it('SHARE-002 — strips server paths and data: URLs to null, keeps live links', async () => {
    await db.trips.put(buildTrip({ id: 1, cover_image: '/uploads/covers/x.png' }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1, image_url: '/uploads/img/y.jpg' }));
    await db.places.put(
      buildPlace({ id: 6, trip_id: 1, image_url: 'data:image/png;base64,AAAA', website: '/uploads/w' })
    );
    await db.places.put(
      buildPlace({ id: 7, trip_id: 1, image_url: 'https://cdn.example/ok.jpg', website: 'https://ok.example' })
    );
    await db.reservations.put({
      ...buildReservation({ id: 20, trip_id: 1, url: '/api/files/r.pdf' }),
      travelers: [{ user_id: 1, username: 'Me', avatar: null, avatar_url: 'data:image/png;base64,BB' }],
    });
    await db.reservations.put(buildReservation({ id: 21, trip_id: 1, url: 'https://booking.example/ok' }));
    await db.accommodations.put({
      id: 8,
      trip_id: 1,
      place_id: 5,
      start_day_id: 1,
      end_day_id: 2,
      place_image: '/uploads/stay.jpg',
    });
    await db.budgetItems.put({
      ...buildBudgetItem({ id: 40, trip_id: 1 }),
      members: [{ user_id: 1, paid: 1, amount: null, username: 'Me', avatar_url: '/uploads/me.png' }],
      receipts: [
        { id: 3, filename: 'x.pdf', original_name: 'x.pdf', url: '/uploads/r.pdf' },
        { id: 4, filename: 'y.png', original_name: 'y.png', url: 'data:image/png;base64,CC' },
      ],
    });
    await db.budgetSettlements.put({
      id: 50,
      trip_id: 1,
      from_user_id: 1,
      to_user_id: 1,
      amount: 5,
      from_avatar_url: '/api/avatars/1',
      to_avatar: '/uploads/t.png',
    } as BudgetSettlement);
    await db.days.put({
      ...buildDay({ id: 1, trip_id: 1, day_number: 1 }),
      vias: [],
      assignments: [
        {
          ...storedAssignment({ id: 10, day_id: 1, place_id: 5 }),
          place: { id: 5, name: 'P', image_url: '/uploads/p.png' },
        },
      ],
      notes_items: [],
    } as unknown as DayRow);

    const bundle = await buildBundle(1);

    expect(bundle.trip.cover_image).toBeNull();
    expect(bundle.places.map((p) => p.image_url)).toEqual([null, null, 'https://cdn.example/ok.jpg']);
    expect(bundle.places[1].website).toBeNull();
    expect(bundle.places[2].website).toBe('https://ok.example');
    expect(bundle.reservations[0].url).toBeNull();
    expect(bundle.reservations[0].travelers?.[0].avatar_url).toBeNull();
    expect(bundle.reservations[1].url).toBe('https://booking.example/ok');
    expect(bundle.accommodations[0].place_image).toBeNull();
    expect(bundle.budgetItems[0].members?.[0].avatar_url).toBeNull();
    expect(bundle.budgetItems[0].receipts?.map((r) => r.url)).toEqual([null, null]);
    expect(bundle.budgetSettlements[0].from_avatar_url).toBeNull();
    expect(bundle.budgetSettlements[0]).not.toHaveProperty('to_avatar_url');
    expect(bundle.days[0].assignments?.[0].place?.image_url).toBeNull();
  });

  it('SHARE-003 — rejects a bundle versioned newer than this build', async () => {
    const token = await craftToken({ v: 99, trip: { id: 1, title: 'x' }, days: [] });
    await expect(decodeTrip(token)).rejects.toThrow(/newer version of PanelMint/);
    expect(() => decodeFromFile(JSON.stringify({ v: 99 }))).toThrow(/newer version of PanelMint/);
  });

  it('SHARE-004 — tolerates unknown fields by stripping them', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }));

    const raw = JSON.parse(await encodeToFile(1)) as Record<string, unknown>;
    raw.future_top_level = { nested: true };
    (raw.trip as Record<string, unknown>).unknown_column = 'x';
    (raw.places as Record<string, unknown>[])[0].futuristic = [1, 2, 3];

    const bundle = decodeFromFile(JSON.stringify(raw));
    expect(bundle.trip.title).toBe((await db.trips.get(1))!.title);
    expect(bundle.trip).not.toHaveProperty('unknown_column');
    expect(bundle.places[0]).not.toHaveProperty('futuristic');
    expect(bundle).not.toHaveProperty('future_top_level');
    // …and collections the file omitted decode to empty arrays.
    expect(bundle.packingItems).toEqual([]);
  });

  it('SHARE-005 — a big trip encodes past SHARE_URL_MAX_CHARS and still decodes', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    for (let i = 0; i < 40; i++) {
      await db.places.put(
        buildPlace({ id: 100 + i, trip_id: 1, name: `Place ${i} ${randomText(30)}`, description: randomText(600) })
      );
    }

    const token = await encodeTrip(1);
    expect(token.length).toBeGreaterThan(SHARE_URL_MAX_CHARS);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const bundle = await decodeTrip(token);
    expect(bundle.places).toHaveLength(40);
  });

  it('SHARE-006 — the file transport is plain JSON and roundtrips the same bundle', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Summer' }));
    await db.places.put(buildPlace({ id: 5, trip_id: 1 }));

    const file = await encodeToFile(1);
    const raw = JSON.parse(file) as { v: number; trip: { title: string } };
    expect(raw.v).toBe(1);
    expect(raw.trip.title).toBe('Summer');

    const fromFile = decodeFromFile(file);
    const fromUrl = await decodeTrip(await encodeTrip(1));
    expect({ ...fromFile, exported_at: null }).toEqual({ ...fromUrl, exported_at: null });
  });

  it('SHARE-007 — malformed input rejects with a friendly error, never a crash', async () => {
    await expect(decodeTrip('!!!not base64!!!')).rejects.toThrow(/PanelMint trip/);
    // Valid base64url alphabet, not a deflate stream.
    await expect(decodeTrip('aGVsbG8td29ybGQ')).rejects.toThrow(/PanelMint trip/);
    // Inflates to JSON that isn't a bundle (no trip).
    await expect(decodeTrip(await craftToken({ hello: 'world' }))).rejects.toThrow(/PanelMint trip/);
    await expect(decodeTrip('')).rejects.toThrow(/PanelMint trip/);

    expect(() => decodeFromFile('{not json')).toThrow(/PanelMint trip export/);
    expect(() => decodeFromFile('{"v":1}')).toThrow(/PanelMint trip export/);
    expect(() => decodeFromFile('42')).toThrow(/PanelMint trip export/);
  });

  it('SHARE-008 — tables with no envelope slot are not exported', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    await seedMember(1, 'Me');
    await db.packingCategoryAssignees.put({ id: 1, trip_id: 1, category_name: 'Clothes', user_id: 1 });
    await db.todoCategoryAssignees.put({ id: 1, trip_id: 1, category_name: 'Prep', user_id: 1 });
    await db.budgetCategoryOrder.put({ id: 1, trip_id: 1, category: 'food', sort_order: 0 });
    await db.tags.put(buildTag({ id: 9 }));
    await db.settings.put({ key: 'language', value: 'vi' });

    const bundle = await buildBundle(1);
    expect(Object.keys(bundle).sort()).toEqual(
      [
        'v',
        'exported_at',
        'trip',
        'days',
        'places',
        'reservations',
        'reservationTravelers',
        'accommodations',
        'budgetItems',
        'budgetSettlements',
        'packingItems',
        'packingBags',
        'todoItems',
        'categories',
        'users',
      ].sort()
    );
    // The member-linked self row still lands in the roster.
    expect(bundle.users).toEqual([SELF]);
  });

  it('SHARE-009 — a missing or non-numeric trip id rejects like a 404', async () => {
    await expect(encodeTrip(999)).rejects.toThrow('Trip not found');
    await expect(encodeTrip('nope')).rejects.toThrow('Trip not found');
    await expect(encodeToFile(999)).rejects.toThrow('Trip not found');
  });

  it('SHARE-010 — junction edge cases: guest fallback and dangling bag member', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    await db.days.put({
      ...buildDay({ id: 1, trip_id: 1, day_number: 1 }),
      assignments: [storedAssignment({ id: 10, day_id: 1, place_id: 5 })],
      notes_items: [],
    } as unknown as DayRow);
    // Participant row pointing at a user that's gone — participantsOf's
    // 'Guest N' fallback.
    await db.assignmentParticipants.put({ id: 1, assignment_id: 10, user_id: 99 });
    await db.packingBags.put({
      id: 70,
      trip_id: 1,
      name: 'Bag',
      color: '#fff',
      sort_order: 0,
      user_id: null,
    });
    // A bag member whose user row is gone drops like the wire's INNER JOIN.
    await db.packingBagMembers.put({ bag_id: 70, user_id: 99 });

    const bundle = await buildBundle(1);
    expect(bundle.days[0].assignments?.[0].participants).toEqual([{ user_id: 99, username: 'Guest 99', avatar: null }]);
    expect(bundle.packingBags[0].members).toEqual([]);
    // The dangling user id is not in the roster either.
    expect(bundle.users.find((u) => u.id === 99)).toBeUndefined();
  });
});

/**
 * The export-all archive — Settings "Export all" writes one `.panelmint.json`
 * whose envelope is `{v, kind:'panelmint-archive', exported_at, trips}` with
 * each member exactly the bundle `encodeToFile` emits for one trip.
 */
describe('share archive codec', () => {
  it('SHARE-011 — encodeAllToFile packs every trip — archived included — into one archive', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Live trip' }));
    await db.trips.put(buildTrip({ id: 2, title: 'Archived trip', is_archived: 1 }));
    await db.places.put(buildPlace({ id: 5, trip_id: 2, name: 'Ruins' }));

    const json = await encodeAllToFile();
    const raw = JSON.parse(json) as { v: number; kind: string; exported_at: unknown; trips: unknown[] };
    expect(raw).toMatchObject({ v: 1, kind: 'panelmint-archive' });
    expect(typeof raw.exported_at).toBe('string');
    expect(raw.trips).toHaveLength(2);

    const bundles = decodeBundlesFromFile(json);
    expect(bundles.map((b) => b.trip.title)).toEqual(['Live trip', 'Archived trip']);
    // The archived member rides the backup and decodes through the same schema.
    expect(bundles[1].trip.is_archived).toBe(1);
    expect(bundles[1].places.map((p) => p.name)).toEqual(['Ruins']);
    // The member is exactly the bundle encodeToFile writes for the same trip.
    expect({ ...bundles[0], exported_at: null }).toEqual({
      ...decodeFromFile(await encodeToFile(1)),
      exported_at: null,
    });
  });

  it('SHARE-012 — decodeBundlesFromFile reads a single-trip file as a one-element list', async () => {
    await db.trips.put(buildTrip({ id: 1, title: 'Solo' }));
    const file = await encodeToFile(1);
    const bundles = decodeBundlesFromFile(file);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toEqual(decodeFromFile(file));
  });

  it('SHARE-013 — a newer format version is refused at both archive levels', async () => {
    await db.trips.put(buildTrip({ id: 1 }));
    const bundle = JSON.parse(await encodeToFile(1)) as Record<string, unknown>;
    // Newer archive envelope.
    expect(() =>
      decodeBundlesFromFile(JSON.stringify({ v: 99, kind: 'panelmint-archive', trips: [bundle] }))
    ).toThrow(/newer version of PanelMint/);
    // v1 envelope carrying a newer member.
    expect(() =>
      decodeBundlesFromFile(JSON.stringify({ v: 1, kind: 'panelmint-archive', trips: [{ ...bundle, v: 99 }] }))
    ).toThrow(/newer version of PanelMint/);
  });

  it('SHARE-014 — malformed archives and files answer the friendly error, empty archives decode', async () => {
    expect(() => decodeBundlesFromFile('{nope')).toThrow(/PanelMint trip export/);
    expect(() => decodeBundlesFromFile('{"v":1}')).toThrow(/PanelMint trip export/);
    expect(() => decodeBundlesFromFile('42')).toThrow(/PanelMint trip export/);
    // The archive marker demands the real envelope — no silent fall-through.
    expect(() =>
      decodeBundlesFromFile(JSON.stringify({ v: 1, kind: 'panelmint-archive', trips: 'yes' }))
    ).toThrow(/PanelMint trip export/);
    expect(() =>
      decodeBundlesFromFile(JSON.stringify({ v: 1, kind: 'panelmint-archive', trips: [{ nope: true }] }))
    ).toThrow(/PanelMint trip export/);
    expect(() =>
      decodeBundlesFromFile(JSON.stringify({ v: 1, kind: 'panelmint-archive' }))
    ).toThrow(/PanelMint trip export/);
    // A backup of nothing is still a valid archive.
    expect(decodeBundlesFromFile(JSON.stringify({ v: 1, kind: 'panelmint-archive', trips: [] }))).toEqual([]);
    // decodeFromFile stays single-bundle: an archive is not a bundle.
    await db.trips.put(buildTrip({ id: 1 }));
    const bundle = JSON.parse(await encodeToFile(1));
    expect(() =>
      decodeFromFile(JSON.stringify({ v: 1, kind: 'panelmint-archive', trips: [bundle] }))
    ).toThrow(/PanelMint trip export/);
  });
});
