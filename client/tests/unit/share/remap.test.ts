/**
 * Tests for `saveBundle` (src/share/remap.ts) — importing a decoded
 * ShareBundle into the real Dexie `panelmint` database (fake-indexeddb).
 * Covered: fresh-id allocation with no collisions against existing rows,
 * every foreign key remapped through the old→new maps, the roster's
 * self-fold / name-match / guest-create rules, dangling references dropping
 * to null or skipping the row, order densification, the embedded-junction
 * rebuilds, and the single-transaction rollback on failure.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DayRow, StoredAssignment } from '../../../src/api/local/dexieStore';
import { db, type LocalTripMember } from '../../../src/db/panelmintDb';
import { buildBundle, decodeFromFile, type ShareBundle } from '../../../src/share/codec';
import { saveBundle } from '../../../src/share/remap';
import type { LocalUser, Reservation } from '../../../src/types';
import {
  buildBudgetItem,
  buildCategory,
  buildDay,
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

/** The `api/local` write path's embedded assignment — bare server columns,
 *  `end_day` as SQLite 0/1, no `place`/`participants` joins. */
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

const memberRow = (tripId: number, userId: number, name: string): LocalTripMember => ({
  tripId,
  id: userId,
  username: name,
  role: 'member',
  added_at: '2025-01-01T00:00:00.000Z',
  invited_by_username: 'Me',
  is_guest: true,
});

/** Minimal valid bundle JSON for the hand-authored (foreign-device) cases —
 *  decodeFromFile normalizes it through shareBundleSchema, same as a real
 *  .panelmint.json a user picked up. */
function craftBundle(parts: Record<string, unknown>): ShareBundle {
  return decodeFromFile(
    JSON.stringify({
      v: 1,
      trip: { id: 900, user_id: 55, title: 'Shared trip', currency: 'EUR', is_archived: 0, reminder_days: 7 },
      ...parts,
    })
  );
}

/** Every id stored for `tripId` per table — the collision sweep compares the
 *  pre-import set against the post-import one. */
async function tripIds(tripId: number) {
  const grab = async <T extends { id: number }>(rows: Promise<T[]>) => (await rows).map((r) => r.id);
  return {
    days: await grab(db.days.where('trip_id').equals(tripId).toArray()),
    places: await grab(db.places.where('trip_id').equals(tripId).toArray()),
    reservations: await grab(db.reservations.where('trip_id').equals(tripId).toArray()),
    accommodations: await grab(db.accommodations.where('trip_id').equals(tripId).toArray()),
    budgetItems: await grab(db.budgetItems.where('trip_id').equals(tripId).toArray()),
    budgetSettlements: await grab(db.budgetSettlements.where('trip_id').equals(tripId).toArray()),
    packingItems: await grab(db.packingItems.where('trip_id').equals(tripId).toArray()),
    packingBags: await grab(db.packingBags.where('trip_id').equals(tripId).toArray()),
    todoItems: await grab(db.todoItems.where('trip_id').equals(tripId).toArray()),
  };
}

/**
 * The rich source trip — one of everything, in both assignment storage shapes,
 * with junction rows and references crisscrossing the collections. Exported
 * through the real codec so saveBundle consumes exactly what a share produces.
 */
async function seedSourceTrip() {
  await db.trips.put(buildTrip({ id: 1, title: 'Original', cover_image: 'gradient:emerald' }));
  await db.localUsers.put({ id: 2, name: 'Ana', is_self: 0 });
  await db.tripMembers.put(memberRow(1, 2, 'Ana'));

  const day1Assignment = storedAssignment({ id: 10, day_id: 1, place_id: 5, order_index: 0 });
  const wireAssignment = {
    ...storedAssignment({ id: 11, day_id: 2, place_id: 6, order_index: 4 }),
    end_day: true,
    accommodation_id: 8,
    place: { id: 6, name: 'Museum', fill_percent: null },
    participants: [{ user_id: 9, username: 'stale', avatar: null }],
  };
  await db.days.bulkPut([
    {
      ...buildDay({ id: 1, trip_id: 1, day_number: 1, date: '2025-06-01' }),
      vias: [{ id: 3, day_id: 1, after_order_index: 0, sequence: 0, lat: 10, lng: 20 }],
      assignments: [day1Assignment],
      notes_items: [],
    },
    {
      ...buildDay({ id: 2, trip_id: 1, day_number: 2, date: '2025-06-02' }),
      vias: [],
      assignments: [wireAssignment],
      notes_items: [],
    },
  ] as unknown as DayRow[]);

  await db.assignmentParticipants.bulkPut([
    { id: 1, assignment_id: 10, user_id: 1 },
    { id: 2, assignment_id: 10, user_id: 2 },
    { id: 3, assignment_id: 11, user_id: 2 },
  ]);

  await db.places.bulkPut([
    {
      ...buildPlace({ id: 5, trip_id: 1, name: 'Beach', category_id: 7 }),
      tags: [{ id: 9, name: 'Must-see', color: '#f00', user_id: 1 }],
    },
    buildPlace({ id: 6, trip_id: 1, name: 'Museum' }),
  ]);

  await db.accommodations.put({
    id: 8,
    trip_id: 1,
    place_id: 5,
    start_day_id: 1,
    end_day_id: 2,
    check_in: '15:00',
    check_out: '11:00',
    confirmation: 'ABC',
    created_at: '2025-01-01T00:00:00.000Z',
  });

  await db.reservations.put({
    ...buildReservation({ id: 20, trip_id: 1, title: 'Train' }),
    day_id: 1,
    place_id: 5,
    assignment_id: 10,
    accommodation_id: 8,
    day_plan_position: 1,
    day_positions: { '1': 2 },
    endpoints: [
      {
        id: 1,
        reservation_id: 20,
        role: 'from',
        sequence: 0,
        name: 'FRA',
        code: 'FRA',
        lat: 50,
        lng: 8,
        timezone: 'Europe/Berlin',
        local_time: '10:00',
        local_date: '2025-06-01',
      },
      {
        id: 2,
        reservation_id: 20,
        role: 'to',
        sequence: 1,
        name: 'CDG',
        code: 'CDG',
        lat: 49,
        lng: 2,
        timezone: 'Europe/Paris',
        local_time: '12:30',
        local_date: '2025-06-01',
      },
    ],
    travelers: [{ user_id: 2, username: 'Ana', avatar: null, avatar_url: null }],
  } as unknown as Reservation);
  await db.reservationTravelers.put({ id: 5, reservation_id: 20, user_id: 1 });

  await db.budgetItems.put({
    ...buildBudgetItem({ id: 40, trip_id: 1, category: 'food', name: 'Dinner', total_price: 60, sort_order: 0 }),
    reservation_id: 20,
    place_id: null,
    paid_by_user_id: 1,
    members: [
      { user_id: 1, paid: 1, amount: null, username: 'Me' },
      { user_id: 2, paid: 0, amount: 30, username: 'Ana' },
    ],
    payers: [{ user_id: 1, amount: 60 }],
  });
  await db.budgetItems.put(
    buildBudgetItem({ id: 41, trip_id: 1, category: 'transport', name: 'Tickets', total_price: 20, sort_order: 0 })
  );
  await db.budgetSettlements.put({
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
  });

  await db.packingBags.put({ id: 70, trip_id: 1, name: 'Carry-on', color: '#00ffcc', sort_order: 0, user_id: 2 });
  await db.packingBagMembers.put({ bag_id: 70, user_id: 1 });
  await db.packingItems.put({
    ...buildPackingItem({ id: 60, trip_id: 1, name: 'Charger', sort_order: 0 }),
    bag_id: 70,
    owner_id: 2,
    recipients: [{ user_id: 1, username: 'Me' }],
    contributors: [],
  });
  await db.todoItems.put(buildTodoItem({ id: 80, trip_id: 1, name: 'Book museum', assigned_user_id: 2 }));
  await db.categories.put(buildCategory({ id: 7, name: 'Sights', user_id: null }));
  await db.tags.put(buildTag({ id: 9, name: 'Must-see', user_id: 1 }));
}

describe('saveBundle', () => {
  it('IMPORT-001 — re-lands the trip under fresh ids with every FK remapped and no collisions', async () => {
    await seedSourceTrip();
    const before = await tripIds(1);

    const newId = await saveBundle(await buildBundle(1));
    expect(newId).not.toBe(1);

    const trip = await db.trips.get(newId);
    expect(trip?.title).toBe('Original');
    expect(trip?.user_id).toBe(1);
    expect(trip).not.toHaveProperty('day_count');
    expect(trip).not.toHaveProperty('is_owner');

    // No id collides with a source row — every table's new set is disjoint.
    const after = await tripIds(newId);
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      expect(after[key].length).toBe(before[key].length);
      for (const id of after[key]) expect(before[key]).not.toContain(id);
    }

    // Days: renumbered dense, embeds carried fresh ids.
    const days = await db.days.where('trip_id').equals(newId).sortBy('day_number');
    expect(days.map((d) => d.day_number)).toEqual([1, 2]);
    const [nd1, nd2] = days as [DayRow, DayRow];
    expect(nd1.vias?.[0]?.day_id).toBe(nd1.id);
    expect(nd1.vias?.[0]?.id).not.toBe(3);

    const importedPlaces = await db.places.where('trip_id').equals(newId).toArray();
    const newBeach = importedPlaces.find((p) => p.name === 'Beach')!;
    const newMuseum = importedPlaces.find((p) => p.name === 'Museum')!;

    const nda1 = nd1.assignments?.[0] as unknown as StoredAssignment;
    const nda2 = nd2.assignments?.[0] as unknown as StoredAssignment;
    expect(nda1.day_id).toBe(nd1.id);
    expect(nda1.place_id).toBe(newBeach.id);
    expect(nda2.place_id).toBe(newMuseum.id);
    expect([10, 11]).not.toContain(nda1.id);
    // The wire shape folds to the stored one: end_day back to SQLite 0/1 and
    // the joins stay off the stored row (assignmentWire rebuilds them).
    expect(nda2.end_day).toBe(1);
    expect(nda2).not.toHaveProperty('place');
    expect(nda2).not.toHaveProperty('participants');
    // accommodation_id 8 → the new accommodation row, allocated before the
    // days were written so the link resolves.
    const newAcc = await db.accommodations.where('trip_id').equals(newId).first();
    expect(newAcc).toBeTruthy();
    expect(nda2.accommodation_id).toBe(newAcc!.id);

    // Junction rows rebuilt against the new assignment ids — Ana stayed user 2
    // (name-matched), self stayed 1.
    const parts = await db.assignmentParticipants.where('assignment_id').anyOf([nda1.id, nda2.id]).toArray();
    expect(parts.map((p) => [p.assignment_id, p.user_id].join(':')).sort()).toEqual([
      `${nda1.id}:1`,
      `${nda1.id}:2`,
      `${nda2.id}:2`,
    ]);
    for (const p of parts) expect([1, 2, 3]).not.toContain(p.id);

    // Accommodation: the day span points at the new days.
    expect(newAcc!.start_day_id).toBe(nd1.id);
    expect(newAcc!.end_day_id).toBe(nd2.id);
    expect(newAcc!.place_id).toBe(newBeach.id);

    // Reservation: every reference column + the embedded day_positions keys and
    // endpoint ids remapped. The junction is authoritative — reservation 20's
    // junction row says user 1, so the stale embedded user-2 echo is dropped
    // and the read-time `travelers` join is not persisted on the stored row.
    const res = (await db.reservations.where('trip_id').equals(newId).first()) as Reservation & {
      day_positions?: Record<string, number> | null;
    };
    expect(res.day_id).toBe(nd1.id);
    expect(res.place_id).toBe(newBeach.id);
    expect(res.assignment_id).toBe(nda1.id);
    expect(Number(res.accommodation_id)).toBe(newAcc!.id);
    expect(res.endpoints?.map((e) => e.reservation_id)).toEqual([res.id, res.id]);
    for (const e of res.endpoints ?? []) expect([1, 2]).not.toContain(e.id);
    expect(Object.keys(res.day_positions ?? {})).toEqual([String(nd1.id)]);
    const travelers = await db.reservationTravelers.where('reservation_id').equals(res.id).toArray();
    expect(travelers.map((t) => t.user_id)).toEqual([1]);
    expect(res).not.toHaveProperty('travelers');

    // Budget: per-category dense sort_order, refs remapped, usernames refreshed.
    const items = await db.budgetItems.where('trip_id').equals(newId).toArray();
    const dinner = items.find((b) => b.name === 'Dinner')!;
    expect(dinner.reservation_id).toBe(res.id);
    expect(dinner.paid_by_user_id).toBe(1);
    expect(dinner.members?.map((m) => m.user_id)).toEqual([1, 2]);
    expect(dinner.payers?.map((p) => p.user_id)).toEqual([1]);
    expect(dinner.sort_order).toBe(0);
    expect(items.find((b) => b.name === 'Tickets')!.sort_order).toBe(0);
    const catOrder = await db.budgetCategoryOrder.where('trip_id').equals(newId).toArray();
    expect(catOrder.map((c) => c.category).sort()).toEqual(['food', 'transport']);

    // Settlement: both ends remapped through the roster.
    const settlement = await db.budgetSettlements.where('trip_id').equals(newId).first();
    expect(settlement).toMatchObject({ from_user_id: 2, to_user_id: 1, amount: 25 });

    // Packing: bag owner + members junction remapped to the new bag id.
    const bag = await db.packingBags.where('trip_id').equals(newId).first();
    expect(bag!.user_id).toBe(2);
    const bagMembers = await db.packingBagMembers.where('bag_id').equals(bag!.id).toArray();
    expect(bagMembers.map((m) => m.user_id)).toEqual([1]);
    const item = await db.packingItems.where('trip_id').equals(newId).first();
    expect(item!.bag_id).toBe(bag!.id);
    expect(item!.owner_id).toBe(2);
    expect(item!.recipients).toEqual([{ user_id: 1, username: 'Me' }]);

    // Todo + roster + category match (the seeded 'Sights' row is reused, not cloned).
    const todo = await db.todoItems.where('trip_id').equals(newId).first();
    expect(todo!.assigned_user_id).toBe(2);
    expect((await db.categories.toArray()).filter((c) => c.name === 'Sights')).toHaveLength(1);
    expect(newBeach.category_id).toBe(7);
    // The tag embed rematched the self user's 'Must-see' tag row.
    expect(newBeach.tags).toEqual([{ id: 9, user_id: 1, name: 'Must-see', color: '#ff0000' }]);

    // Roster: Ana is a member of the new trip; self is owner via user_id.
    const members = await db.tripMembers.where('tripId').equals(newId).toArray();
    expect(members.map((m) => m.id)).toEqual([2]);

    // The source trip is untouched.
    expect((await db.days.where('trip_id').equals(1).toArray()).length).toBe(2);
    expect((await db.assignmentParticipants.toArray()).filter((p) => p.assignment_id === 10)).toHaveLength(2);
  });

  it('IMPORT-002 — self folds to SELF_ID, names match case-insensitively, strangers become guests', async () => {
    await db.localUsers.put({ id: 4, name: 'ANNA', is_self: 0 });

    const bundle = craftBundle({
      users: [
        { id: 55, name: 'Owner', is_self: 1 },
        { id: 56, name: ' anna ', is_self: 0 }, // trims + folds onto 'ANNA'
        { id: 57, name: 'Bob', is_self: 0 },
      ],
      budgetItems: [
        {
          id: 40,
          trip_id: 900,
          category: 'food',
          name: 'Dinner',
          total_price: 10,
          paid_by_user_id: 55,
          members: [{ user_id: 56, paid: 1, username: 'anna' }],
          payers: [{ user_id: 55, amount: 10 }],
        },
      ],
      todoItems: [{ id: 80, trip_id: 900, name: 't', assigned_user_id: 57 }],
    });

    const newId = await saveBundle(bundle);

    // 'anna' matched the existing user 4 (trimmed, case-insensitive); Bob is a
    // brand-new guest row — exactly one new localUsers row landed.
    const users = await db.localUsers.toArray();
    expect(users).toHaveLength(3);
    const bob = users.find((u) => u.name === 'Bob')!;
    expect(bob.id).not.toBe(57);
    expect(bob.is_self).toBe(0);
    expect(bob.email).toMatch(/^guest-.*@guests\.invalid$/);

    const item = await db.budgetItems.where('trip_id').equals(newId).first();
    expect(item!.paid_by_user_id).toBe(1); // foreign self → SELF_ID
    expect(item!.members!.map((m) => m.user_id)).toEqual([4]);
    expect(item!.members![0].username).toBe('ANNA'); // refreshed off the local row
    expect(item!.payers!.map((p) => p.user_id)).toEqual([1]);

    const todo = await db.todoItems.where('trip_id').equals(newId).first();
    expect(todo!.assigned_user_id).toBe(bob.id);

    // The non-self roster became trip members: Anna-by-match and Bob-the-guest.
    const members = await db.tripMembers.where('tripId').equals(newId).toArray();
    expect(members.map((m) => m.id).sort()).toEqual([4, bob.id].sort());
  });

  it('IMPORT-003 — two bundle users folding onto one local user dedupe their junction rows', async () => {
    await db.places.put(buildPlace({ id: 5, trip_id: 999 })); // decoy, different trip — never matched
    const bundle = craftBundle({
      users: [
        { id: 55, name: 'Owner', is_self: 1 },
        { id: 56, name: 'Sam', is_self: 0 },
        { id: 57, name: ' sam ', is_self: 0 }, // folds onto the same guest
      ],
      places: [{ id: 5, trip_id: 900, name: 'Beach' }],
      days: [
        {
          id: 1,
          trip_id: 900,
          day_number: 1,
          assignments: [
            {
              id: 10,
              day_id: 1,
              place_id: 5,
              order_index: 0,
              participants: [
                { user_id: 55, username: 'Owner', avatar: null },
                { user_id: 56, username: 'Sam', avatar: null },
                { user_id: 57, username: 'sam', avatar: null },
              ],
            },
          ],
        },
      ],
    });

    const newId = await saveBundle(bundle);
    const day = (await db.days.where('trip_id').equals(newId).first()) as DayRow;
    const assignment = day.assignments![0] as unknown as StoredAssignment;
    const parts = await db.assignmentParticipants.where('assignment_id').equals(assignment.id).toArray();
    // 55→1 (self); 56 and 57 collapsed onto a single 'Sam' guest row.
    const users = await db.localUsers.toArray();
    const sams = users.filter((u) => u.name.trim().toLowerCase() === 'sam');
    expect(sams).toHaveLength(1);
    expect(parts.map((p) => p.user_id).sort()).toEqual([1, sams[0].id].sort());
    expect(parts).toHaveLength(2);
  });

  it('IMPORT-004 — dangling references null out or drop instead of aborting the import', async () => {
    const bundle = craftBundle({
      users: [{ id: 55, name: 'Owner', is_self: 1 }],
      places: [{ id: 5, trip_id: 900, name: 'Beach', category_id: 4242 }],
      days: [
        {
          id: 1,
          trip_id: 900,
          day_number: 1,
          assignments: [
            { id: 10, day_id: 1, place_id: 5, order_index: 0 }, // resolves
            { id: 11, day_id: 1, place_id: 999, order_index: 1 }, // place missing → drop
          ],
        },
      ],
      accommodations: [
        { id: 8, trip_id: 900, place_id: 5, start_day_id: 1, end_day_id: 999 }, // dangling end → skip
      ],
      reservations: [
        {
          id: 20,
          trip_id: 900,
          title: 'Loose ends',
          status: 'confirmed',
          type: 'flight',
          day_id: 999,
          end_day_id: 999,
          place_id: 999,
          assignment_id: 999,
          accommodation_id: '999',
          day_positions: { '999': 0, [String(1)]: 3 },
          travelers: [
            { user_id: 55, username: 'Owner' },
            { user_id: 999, username: 'Ghost' },
          ],
        },
      ],
      reservationTravelers: [
        { reservation_id: 20, user_id: 999 }, // dangling user → dropped
        { reservation_id: 20, user_id: 55 },
        { reservation_id: 777, user_id: 55 }, // reservation not in bundle → ignored
      ],
      budgetItems: [
        {
          id: 40,
          trip_id: 900,
          category: 'food',
          name: 'Dinner',
          total_price: 10,
          paid_by_user_id: 999,
          reservation_id: 999,
          place_id: 999,
          members: [{ user_id: 999, paid: 1, username: 'Ghost' }],
          payers: [{ user_id: 999, amount: 10 }],
        },
      ],
      budgetSettlements: [
        { id: 50, trip_id: 900, from_user_id: 55, to_user_id: 999, amount: 5 }, // dangling → skip
        { id: 51, trip_id: 900, from_user_id: 55, to_user_id: 55, amount: 7 },
      ],
      packingItems: [
        {
          id: 60,
          trip_id: 900,
          name: 'Private thing',
          checked: 0,
          sort_order: 0,
          is_private: 1,
          owner_id: 999,
          bag_id: 999,
        },
      ],
      todoItems: [{ id: 80, trip_id: 900, name: 't', assigned_user_id: 999 }],
      categories: [{ id: 4242, name: 'Vanished', color: '#123456', icon: 'x' }],
    });

    const newId = await saveBundle(bundle);
    expect(await db.trips.get(newId)).toBeTruthy();

    const day = (await db.days.where('trip_id').equals(newId).first()) as DayRow;
    expect(day.assignments).toHaveLength(1); // the placeless stop dropped like the JOIN
    const place = await db.places.where('trip_id').equals(newId).first();
    expect(place!.category_id).not.toBeNull(); // 'Vanished' was created self-owned
    const cat = await db.categories.get(place!.category_id!);
    expect(cat).toMatchObject({ name: 'Vanished', user_id: 1 });

    expect(await db.accommodations.where('trip_id').equals(newId).toArray()).toHaveLength(0);

    const res = (await db.reservations.where('trip_id').equals(newId).first()) as Reservation & {
      day_positions?: Record<string, number> | null;
    };
    expect(res.day_id).toBeNull();
    expect(res.end_day_id).toBeNull();
    expect(res.place_id).toBeNull();
    expect(res.assignment_id).toBeNull();
    expect(res.accommodation_id).toBeNull();
    expect(res.day_positions).toEqual({ [String(day.id)]: 3 });
    // The junction is authoritative here too: user 999 drops, 55 folds to
    // self; the embed (55 + 999) is never consulted and is not persisted.
    const junction = await db.reservationTravelers.where('reservation_id').equals(res.id).toArray();
    expect(junction.map((t) => t.user_id)).toEqual([1]);
    expect(res).not.toHaveProperty('travelers');

    const item = await db.budgetItems.where('trip_id').equals(newId).first();
    expect(item!.paid_by_user_id).toBeNull();
    expect(item!.reservation_id).toBeNull();
    expect(item!.place_id).toBeNull();
    expect(item!.members).toEqual([]);
    expect(item!.payers).toEqual([]);

    const settlements = await db.budgetSettlements.where('trip_id').equals(newId).toArray();
    expect(settlements).toHaveLength(1);
    expect(settlements[0].amount).toBe(7);
    expect(settlements[0].from_username).toBe('Me');

    // The ownerless *private* item folds onto the importer so it stays reachable.
    const packing = await db.packingItems.where('trip_id').equals(newId).first();
    expect(packing!.owner_id).toBe(1);
    expect(packing!.owner_username).toBe('Me');
    expect(packing!.bag_id).toBeNull();

    expect((await db.todoItems.where('trip_id').equals(newId).first())!.assigned_user_id).toBeNull();
  });

  it('IMPORT-004b — a bundle with no junction array at all falls back to the travelers embed', async () => {
    const bundle = craftBundle({
      users: [
        { id: 55, name: 'Owner', is_self: 1 },
        { id: 56, name: 'Ana', is_self: 0 },
      ],
      reservations: [
        {
          id: 20,
          trip_id: 900,
          title: 'Foreign row',
          status: 'confirmed',
          type: 'flight',
          travelers: [
            { user_id: 55, username: 'Owner' },
            { user_id: 56, username: 'Ana' },
            { user_id: 999, username: 'Ghost' }, // dangling → dropped
          ],
        },
      ],
      // reservationTravelers deliberately absent — a producer that never
      // knew the table.
    });

    const newId = await saveBundle(bundle);
    const res = await db.reservations.where('trip_id').equals(newId).first();
    const ana = (await db.localUsers.toArray()).find((u) => u.name === 'Ana')!;
    const junction = await db.reservationTravelers.where('reservation_id').equals(res!.id).toArray();
    expect(junction.map((t) => t.user_id).sort()).toEqual([1, ana.id].sort());
    expect(res).not.toHaveProperty('travelers');
  });

  it('IMPORT-005 — order columns densify; a second import of the same bundle never collides', async () => {
    const bundle = craftBundle({
      users: [{ id: 55, name: 'Owner', is_self: 1 }],
      days: [
        { id: 9, trip_id: 900, day_number: 7, date: '2025-06-02' },
        { id: 8, trip_id: 900, day_number: 3, date: '2025-06-01' },
      ],
      packingItems: [
        { id: 60, trip_id: 900, name: 'a', checked: 0, sort_order: 9 },
        { id: 61, trip_id: 900, name: 'b', checked: 0, sort_order: 2 },
      ],
      todoItems: [
        { id: 80, trip_id: 900, name: 'x', sort_order: 8 },
        { id: 81, trip_id: 900, name: 'y', sort_order: 1 },
      ],
      budgetItems: [
        { id: 41, trip_id: 900, category: 'food', name: 'later', total_price: 1, sort_order: 7 },
        { id: 40, trip_id: 900, category: 'food', name: 'first', total_price: 1, sort_order: 3 },
      ],
    });

    const firstId = await saveBundle(bundle);
    const secondId = await saveBundle(bundle);
    expect(secondId).not.toBe(firstId);

    for (const tripId of [firstId, secondId]) {
      const days = await db.days.where('trip_id').equals(tripId).sortBy('day_number');
      expect(days.map((d) => d.day_number)).toEqual([1, 2]);
      // The (day_number, id) sort renumbers dense: old day 3 → 1, day 7 → 2.
      expect(days.map((d) => d.date)).toEqual(['2025-06-01', '2025-06-02']);
      const items = await db.packingItems.where('trip_id').equals(tripId).toArray();
      expect(items.sort((a, b) => a.sort_order - b.sort_order).map((p) => p.name)).toEqual(['b', 'a']);
      const todos = await db.todoItems.where('trip_id').equals(tripId).toArray();
      expect(todos.sort((a, b) => a.sort_order - b.sort_order).map((t) => t.name)).toEqual(['y', 'x']);
      const budget = await db.budgetItems.where('trip_id').equals(tripId).toArray();
      expect(budget.sort((a, b) => a.sort_order - b.sort_order).map((b) => b.name)).toEqual(['first', 'later']);
    }

    // Disjoint ids across the two imports, on every table.
    const idsFirst = await tripIds(firstId);
    const idsSecond = await tripIds(secondId);
    for (const key of Object.keys(idsFirst) as (keyof typeof idsFirst)[]) {
      for (const id of idsSecond[key]) expect(idsFirst[key]).not.toContain(id);
    }
    // And the trip-level junction rows are scoped to their own trip.
    const members = await db.tripMembers.where('tripId').equals(secondId).toArray();
    expect(members.every((m) => m.tripId === secondId)).toBe(true);
  });

  it('IMPORT-006 — a mid-write failure rolls the whole trip back', async () => {
    const bundle = craftBundle({
      users: [
        { id: 55, name: 'Owner', is_self: 1 },
        { id: 56, name: 'Guest', is_self: 0 },
      ],
      categories: [{ id: 7, name: 'NewCat', color: '#fff', icon: 'x' }],
    });
    // A poisoned collection getter — the throw lands after the trip, roster
    // and category writes have run, inside the same Dexie transaction.
    const poisoned = Object.create(Object.getPrototypeOf(bundle), {
      ...Object.getOwnPropertyDescriptors(bundle),
      days: {
        get() {
          throw new Error('boom');
        },
      },
    }) as ShareBundle;

    await expect(saveBundle(poisoned)).rejects.toThrow('boom');
    expect(await db.trips.count()).toBe(0);
    expect(await db.tripMembers.count()).toBe(0);
    expect((await db.localUsers.toArray()).map((u) => u.id)).toEqual([1]);
    expect(await db.categories.count()).toBe(0);
  });
});
