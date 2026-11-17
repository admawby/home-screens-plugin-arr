// Day bucketing and labels on the household's clock (the host timezone), not
// the display device's. Uses Intl only, so it works on any kiosk browser.

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD of an instant in `tz`. */
export function dayKey(ms: number, tz: string): string {
  let f = keyFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    keyFormatters.set(tz, f);
  }
  return f.format(ms);
}

/** Whole days from `fromKey` to `toKey` (both YYYY-MM-DD). */
export function dayDiff(fromKey: string, toKey: string): number {
  const a = Date.UTC(+fromKey.slice(0, 4), +fromKey.slice(5, 7) - 1, +fromKey.slice(8, 10));
  const b = Date.UTC(+toKey.slice(0, 4), +toKey.slice(5, 7) - 1, +toKey.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** Add `n` days to a YYYY-MM-DD key. */
export function addDays(key: string, n: number): string {
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

/** The date part of an *arr date-only value ("2026-11-17T00:00:00Z" → "2026-11-17").
 *  Radarr and Lidarr store release days as midnight UTC; converting those to a
 *  western timezone would move every release to the previous evening. */
export function dateOnlyOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 10) return undefined;
  const k = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : undefined;
}

export function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/** "Today", "Tomorrow", "Yesterday", or "Wed, Nov 19". */
export function dayLabel(key: string, todayKey: string, locale?: string): string {
  const diff = dayDiff(todayKey, key);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10), 12));
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** Short day label for poster cards: "Today", "Tue", or "Nov 30" beyond a week. */
export function shortDayLabel(key: string, todayKey: string, locale?: string): string {
  const diff = dayDiff(todayKey, key);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10), 12));
  const opts: Intl.DateTimeFormatOptions =
    Math.abs(diff) < 7 ? { timeZone: 'UTC', weekday: 'short' } : { timeZone: 'UTC', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

export function timeLabel(ms: number, tz: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ms);
}

/** "5m ago", "3h ago", "2d ago". */
export function agoLabel(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
