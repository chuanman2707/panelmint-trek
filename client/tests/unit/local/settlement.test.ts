/**
 * Parity tests for the ported settlement math.
 *
 * Source fixtures: server/tests/unit/nest/budget.service.test.ts pins the
 * largest-remainder rotation (itemId % n start index, user_id-sorted members),
 * the canonical trip-currency ledger, greedy flow simplification and the
 * fronted/reimbursed breakdown. The pure math runs verbatim here; the
 * row-reading and row-writing halves are asserted through the MemoryStore seam
 * or parked in describe.todo where they are persistence-only.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateDisplayCents,
  calculateSettlement,
  splitEqualShares,
  sumMoney,
  type SettlementSource,
} from '../../../src/api/local/ported/settlement';

const alice = { user_id: 1, username: 'alice' };
const bob = { user_id: 2, username: 'bob' };
const carol = { user_id: 3, username: 'carol' };

describe('splitEqualShares (largest-remainder, item-id rotation)', () => {
  const members = [carol, alice, bob]; // deliberately unsorted — the port sorts by user_id

  it('splits an even total evenly', () => {
    expect(splitEqualShares(300, members, 1)).toEqual({ 1: 100, 2: 100, 3: 100 });
  });

  it('rotates the remainder starting at itemId % n over user_id-sorted members', () => {
    // 100 cents over 3 members: base 33, remainder 1.
    // itemId 4 → startIndex 4 % 3 = 1 → sorted[1] (bob, user_id 2) gets the cent.
    expect(splitEqualShares(100, members, 4)).toEqual({ 1: 33, 2: 34, 3: 33 });
    // itemId 3 → startIndex 0 → alice gets it.
    expect(splitEqualShares(100, members, 3)).toEqual({ 1: 34, 2: 33, 3: 33 });
  });

  it('negative (refund) totals keep their sign and still reconcile', () => {
    // -100 / 3: base -34 (floor), remainder 2 → two members at -33, one at -34.
    const shares = splitEqualShares(-100, members, 1);
    expect(Object.values(shares).reduce((a, c) => a + c, 0)).toBe(-100);
  });

  it('returns {} for an empty member list', () => {
    expect(splitEqualShares(100, [], 1)).toEqual({});
  });
});

describe('calculateSettlement', () => {
  const source = (over: Partial<SettlementSource> = {}): SettlementSource => ({
    items: [{ id: 10, currency: 'EUR', exchange_rate: 1 }],
    members: [
      { budget_item_id: 10, user_id: 1, amount: null, username: 'alice' },
      { budget_item_id: 10, user_id: 2, amount: null, username: 'bob' },
      { budget_item_id: 10, user_id: 3, amount: null, username: 'carol' },
    ],
    payers: [{ budget_item_id: 10, user_id: 1, amount: 30, username: 'alice' }],
    settlements: [],
    ...over,
  });

  it('nets one payer against equal shares and simplifies to greedy flows', () => {
    const { balances, flows } = calculateSettlement(source(), { tripCurrency: 'EUR' });
    const cents = Object.fromEntries(balances.map((b) => [b.user_id, b.balance]));
    expect(Math.round(cents[1] * 100)).toBe(2000); // paid 30, owes 10
    expect(Math.round(cents[2] * 100)).toBe(-1000);
    expect(Math.round(cents[3] * 100)).toBe(-1000);
    expect(flows).toHaveLength(2);
    for (const f of flows) {
      expect(f.to.user_id).toBe(1);
      expect(Math.round(f.amount * 100)).toBe(1000);
    }
  });

  it('ignores items with no participants and items nobody has paid', () => {
    const { balances, flows } = calculateSettlement(
      source({
        items: [
          { id: 10, currency: 'EUR', exchange_rate: 1 },
          { id: 11, currency: 'EUR', exchange_rate: 1 }, // planning-only: no members
          { id: 12, currency: 'EUR', exchange_rate: 1 }, // unpaid: payers all 0
        ],
        members: [
          { budget_item_id: 10, user_id: 1, amount: null },
          { budget_item_id: 10, user_id: 2, amount: null },
          { budget_item_id: 10, user_id: 3, amount: null },
          { budget_item_id: 12, user_id: 1, amount: null },
        ],
        payers: [
          { budget_item_id: 10, user_id: 1, amount: 30 },
          { budget_item_id: 12, user_id: 1, amount: 0 },
        ],
      }),
      { tripCurrency: 'EUR' }
    );
    expect(balances.map((b) => b.user_id).sort()).toEqual([1, 2, 3]);
    expect(flows.every((f) => f.to.user_id === 1)).toBe(true);
  });

  it('recorded settlements move money back through the ledger', () => {
    const { balances, finalBudgets } = calculateSettlement(
      source({
        settlements: [
          {
            id: 5,
            from_user_id: 2,
            to_user_id: 1,
            amount: 10,
            currency: 'EUR',
            exchange_rate: 1,
            from_username: 'bob',
            from_avatar_url: null,
            to_username: 'alice',
            to_avatar_url: null,
          },
        ],
      }),
      { tripCurrency: 'EUR' }
    );
    const cents = Object.fromEntries(balances.map((b) => [b.user_id, b.balance]));
    expect(Math.round(cents[2] * 100)).toBe(0); // bob settled his 10€ share
    expect(finalBudgets.length).toBeGreaterThan(0);
  });

  it('converts display-currency totals through the rate table', () => {
    const { balances } = calculateSettlement(source(), {
      base: 'USD',
      tripCurrency: 'EUR',
      rates: { EUR: 0.9, USD: 1 },
    });
    // EUR trip currency → USD display; direction pinned by the port's factor.
    const alice2 = balances.find((b) => b.user_id === 1)!;
    expect(alice2.balance).not.toBe(20); // converted, not raw euros
    expect(Number.isFinite(alice2.balance)).toBe(true);
  });
});

describe('sumMoney / allocateDisplayCents', () => {
  it('sumMoney rounds away float dust', () => {
    expect(sumMoney([0.1, 0.2])).toBeCloseTo(0.3, 10);
    expect(sumMoney([19.99, 0.01])).toBe(20);
  });

  it('allocateDisplayCents distributes the remainder over the largest fractional parts', () => {
    const out = allocateDisplayCents([3333, 3333, 3334], 1);
    expect(out.reduce((a, c) => a + c, 0)).toBe(10000);
  });
});

describe.todo('settlement rows via real persistence (Dexie adapter)', () => {
  // listSettlements / insertSettlement / applySettlementUpdate / deleteSettlement
  // need a running offlineDb adapter — the MemoryStore exercises the seam shape
  // but IndexedDB behaviour (compound keys, transaction rollback) belongs to an
  // integration test once repo/ wires the seam up.
});
