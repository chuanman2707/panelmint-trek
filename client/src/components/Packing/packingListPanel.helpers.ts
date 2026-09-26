import { KAT_COLORS } from './packingListPanel.constants'

// Stable color assignment: category name → index via simple hash
export function katColor(kat: string, allCategories?: string[]): string {
  const idx = allCategories ? allCategories.indexOf(kat) : -1
  if (idx >= 0) return KAT_COLORS[idx % KAT_COLORS.length]
  // Fallback: hash-based
  let h = 0
  for (let i = 0; i < kat.length; i++) h = ((h << 5) - h + (kat.codePointAt(i) ?? 0)) | 0
  return KAT_COLORS[Math.abs(h) % KAT_COLORS.length]
}

/** Weight an item contributes to a total: unit weight times quantity (defaults: 0 g, qty 1). */
export const itemWeight = (i: { weight_grams?: number | null; quantity?: number | null }): number =>
  (i.weight_grams || 0) * (i.quantity || 1)

/**
 * Whether an item's weight is part of what *you* carry. An item shared through the
 * "Shared with…" tier stays visible to its recipients, but the owner is the one bringing
 * it — counting it for everyone it was shared with inflated their bags (#1767).
 * Common items are the group pool and always count; so does anything unowned (legacy
 * rows) and everything, if we don't know who is looking.
 */
export const countsTowardsMyLoad = (
  i: { is_private?: number | boolean | null; owner_id?: number | null },
  currentUserId?: number | null,
): boolean => {
  if (currentUserId == null) return true
  if (!i.is_private) return true
  return i.owner_id == null || i.owner_id === currentUserId
}

/**
 * What a bag weighs, as shown (#2191).
 *
 * The adapter sums every member's items — including the private ones this viewer
 * may not see — and sends the figure on the bag itself. Adding it up locally
 * could only ever produce the part of the bag the viewer is allowed to look at,
 * which is the wrong number to measure against an airline's weight limit.
 *
 * The local sum is the fallback for a bag that reaches the surface without the
 * field (e.g. a row built before #2191). Note the explicit null check rather
 * than `??` on a falsy value: an empty bag legitimately weighs 0 and must not
 * fall through to the local sum.
 */
export const bagTotalWeight = (
  bag: { total_weight_grams?: number | null },
  visibleItems: { weight_grams?: number | null; quantity?: number | null }[],
): number =>
  bag.total_weight_grams != null
    ? bag.total_weight_grams
    : visibleItems.reduce((sum, i) => sum + itemWeight(i), 0)

/** The same rule for the pile that is in no bag (#2191). */
export const unassignedTotalWeight = (
  total: number | null | undefined,
  visibleItems: { weight_grams?: number | null; quantity?: number | null }[],
): number =>
  total != null
    ? total
    : visibleItems.reduce((sum, i) => sum + itemWeight(i), 0)

/**
 * How full a bag's bar reads. A bag with a weight limit is measured against that limit —
 * that is the number an airline cares about. Without one there is nothing absolute to
 * measure against, so bags are shown relative to the heaviest one and stay comparable.
 * Lives here because three surfaces draw this bar and one of them used to forget the limit.
 */
export const bagFillPct = (bagWeight: number, limitGrams: number | null | undefined, heaviestBagWeight: number): number =>
  Math.min(100, Math.round((bagWeight / (limitGrams || Math.max(heaviestBagWeight, 1))) * 100))
