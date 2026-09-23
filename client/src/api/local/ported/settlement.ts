/**
 * Port of the settlement half of BudgetService
 * (server/src/nest/budget/budget.service.ts) plus the avatarUrl helper.
 *
 * The arithmetic is verbatim and pure: integer cents, largest-remainder splits,
 * frozen FX at entry, display-currency conversion as one allocation set. The
 * reads (items/members/payers/settlements) come in through a `SettlementSource`
 * record instead of SQL; persisted settle-up rows go through `SettlementStore`.
 *
 * Server behaviours preserved:
 *  - splitEqualShares: floor-based largest remainder, the extra cents rotating
 *    with the item id; negatives (refunds) still sum back exactly.
 *  - An expense nobody has paid stays out of the ledger; a planning-only entry
 *    (no members) too; payers net to zero still divide zero.
 *  - Frozen exchange_rate preferred over live rates both ways; legacy NULL
 *    currency/rate rows fall back to live rates via base.
 *  - allocateDisplayCents keeps Σ(converted) === converted(Σ).
 *  - Persisted settlements net into the ledger in trip cents, per transfer.
 */
import type { BudgetParticipantFinal } from '@trek/shared';

/** How the costs UI used to smuggle an itemized receipt through the note field. */
const LEGACY_TICKET_PREFIX = 'TICKETJSON:';

/**
 * Keep a written note and an itemized receipt out of each other's way (#1658).
 * Verbatim from the server.
 */
export function splitLegacyTicketNote(
  note: string | null | undefined,
  ticket: string | null | undefined
): { note: string | null | undefined; ticket: string | null | undefined } {
  if (typeof note === 'string' && note.startsWith(LEGACY_TICKET_PREFIX)) {
    return { note: undefined, ticket: note.slice(LEGACY_TICKET_PREFIX.length) };
  }
  return { note, ticket };
}

/** Resolve a user's stored avatar reference to a renderable URL. Verbatim. */
export function avatarUrl(user: { avatar?: string | null }): string | null {
  if (!user.avatar) return null;
  if (/^https:\/\//i.test(user.avatar)) return user.avatar;
  return `/uploads/avatars/${user.avatar}`;
}

/**
 * Add money in whole cents, not in floats (#1964). Verbatim.
 */
export function sumMoney(amounts: number[]): number {
  return amounts.reduce((a, v) => a + Math.round(v * 100), 0) / 100;
}

/**
 * Convert a set of trip cents to display cents so that they still add up: floor
 * each one, then hand the cents lost to flooring to the largest fractions.
 * Verbatim.
 */
export function allocateDisplayCents(
  cents: number[],
  factor: number,
  total = Math.round(cents.reduce((a, c) => a + c, 0) * factor)
): number[] {
  if (factor === 1) return [...cents];
  const exact = cents.map((c) => c * factor);
  const out = exact.map((v) => Math.floor(v));
  const drift = total - out.reduce((a, v) => a + v, 0);
  const byFraction = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < drift && k < byFraction.length; k++) out[byFraction[k].i] += 1;
  return out;
}

/** The minimal item shape the settlement reads. */
export interface SettlementItem {
  id: number;
  currency: string | null;
  exchange_rate: number | null;
}

export interface SettlementMember {
  budget_item_id: number;
  user_id: number;
  amount: number | null;
  username?: string;
  avatar?: string | null;
}

export interface SettlementPayer {
  budget_item_id: number;
  user_id: number;
  amount: number;
  username?: string;
  avatar?: string | null;
}

/** A persisted settle-up row in the mapped (read-model) shape the server returns. */
export interface SettlementRowLike {
  id: number;
  from_user_id: number;
  to_user_id: number;
  amount: number;
  currency: string | null;
  exchange_rate: number | null;
  from_username?: string;
  to_username?: string;
  from_avatar_url?: string | null;
  to_avatar_url?: string | null;
}

/**
 * Everything calculateSettlement reads, gathered by the caller — the port's
 * answer to the server's three queries + listSettlements.
 */
export interface SettlementSource {
  items: SettlementItem[];
  members: SettlementMember[];
  payers: SettlementPayer[];
  settlements: SettlementRowLike[];
}

/**
 * Largest-remainder split of an expense across its participants. Takes and
 * returns **whole cents**, so the shares add back up to the input exactly.
 * Verbatim (the server's private splitEqualShares, exported here for the parity
 * tests).
 */
export function splitEqualShares(
  totalCents: number,
  members: { user_id: number }[],
  itemId: number
): Record<number, number> {
  const n = members.length;
  if (n === 0) return {};

  const baseCents = Math.floor(totalCents / n);
  const remainder = totalCents - baseCents * n;

  const shares: Record<number, number> = {};
  const sortedMembers = [...members].sort((a, b) => a.user_id - b.user_id);
  const startIndex = itemId % n;

  for (let i = 0; i < n; i++) {
    const member = sortedMembers[i];
    const hasExtraCent = (i - startIndex + n) % n < remainder;
    shares[member.user_id] = baseCents + (hasExtraCent ? 1 : 0);
  }

  return shares;
}

/**
 * Who owes whom (`balances` + the simplified `flows`), the recorded transfers
 * (`settlements`), and what the trip ends up costing each participant
 * (`finalBudgets`). Verbatim from the server — only the reads are swapped for
 * the `source` record.
 */
export function calculateSettlement(
  source: SettlementSource,
  opts: { base?: string; rates?: Record<string, number> | null; tripCurrency?: string } = {}
): {
  balances: { user_id: number; username: string; avatar_url: string | null; balance: number }[];
  flows: {
    from: { user_id: number; username: string; avatar_url: string | null };
    to: { user_id: number; username: string; avatar_url: string | null };
    amount: number;
  }[];
  settlements: SettlementRowLike[];
  finalBudgets: BudgetParticipantFinal[];
} {
  const base = (opts.base || opts.tripCurrency || 'EUR').toUpperCase();
  const tripCurrency = (opts.tripCurrency || base).toUpperCase();
  const rates = opts.rates ?? null;
  // rates[X] = units of X per 1 base; the frozen exchange_rate is units of
  // item-currency per 1 trip-currency. NULL currency = "the trip's own currency".
  const toTrip = (amount: number, itemCurrency: string | null | undefined, itemRate?: number | null): number => {
    const cur = (itemCurrency || tripCurrency).toUpperCase();
    if (cur === tripCurrency) return amount;
    // Prefer the FX rate frozen at entry time (#1335).
    if (itemRate != null && itemRate > 0 && itemRate !== 1) return amount / itemRate;
    // Legacy rows without a frozen rate: convert via base with live rates.
    if (!rates) return amount;
    const rCur = rates[cur];
    const rTrip = rates[tripCurrency];
    if (rCur && rCur > 0 && rTrip && rTrip > 0) return (amount / rCur) * rTrip;
    return amount;
  };
  // trip-currency → display currency, applied once to the final netted totals.
  const displayFactor = base === tripCurrency ? 1 : rates && rates[tripCurrency] > 0 ? 1 / rates[tripCurrency] : 1;
  // A recorded settle-up amount is entered in whatever display currency the payer
  // was viewing; new rows carry that currency and the rate frozen at settle time.
  const settleToTrip = (amount: number, sCurrency?: string | null, sRate?: number | null): number => {
    if (sCurrency) {
      const cur = sCurrency.toUpperCase();
      if (cur === tripCurrency) return amount;
      if (sRate != null && sRate > 0 && sRate !== 1) return amount / sRate;
      // Frozen currency but no usable rate: live fallback.
      if (rates) {
        const rCur = rates[cur];
        const rTrip = rates[tripCurrency];
        if (rCur && rCur > 0 && rTrip && rTrip > 0) return (amount / rCur) * rTrip;
      }
      return amount;
    }
    return base === tripCurrency ? amount : rates && rates[tripCurrency] > 0 ? amount * rates[tripCurrency] : amount;
  };

  const { items, members: allMembers, payers: allPayers } = source;

  // Net balance per user, in whole cents of the TRIP currency.
  const toTripCents = (amount: number, itemCurrency: string | null | undefined, itemRate?: number | null): number =>
    Math.round(toTrip(amount, itemCurrency, itemRate) * 100);
  const balances: Record<number, { user_id: number; username: string; avatar_url: string | null; cents: number }> = {};
  const ensure = (id: number, src: { username?: string; avatar?: string | null }) => {
    if (!balances[id])
      balances[id] = { user_id: id, username: src.username || '', avatar_url: avatarUrl(src), cents: 0 };
    return balances[id];
  };
  // The two halves of the balance, kept apart so the per-person final budget can
  // show its own arithmetic: what each person fronted, and what the recorded
  // transfers have already moved back.
  const frontedCents: Record<number, number> = {};
  const reimbursedCents: Record<number, number> = {};
  // ...and the rows they are made of.
  const frontedRows: Record<number, { item_id: number; cents: number }[]> = {};
  const movedRows: Record<
    number,
    { settlement_id: number; from_user_id: number; to_user_id: number; cents: number }[]
  > = {};

  for (const item of items) {
    const members = allMembers.filter((m) => m.budget_item_id === item.id);
    const payers = allPayers.filter((p) => p.budget_item_id === item.id);
    if (members.length === 0) continue; // planning-only entry → doesn't affect balances

    // An expense nobody has paid stays out of the ledger (#2225).
    if (!payers.some((p) => p.amount !== 0)) continue;

    // Payers are credited what they actually paid.
    let creditCents = 0;
    for (const p of payers) {
      const paid = toTripCents(p.amount, item.currency, item.exchange_rate);
      ensure(p.user_id, p).cents += paid;
      frontedCents[p.user_id] = (frontedCents[p.user_id] || 0) + paid;
      if (paid !== 0) (frontedRows[p.user_id] ??= []).push({ item_id: item.id, cents: paid });
      creditCents += paid;
    }
    // …and each split participant owes their share — custom per-member amount,
    // else an equal share of what the payers were actually credited.
    const hasCustomSplit = members.some((m) => m.amount !== null && m.amount !== undefined);
    const equalShares = !hasCustomSplit ? splitEqualShares(creditCents, members, item.id) : {};
    for (const m of members) {
      const memberShare =
        hasCustomSplit && m.amount !== null && m.amount !== undefined
          ? toTripCents(m.amount, item.currency, item.exchange_rate)
          : equalShares[m.user_id] || 0;
      ensure(m.user_id, m).cents -= memberShare;
    }
  }

  // Persisted settle-up transfers already moved money.
  const settlements = source.settlements;
  const ensureSettled = (id: number, username: string | undefined, avatar_url: string | null | undefined) => {
    if (!balances[id])
      balances[id] = { user_id: id, username: username || '', avatar_url: avatar_url ?? null, cents: 0 };
    return balances[id];
  };
  for (const s of settlements) {
    const inTrip = Math.round(settleToTrip(s.amount, s.currency, s.exchange_rate) * 100);
    ensureSettled(s.from_user_id, s.from_username, s.from_avatar_url).cents += inTrip;
    ensureSettled(s.to_user_id, s.to_username, s.to_avatar_url).cents -= inTrip;
    reimbursedCents[s.to_user_id] = (reimbursedCents[s.to_user_id] || 0) + inTrip;
    reimbursedCents[s.from_user_id] = (reimbursedCents[s.from_user_id] || 0) - inTrip;
    const moved = { settlement_id: s.id, from_user_id: s.from_user_id, to_user_id: s.to_user_id };
    (movedRows[s.to_user_id] ??= []).push({ ...moved, cents: inTrip });
    (movedRows[s.from_user_id] ??= []).push({ ...moved, cents: -inTrip });
  }

  // Into the display currency as one set, then simplify.
  const ledger = Object.values(balances);
  const displayCents = allocateDisplayCents(
    ledger.map((b) => b.cents),
    displayFactor
  );
  const frontedDisplayCents = allocateDisplayCents(
    ledger.map((b) => frontedCents[b.user_id] || 0),
    displayFactor
  );
  const reimbursedDisplayCents = allocateDisplayCents(
    ledger.map((b) => reimbursedCents[b.user_id] || 0),
    displayFactor
  );

  // Optimized payment flows (greedy algorithm).
  const people = ledger
    .map((b, i) => ({ user_id: b.user_id, username: b.username, avatar_url: b.avatar_url, cents: displayCents[i] }))
    .filter((b) => b.cents !== 0);
  const debtors = people.filter((p) => p.cents < 0).map((p) => ({ ...p, amount: -p.cents }));
  const creditors = people.filter((p) => p.cents > 0).map((p) => ({ ...p, amount: p.cents }));

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const flows: {
    from: { user_id: number; username: string; avatar_url: string | null };
    to: { user_id: number; username: string; avatar_url: string | null };
    amount: number;
  }[] = [];

  let di = 0,
    ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const transfer = Math.min(debtors[di].amount, creditors[ci].amount);
    flows.push({
      from: { user_id: debtors[di].user_id, username: debtors[di].username, avatar_url: debtors[di].avatar_url },
      to: { user_id: creditors[ci].user_id, username: creditors[ci].username, avatar_url: creditors[ci].avatar_url },
      amount: transfer / 100,
    });
    debtors[di].amount -= transfer;
    creditors[ci].amount -= transfer;
    if (debtors[di].amount === 0) di++;
    if (creditors[ci].amount === 0) ci++;
  }

  return {
    balances: ledger.map((b, i) => ({
      user_id: b.user_id,
      username: b.username,
      avatar_url: b.avatar_url,
      balance: displayCents[i] / 100,
    })),
    flows,
    settlements,
    finalBudgets: ledger.map((b, i) => {
      const fronted = frontedRows[b.user_id] || [];
      const moved = movedRows[b.user_id] || [];
      const frontedDisplay = allocateDisplayCents(
        fronted.map((r) => r.cents),
        displayFactor,
        frontedDisplayCents[i]
      );
      const movedDisplay = allocateDisplayCents(
        moved.map((r) => r.cents),
        displayFactor,
        reimbursedDisplayCents[i]
      );
      return {
        user_id: b.user_id,
        username: b.username,
        avatar_url: b.avatar_url,
        expenses: frontedDisplayCents[i] / 100,
        reimbursed: reimbursedDisplayCents[i] / 100,
        pending: displayCents[i] / 100,
        final: (frontedDisplayCents[i] - reimbursedDisplayCents[i] - displayCents[i]) / 100,
        sources: {
          fronted: fronted.map((r, k) => ({ item_id: r.item_id, cents: frontedDisplay[k] })),
          moved: moved.map((r, k) => ({ ...r, cents: movedDisplay[k] })),
          outstanding: flows
            .filter((f) => f.from.user_id === b.user_id || f.to.user_id === b.user_id)
            .map((f) => ({
              from_user_id: f.from.user_id,
              to_user_id: f.to.user_id,
              cents: Math.round(f.amount * 100) * (f.to.user_id === b.user_id ? 1 : -1),
            })),
        },
      };
    }) satisfies BudgetParticipantFinal[],
  };
}

// ── Persisted settle-up rows (the listSettlements/insertSettlement half) ─────

/** The stored row behind SettlementRowLike (the server's SETTLEMENT_SELECT join). */
export interface SettlementStoreRow {
  id: number;
  trip_id: string;
  from_user_id: number;
  to_user_id: number;
  amount: number;
  currency: string | null;
  exchange_rate: number | null;
  created_at: string;
  settled_at: string | null;
  created_by_user_id: number | null;
  from_username: string;
  from_avatar: string | null;
  to_username: string;
  to_avatar: string | null;
}

/** Map the stored row to the read model. Verbatim (mapSettlementRow). */
export function mapSettlementRow(
  r: SettlementStoreRow
): SettlementRowLike & {
  trip_id: string;
  created_at: string;
  settled_at: string | null;
  created_by_user_id: number | null;
} {
  return {
    id: r.id,
    trip_id: r.trip_id,
    from_user_id: r.from_user_id,
    to_user_id: r.to_user_id,
    amount: r.amount,
    currency: r.currency ?? null,
    exchange_rate: r.exchange_rate ?? 1,
    created_at: r.created_at,
    settled_at: r.settled_at ?? null,
    created_by_user_id: r.created_by_user_id,
    from_username: r.from_username,
    from_avatar_url: avatarUrl({ avatar: r.from_avatar }),
    to_username: r.to_username,
    to_avatar_url: avatarUrl({ avatar: r.to_avatar }),
  };
}

export interface SettlementWriteData {
  from_user_id: number;
  to_user_id: number;
  amount: number;
  currency?: string | null;
  exchange_rate?: number;
  settled_at?: string | null;
}

/**
 * Persistence seam for the settlement rows. The pure calc lives in
 * calculateSettlement; this is the stored-adjustment half.
 */
export interface SettlementStore {
  /** SETTLEMENT_SELECT rows for the trip, newest first (created_at DESC, id DESC). */
  listSettlementRows(tripId: number): SettlementStoreRow[];
  getSettlementRow(id: number, tripId: number): SettlementStoreRow | undefined;
  /** INSERT with the server's coercions: amount rounded to cents, currency
   *  uppercased-or-null, exchange_rate defaulting to 1. */
  insertSettlementRow(tripId: number, data: SettlementWriteData, createdByUserId?: number): number;
  /** UPDATE with the server's CASE-WHEN sentinel semantics: currency/exchange_rate/
   *  settled_at only move when the key is present (`!== undefined`). */
  applySettlementRowUpdate(id: number, tripId: number, data: SettlementWriteData): boolean;
  deleteSettlementRow(id: number, tripId: number): boolean;
  /** Trip roster (owner + members) — the settlementPartiesOnTrip guard. */
  rosterUserIds(tripId: number): Set<number>;
}

export function listSettlements(store: SettlementStore, tripId: number) {
  return store.listSettlementRows(tripId).map(mapSettlementRow);
}

export function getSettlement(store: SettlementStore, id: number, tripId: number) {
  const row = store.getSettlementRow(id, tripId);
  return row ? mapSettlementRow(row) : null;
}

/** Raw settlement insert (no FX freeze — the caller owns that). */
export function insertSettlement(
  store: SettlementStore,
  tripId: number,
  data: SettlementWriteData,
  createdByUserId?: number
) {
  const id = store.insertSettlementRow(tripId, data, createdByUserId);
  return getSettlement(store, id, tripId);
}

/** Raw settlement update (no FX freeze). */
export function applySettlementUpdate(store: SettlementStore, id: number, tripId: number, data: SettlementWriteData) {
  if (!store.applySettlementRowUpdate(id, tripId, data)) return null;
  return getSettlement(store, id, tripId);
}

export function deleteSettlement(store: SettlementStore, id: number, tripId: number): boolean {
  return store.deleteSettlementRow(id, tripId);
}

/** A settlement cannot drop an off-roster id — refuse the whole write (null
 *  lands on the caller's existing "not found" path). */
export function settlementPartiesOnTrip(
  store: SettlementStore,
  tripId: number,
  data: { from_user_id: number; to_user_id: number }
): boolean {
  const roster = store.rosterUserIds(tripId);
  return roster.has(data.from_user_id) && roster.has(data.to_user_id);
}
