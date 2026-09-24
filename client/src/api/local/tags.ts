/**
 * `tagsApi` — the local implementation. Same method list and envelopes as the
 * axios version in api/client.ts (`list` → `{tags}`, `create`/`update` →
 * `{tag}`, `delete` → `{success: true}`), over `db.tags` scoped to the local
 * self user.
 *
 * Server parity notes (server/src/nest/tags/ + services/tagService.ts):
 *  - Every route was scoped to the caller's own tags (`WHERE user_id = ?`) —
 *    locally that is the seeded self profile, SELF_ID.
 *  - `list` ordered `ORDER BY name ASC` — SQLite's BINARY collation, so the
 *    comparison here is code-point `<`/`>`, not a locale-aware sort.
 *  - `create` deliberately bypassed the shared zod schema (TagCreateDto holds
 *    `z.unknown()` fields — the comment in tags.dto.ts): a falsy `name`
 *    answers 400 `{error: 'Tag name is required'}` and `color` falls back to
 *    '#10b981' via `color || default`. Non-string truthy values were bound
 *    into a TEXT column — SQLite's type affinity coerced them, mirrored here
 *    by String() so the stored wire value is text.
 *  - `update`/`delete` verified ownership first (`getByIdAndUser`); an unknown
 *    or foreign id answers 404 `{error: 'Tag not found'}` — locally that is
 *    "no tags row with this id AND user_id === SELF_ID". A non-numeric id
 *    string bound NULL-side on the server (matched nothing → 404); `numId`'s
 *    NaN is the local equivalent.
 *  - `update` COALESCEs: `name || null` / `color || null` — a falsy field
 *    keeps the stored value verbatim.
 *  - `create` answered 201 on the wire; the response BODY (`{tag}`) is the
 *    surface callers consume, so no status rides along locally.
 */
import type { Tag } from '../../types';
import { badRequest, detached, detachedList, notFound, nowIso, numId } from './helpers';
import { SELF_ID, withStore } from './dexieStore';

/** The legacy route bound whatever arrived into a TEXT column — numbers came
 *  back as their text form via column affinity. */
function toText(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

export const tagsApi = {
  list: (): Promise<{ tags: Tag[] }> =>
    withStore((store) => {
      const tags = [...store.tagRows().values()]
        .filter((t) => t.user_id === SELF_ID)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { tags: detachedList(tags) };
    }),

  create: (data: { name?: unknown; color?: unknown }): Promise<{ tag: Tag }> =>
    withStore((store) => {
      const { name, color } = (data ?? {}) as { name?: unknown; color?: unknown };
      if (!name) throw badRequest('Tag name is required');
      const tag: Tag = {
        id: store.allocId('tags'),
        user_id: SELF_ID,
        name: toText(name),
        color: color ? toText(color) : '#10b981',
        created_at: nowIso(),
      };
      store.put('tags', tag);
      return { tag: detached(tag) };
    }),

  update: (id: number | string, data: { name?: unknown; color?: unknown }): Promise<{ tag: Tag }> =>
    withStore((store) => {
      const tid = numId(id);
      const existing = Number.isFinite(tid) ? store.tagRows().get(tid) : undefined;
      if (!existing || existing.user_id !== SELF_ID) throw notFound('Tag');
      const { name, color } = (data ?? {}) as { name?: unknown; color?: unknown };
      const tag: Tag = {
        ...existing,
        name: name ? toText(name) : existing.name,
        color: color ? toText(color) : existing.color,
      };
      store.put('tags', tag);
      return { tag: detached(tag) };
    }),

  delete: (id: number | string): Promise<{ success: true }> =>
    withStore((store) => {
      const tid = numId(id);
      const existing = Number.isFinite(tid) ? store.tagRows().get(tid) : undefined;
      if (!existing || existing.user_id !== SELF_ID) throw notFound('Tag');
      store.delete('tags', tid);
      return { success: true as const };
    }),
};
