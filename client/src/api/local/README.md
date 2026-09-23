# `api/local/` — local implementations of the TREK API

There is no server. Every domain object `api/client.ts` exports (`tripsApi`,
`daysApi`, …) is being replaced, one domain at a time, by a module here that
produces the same surface over `db` (`src/db/panelmintDb.ts` — the system of
record) instead of axios over HTTP.

## Layout

- `ported/` — server logic lifted verbatim-then-adapted before `server/` was
  deleted. Pure functions over named persistence seams (`*Store` interfaces):
  `DayOpsStore`, `AssignmentTimeStore`, `NightSeatStore`,
  `ReservationCascadeStore`, `SettlementStore`, `AirportBackfillStore`,
  `LocalSeedStore`. Ports never touch Dexie directly; the domain adapter
  implements the seam over `db`.
- `helpers.ts` — `nowIso`, `numId`, `requireRow`, `detached`/`detachedList`,
  `LocalApiError`/`apiError`/`notFound`/`badRequest`. Read that file first.
- `ids.ts` — `nextId(table)` surrogate-id allocation.
- `<domain>.ts` — one module per domain object, landing per plan task.
- `index.ts` — the barrel (below).

## Barrel strategy

`~270` call sites import from `api/client.ts`. We do not move them:

1. A domain's local adapter lands as `api/local/<domain>.ts` exporting the
   same object name (`export const tripsApi = { … }`) with **name-for-name,
   signature-identical** methods — read the axios version first and copy the
   method list exactly.
2. `api/local/index.ts` gains one line: `export { tripsApi } from './trips'`.
3. In `client.ts` the domain's axios object is deleted and replaced by
   `export { tripsApi } from './local'` — the import surface never changes.
4. When every kept domain is swapped, `client.ts` ends as
   `export * from './local'` plus whatever stays genuinely HTTP-less; the
   axios instance itself is deleted in the last scaffold task (plan A9).

Dead domains (auth, admin, plugins, …) are deleted with their callers in
Phase B — they get no local module.

## The write-through rule

Every mutating adapter follows three rules:

**(a) Write inside a transaction.** Multi-row writes go through
`db.transaction('rw', [tables…], async () => { … })` — the seam's
`transaction()` composes inside it (Dexie transactions nest by rejoining the
ambient transaction). Allocate surrogate ids with `nextId(table)` **inside**
that transaction — IndexedDB serialises `rw` transactions across tabs, which
is what makes `nextId` collision-safe (see `ids.ts`).

**(b) Return the server's exact response shape — including side channels.**
The hosted server returned `{ assignment }` for `updateTime` while
broadcasting `assignment:reordered` + `roadtripVia:changed` separately;
locally the response carries everything: `{ assignment, reordered, vias }`
(the port's `AssignmentTimeUpdate` is already this shape). Callers that
dropped `.reordered` when it arrived via socket must not drop it now.

**(c) The caller replays side-channels through the store.** `api/local/*`
never imports the Zustand store — adapters stay below the repo layer: Dexie
in, response out. The caller (slice action, repo, or a store-level helper
like `applyStayStops`) folds each side-channel into the UI:

```ts
import { applyLocalEffect } from '../../store/localEffects'  // non-slice callers
import { emitLocalEvent } from '../websocket'                // outside-store events
// or inside a slice action: get().applyLocalEffect(...)

const res = await localAssignmentsApi.updateTime(tripId, id, times)
applyLocalEffect('assignment:updated', { assignment: res.assignment })
applyLocalEffect('assignment:reordered', res.reordered) // null → no-op
if (res.vias) emitLocalEvent({ type: 'roadtripVia:changed', ...res.vias })
```

`applyLocalEffect(type, payload)` (`store/localEffects.ts`, also a method on
the trip store) runs the event through `handleRemoteEvent` — the same
`STATE_APPLIERS` reducer + `DEXIE_WRITERS` write-through a socket frame used.
The Dexie write there is a redundant-but-idempotent re-persist of what the
adapter already committed; it exists so embedded views (a day row's
`assignments`/`notes_items`) settle from the post-update store state.

Two dispatch paths, one rule:

| Event's home | Replay through |
|---|---|
| `STATE_APPLIERS` / `DEXIE_WRITERS` (store appliers) | `applyLocalEffect(type, payload)` |
| `HANDLED_OUTSIDE_TRIP_STORE` (`api/wsEventPolicy.ts`) | `emitLocalEvent({ type, ...payload })` from `api/websocket.ts` — feeds the same listener registry the socket did (e.g. `roadtripVia:changed` → `useRoadtripVias`) |
| `IGNORED_WS_EVENTS` | nothing — it was already a no-op on the client |

Never call `emitLocalEvent` for a store-applied event: `handleRemoteEvent` is
itself a registered listener while the trip socket hook is mounted, so the
event would apply twice.

## Detached snapshots — the seam rule that bites

The server's `SELECT` returned fresh row objects; ported code scribbles on
them as bookkeeping (e.g. `resyncAccommodationDays` rewrites
`stay.start_day_id` mid-loop). A Dexie row handed out twice and mutated once
is a corrupt second read, so **every seam `list*`/`get*` implementation
returns detached snapshots**: `requireRow` already clones; wrap list reads in
`detachedList(rows)` (or project + clone). The in-memory test seam
(`tests/unit/local/helpers/memoryStore.ts`) does the same — keep them
semantically identical.

## Errors

Throw `LocalApiError` (axios-shaped: `.message`, `.status`,
`.response.status`, `.response.data.error`) so `getApiErrorMessage` and
`err.response?.status` consumers render it exactly like an HTTP error. Match
the server's status code and error **string** verbatim (`'Trip not found'`,
`'orderedIds must be a permutation of the trip day ids.'` — `DayReorderError`
ports to a 400 `LocalApiError` at the adapter boundary). `requireRow(table,
id, 'Trip')` covers the common 404. Validation parity matters: the same wrong
input must fail the same way.

## Identity, self, roster

- Self is `getSelf()` / `SELF_ID` from `src/db/bootstrap.ts` (localUsers row
  1). Adapters never read `useAuthStore` — the roster's "me" is that row.
- Request ids arrive as `number | string` (route-param convention); pass them
  through `numId()` before keying Dexie. `numId` can yield NaN — `requireRow`
  turns that into the same 404 the server's NULL-bound lookup produced; never
  feed it to `where().equals()`/`get()` bare (IndexedDB throws `DataError`).
- Junction rows (`packingBagMembers`, `tripMembers`, assignee/traveler/
  participant tables) keep their server column names and UNIQUE semantics —
  mirror the `delete`-then-insert / insert-or-ignore sequences the server
  used.

## Domain surface checklist (copied from `client.ts`, Task-4 scaffold)

Local impls must match these method lists name-for-name:

- `tripsApi`: `list, create, get, active, update, delete, uploadCover, searchCoverImages, archive, unarchive, getMembers, addMember, removeMember, transferOwnership, createGuest, renameGuest, deleteGuest, copy, bundle`
- `daysApi`: `list, create, update, updateTransport, delete, reorder`
- `placesApi`: `list, create, get, update, delete, searchImage, uploadImage, rate, importGpx, importMapFile, importGoogleList, importNaverList, bulkDelete, bulkUpdate`
- `assignmentsApi`: `list, create, delete, reorder, move, update, getParticipants, setParticipants, updateTime, updateNotes, updateTransport`
- `packingApi`: `list, create, bulkImport, update, delete, reorder, setSharing, clone, addContributor, removeContributor, getCategoryAssignees, setCategoryAssignees, listTemplates, applyTemplate, saveAsTemplate, setBagMembers, listBags, createBag, updateBag, deleteBag`
- `todoApi`: `list, create, update, delete, reorder, getCategoryAssignees, setCategoryAssignees`
- `tagsApi`: `list, create, update, delete`
- `categoriesApi`: `list, create, update, delete`
- `budgetApi`: `list, create, update, delete, setMembers, togglePaid, setPayers, perPersonSummary, settlement, createSettlement, updateSettlement, deleteSettlement, reorderItems, reorderCategories`
- `reservationsApi`: `list, upcoming, create, update, delete, setTravelers, updatePositions, importBookingPreview, importBookingConfirm, importBookingAsync, importJobStatus`
- `accommodationsApi`: `list, create, update, delete`
- `dayNotesApi`: `list, create, update, delete`
- `settingsApi`: `get, set, setBulk` (→ `db.settings` KV)

Whether a dead-on-arrival method (import pipelines, cover search) is ported or
deleted is each domain task's call — the checklist pins the *kept* surface.
