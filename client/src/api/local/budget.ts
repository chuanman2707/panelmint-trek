/**
 * `budgetApi` — the Dexie port of the hosted BudgetController + BudgetService
 * (server/src/nest/budget/). Expense rows live in `budgetItems` with members,
 * payers and receipts embedded (the server's budget_item_members /
 * budget_item_payers / file_links junctions); category group order lives in
 * `budgetCategoryOrder` (the server's budget_category_order table), and
 * recorded settle-up transfers in `budgetSettlements` through the ported
 * SettlementStore seam (`ported/settlement.ts` — the pure ledger arithmetic
 * is not reimplemented here).
 *
 * Wire parity with the axios surface it replaced:
 *   GET                    → { items }
 *   POST                   → { item }
 *   PUT :id                → { item }   (reservation-linked price sync rides
 *                            inside the transaction; the caller re-reads
 *                            reservations like the broadcast consumer did)
 *   DELETE :id             → { success: true }  (mirror price cleared)
 *   PUT :id/members        → { members, item }  (`item` is the bare row —
 *                            the server returned `SELECT *`, no junction keys)
 *   PUT :id/members/:uid/paid → { member }  (null when the row joins to
 *                            nothing — never a 404 for a missing member)
 *   PUT :id/payers         → { item }
 *   GET summary/per-person → { summary }
 *   GET settlement         → { balances, flows, settlements, finalBudgets }
 *   POST settlements       → { settlement }
 *   PUT settlements/:id    → { settlement }
 *   DELETE settlements/:id → { success: true }
 *   PUT reorder/items      → { success: true }
 *   PUT reorder/categories → { success: true }
 *
 * Errors reproduce the controller verbatim: 'Trip not found' (the access
 * guard), 'Budget item not found' / 'Settlement not found', and the
 * ZodValidationPipe 400 strings `parseBody` produces. A settlement whose
 * parties are off the trip roster 404s as 'Settlement not found' — the same
 * probe-proof answer the controller gave.
 *
 * FX freezes (items + settlements) resolve through `api/ext/fx.ts` BEFORE the
 * Dexie transaction opens — external work never happens inside withStore
 * (IndexedDB auto-commits across non-Dexie awaits). Trip-currency rebasing
 * stays in `tripsApi.update` → `DexieStore.rebaseTripCurrency`.
 */
import {
  budgetCreateItemRequestSchema,
  budgetCreateSettlementRequestSchema,
  budgetReorderCategoriesRequestSchema,
  budgetReorderItemsRequestSchema,
  budgetToggleMemberPaidRequestSchema,
  budgetUpdateItemRequestSchema,
  budgetUpdateMembersRequestSchema,
  budgetUpdatePayersRequestSchema,
  budgetUpdateSettlementRequestSchema,
  type BudgetCreateItemRequest,
  type BudgetUpdateItemRequest,
} from '@trek/shared';
import type { BudgetItem, Trip } from '../../types';
import { db } from '../../db/panelmintDb';
import { fetchExchangeRates } from '../ext/fx';
import { DexieStore, SELF_ID, withStore } from './dexieStore';
import { notFound, numId, nowIso, parseBody } from './helpers';
import {
  applySettlementUpdate,
  calculateSettlement,
  deleteSettlement,
  insertSettlement,
  listSettlements,
  settlementPartiesOnTrip,
  splitLegacyTicketNote,
  sumMoney,
  type SettlementMember,
  type SettlementPayer,
  type SettlementWriteData,
} from './ported/settlement';

/** TripAccessGuard's verdict: reachable trip or the 404 it produced. */
function requireTrip(store: DexieStore, tripId: number | string): number {
  const tid = numId(tripId);
  const trip = Number.isFinite(tid) ? store.tripRaw(tid) : undefined;
  if (!trip || !store.accessibleTripIds().has(tid)) throw notFound('Trip');
  return tid;
}

/**
 * The same guard, resolvable before `withStore` opens: the server's handlers
 * ran the FX fetch *after* TripAccessGuard, so an unreachable trip 404s
 * without ever touching Frankfurter.
 */
async function requireTripAccess(tripId: number): Promise<Trip> {
  const trip = Number.isFinite(tripId) ? await db.trips.get(tripId) : undefined;
  if (!trip) throw notFound('Trip');
  if (trip.user_id !== SELF_ID) {
    const member = await db.tripMembers.get([tripId, SELF_ID]);
    if (!member) throw notFound('Trip');
  }
  return trip;
}

/** Pre-transaction `settlementPartiesOnTrip` — the in-store re-check still
 *  runs inside withStore; this pass exists so the FX fetch never fires for a
 *  write that was always going to be refused. */
async function rosterPartiesOnTrip(
  tripId: number,
  data: { from_user_id: number; to_user_id: number },
): Promise<boolean> {
  const trip = await db.trips.get(tripId);
  const memberIds = await db.tripMembers.where('tripId').equals(tripId).primaryKeys();
  const roster = new Set<number>(memberIds.map((k) => (k as [number, number])[1]));
  if (trip) roster.add(trip.user_id);
  return roster.has(data.from_user_id) && roster.has(data.to_user_id);
}

/**
 * Freeze the live FX rate at entry time into `exchange_rate` so a settled
 * position isn't re-opened when live rates drift later (#1335 / #1445).
 * Verbatim from the service: only for a foreign currency with no explicit
 * rate; on update it (re)freezes only when the currency actually changes, so
 * an unrelated edit never moves money. Degrades to live rates when the fetch
 * fails (fetchExchangeRates never rejects).
 */
async function freezeForeignRate(
  tripId: number,
  data: { currency?: string | null; exchange_rate?: number },
  existingItemId?: number,
  existingCurrency?: string | null,
): Promise<void> {
  if (data.exchange_rate != null) return; // an explicit rate from the caller wins
  const cur = (data.currency || '').toUpperCase();
  if (!cur) return; // currency not being set in this request
  // Items resolve the prior currency from budget_items; a settlement's caller
  // passes it in directly (same split as the service).
  let prior: string | undefined;
  if (existingCurrency !== undefined) {
    prior = (existingCurrency || '').toUpperCase();
  } else if (existingItemId != null) {
    const existing = Number.isFinite(existingItemId)
      ? await db.budgetItems.get(existingItemId)
      : undefined;
    if (existing) prior = (existing.currency || '').toUpperCase();
  }
  if (prior !== undefined && prior === cur) return; // currency unchanged
  const trip = await db.trips.get(tripId);
  const tripCur = (trip?.currency || 'EUR').toUpperCase();
  if (cur === tripCur) return; // same as the trip currency → no conversion to freeze
  const rates = await fetchExchangeRates(tripCur);
  const r = rates?.[cur];
  if (r && r > 0) data.exchange_rate = r;
}

/**
 * Replace the payer rows of an item and keep total_price = sum of payer
 * amounts — `writeItemPayers` verbatim. Zero/NaN amounts and off-roster ids
 * are dropped; a duplicate user_id's row is ignored (INSERT OR IGNORE) but
 * its amount still counts into the total, the same edge the server had.
 */
function writeItemPayers(
  store: DexieStore,
  item: BudgetItem,
  tripId: number,
  payers: { user_id: number; amount: number }[],
): number {
  const known = store.rosterMemberIds(tripId, payers.map((p) => p.user_id));
  const seen = new Set<number>();
  const accepted: number[] = [];
  const rows: NonNullable<BudgetItem['payers']> = [];
  for (const p of payers) {
    if (!p.amount || !known.has(p.user_id)) continue;
    if (!seen.has(p.user_id)) {
      seen.add(p.user_id);
      rows.push({ user_id: p.user_id, amount: p.amount });
    }
    accepted.push(p.amount);
  }
  item.payers = rows;
  const total = sumMoney(accepted);
  item.total_price = total;
  store.putBudgetItem(item);
  return total;
}

/** INSERT OR IGNORE per member id — first occurrence of a user wins. */
function firstPerUser<T extends { user_id: number }>(rows: T[]): T[] {
  const seen = new Set<number>();
  return rows.filter((r) => !seen.has(r.user_id) && seen.add(r.user_id));
}

/**
 * A stored member row. The server's member table carried no name, but the
 * wire type it fed (`budgetItemMemberSchema`) keeps `username` non-optional,
 * so the Dexie row stores the roster name too; `itemMembersWire` re-joins it
 * on the way out regardless.
 */
function memberRow(store: DexieStore, userId: number, paid: number, amount: number | null) {
  return { user_id: userId, paid, amount, username: store.user(userId)?.name ?? '' };
}

/** The service's createBudgetItem transaction, verbatim. */
function createBudgetItem(store: DexieStore, tripId: number, data: BudgetCreateItemRequest): BudgetItem {
  const items = store.budgetItemsOfTrip(tripId);
  const sortOrder = items.reduce((max, i) => Math.max(max, i.sort_order ?? 0), -1) + 1;

  const cat = data.category || 'other';
  store.ensureCategoryOrder(tripId, cat);

  // total_price is derived from explicit payers when given; otherwise the
  // caller value (planning entries, or a bill no one has paid yet). Negative
  // payer amounts (a refund's recipient, #2176) count like any other.
  const payerTotal = sumMoney((data.payers || []).filter((p) => p.amount !== 0).map((p) => p.amount));
  const total = data.payers && data.payers.length > 0 ? payerTotal : data.total_price || 0;

  const knownMembers = data.members
    ? store.rosterMemberIds(tripId, data.members.map((m) => m.user_id))
    : null;
  const members =
    data.members && knownMembers ? data.members.filter((m) => knownMembers.has(m.user_id)) : undefined;
  const knownIds = data.member_ids ? store.rosterMemberIds(tripId, data.member_ids) : null;
  const memberIds =
    data.member_ids && knownIds ? data.member_ids.filter((uid) => knownIds.has(uid)) : undefined;

  const { note, ticket } = splitLegacyTicketNote(data.note, data.ticket_json);

  const id = store.allocId('budgetItems');
  store.putBudgetItem({
    id,
    trip_id: tripId,
    category: cat,
    name: data.name,
    total_price: total,
    currency: data.currency || null,
    exchange_rate: data.exchange_rate != null ? data.exchange_rate : 1,
    persons: memberIds ? memberIds.length : data.persons != null ? data.persons : null,
    days: data.days !== undefined && data.days !== null ? data.days : null,
    note: note || null,
    ticket_json: ticket || null,
    sort_order: sortOrder,
    expense_date: data.expense_date || null,
    reservation_id: data.reservation_id != null ? data.reservation_id : null,
    place_id: data.place_id != null ? data.place_id : null,
    paid_by_user_id: null,
    created_at: nowIso(),
    members: [],
    payers: [],
    receipts: [],
  });

  const item = store.budgetItemRaw(id)!;
  if (data.payers && data.payers.length > 0) {
    writeItemPayers(store, item, tripId, data.payers);
  }
  if (members && members.length > 0) {
    item.members = firstPerUser(
      members.map((m) => memberRow(store, m.user_id, 0, m.amount != null ? m.amount : null)),
    );
  } else if (memberIds && memberIds.length > 0) {
    item.members = firstPerUser(memberIds.map((uid) => memberRow(store, uid, 0, null)));
  }
  store.putBudgetItem(item);

  // receipt_file_ids: there are no trip_files locally — the server's
  // belongs-to-trip check fails every id, so nothing links.

  return store.budgetItemWire(id)!;
}

/** The service's updateBudgetItem transaction — the same COALESCE /
 *  CASE-WHEN sentinel conventions on the stored row. */
function updateBudgetItem(
  store: DexieStore,
  id: number,
  tripId: number,
  data: BudgetUpdateItemRequest,
): BudgetItem | null {
  const item = store.budgetItemRaw(id);
  if (!item || item.trip_id !== tripId) return null;

  // An old client sending a receipt in `note` still lands in ticket_json, and
  // its note is left untouched rather than clobbered with the receipt blob.
  const { note, ticket } = splitLegacyTicketNote(data.note, data.ticket_json);
  const noteTouched = data.note !== undefined && note !== undefined;
  const ticketTouched = data.ticket_json !== undefined || ticket !== undefined;

  // category/name: COALESCE(?, col) bound with `x || null` — a falsy value
  // binds NULL and keeps the stored one.
  if (data.category) item.category = data.category;
  if (data.name) item.name = data.name;
  if (data.total_price !== undefined) item.total_price = data.total_price;
  if (data.currency !== undefined) item.currency = data.currency || null;
  if (data.exchange_rate !== undefined) item.exchange_rate = data.exchange_rate;
  if (data.persons !== undefined) item.persons = data.persons;
  if (data.days !== undefined) item.days = data.days;
  if (noteTouched) item.note = note ?? null;
  if (ticketTouched) item.ticket_json = ticket ?? null;
  if (data.expense_date !== undefined) item.expense_date = data.expense_date || null;

  // Optional inline payer/member replacement (the edit modal saves all at once).
  if (data.payers !== undefined) {
    writeItemPayers(store, item, tripId, data.payers);
    // writeItemPayers derives total_price from the payer sum (0 for no payers).
    // A "recorded total, nobody assigned" expense clears payers but still
    // carries an explicit total_price — re-apply it so it isn't clobbered to 0.
    if (data.payers.length === 0 && data.total_price !== undefined) {
      item.total_price = data.total_price;
      store.putBudgetItem(item);
    }
  }
  if (data.members !== undefined) {
    const known = store.rosterMemberIds(tripId, data.members.map((m) => m.user_id));
    const members = data.members.filter((m) => known.has(m.user_id));
    item.members = firstPerUser(
      members.map((m) => memberRow(store, m.user_id, 0, m.amount != null ? m.amount : null)),
    );
    item.persons = members.length || null;
  } else if (data.member_ids !== undefined) {
    const known = store.rosterMemberIds(tripId, data.member_ids);
    const memberIds = data.member_ids.filter((uid) => known.has(uid));
    item.members = firstPerUser(memberIds.map((uid) => memberRow(store, uid, 0, null)));
    item.persons = memberIds.length || null;
  }

  // If the category changed, register it in the category order table.
  if (data.category) store.ensureCategoryOrder(tripId, data.category);

  // receipt_file_ids: no trip_files locally — the belongs check drops all ids.

  store.putBudgetItem(item);
  return store.budgetItemWire(id)!;
}

/**
 * Mirrors the legacy PUT /:id side effect: when a price-linked budget item's
 * total_price changes, write it into the reservation's metadata. Non-fatal,
 * exactly like the writer — a parse failure never breaks the budget update.
 */
function syncReservationPrice(
  store: DexieStore,
  tripId: number,
  reservationId: number,
  totalPrice: number,
): void {
  try {
    const reservation = store.reservationRecord(reservationId);
    if (!reservation || reservation.trip_id !== tripId) return;
    const meta = reservation.metadata ? JSON.parse(reservation.metadata) : {};
    // Cent-clean, so a booking never inherits float noise from the expense it
    // is linked to — and so a row stamped before #1964 heals on the next edit.
    meta.price = String(Math.round(totalPrice * 100) / 100);
    store.updateReservationMeta(reservation.id, JSON.stringify(meta), null);
  } catch (err) {
    console.error('[budget] Failed to sync price to reservation:', err);
  }
}

/** The counterpart to syncReservationPrice: take the mirrored total back off
 *  the booking when the expense it came from disappears. Non-fatal. */
function clearReservationPrice(store: DexieStore, tripId: number, reservationId: number): void {
  try {
    const reservation = store.reservationRecord(reservationId);
    if (!reservation || reservation.trip_id !== tripId || !reservation.metadata) return;
    const meta = JSON.parse(reservation.metadata);
    if (!meta || typeof meta !== 'object' || meta.price === undefined) return;
    delete meta.price;
    delete meta.priceCurrency;
    store.updateReservationMeta(reservation.id, JSON.stringify(meta), null);
  } catch (err) {
    console.error('[budget] Failed to clear the mirrored price from the reservation:', err);
  }
}

/** The SettlementSource record calculateSettlement reads — the server's
 *  `SELECT *` items plus the member/payer JOINs and listSettlements. */
function buildSettlementSource(store: DexieStore, tripId: number) {
  const items = store.budgetItemsOfTrip(tripId);
  const members: SettlementMember[] = [];
  const payers: SettlementPayer[] = [];
  for (const item of items) {
    for (const m of item.members ?? []) {
      const u = store.user(m.user_id);
      if (!u) continue; // the INNER JOIN drops a dead user's row
      members.push({ budget_item_id: item.id, user_id: m.user_id, amount: m.amount ?? null, username: u.name, avatar: null });
    }
    for (const p of item.payers ?? []) {
      const u = store.user(p.user_id);
      if (!u) continue;
      payers.push({ budget_item_id: item.id, user_id: p.user_id, amount: p.amount, username: u.name, avatar: null });
    }
  }
  return {
    items: items.map((i) => ({ id: i.id, currency: i.currency ?? null, exchange_rate: i.exchange_rate ?? null })),
    members,
    payers,
    settlements: listSettlements(store, tripId),
  };
}

export const budgetApi = {
  /** GET /api/trips/:id/budget → { items } */
  list: (tripId: number | string): Promise<{ items: BudgetItem[] }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      return { items: store.listBudgetItemsWire(tid) };
    }),

  /** POST /api/trips/:id/budget → { item } */
  create: async (tripId: number | string, data: BudgetCreateItemRequest): Promise<{ item: BudgetItem }> => {
    const tid = numId(tripId);
    await requireTripAccess(tid); // the access guard, before the FX fetch
    const body = parseBody(budgetCreateItemRequestSchema, data);
    await freezeForeignRate(tid, body);
    return withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      return { item: createBudgetItem(store, scopedTripId, body) };
    });
  },

  /** PUT /api/trips/:id/budget/:itemId → { item } */
  update: async (tripId: number | string, id: number, data: BudgetUpdateItemRequest): Promise<{ item: BudgetItem }> => {
    const tid = numId(tripId);
    await requireTripAccess(tid);
    const body = parseBody(budgetUpdateItemRequestSchema, data);
    await freezeForeignRate(tid, body, numId(id));
    return withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      const item = updateBudgetItem(store, numId(id), scopedTripId, body);
      if (!item) throw notFound('Budget item');
      // The controller's post-update side channel: a linked reservation's
      // metadata copy of the price follows the expense.
      if (item.reservation_id && body.total_price !== undefined) {
        syncReservationPrice(store, scopedTripId, item.reservation_id, item.total_price);
      }
      return { item };
    });
  },

  /** DELETE /api/trips/:id/budget/:itemId → { success: true } */
  delete: async (tripId: number | string, id: number): Promise<{ success: true }> =>
    withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      const item = store.budgetItemRaw(numId(id));
      if (!item || item.trip_id !== scopedTripId) throw notFound('Budget item');
      store.deleteBudgetItem(item.id);
      // The booking keeps a copy of this expense's total in its metadata;
      // with the expense gone the mirror goes too.
      if (item.reservation_id) clearReservationPrice(store, scopedTripId, item.reservation_id);
      return { success: true as const };
    }),

  /** PUT /api/trips/:id/budget/:itemId/members → { members, item }.
   *  Existing `paid` flags survive the replacement; `item` is the bare row
   *  (the server's `SELECT *` — junction fields stay out of it). */
  setMembers: async (
    tripId: number | string,
    id: number,
    userIds: number[],
  ): Promise<{ members: NonNullable<BudgetItem['members']>; item: BudgetItem }> =>
    withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      const body = parseBody(budgetUpdateMembersRequestSchema, { user_ids: userIds });
      const item = store.budgetItemRaw(numId(id));
      if (!item || item.trip_id !== scopedTripId) throw notFound('Budget item');

      const existingPaid = new Map((item.members ?? []).map((m) => [m.user_id, m.paid]));
      const known = store.rosterMemberIds(scopedTripId, body.user_ids);
      const memberIds = body.user_ids.filter((uid) => known.has(uid));
      item.members = firstPerUser(
        memberIds.map((uid) => memberRow(store, uid, existingPaid.get(uid) ?? 0, null)),
      );
      item.persons = memberIds.length > 0 ? memberIds.length : null;
      store.putBudgetItem(item);

      const members = store.itemMembersWire(item);
      const { members: _m, payers: _p, receipts: _r, ...bare } = item;
      return { members, item: bare };
    }),

  /** PUT /api/trips/:id/budget/:itemId/members/:userId/paid → { member }.
   *  The server answered {member: null} for a missing item or member row —
   *  never a 404 on this route. */
  togglePaid: async (
    tripId: number | string,
    id: number,
    userId: number,
    paid: boolean,
  ): Promise<{ member: { user_id: number; paid: number; username: string; avatar: null; avatar_url: null } | null }> =>
    withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      const body = parseBody(budgetToggleMemberPaidRequestSchema, { paid });
      const item = store.budgetItemRaw(numId(id));
      if (!item || item.trip_id !== scopedTripId) return { member: null };
      const uid = numId(userId);
      const m = (item.members ?? []).find((x) => x.user_id === uid);
      if (!m) return { member: null };
      m.paid = body.paid ? 1 : 0;
      store.putBudgetItem(item);
      const u = store.user(uid);
      // The JOIN'd member — a dead user joins to nothing, like the server.
      if (!u) return { member: null };
      return {
        member: { user_id: uid, paid: m.paid, username: u.name, avatar: null, avatar_url: null },
      };
    }),

  /** PUT /api/trips/:id/budget/:itemId/payers → { item }.
   *  The response carries members+payers joins but no receipts — the server
   *  never loaded them on this route. */
  setPayers: async (
    tripId: number | string,
    id: number,
    payers: { user_id: number; amount: number }[],
  ): Promise<{ item: BudgetItem }> =>
    withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      const body = parseBody(budgetUpdatePayersRequestSchema, { payers });
      const item = store.budgetItemRaw(numId(id));
      if (!item || item.trip_id !== scopedTripId) throw notFound('Budget item');
      writeItemPayers(store, item, scopedTripId, body.payers);
      const { receipts: _r, ...wire } = store.budgetItemWire(item.id)!;
      return { item: wire };
    }),

  /** GET /api/trips/:id/budget/summary/per-person → { summary }.
   *  Per split member: assigned total (custom amount or equal share of the
   *  item total), the paid subset of it, and the item count — the SQL's
   *  GROUP BY bm.user_id, sorted by user id. */
  perPersonSummary: (tripId: number | string): Promise<{
    summary: {
      user_id: number;
      username: string;
      avatar: null;
      total_assigned: number;
      total_paid: number;
      items_count: number;
      avatar_url: null;
    }[];
  }> =>
    withStore((store) => {
      const tid = requireTrip(store, tripId);
      const byUser = new Map<
        number,
        { user_id: number; username: string; avatar: null; total_assigned: number; total_paid: number; items_count: number; avatar_url: null }
      >();
      for (const item of store.budgetItemsOfTrip(tid)) {
        const members = item.members ?? [];
        const memberCount = members.length;
        if (memberCount === 0) continue;
        for (const m of members) {
          const u = store.user(m.user_id);
          if (!u) continue; // JOIN users
          const share = m.amount ?? item.total_price / memberCount;
          let row = byUser.get(m.user_id);
          if (!row) {
            row = { user_id: m.user_id, username: u.name, avatar: null, total_assigned: 0, total_paid: 0, items_count: 0, avatar_url: null };
            byUser.set(m.user_id, row);
          }
          row.total_assigned += share;
          if (m.paid === 1) row.total_paid += share;
          row.items_count += 1;
        }
      }
      return { summary: [...byUser.values()].sort((a, b) => a.user_id - b.user_id) };
    }),

  /** GET /api/trips/:id/budget/settlement → { balances, flows, settlements,
   *  finalBudgets }. Live FX rates resolve before the transaction — the
   *  ported calculateSettlement then nets in trip cents verbatim. */
  settlement: async (tripId: number | string, base?: string) => {
    const tid = numId(tripId);
    const trip = await requireTripAccess(tid);
    const tripCurrency = (trip.currency || 'EUR').toUpperCase();
    const effectiveBase = (base || tripCurrency).toUpperCase();
    const rates = await fetchExchangeRates(effectiveBase);
    return withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      return calculateSettlement(buildSettlementSource(store, scopedTripId), {
        base: effectiveBase,
        rates,
        tripCurrency,
      });
    });
  },

  /** POST /api/trips/:id/budget/settlements → { settlement }.
   *  Off-roster parties refuse as 'Settlement not found' (the controller's
   *  probe-proof answer). `created_by_user_id` is the self roster row. */
  createSettlement: async (
    tripId: number | string,
    data: { from_user_id: number; to_user_id: number; amount: number; currency?: string | null; settled_at?: string | null },
  ) => {
    const tid = numId(tripId);
    await requireTripAccess(tid);
    const body = parseBody(budgetCreateSettlementRequestSchema, data);
    if (!(await rosterPartiesOnTrip(tid, body))) throw notFound('Settlement');
    // Freeze the display currency's rate at settle time (#1445) — before the
    // transaction, like the service's await.
    const write: SettlementWriteData = { ...body };
    await freezeForeignRate(tid, write);
    return withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      if (!settlementPartiesOnTrip(store, scopedTripId, body)) throw notFound('Settlement');
      const settlement = insertSettlement(store, scopedTripId, write, SELF_ID);
      return { settlement };
    });
  },

  /** PUT /api/trips/:id/budget/settlements/:id → { settlement }.
   *  A currency the edit doesn't touch keeps the already-frozen rate — the
   *  stored row's currency seeds the re-freeze check. */
  updateSettlement: async (
    tripId: number | string,
    settlementId: number,
    data: { from_user_id: number; to_user_id: number; amount: number; currency?: string | null; settled_at?: string | null },
  ) => {
    const tid = numId(tripId);
    await requireTripAccess(tid);
    const body = parseBody(budgetUpdateSettlementRequestSchema, data);
    const sid = numId(settlementId);
    const existing = Number.isFinite(sid) ? await db.budgetSettlements.get(sid) : undefined;
    const existingCurrency = existing && existing.trip_id === tid ? existing.currency ?? null : null;
    if (!(await rosterPartiesOnTrip(tid, body))) throw notFound('Settlement');
    const write: SettlementWriteData = { ...body };
    await freezeForeignRate(tid, write, undefined, existingCurrency);
    return withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      if (!settlementPartiesOnTrip(store, scopedTripId, body)) throw notFound('Settlement');
      const settlement = applySettlementUpdate(store, sid, scopedTripId, write);
      if (!settlement) throw notFound('Settlement');
      return { settlement };
    });
  },

  /** DELETE /api/trips/:id/budget/settlements/:id → { success: true } */
  deleteSettlement: async (tripId: number | string, settlementId: number): Promise<{ success: true }> =>
    withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      if (!deleteSettlement(store, numId(settlementId), scopedTripId)) throw notFound('Settlement');
      return { success: true as const };
    }),

  /** PUT /api/trips/:id/budget/reorder/items → { success: true }.
   *  Foreign/missing ids are silently skipped (`WHERE id=? AND trip_id=?`). */
  reorderItems: async (tripId: number | string, orderedIds: number[]): Promise<{ success: true }> =>
    withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      const body = parseBody(budgetReorderItemsRequestSchema, { orderedIds });
      body.orderedIds.forEach((itemId, index) => {
        const item = store.budgetItemRaw(itemId);
        if (!item || item.trip_id !== scopedTripId) return;
        item.sort_order = index;
        store.putBudgetItem(item);
      });
      return { success: true as const };
    }),

  /** PUT /api/trips/:id/budget/reorder/categories → { success: true }.
   *  Upserts the group's position in budget_category_order. */
  reorderCategories: async (tripId: number | string, orderedCategories: string[]): Promise<{ success: true }> =>
    withStore((store) => {
      const scopedTripId = requireTrip(store, tripId);
      const body = parseBody(budgetReorderCategoriesRequestSchema, { orderedCategories });
      body.orderedCategories.forEach((cat, index) => {
        store.upsertCategoryOrder(scopedTripId, cat, index);
      });
      return { success: true as const };
    }),
};
