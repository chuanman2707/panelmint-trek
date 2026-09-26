import type { ShareBundle } from '../../share/codec';
import type { TranslationFn } from '../../types';

interface ImportPreviewProps {
  bundle: ShareBundle;
  t: TranslationFn;
  locale: string;
}

function formatDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, { dateStyle: 'medium' });
}

/**
 * Read-only summary of what the bundle carries — title, dates, the content
 * counts and the roster — so the user sees what they are saving before the
 * write. Zero-count groups drop out; the trip fields are rendered verbatim
 * (no joins, no edits).
 */
export default function ImportPreview({ bundle, t, locale }: ImportPreviewProps) {
  const { trip } = bundle;
  const stats: [number, string][] = [
    [bundle.days.length, 'import.stat.days'],
    [bundle.places.length, 'import.stat.places'],
    [bundle.reservations.length, 'import.stat.reservations'],
    [bundle.accommodations.length, 'import.stat.stays'],
    [bundle.packingItems.length, 'import.stat.packing'],
    [bundle.todoItems.length, 'import.stat.todos'],
    [bundle.budgetItems.length, 'import.stat.expenses'],
    [bundle.users.length, 'import.stat.people'],
  ];
  const visible = stats.filter(([n]) => n > 0);

  const start = formatDate(trip.start_date, locale);
  const end = formatDate(trip.end_date, locale);
  const names = bundle.users.map((u) => u.name).filter(Boolean);

  return (
    <div className="rounded-2xl border border-edge-faint bg-surface-card p-5">
      <h2 className="text-lg font-semibold text-content">{trip.title}</h2>
      {(start || end) && (
        <p className="mt-1 text-sm text-content-muted">
          {start ?? '…'} — {end ?? '…'}
        </p>
      )}
      {trip.description && (
        <p className="mt-3 whitespace-pre-line text-sm text-content-secondary">{trip.description}</p>
      )}
      {visible.length > 0 && (
        <dl className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
          {visible.map(([count, key]) => (
            <div key={key} className="flex items-baseline gap-1.5">
              <dt className="order-2 text-xs text-content-faint">{t(key)}</dt>
              <dd className="order-1 text-sm font-semibold text-content">{count}</dd>
            </div>
          ))}
        </dl>
      )}
      {names.length > 0 && (
        <p className="mt-4 border-t border-edge-faint pt-3 text-xs text-content-muted">
          <span className="font-medium text-content-secondary">{t('import.people')} </span>
          {names.join(' · ')}
        </p>
      )}
    </div>
  );
}
