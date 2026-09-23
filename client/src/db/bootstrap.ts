// First-run bootstrap for the `panelmint` database — the system of record.
//
// Seeds the rows the hosted app got from the server: the local self profile
// (localUsers id 1, the roster entry every member/traveler/payer picker means
// by "me"), the category palette, and the settings defaults — exactly once,
// behind a settings flag. Also where devices that ran hosted TREK get their
// legacy IndexedDB caches cleaned up.
import Dexie from 'dexie'
import { db } from './panelmintDb'
import { SEED_CATEGORIES } from '../api/local/ported/seeds'
// The leaf module, not the store: importing settingsStore would drag the API
// client and the legacy per-user offline cache into the boot path.
import { DEFAULT_SETTINGS } from '../store/settingsDefaults'
import type { Category, LocalUser } from '../types'

// Re-exported so callers get bootstrap + allocation from one module.
export { nextId } from '../api/local/ids'

/** settings row marking a completed bootstrap — the idempotency flag. */
const BOOTSTRAP_FLAG = '__bootstrapped'

/** The seeded self profile is always localUsers row 1. */
export const SELF_ID = 1

/**
 * The hosted TREK anonymous offline cache — the only legacy database with a
 * fixed name. The per-account `trek-offline-u<id>` databases cannot be
 * enumerated without indexedDB.databases() (unreliable on Firefox/Safari), so
 * they orphan harmlessly and are left alone.
 */
const LEGACY_DB_NAME = 'trek-offline'

/**
 * SEED_CATEGORIES carries the verbatim server rows ({name, color, icon}); the
 * table wants the full Category shape — instance-wide categories get
 * `user_id: null`, same as the server seeded them.
 */
function categorySeeds(): Category[] {
  const now = new Date().toISOString()
  return SEED_CATEGORIES.map((c, i) => ({
    id: i + 1,
    name: c.name,
    color: c.color,
    icon: c.icon,
    user_id: null,
    created_at: now,
  }))
}

/**
 * Idempotent: returns early on the `__bootstrapped` flag, which is written in
 * the same transaction as the seeds — a crash mid-seed reruns the whole thing
 * rather than stranding a half-seeded database behind the flag.
 *
 * The flag check lives INSIDE the transaction on purpose: IndexedDB
 * serialises `rw` transactions across tabs, so two tabs racing a first launch
 * cannot both pass the check. The count guards make even that impossible case
 * harmless — seeds go in only when the table is empty.
 */
export async function bootstrapLocalData(): Promise<void> {
  // Fire-and-forget: while another tab holds the legacy DB open, the
  // deleteDatabase request queues behind it (onblocked) and the returned
  // promise stays pending — Dexie never rejects it — so awaiting here could
  // hang bootstrap on exactly the devices this cleanup targets. Failure is
  // equally fine: the orphaned bytes are inert and the next boot retries.
  void Dexie.delete(LEGACY_DB_NAME).catch(() => {})

  await db.transaction('rw', [db.localUsers, db.categories, db.settings], async () => {
    if (await db.settings.get(BOOTSTRAP_FLAG)) return

    if ((await db.localUsers.count()) === 0) {
      await db.localUsers.put({ id: SELF_ID, name: 'Me', is_self: 1 })
    }
    if ((await db.categories.count()) === 0) {
      await db.categories.bulkPut(categorySeeds())
    }
    // DEFAULT_SETTINGS is already the effective fresh-install value set — a
    // flat key/value seed needs nothing filtered out.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await db.settings.put({ key, value })
    }
    await db.settings.put({ key: BOOTSTRAP_FLAG, value: true })
  })
}

/**
 * The local self profile. Bootstraps on demand so callers never have to
 * sequence against startup; throws only if seeding genuinely failed.
 */
export async function getSelf(): Promise<LocalUser> {
  let self = await db.localUsers.get(SELF_ID)
  if (!self) {
    await bootstrapLocalData()
    self = await db.localUsers.get(SELF_ID)
  }
  if (!self) throw new Error('self profile missing after bootstrap')
  return self
}
