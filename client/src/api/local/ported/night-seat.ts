/**
 * Port of server/src/nest/accommodations/night-seat.ts plus the day-stop mirror
 * half of accommodations.service.ts (attachStayStop / moveStayStop /
 * dropStayStops and their helpers).
 *
 * The server version prepared SQL statements over better-sqlite3. Here every
 * read/write goes through `NightSeatStore` / `StayMirrorStore` — semantic
 * seams a client persistence layer (Dexie, in-memory tests) implements. All
 * ordering, seating and via re-pinning logic is verbatim.
 *
 * Server behaviours preserved:
 *  - A booked night's stop is measured by the accommodation's check_in, never
 *    by the assignment's own time (the `at` column of dayStops).
 *  - Nights without a check-in lead their day; multiple nights order by
 *    check-in then booking id.
 *  - reseatOwnStop parks at the day's end, then seats by check-in (two steps).
 *  - carryVias: a via follows its stop; a removed stop hands its road to the
 *    stop before it; a via behind the day's last stop stays while that stop is
 *    still last. Merged legs are renumbered like RoadtripService.reanchor.
 *  - The mirror: only the check-in day gets a stop; a day already holding the
 *    place keeps the traveller's stop and the booking rides along; an untyped
 *    place is stamped 'hotel'.
 *
 * PanelMint extension — nights, plural: the offline build seats a stay on every
 * night it covers (every trip day from the check-in day up to, not including,
 * the check-out day; a same-day stay keeps the server's one seat). The
 * single-day primitives stay verbatim; `attachStayNights` / `moveStayNights`
 * iterate them per night, carrying surplus own rows onto newly covered nights
 * so a moved stop keeps its id, notes, hour and participants.
 */
import type { RoadtripVia } from '@trek/shared';

/** A stop of one day as the rule sees it: the clock it is measured by (dayStops), the
 *  booking that owns it, and whether the router counts it. */
export interface SeatRow {
  id: number;
  order_index: number;
  at: string | null;
  night_id: number | null;
  located: number;
}

/** The booking whose stop is being seated. */
export interface Night {
  id: number;
  check_in: string | null | undefined;
}

/** A via as the re-pinning reads it: where it is pinned and its place on that leg. */
export interface PinnedVia {
  id: number;
  after_order_index: number;
  sequence: number;
}

/**
 * Persistence seam replacing the server's SeatConnection.prepare(). Each method
 * is one of the statements night-seat.ts issued; implement them over Dexie or
 * an in-memory fixture. Everything runs inside the caller's transaction.
 */
export interface NightSeatStore {
  /** The server's dayStops() query: the day's stops in order, each measured by
   *  its own time, else the place's, else the owning booking's check_in. */
  dayStops(dayId: number): SeatRow[];
  /** The day's pinned vias (id, after_order_index, sequence). */
  listVias(dayId: number): PinnedVia[];
  /** order_index -= 1 for the day's stops with order_index > afterOrderIndex. */
  closeOrderGap(dayId: number, afterOrderIndex: number): void;
  /** MAX(order_index) among the day's stops, excluding `excludeId`; null when empty. */
  maxOrderIndex(dayId: number, excludeId?: number): number | null;
  /** Move a stop to (dayId, placeId, orderIndex). */
  moveStop(stopId: number, dayId: number, placeId: number, orderIndex: number): void;
  /** order_index += 1 for the day's stops with order_index >= fromOrderIndex, excluding `excludeId`. */
  bumpOrderIndexes(dayId: number, fromOrderIndex: number, excludeId?: number): void;
  /** Re-pin a via to a leg position. */
  setViaLeg(viaId: number, dayId: number, afterOrderIndex: number): void;
  /** Rewrite a via's sequence within its leg. */
  setViaSequence(viaId: number, dayId: number, sequence: number): void;
  deleteVia(viaId: number, dayId: number): void;
}

/**
 * The wider seam the stay mirror needs (the accommodations.service half).
 * Extends the seating store with the writes mirrorStay/remirrorStay/
 * releaseStops issue.
 */
export interface StayMirrorStore extends NightSeatStore {
  /** The day stops a booking put there itself (accommodation_id = id). */
  ownStops(
    accommodationId: number,
    excludeDayId?: number
  ): { id: number; day_id: number; place_id: number; order_index: number }[];
  /** Whether the day already holds that place under any stop (optionally excluding one row). */
  dayHasPlace(dayId: number, placeId: number, excludeId?: number): boolean;
  /** The place's stored stop_type (undefined/null when untyped or unknown). */
  placeStopType(placeId: number): string | null | undefined;
  /** Type a place as lodging. */
  stampPlaceLodging(placeId: number): void;
  /** Read back the place for the mirror's `stamped` field (null tolerates no lookup). */
  getPlaceForMirror(placeId: number): unknown | null;
  /** Insert a stop seated at orderIndex (shifting the rest), owned by the booking. Returns its id. */
  insertOwnedStop(dayId: number, placeId: number, orderIndex: number, accommodationId: number): number;
  /** Drop a stop row. */
  deleteStop(stopId: number): void;
  /** Hand a stop back to the traveller (clear its booking link). */
  releaseStop(stopId: number): void;
  /** Read back a stop in the assignment wire shape for mirror reporting (null tolerates). */
  getStopForMirror(stopId: number): MirroredAssignment | null;
  /** The day's vias in broadcast shape, for mirror.vias reporting. */
  listDayVias(dayId: number): RoadtripVia[];
}

/** The assignment wire shape a mirror carries (the server's
 *  getAssignmentWithPlace result; kept open because the store owns it). */
export type MirroredAssignment = {
  id: number;
  day_id: number;
  [key: string]: unknown;
};

/** One day's drawn roads after a write re-pinned them, as the road trip broadcasts them. */
export interface DayVias {
  dayId: number;
  vias: RoadtripVia[];
}

/** What a stay write did to the day plan, on top of writing the stay itself. */
export interface AccommodationMirror {
  /** The day stop the booking added, or null when that day already held the place. */
  created: MirroredAssignment | null;
  /** Seats past the first — the second and later nights a spanning stay put down. */
  createdExtra: MirroredAssignment[];
  /** The booking's own stop, carried to where the booking now is. */
  moved: { assignment: MirroredAssignment; oldDayId: number } | null;
  /** Extra carried rows — a re-ranged stay can carry several nights at once. */
  movedExtra: { assignment: MirroredAssignment; oldDayId: number }[];
  /** Stops the booking still stands on but no longer owns (a night dropped, the place kept). */
  updated: MirroredAssignment[];
  /** Day stops the booking took back, because it moved days or was deleted. */
  removed: { id: number; dayId: number }[];
  /** The place, when this write was the one that typed it as lodging. */
  stamped: unknown | null;
  /** Days whose drawn roads were re-pinned because a stop of theirs changed position. */
  vias?: DayVias[];
}

/** A write that left the day plan alone. */
export const noStayMirror = (): AccommodationMirror => ({
  created: null,
  createdExtra: [],
  moved: null,
  movedExtra: [],
  updated: [],
  removed: [],
  stamped: null,
});

/**
 * The days a stay's nights land on: every trip day from the check-in day up to,
 * not including, the check-out day — the night of the check-out day is not the
 * hotel's anymore. A same-day (or reversed, or dangling-ref) stay keeps the
 * server's one seat on the start day. `dayIds` are the trip's days in
 * `day_number` order, not id order (#889). Both reservation hotel bookings and
 * day_accommodations seat through this one rule.
 */
export function staySeatDays(dayIds: number[], startDayId: number, endDayId: number): number[] {
  const start = dayIds.indexOf(startDayId);
  const end = dayIds.indexOf(endDayId);
  if (start < 0 || end < 0 || end <= start) return [startDayId];
  return dayIds.slice(start, end);
}

// ── night-seat.ts, verbatim over the store seam ─────────────────────────────

/** A day's stops in order, each with the hour it is measured by: the visit's own, else
 *  the place's — and for a booking-owned stop, the booking's check-in. */
export function dayStops(store: NightSeatStore, dayId: number): SeatRow[] {
  return store.dayStops(dayId);
}

/** The stops the router counts, in day order: the positions the vias are pinned to. */
export function locatedIds(rows: readonly SeatRow[]): number[] {
  return rows.filter((row) => row.located).map((row) => row.id);
}

export function locatedStopIds(store: NightSeatStore, dayId: number): number[] {
  return locatedIds(store.dayStops(dayId));
}

/**
 * Whether `row` stands ahead of the night on its day. Verbatim from the server:
 * the night leads its day; only a stop with a clock at or before the check-in
 * stands ahead; nights settle by check-in then booking id.
 */
export function standsAhead(row: SeatRow, night: Night): boolean {
  const earlierBooking = row.night_id !== null && row.night_id < night.id;
  if (!night.check_in) return row.at === null && earlierBooking;
  if (row.at === null) return row.night_id !== null;
  if (row.at === night.check_in) return row.night_id === null || earlierBooking;
  return row.at < night.check_in;
}

/** The position among `others` (the day's stops without the night's own) the night
 *  takes: right behind the last row that stands ahead of it, else first. */
export function seatAmong(others: readonly SeatRow[], night: Night): number {
  let seat = 0;
  others.forEach((row, i) => {
    if (standsAhead(row, night)) seat = i + 1;
  });
  return seat;
}

/**
 * The order_index a fresh insert of the night gets, with everything from there on
 * moved down. `excludeId` leaves the night's own row out of the chain.
 */
export function seatIndex(store: NightSeatStore, dayId: number, night: Night, excludeId?: number): number {
  const others = store.dayStops(dayId).filter((row) => row.id !== excludeId);
  const seat = seatAmong(others, night);
  return seat === 0 ? 0 : others[seat - 1].order_index + 1;
}

/**
 * Whether the night already sits somewhere its check-in allows, on an edit that did
 * not touch the check-in. Verbatim from the server.
 */
export function seatHolds(rows: readonly SeatRow[], ownId: number, checkIn: string | null | undefined): boolean {
  if (!checkIn) return true;
  const own = rows.findIndex((row) => row.id === ownId);
  if (own < 0) return true;
  const laterAhead = rows.slice(0, own).some((row) => row.at !== null && row.at > checkIn);
  const earlierBehind = rows
    .slice(own + 1)
    .some((row) => row.at !== null && (row.night_id === null ? row.at <= checkIn : row.at < checkIn));
  return !laterAhead && !earlierBehind;
}

/**
 * Carry a night's own stop to `dayId` in place, seated where its check-in says.
 * Verbatim: close the gap on the source day, park at the end of the target day,
 * then seat it the way a fresh insert would be.
 */
export function reseatOwnStop(
  store: NightSeatStore,
  stop: { id: number; day_id: number; order_index: number },
  placeId: number,
  dayId: number,
  night: Night
): void {
  store.closeOrderGap(stop.day_id, stop.order_index);
  const max = store.maxOrderIndex(dayId, stop.id);
  const end = (max !== null ? max : -1) + 1;
  store.moveStop(stop.id, dayId, placeId, end);

  const seat = seatIndex(store, dayId, night, stop.id);
  if (seat < end) {
    store.bumpOrderIndexes(dayId, seat, stop.id);
    store.moveStop(stop.id, dayId, placeId, seat);
  }
}

/**
 * Keep every drawn road behind the stop it was drawn after, now that a write has
 * seated, moved or taken out a stop on this day. Verbatim from the server.
 * Returns what changed, or null when nothing did.
 */
export function carryVias(
  store: NightSeatStore,
  dayId: number,
  previousIds: number[],
  nextIds: number[]
): { moved: number; removed: number } | null {
  if (previousIds.length === nextIds.length && previousIds.every((id, i) => id === nextIds[i])) return null;
  const vias = store.listVias(dayId);
  if (!vias.length) return null;

  const previousLast = previousIds.length - 1;
  const nextLast = nextIds.length - 1;
  const lastStayed = previousLast >= 0 && previousIds[previousLast] === nextIds[nextLast];
  const remove: number[] = [];
  const moved: { id: number; after_order_index: number }[] = [];
  for (const via of vias) {
    const next =
      lastStayed && via.after_order_index === previousLast
        ? nextLast
        : legAfter(via.after_order_index, previousIds, nextIds);
    if (next === null) remove.push(via.id);
    else if (next !== via.after_order_index) moved.push({ id: via.id, after_order_index: next });
  }
  if (!remove.length && !moved.length) return null;

  for (const viaId of remove) store.deleteVia(viaId, dayId);
  for (const via of moved) {
    store.setViaLeg(via.id, dayId, via.after_order_index);
  }
  renumberMergedLegs(
    store,
    dayId,
    vias.filter((via) => !remove.includes(via.id)),
    moved
  );
  return { moved: moved.length, removed: remove.length };
}

/** The leg a via pinned behind the n-th stop of the old order is on in the new one. */
function legAfter(index: number, previousIds: number[], nextIds: number[]): number | null {
  if (index > previousIds.length - 1) return null;
  let at = index;
  while (at >= 0 && !nextIds.includes(previousIds[at])) at -= 1;
  if (at < 0) return null;
  const next = nextIds.indexOf(previousIds[at]);
  return next >= nextIds.length - 1 ? null : next;
}

/** Renumber merged legs the way RoadtripService.reanchor does. */
function renumberMergedLegs(
  store: NightSeatStore,
  dayId: number,
  kept: PinnedVia[],
  moved: { id: number; after_order_index: number }[]
): void {
  const landed = new Map(moved.map((via) => [via.id, via.after_order_index]));
  const byLeg = new Map<number, PinnedVia[]>();
  for (const via of kept) {
    const leg = landed.get(via.id) ?? via.after_order_index;
    byLeg.set(leg, [...(byLeg.get(leg) ?? []), via]);
  }
  for (const onLeg of byLeg.values()) {
    if (!onLeg.some((via) => landed.has(via.id))) continue;
    onLeg.sort((a, b) => a.after_order_index - b.after_order_index || a.sequence - b.sequence || a.id - b.id);
    onLeg.forEach((via, index) => {
      if (via.sequence !== index) store.setViaSequence(via.id, dayId, index);
    });
  }
}

// ── Stay mirror (accommodations.service.ts half), over StayMirrorStore ───────

/** Type the place as lodging, unless the traveller already typed it themselves. */
function stampLodging(store: StayMirrorStore, placeId: number): unknown | null {
  const stopType = store.placeStopType(placeId);
  if (stopType === undefined) return null; // unknown place — nothing to stamp
  if (stopType) return null;
  store.stampPlaceLodging(placeId);
  return store.getPlaceForMirror(placeId);
}

/** Each day's located stops in order, taken before a write that can move them. */
function stopOrders(store: StayMirrorStore, dayIds: number[]): Map<number, number[]> {
  return new Map([...new Set(dayIds)].map((dayId): [number, number[]] => [dayId, locatedStopIds(store, dayId)]));
}

/** Re-pin the drawn roads of the days whose stops changed, and report them on the mirror. */
function reanchorVias(store: StayMirrorStore, mirror: AccommodationMirror, before: Map<number, number[]>): void {
  for (const [dayId, previousIds] of before) {
    if (!carryVias(store, dayId, previousIds, locatedStopIds(store, dayId))) continue;
    noteVias(mirror, { dayId, vias: store.listDayVias(dayId) });
  }
}

/** One entry per day: a write that takes a stop off a day and puts one back on
 *  the same day reports the state it left behind, not both steps. */
function noteVias(mirror: AccommodationMirror, day: DayVias): void {
  mirror.vias = [...(mirror.vias ?? []).filter((known) => known.dayId !== day.dayId), day];
}

/**
 * Carry the booking's own stop to where the booking now is, in place.
 * Null when the target day already holds that place under a stop of its own.
 */
function relocateOwnStop(
  store: StayMirrorStore,
  stop: { id: number; day_id: number; order_index: number },
  placeId: number,
  dayId: number,
  night: Night
): MirroredAssignment | null {
  if (store.dayHasPlace(dayId, placeId, stop.id)) {
    return null;
  }
  reseatOwnStop(store, stop, placeId, dayId, night);
  return store.getStopForMirror(stop.id);
}

/**
 * Put the booking's check-in day on the map. Only the check-in day gets a stop.
 * (Server: AccommodationsService.mirrorStay.)
 */
function mirrorStay(
  store: StayMirrorStore,
  accommodationId: number,
  placeId: number | null,
  dayId: number,
  checkIn?: string | null
): AccommodationMirror {
  const mirror = noStayMirror();
  // A stay can outlive its place; the booking form writes stays that never had one.
  if (!placeId) return mirror;

  mirror.stamped = stampLodging(store, placeId);

  // The road-trip flow assigns the place to the day and only then books the night;
  // claiming that row would make cancelling the booking delete a stop the traveller
  // placed. Same answer for a place already planned for that day by hand.
  if (store.dayHasPlace(dayId, placeId)) return mirror;

  const before = stopOrders(store, [dayId]);
  mirror.created = store.getStopForMirror(
    store.insertOwnedStop(
      dayId,
      placeId,
      seatIndex(store, dayId, { id: accommodationId, check_in: checkIn }),
      accommodationId
    )
  );
  reanchorVias(store, mirror, before);
  return mirror;
}

/** The day stops this booking, and only this booking, put on the plan. */
function ownStops(store: StayMirrorStore, accommodationId: number) {
  return store.ownStops(accommodationId);
}

/**
 * Let go of the stops a booking owns, because the booking is going away.
 * `keepStop` hands them to the traveller instead of taking them away.
 * (Server: AccommodationsService.releaseStops.)
 */
function releaseStops(
  store: StayMirrorStore,
  accommodationId: number,
  opts: { keepStop?: boolean }
): AccommodationMirror {
  const mirror = noStayMirror();
  const own = ownStops(store, accommodationId);
  const before = stopOrders(
    store,
    own.map((stop) => stop.day_id)
  );
  for (const stop of own) {
    if (opts.keepStop) {
      store.releaseStop(stop.id);
      const released = store.getStopForMirror(stop.id);
      if (released) mirror.updated.push(released);
      continue;
    }
    store.deleteStop(stop.id);
    mirror.removed.push({ id: stop.id, dayId: stop.day_id });
  }
  reanchorVias(store, mirror, before);
  return mirror;
}

/**
 * Carry the mirrored stop over to wherever the booking now is.
 * (Server: AccommodationsService.remirrorStay.)
 */
function remirrorStay(
  store: StayMirrorStore,
  accommodationId: number,
  placeId: number | null,
  dayId: number,
  checkIn?: string | null,
  opts: { checkInChanged?: boolean } = {}
): AccommodationMirror {
  const own = ownStops(store, accommodationId);
  if (own.length === 0) return noStayMirror();
  const night: Night = { id: accommodationId, check_in: checkIn };
  if (own.length === 1 && own[0].day_id === dayId && own[0].place_id === placeId) {
    // Same place, same day. A stop already where a fresh seat would put it stays;
    // a check-in given a new hour seats the night afresh; any other edit leaves a
    // stop the clocks say is settled alone.
    const settled =
      seatIndex(store, dayId, night, own[0].id) === own[0].order_index ||
      (!opts.checkInChanged && seatHolds(store.dayStops(dayId), own[0].id, checkIn));
    if (settled) return noStayMirror();
  }

  const mirror = noStayMirror();

  // One stop is the ordinary case, and it can be carried across rather than rebuilt.
  if (own.length === 1 && placeId) {
    const before = stopOrders(store, [own[0].day_id, dayId]);
    const moved = relocateOwnStop(store, own[0], placeId, dayId, night);
    if (moved) {
      mirror.moved = { assignment: moved, oldDayId: own[0].day_id };
      mirror.stamped = stampLodging(store, placeId);
      reanchorVias(store, mirror, before);
      return mirror;
    }
  }

  const beforeRebuild = stopOrders(
    store,
    own.map((stop) => stop.day_id)
  );
  for (const stop of own) {
    store.deleteStop(stop.id);
    mirror.removed.push({ id: stop.id, dayId: stop.day_id });
  }
  reanchorVias(store, mirror, beforeRebuild);
  const fresh = mirrorStay(store, accommodationId, placeId, dayId, checkIn);
  mirror.created = fresh.created;
  mirror.stamped = fresh.stamped;
  for (const day of fresh.vias ?? []) noteVias(mirror, day);
  return mirror;
}

// ── The port's public mirror surface (attachStayStop / moveStayStop / dropStayStops) ──

/** Put a freshly written stay on the map. */
export function attachStayStop(
  store: StayMirrorStore,
  accommodationId: number,
  placeId: number | null,
  dayId: number,
  checkIn?: string | null
): AccommodationMirror {
  return mirrorStay(store, accommodationId, placeId, dayId, checkIn);
}

/** Carry a stay's own stop over to where the stay now is. `checkInChanged` says the
 *  booking was given a new hour, which seats the night afresh (see remirrorStay). */
export function moveStayStop(
  store: StayMirrorStore,
  accommodationId: number,
  placeId: number | null,
  dayId: number,
  checkIn?: string | null,
  opts: { checkInChanged?: boolean } = {}
): AccommodationMirror {
  return remirrorStay(store, accommodationId, placeId, dayId, checkIn, opts);
}

/** Take back the stops of a stay that is being deleted elsewhere. */
export function dropStayStops(
  store: StayMirrorStore,
  accommodationId: number,
  opts: { keepStop?: boolean } = {}
): AccommodationMirror {
  return releaseStops(store, accommodationId, opts);
}

/** Days whose stop order a mirror can have changed, each named once (the server's
 *  touchedDays — used by whoever broadcasts the mirror's events). */
export function mirrorTouchedDays(mirror: AccommodationMirror): number[] {
  const days = new Set<number>();
  for (const created of [mirror.created, ...mirror.createdExtra]) {
    if (created) days.add(created.day_id);
  }
  for (const moved of [mirror.moved, ...mirror.movedExtra]) {
    if (moved) {
      days.add(moved.assignment.day_id);
      days.add(moved.oldDayId);
    }
  }
  for (const stop of mirror.removed) days.add(stop.dayId);
  return [...days];
}

// ── The multi-night mirror (PanelMint) — the same rules, run per night ─────────

/**
 * Put a stay on the map for every night it covers. `dayIds` are the seat days
 * in trip order (the caller decides what "the stay's nights" means). The rules
 * are mirrorStay's, per day: the first write stamps the place as lodging, a
 * night day already holding the place keeps the traveller's stop, and each
 * seated night is measured by the same check-in.
 */
export function attachStayNights(
  store: StayMirrorStore,
  accommodationId: number,
  placeId: number | null,
  dayIds: number[],
  checkIn?: string | null
): AccommodationMirror {
  const mirror = noStayMirror();
  if (!placeId) return mirror;

  mirror.stamped = stampLodging(store, placeId);

  const before = stopOrders(store, dayIds);
  const night: Night = { id: accommodationId, check_in: checkIn };
  const created: MirroredAssignment[] = [];
  for (const dayId of dayIds) {
    if (store.dayHasPlace(dayId, placeId)) continue;
    const stop = store.getStopForMirror(
      store.insertOwnedStop(dayId, placeId, seatIndex(store, dayId, night), accommodationId)
    );
    if (stop) created.push(stop);
  }
  mirror.created = created[0] ?? null;
  mirror.createdExtra = created.slice(1);
  reanchorVias(store, mirror, before);
  return mirror;
}

/**
 * Re-seat a stay whose nights changed. Every own stop on a night still covered
 * keeps its row (a re-seat or a new place only edits it); own stops on nights
 * the stay no longer covers are carried onto newly covered nights — keeping
 * the row's notes, hour, participants and id — and whatever remains is taken
 * back. Nights the traveller's own stop already holds are never claimed.
 */
export function moveStayNights(
  store: StayMirrorStore,
  accommodationId: number,
  placeId: number | null,
  dayIds: number[],
  checkIn?: string | null,
  opts: { checkInChanged?: boolean } = {}
): AccommodationMirror {
  const mirror = noStayMirror();
  const own = ownStops(store, accommodationId);
  const seatDays = new Set(dayIds);
  const night: Night = { id: accommodationId, check_in: checkIn };
  const touchedDays = [...new Set([...dayIds, ...own.map((stop) => stop.day_id)])];
  const before = stopOrders(store, touchedDays);

  const noteMoved = (moved: { assignment: MirroredAssignment; oldDayId: number }) => {
    if (mirror.moved) mirror.movedExtra.push(moved);
    else mirror.moved = moved;
  };

  // Stops on nights the stay still covers stay put, with remirrorStay's own
  // rules per stop: a new check-in hour seats the night afresh, a new place is
  // carried over unconditionally, and anything else the clocks call settled
  // stays. A kept day that already holds the new place under another stop
  // takes the duplicate back instead. Stops on dropped nights — and every own
  // stop when the place itself was cleared — become surplus rows.
  const surplus: { id: number; day_id: number; order_index: number }[] = [];
  for (const stop of own) {
    if (!placeId || !seatDays.has(stop.day_id)) {
      surplus.push(stop);
      continue;
    }
    if (stop.place_id !== placeId && store.dayHasPlace(stop.day_id, placeId, stop.id)) {
      store.deleteStop(stop.id);
      mirror.removed.push({ id: stop.id, dayId: stop.day_id });
      continue;
    }
    const settled =
      stop.place_id === placeId &&
      (seatIndex(store, stop.day_id, night, stop.id) === stop.order_index ||
        (!opts.checkInChanged && seatHolds(store.dayStops(stop.day_id), stop.id, checkIn)));
    if (settled) continue;
    reseatOwnStop(store, stop, placeId, stop.day_id, night);
    const seated = store.getStopForMirror(stop.id);
    if (seated) noteMoved({ assignment: seated, oldDayId: stop.day_id });
  }

  // Nights without a stop of this booking's own. A day already holding the
  // place under another stop keeps the traveller's — no seat, and the surplus
  // row that might have moved here falls through to removal.
  const keptDays = new Set(own.filter((stop) => seatDays.has(stop.day_id)).map((stop) => stop.day_id));
  const needed = !placeId ? [] : dayIds.filter((dayId) => !keptDays.has(dayId) && !store.dayHasPlace(dayId, placeId));

  // Carry surplus rows onto newly covered nights — same row, new home.
  let row = 0;
  const created: MirroredAssignment[] = [];
  for (const dayId of needed) {
    const stop = surplus[row];
    if (stop) {
      row += 1;
      reseatOwnStop(store, stop, placeId!, dayId, night);
      const moved = store.getStopForMirror(stop.id);
      if (moved) noteMoved({ assignment: moved, oldDayId: stop.day_id });
      continue;
    }
    const seat = store.getStopForMirror(
      store.insertOwnedStop(dayId, placeId!, seatIndex(store, dayId, night), accommodationId)
    );
    if (seat) created.push(seat);
  }
  for (; row < surplus.length; row += 1) {
    const stop = surplus[row];
    store.deleteStop(stop.id);
    mirror.removed.push({ id: stop.id, dayId: stop.day_id });
  }

  mirror.created = created[0] ?? null;
  mirror.createdExtra = created.slice(1);
  // The stamp ran wherever the server stamped: remirrorStay's relocate and
  // rebuild paths both type the place once the day plan changed — including a
  // write whose only outcome is taking back a duplicated own stop (the rebuild
  // path stamps inside mirrorStay, before its dayHasPlace return). A fully
  // settled edit never reaches those paths, and stamps nothing either.
  if (
    placeId &&
    (created.length > 0 || mirror.moved || mirror.movedExtra.length > 0 || mirror.removed.length > 0)
  ) {
    mirror.stamped = stampLodging(store, placeId);
  }
  reanchorVias(store, mirror, before);
  return mirror;
}
