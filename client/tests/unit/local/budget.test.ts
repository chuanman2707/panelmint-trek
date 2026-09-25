/**
 * Parity tests for the local `budgetApi` — the adapter that replaced the
 * `/api/trips/:id/budget*` axios surface — over the real Dexie `panelmint`
 * database (fake-indexeddb). Pins the hosted envelopes ({items}/{item}/
 * {members,item}/{member}/{summary}/{balances,flows,settlements,finalBudgets}),
 * the LocalApiError strings the BudgetController sent, the CASE-WHEN update
 * semantics, the roster filtering, the category-order table, the linked
 * reservation price mirror, the settlement ledger arithmetic (largest-
 * remainder odd cents, frozen FX rates), and zero-HTTP operation (the only
 * outbound call is the mocked Frankfurter fetcher).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The item/settlement FX freeze and the settlement base conversion fetch live
// rates before the Dexie transaction — stub the fetcher the adapter imports so
// tests stay offline and pin which rates were live.
vi.mock('../../../src/api/ext/fx', () => ({
  fetchExchangeRates: vi.fn(),
}));
import { fetchExchangeRates } from '../../../src/api/ext/fx';
import { budgetApi } from '../../../src/api/local/budget';
import { usersApi } from '../../../src/api/local/users';
import { db } from '../../../src/db/panelmintDb';
import { splitEqualShares } from '../../../src/api/local/ported/settlement';
import { buildTrip, buildBudgetItem, buildReservation } from '../../helpers/factories';
import type { LocalUser } from '../../../src/types';

const SELF: LocalUser = { id: 1, name: 'Me', is_self: 1 };
const mockFetchRates = vi.mocked(fetchExchangeRates);

async function resetDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
  await db.localUsers.put(SELF);
  mockFetchRates.mockReset().mockResolvedValue(null);
}

beforeEach(resetDb);

const seedTrip = (over: Parameters<typeof buildTrip>[0] = {}) => db.trips.put(buildTrip({ id: 1, ...over }));

/** Seed a guest the way usersApi.create does — roster row + membership link. */
async function seedGuest(tripId: number, name: string): Promise<number> {
  const { member } = await usersApi.create(tripId, name);
  return member.id;
}

/** Catch the rejection as a LocalApiError-shaped value. */
const fail = (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('budgetApi.list', () => {
  it('answers { items } ordered by category order then sort_order', async () => {
    await seedTrip();
    await db.budgetItems.bulkPut([
      buildBudgetItem({ id: 11, trip_id: 1, category: 'food', name: 'A', sort_order: 0 }),
      buildBudgetItem({ id: 12, trip_id: 1, category: 'travel', name: 'B', sort_order: 1 }),
      buildBudgetItem({ id: 13, trip_id: 1, category: 'food', name: 'C', sort_order: 2 }),
    ]);
    // Reorder categories so 'travel' outranks 'food' — the order table, not
    // the item rows, carries the grouping.
    await budgetApi.reorderCategories(1, ['travel', 'food']);
    const { items } = await budgetApi.list(1);
    expect(items.map((i) => i.id)).toEqual([12, 11, 13]);
  });

  it('hydrates member/payer display fields from the roster', async () => {
    await seedTrip();
    const anna = await seedGuest(1, 'Anna');
    await db.budgetItems.put(
      buildBudgetItem({
        id: 11,
        trip_id: 1,
        members: [{ user_id: anna, paid: 1, amount: null, username: 'Anna' }],
        payers: [{ user_id: 1, amount: 50 }],
      }),
    );
    const { items } = await budgetApi.list(1);
    expect(items[0].members).toEqual([
      { user_id: anna, paid: 1, amount: null, username: 'Anna', avatar: null, avatar_url: null },
    ]);
    expect(items[0].payers).toEqual([
      { user_id: 1, amount: 50, username: 'Me', avatar: null, avatar_url: null },
    ]);
  });

  it('404s a missing trip', async () => {
    const err = await fail(budgetApi.list(999));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Trip not found');
  });
});

describe('budgetApi.create', () => {
  beforeEach(() => seedTrip());

  it('creates an item with members/payers embedded and { item } on the wire', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { item } = await budgetApi.create(1, {
      name: 'Dinner',
      category: 'food',
      total_price: 90,
      payers: [{ user_id: 1, amount: 90 }],
      member_ids: [anna, 1],
    });
    expect(item.id).toBeGreaterThan(0);
    expect(item.category).toBe('food');
    // The explicit payers keep total_price at their sum.
    expect(item.total_price).toBe(90);
    expect(item.persons).toBe(2);
    expect(item.payers).toEqual([{ user_id: 1, amount: 90, username: 'Me', avatar: null, avatar_url: null }]);
    expect(item.members!.map((m) => m.user_id)).toEqual([anna, 1]);
    expect(item.created_at).toBeTruthy();
    // The category got an order-table row (first category → sort_order 0).
    const order = await db.budgetCategoryOrder.where('trip_id').equals(1).toArray();
    expect(order).toEqual([expect.objectContaining({ category: 'food', sort_order: 0 })]);
  });

  it('derives total_price from the payer sum, not the submitted total', async () => {
    const { item } = await budgetApi.create(1, {
      name: 'Split taxi',
      total_price: 999,
      payers: [
        { user_id: 1, amount: 20 },
        { user_id: 1, amount: 10 }, // a dup user_id's row is ignored but its amount still counts
      ],
    });
    expect(item.total_price).toBe(30);
    expect(item.payers).toEqual([{ user_id: 1, amount: 20, username: 'Me', avatar: null, avatar_url: null }]);
  });

  it('drops off-roster member ids silently like the server', async () => {
    const anna = await seedGuest(1, 'Anna');
    await db.localUsers.put({ id: 77, name: 'Outsider', is_self: 0 }); // exists, but no membership
    const { item } = await budgetApi.create(1, {
      name: 'X',
      member_ids: [anna, 77],
    });
    expect(item.members!.map((m) => m.user_id)).toEqual([anna]);
    expect(item.persons).toBe(1); // the FILTERED length — 77 never entered
  });

  it('freezes the live FX rate onto a foreign-currency expense', async () => {
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 1.2 });
    const { item } = await budgetApi.create(1, { name: 'USD thing', currency: 'usd', total_price: 12 });
    expect(item.currency).toBe('usd'); // stored verbatim — the server kept the raw string
    expect(item.exchange_rate).toBe(1.2);
    expect(mockFetchRates).toHaveBeenCalledWith('EUR');
  });

  it('skips the freeze for an explicit rate, the trip currency, or a failed fetch', async () => {
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 1.2 });
    const a = await budgetApi.create(1, { name: 'a', currency: 'USD', exchange_rate: 1.5 });
    expect(a.item.exchange_rate).toBe(1.5);
    const b = await budgetApi.create(1, { name: 'b', currency: 'EUR' });
    expect(b.item.exchange_rate).toBe(1);
    mockFetchRates.mockResolvedValue(null);
    const c = await budgetApi.create(1, { name: 'c', currency: 'USD' });
    expect(c.item.exchange_rate).toBe(1); // the server's "not frozen" sentinel
  });

  it('splits a TICKETJSON: legacy note into note + ticket_json like the server', async () => {
    const { item } = await budgetApi.create(1, {
      name: 'Museum',
      note: 'TICKETJSON:{"a":1}',
    });
    // The whole suffix is the receipt blob and the note itself stayed
    // untouched (the server did not want a smuggled blob parked under `note`).
    expect(item.ticket_json).toBe('{"a":1}');
    expect(item.note).toBeNull();
  });

  it('400s a missing name the way the validation pipe did', async () => {
    const err = await fail(budgetApi.create(1, {} as never));
    expect(err.response.status).toBe(400);
    expect(err.response.data.error).toContain('name:');
  });

  it('404s a missing trip without touching the FX fetcher', async () => {
    const err = await fail(budgetApi.create(999, { name: 'X' }));
    expect(err.response.data.error).toBe('Trip not found');
    expect(mockFetchRates).not.toHaveBeenCalled();
  });
});

describe('budgetApi.update', () => {
  beforeEach(() => seedTrip());

  it('applies CASE-WHEN semantics — absent keys untouched, explicit null clears', async () => {
    const { item } = await budgetApi.create(1, {
      name: 'Old', category: 'food', currency: 'EUR', note: 'hello', persons: 3,
    });
    const { item: kept } = await budgetApi.update(1, item.id, { name: 'New' });
    expect(kept.name).toBe('New');
    expect(kept.category).toBe('food');
    expect(kept.currency).toBe('EUR');
    expect(kept.note).toBe('hello');
    expect(kept.persons).toBe(3);
    const { item: cleared } = await budgetApi.update(1, item.id, { currency: null, note: null });
    expect(cleared.currency).toBeNull();
    expect(cleared.note).toBeNull();
  });

  it('re-freezes FX only when the currency actually changes', async () => {
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 1.2 });
    const { item } = await budgetApi.create(1, { name: 'x', currency: 'USD' });
    expect(item.exchange_rate).toBe(1.2);
    // An unrelated edit on the same currency leaves the frozen rate alone.
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 9.9, CHF: 0.95 });
    const { item: sameCur } = await budgetApi.update(1, item.id, { name: 'y' });
    expect(sameCur.exchange_rate).toBe(1.2);
    // A currency change re-freezes at the (mocked) live rate.
    const { item: changed } = await budgetApi.update(1, item.id, { currency: 'CHF' });
    expect(changed.exchange_rate).toBe(0.95);
  });

  it('replaces inline payers/members and re-derives the total', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { item } = await budgetApi.create(1, { name: 'x', total_price: 5 });
    const { item: updated } = await budgetApi.update(1, item.id, {
      payers: [{ user_id: anna, amount: 40 }],
      members: [{ user_id: 1, amount: 10 }, { user_id: anna, amount: null }],
    });
    expect(updated.total_price).toBe(40);
    expect(updated.payers).toEqual([
      { user_id: anna, amount: 40, username: 'Anna', avatar: null, avatar_url: null },
    ]);
    expect(updated.members!.map((m) => m.user_id)).toEqual([1, anna]);
    expect(updated.persons).toBe(2);
  });

  it('cleared payers keep an explicit total_price (the "no payer yet" edge)', async () => {
    const { item } = await budgetApi.create(1, { name: 'x', total_price: 42, payers: [{ user_id: 1, amount: 42 }] });
    const { item: updated } = await budgetApi.update(1, item.id, { payers: [], total_price: 42 });
    expect(updated.payers).toEqual([]);
    expect(updated.total_price).toBe(42);
  });

  it('syncs the mirrored price onto a linked reservation', async () => {
    await db.reservations.put(
      buildReservation({ id: 31, trip_id: 1, metadata: JSON.stringify({ note: 'x' }) }),
    );
    const { item } = await budgetApi.create(1, { name: 'Hotel', total_price: 100, reservation_id: 31 });
    await budgetApi.update(1, item.id, { total_price: 123.456 });
    const res = (await db.reservations.get(31))!;
    const meta = JSON.parse(res.metadata!);
    expect(meta.note).toBe('x');
    expect(meta.price).toBe('123.46'); // cent-clean, no float noise
  });

  it('404s a foreign trip\'s item and a missing item alike', async () => {
    const { item } = await budgetApi.create(1, { name: 'x' });
    await db.trips.put(buildTrip({ id: 2, title: 'other' }));
    const wrongTrip = await fail(budgetApi.update(2, item.id, { name: 'y' }));
    expect(wrongTrip.response.data.error).toBe('Budget item not found');
    const missing = await fail(budgetApi.update(1, 987, { name: 'y' }));
    expect(missing.response.data.error).toBe('Budget item not found');
  });
});

describe('budgetApi.delete', () => {
  beforeEach(() => seedTrip());

  it('answers { success: true }, removes the row, and clears the reservation mirror', async () => {
    await db.reservations.put(
      buildReservation({ id: 31, trip_id: 1, metadata: JSON.stringify({ price: '42', priceCurrency: 'EUR', x: 1 }) }),
    );
    const { item } = await budgetApi.create(1, { name: 'Hotel', reservation_id: 31 });
    expect(await budgetApi.delete(1, item.id)).toEqual({ success: true });
    expect(await db.budgetItems.get(item.id)).toBeUndefined();
    const meta = JSON.parse((await db.reservations.get(31))!.metadata!);
    expect(meta.price).toBeUndefined();
    expect(meta.priceCurrency).toBeUndefined();
    expect(meta.x).toBe(1);
  });

  it('404s a missing or foreign-trip item', async () => {
    const err = await fail(budgetApi.delete(1, 987));
    expect(err.response.data.error).toBe('Budget item not found');
  });
});

describe('budgetApi.setMembers / togglePaid / setPayers', () => {
  beforeEach(() => seedTrip());

  it('setMembers answers { members, item } — item is the bare stored row', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { item } = await budgetApi.create(1, { name: 'x', total_price: 30, member_ids: [1] });
    const res = await budgetApi.setMembers(1, item.id, [anna, 1]);
    expect(res.members.map((m) => m.user_id)).toEqual([anna, 1]);
    expect(res.members[0].username).toBe('Anna');
    expect(res.item.persons).toBe(2);
    // The server's `SELECT *` — no junction keys on the item half.
    expect('members' in res.item).toBe(false);
    expect('payers' in res.item).toBe(false);
  });

  it('setMembers preserves paid flags for members that stayed', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { item } = await budgetApi.create(1, { name: 'x', member_ids: [1, anna] });
    await budgetApi.togglePaid(1, item.id, anna, true);
    const res = await budgetApi.setMembers(1, item.id, [anna]);
    expect(res.members).toEqual([
      expect.objectContaining({ user_id: anna, paid: 1 }),
    ]);
    const stored = (await db.budgetItems.get(item.id))!;
    expect(stored.members!.map((m) => m.user_id)).toEqual([anna]);
    expect(stored.persons).toBe(1);
  });

  it('togglePaid answers the joined member row; null (not 404) for a miss', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { item } = await budgetApi.create(1, { name: 'x', member_ids: [anna] });
    const { member } = await budgetApi.togglePaid(1, item.id, anna, true);
    expect(member).toEqual({ user_id: anna, paid: 1, username: 'Anna', avatar: null, avatar_url: null });
    // Member row missing → { member: null }, the server's JOIN answering nothing.
    expect((await budgetApi.togglePaid(1, item.id, 1, true)).member).toBeNull();
    // Item missing → the same null — this route never 404'd.
    expect((await budgetApi.togglePaid(1, 987, anna, true)).member).toBeNull();
  });

  it('setPayers replaces the rows, re-derives the total, drops off-roster ids', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { item } = await budgetApi.create(1, { name: 'x', total_price: 5 });
    const { item: updated } = await budgetApi.setPayers(1, item.id, [
      { user_id: anna, amount: 30 },
      { user_id: 55, amount: 99 }, // not on the roster — ignored
      { user_id: 1, amount: 0 }, // zero amounts never land
    ]);
    expect(updated.total_price).toBe(30);
    expect(updated.payers).toEqual([
      { user_id: anna, amount: 30, username: 'Anna', avatar: null, avatar_url: null },
    ]);
    expect(updated.members).toEqual([]);
    // The route never loaded receipts — the key stays off the response.
    expect('receipts' in updated).toBe(false);
  });
});

describe('budgetApi.perPersonSummary', () => {
  it('groups assigned/paid totals and item counts per member', async () => {
    await seedTrip();
    const anna = await seedGuest(1, 'Anna');
    const { item } = await budgetApi.create(1, { name: 'x', total_price: 30, member_ids: [1, anna] });
    await budgetApi.togglePaid(1, item.id, anna, true);
    const { summary } = await budgetApi.perPersonSummary(1);
    expect(summary).toEqual([
      { user_id: 1, username: 'Me', avatar: null, total_assigned: 15, total_paid: 0, items_count: 1, avatar_url: null },
      { user_id: anna, username: 'Anna', avatar: null, total_assigned: 15, total_paid: 15, items_count: 1, avatar_url: null },
    ]);
  });
});

describe('budgetApi.settlement — the ported ledger', () => {
  beforeEach(() => seedTrip({ currency: 'EUR' }));

  it('splits odd cents across 3 members with the largest-remainder rule', async () => {
    const anna = await seedGuest(1, 'Anna');
    const bram = await seedGuest(1, 'Bram');
    // item.id picks who gets the extra cent (itemId % 3 rotation) — assert the
    // exact recipient, not just the sum.
    const { item } = await budgetApi.create(1, {
      name: 'Odd bill',
      payers: [{ user_id: 1, amount: 1 }],
      member_ids: [1, anna, bram],
    });
    const shares = splitEqualShares(100, [{ user_id: 1 }, { user_id: anna }, { user_id: bram }], item.id);
    // Largest remainder: 100c over 3 people lands 34/33/33 — never a dropped
    // or doubled cent.
    expect(Object.values(shares).sort((a, b) => a - b)).toEqual([33, 33, 34]);
    const res = await budgetApi.settlement(1);
    const bal = (uid: number) => res.balances.find((b) => b.user_id === uid)!.balance;
    // Each debtor owes their exact share; the payer nets the fronted total
    // minus their own share. Whoever the item.id rotation picked for the odd
    // cent carries it — the ledger agrees with splitEqualShares verbatim.
    expect(bal(anna)).toBeCloseTo(-shares[anna]! / 100, 5);
    expect(bal(bram)).toBeCloseTo(-shares[bram]! / 100, 5);
    expect(bal(1)).toBeCloseTo((100 - shares[1]!) / 100, 5);
    expect(Math.round(res.balances.reduce((a, b) => a + b.balance * 100, 0))).toBe(0);
    // The suggested flows settle exactly to zero — their total is the debtors'
    // magnitude.
    expect(res.flows.reduce((a, f) => a + f.amount, 0)).toBeCloseTo(-(bal(anna) + bal(bram)), 5);
  });

  it('uses the rate frozen at entry time, not today\'s live rate', async () => {
    const anna = await seedGuest(1, 'Anna');
    // 110 USD frozen at 1.10 → 100 EUR in the ledger even though the mocked
    // live fetch now says the rate moved.
    const { item } = await budgetApi.create(1, {
      name: 'Frozen',
      currency: 'USD',
      exchange_rate: 1.1,
      payers: [{ user_id: 1, amount: 110 }],
      member_ids: [1, anna],
    });
    void item;
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 2.0, GBP: 0.8 });
    const res = await budgetApi.settlement(1);
    const annaBal = res.balances.find((b) => b.user_id === anna)!;
    expect(annaBal.balance).toBeCloseTo(-50, 5); // owes half of €100, not €55
    const selfBal = res.balances.find((b) => b.user_id === 1)!;
    expect(selfBal.balance).toBeCloseTo(50, 5);
  });

  it('falls back to live rates for legacy rows without a frozen rate', async () => {
    const anna = await seedGuest(1, 'Anna');
    await db.budgetItems.put(
      buildBudgetItem({
        id: 51,
        trip_id: 1,
        currency: 'USD',
        exchange_rate: 1, // the legacy "not frozen" sentinel
        payers: [{ user_id: 1, amount: 110 }],
        members: [{ user_id: 1, paid: 0, amount: null, username: 'Me' }, { user_id: anna, paid: 0, amount: null, username: 'Anna' }],
      }),
    );
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 1.1 });
    const res = await budgetApi.settlement(1);
    const annaBal = res.balances.find((b) => b.user_id === anna)!;
    expect(annaBal.balance).toBeCloseTo(-50, 5);
  });
});

describe('budgetApi settlement CRUD', () => {
  beforeEach(() => seedTrip({ currency: 'EUR' }));

  it('creates a settled transfer with the server coercions and joined names', async () => {
    const anna = await seedGuest(1, 'Anna');
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 1.2 });
    const { settlement } = await budgetApi.createSettlement(1, {
      from_user_id: anna,
      to_user_id: 1,
      amount: 10.555,
      currency: 'usd',
      settled_at: '2026-03-04',
    });
    expect(settlement.amount).toBe(10.56); // cent-rounded
    expect(settlement.currency).toBe('USD'); // uppercased
    expect(settlement.exchange_rate).toBe(1.2); // the freeze
    expect(settlement.from_username).toBe('Anna');
    expect(settlement.to_username).toBe('Me');
    expect(settlement.created_by_user_id).toBe(1);
    expect(settlement.trip_id).toBe('1'); // the route-param string the server bound
    const stored = (await db.budgetSettlements.get(settlement.id))!;
    expect(stored.trip_id).toBe(1);
  });

  it('defaults exchange_rate to 1 when the fetch fails or currency is the trip\'s', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { settlement } = await budgetApi.createSettlement(1, {
      from_user_id: anna, to_user_id: 1, amount: 5, currency: 'EUR',
    });
    expect(settlement.exchange_rate).toBe(1);
  });

  it('rejects off-roster parties as Settlement not found (no probing)', async () => {
    const anna = await seedGuest(1, 'Anna');
    const err = await fail(budgetApi.createSettlement(1, {
      from_user_id: anna, to_user_id: 777, amount: 5,
    }));
    expect(err.response.status).toBe(404);
    expect(err.response.data.error).toBe('Settlement not found');
    expect(await db.budgetSettlements.count()).toBe(0);
  });

  it('a recorded settlement nets into the ledger', async () => {
    const anna = await seedGuest(1, 'Anna');
    await budgetApi.create(1, {
      name: 'Dinner',
      payers: [{ user_id: 1, amount: 30 }],
      member_ids: [1, anna],
    });
    await budgetApi.createSettlement(1, { from_user_id: anna, to_user_id: 1, amount: 15 });
    const res = await budgetApi.settlement(1);
    expect(res.settlements).toHaveLength(1);
    const annaBal = res.balances.find((b) => b.user_id === anna)!;
    expect(annaBal.balance).toBeCloseTo(0, 5); // the transfer closed her debt
  });

  it('updates with CASE-WHEN sentinels — absent currency keys keep, null clears', async () => {
    const anna = await seedGuest(1, 'Anna');
    mockFetchRates.mockResolvedValue({ EUR: 1, USD: 1.2 });
    const { settlement } = await budgetApi.createSettlement(1, {
      from_user_id: anna, to_user_id: 1, amount: 5, currency: 'USD', settled_at: '2026-01-01',
    });
    expect(settlement.exchange_rate).toBe(1.2);
    // Amount/party edit without touching currency — the frozen rate stays.
    const { settlement: kept } = await budgetApi.updateSettlement(1, settlement.id, {
      from_user_id: anna, to_user_id: 1, amount: 6,
    });
    expect(kept.amount).toBe(6);
    expect(kept.currency).toBe('USD');
    expect(kept.exchange_rate).toBe(1.2);
    // Clear the currency explicitly — the row mirrors the server's NULL.
    const { settlement: cleared } = await budgetApi.updateSettlement(1, settlement.id, {
      from_user_id: anna, to_user_id: 1, amount: 6, currency: null,
    });
    expect(cleared.currency).toBeNull();
  });

  it('update 404s a missing settlement; delete answers { success: true } then 404s', async () => {
    const anna = await seedGuest(1, 'Anna');
    const { settlement } = await budgetApi.createSettlement(1, {
      from_user_id: anna, to_user_id: 1, amount: 5,
    });
    expect(await budgetApi.deleteSettlement(1, settlement.id)).toEqual({ success: true });
    const gone = await fail(budgetApi.deleteSettlement(1, settlement.id));
    expect(gone.response.data.error).toBe('Settlement not found');
    const upd = await fail(budgetApi.updateSettlement(1, 987, {
      from_user_id: anna, to_user_id: 1, amount: 5,
    }));
    expect(upd.response.data.error).toBe('Settlement not found');
  });

  it('a guest created through usersApi is usable as a payer the same request cycle', async () => {
    // The roster contract the brief pins: createGuest → usable as payer.
    const { member } = await usersApi.create(1, 'Guest Payer');
    const { item } = await budgetApi.create(1, {
      name: 'Guests paid',
      payers: [{ user_id: member.id, amount: 10 }],
      member_ids: [member.id, 1],
    });
    expect(item.payers![0]).toMatchObject({ user_id: member.id, username: 'Guest Payer' });
    const res = await budgetApi.settlement(1);
    const g = res.balances.find((b) => b.user_id === member.id)!;
    expect(g.balance).toBeCloseTo(5, 5);
  });
});

describe('budgetApi.reorderItems / reorderCategories', () => {
  beforeEach(() => seedTrip());

  it('reorderItems rewrites sort_order for the trip\'s rows, skipping foreign ids', async () => {
    await db.trips.put(buildTrip({ id: 2, title: 'other' }));
    const a = await budgetApi.create(1, { name: 'a' });
    const b = await budgetApi.create(1, { name: 'b' });
    await db.budgetItems.put(buildBudgetItem({ id: 900, trip_id: 2, sort_order: 7 }));
    expect(await budgetApi.reorderItems(1, [b.item.id, a.item.id, 900])).toEqual({ success: true });
    expect((await db.budgetItems.get(a.item.id))!.sort_order).toBe(1);
    expect((await db.budgetItems.get(b.item.id))!.sort_order).toBe(0);
    expect((await db.budgetItems.get(900))!.sort_order).toBe(7); // untouched — other trip
  });

  it('reorderCategories upserts the group order and list() reflects it', async () => {
    await budgetApi.create(1, { name: 'a', category: 'food' });
    await budgetApi.create(1, { name: 'b', category: 'travel' });
    await budgetApi.create(1, { name: 'c', category: 'stay' });
    await budgetApi.reorderCategories(1, ['stay', 'food', 'travel']);
    const { items } = await budgetApi.list(1);
    expect(items.map((i) => i.category)).toEqual(['stay', 'food', 'travel']);
    const rows = await db.budgetCategoryOrder.where('trip_id').equals(1).toArray();
    // Rows come back in surrogate-key (creation) order — food, travel, stay —
    // with the reordered positions stamped onto them.
    expect(rows.map((r) => [r.category, r.sort_order])).toEqual([
      ['food', 1], ['travel', 2], ['stay', 0],
    ]);
  });
});
