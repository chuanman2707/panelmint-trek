/**
 * Port of server/src/db/seeds.ts — the category rows only.
 *
 * The row data is verbatim ({name, color, icon}), seeded only when the table is
 * empty. Everything else that file seeded — addons, photo providers, document
 * providers, the admin-account bootstrap decision — described surfaces that do
 * not exist in the client-only build, so it went with them. What the server
 * used to upsert locally is now simply what `db/bootstrap.ts` inserts on first
 * run.
 */
// ── Row data, verbatim ────────────────────────────────────────────────────────

export interface SeedCategory {
  name: string;
  color: string;
  icon: string;
}

export const SEED_CATEGORIES: SeedCategory[] = [
  { name: 'Hotel', color: '#3b82f6', icon: '🏨' },
  { name: 'Restaurant', color: '#ef4444', icon: '🍽️' },
  { name: 'Attraction', color: '#8b5cf6', icon: '🏛️' },
  { name: 'Shopping', color: '#f59e0b', icon: '🛍️' },
  { name: 'Transport', color: '#6b7280', icon: '🚌' },
  { name: 'Activity', color: '#10b981', icon: '🎯' },
  { name: 'Bar/Cafe', color: '#f97316', icon: '☕' },
  { name: 'Beach', color: '#06b6d4', icon: '🏖️' },
  { name: 'Nature', color: '#84cc16', icon: '🌿' },
  { name: 'Other', color: '#6366f1', icon: '📍' },
];

