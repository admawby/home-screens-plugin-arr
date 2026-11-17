import React from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle, scalePx } from './host-style';
import type { ArrConfig, Item, Source, SourceResult, Status, View } from './types';
import { PLUGIN_ID, SOURCE_LABEL, baseUrl, load, readSettings, type LoadResult } from './data';
import { formatBytes, formatTimeLeft, groupEpisodes, type SabSummary } from './normalize';
import { cachedPoster, loadPoster, posterRetryAt } from './images';
import { agoLabel, dayKey, dayLabel, shortDayLabel, timeLabel } from './time';
import { demoData } from './demo';

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULTS: ArrConfig = {
  view: 'upcoming',
  title: '',
  showHeader: true,
  sources: ['sonarr', 'radarr', 'lidarr', 'sabnzbd'],
  layout: 'auto',
  daysAhead: 7,
  daysBack: 0,
  recentDays: 14,
  maxItems: 20,
  showPosters: true,
  hideDownloaded: false,
  includeUnmonitored: false,
  showQueueState: true,
  groupEpisodes: true,
  radarrReleaseTypes: ['digital', 'physical'],
  requestFilter: 'all',
  refreshSeconds: 300,
  queueRefreshSeconds: 15,
  demo: false,
};

function num(v: unknown, d: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

export function readConfig(c: Record<string, unknown>): ArrConfig {
  const view = (['upcoming', 'recent', 'queue', 'requests'] as View[]).includes(c.view as View) ? (c.view as View) : DEFAULTS.view;
  const layout = c.layout === 'list' || c.layout === 'posters' ? c.layout : 'auto';
  return {
    view,
    title: typeof c.title === 'string' ? c.title : '',
    showHeader: c.showHeader !== false,
    sources: Array.isArray(c.sources) ? (c.sources as Source[]) : DEFAULTS.sources,
    layout,
    daysAhead: num(c.daysAhead, DEFAULTS.daysAhead, 1, 60),
    daysBack: num(c.daysBack, DEFAULTS.daysBack, 0, 14),
    recentDays: num(c.recentDays, DEFAULTS.recentDays, 1, 90),
    maxItems: num(c.maxItems, DEFAULTS.maxItems, 1, 100),
    showPosters: c.showPosters !== false,
    hideDownloaded: c.hideDownloaded === true,
    includeUnmonitored: c.includeUnmonitored === true,
    showQueueState: c.showQueueState !== false,
    groupEpisodes: c.groupEpisodes !== false,
    radarrReleaseTypes: Array.isArray(c.radarrReleaseTypes) ? (c.radarrReleaseTypes as string[]) : DEFAULTS.radarrReleaseTypes,
    requestFilter: typeof c.requestFilter === 'string' ? c.requestFilter : 'all',
    refreshSeconds: num(c.refreshSeconds, DEFAULTS.refreshSeconds, 30, 3600),
    queueRefreshSeconds: num(c.queueRefreshSeconds, DEFAULTS.queueRefreshSeconds, 3, 300),
    demo: c.demo === true,
  };
}

const VIEW_TITLE: Record<View, string> = {
  upcoming: 'Upcoming',
  recent: 'Recently added',
  queue: 'Downloads',
  requests: 'Requests',
};

// ─── Status presentation ─────────────────────────────────────────────────────

const STATUS: Record<Status, { label: string; color: string }> = {
  downloaded: { label: 'Downloaded', color: '#22c55e' },
  available: { label: 'Available', color: '#22c55e' },
  partial: { label: 'Partial', color: '#f59e0b' },
  missing: { label: 'Missing', color: '#ef4444' },
  failed: { label: 'Failed', color: '#ef4444' },
  declined: { label: 'Declined', color: '#ef4444' },
  warning: { label: 'Needs attention', color: '#f59e0b' },
  downloading: { label: 'Downloading', color: '#3b82f6' },
  importing: { label: 'Importing', color: '#8b5cf6' },
  approved: { label: 'Requested', color: '#3b82f6' },
  pending: { label: 'Needs approval', color: '#f59e0b' },
  queued: { label: 'Queued', color: '#94a3b8' },
  paused: { label: 'Paused', color: '#94a3b8' },
  upcoming: { label: 'Upcoming', color: '#94a3b8' },
};

function statusText(item: Item, tz: string, locale?: string): string {
  if (item.status === 'upcoming' && item.when !== undefined) return timeLabel(item.when, tz, locale);
  return STATUS[item.status].label;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** True when the element's content is taller than the element. */
function useOverflowing(ref: React.RefObject<HTMLElement | null>): boolean {
  const [over, setOver] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const v = el.scrollHeight > el.clientHeight + 1;
    if (v !== over) setOver(v);
  });
  return over;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

interface DataState {
  data?: LoadResult;
  error?: string;
  loading: boolean;
}

// One outage at a time for the whole plugin: report the first failure (with a
// stable `since`) and the recovery exactly once, as the SDK contract asks.
let unhealthySince: number | null = null;
function reportHealth(problem: string | null) {
  const report = window.__HS_SDK__?.reportProviderHealth;
  if (problem) {
    if (unhealthySince === null) unhealthySince = Date.now();
    report?.(PLUGIN_ID, { ok: false, message: problem, since: unhealthySince });
  } else if (unhealthySince !== null) {
    unhealthySince = null;
    report?.(PLUGIN_ID, { ok: true });
  }
}

function useArrData(config: ArrConfig, tz: string): DataState {
  const [state, setState] = React.useState<DataState>({ loading: true });
  const key = JSON.stringify(config);
  React.useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const intervalMs = (config.view === 'queue' ? config.queueRefreshSeconds : config.refreshSeconds) * 1000;
    const lastGood = new Map<Source, Item[]>();
    const run = async () => {
      let nextMs = intervalMs;
      try {
        const now = Date.now();
        const data = config.demo
          ? demoData(config.view, now, tz)
          : await load(config.view, { config, settings: readSettings(), tz, now });
        if (!alive) return;
        // A source that failed this round keeps showing what it had last time
        // (with its error in the footer) rather than vanishing from the wall.
        for (const r of data.results) {
          if (!r.error) { lastGood.set(r.source, r.items); continue; }
          const prev = lastGood.get(r.source);
          if (prev && r.items.length === 0) r.items = prev;
        }
        setState({ data, loading: false });
        if (data.results.some((r) => r.error && /rate limited/.test(r.error))) nextMs = 20_000;
        const failed = data.results.filter((r) => r.error);
        reportHealth(failed.length > 0 && failed.length === data.results.length ? failed[0].error! : null);
      } catch (err) {
        if (!alive) return;
        // Keep the last good data on screen; show why it isn't updating.
        setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
      }
      if (alive) timer = setTimeout(run, Math.min(nextMs, intervalMs));
    };
    run();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tz]);
  return state;
}

// ─── Building the visible list ───────────────────────────────────────────────

function sortAndTrim(config: ArrConfig, results: SourceResult[], tz: string): Item[] {
  let items = results.flatMap((r) => r.items);
  if (config.view === 'upcoming' && config.hideDownloaded) items = items.filter((i) => i.status !== 'downloaded');
  const dayOf = (i: Item) => i.dateOnly ?? (i.when !== undefined ? dayKey(i.when, tz) : '');
  if (config.view === 'upcoming') {
    // Day first, then time (date-only releases sort before timed episodes), then title.
    items.sort((a, b) => dayOf(a).localeCompare(dayOf(b)) || (a.when ?? 0) - (b.when ?? 0) || a.title.localeCompare(b.title));
  } else if (config.view === 'recent' || config.view === 'requests') {
    items.sort((a, b) => (b.when ?? 0) - (a.when ?? 0));
  } else {
    // Queue: active first, then by progress.
    const rank = (s: Status) => (s === 'downloading' ? 0 : s === 'importing' ? 1 : s === 'warning' || s === 'failed' ? 2 : 3);
    items.sort((a, b) => rank(a.status) - rank(b.status) || (b.progress ?? 0) - (a.progress ?? 0));
  }
  if (config.groupEpisodes && (config.view === 'upcoming' || config.view === 'recent')) items = groupEpisodes(items, dayOf);
  return items.slice(0, config.maxItems);
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

const SOURCE_ICON: Record<Source, string> = { sonarr: 'TV', radarr: 'Film', lidarr: 'Music', sabnzbd: 'NZB', seerr: 'Req' };

function Poster({ item, width, radius, square, compact, fit = 'cover' }: { item: Item; width: string; radius: string; square?: boolean; compact?: boolean; fit?: 'cover' | 'contain' }) {
  const [src, setSrc] = React.useState<string | null | undefined>(() => cachedPoster(item.poster));
  const [visible, setVisible] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const boxRef = React.useRef<HTMLDivElement>(null);
  // Only fetch posters that are actually on screen: list rows past the bottom
  // of the module are clipped, and every fetch counts against the hub's
  // per-plugin proxy budget shared by all displays.
  React.useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  React.useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    if (!item.poster) { setSrc(null); return; }
    if (!visible) return;
    const settle = (u: string | null) => {
      if (!alive) return;
      setSrc(u);
      const at = u ? undefined : posterRetryAt(item.poster);
      // A rate-limited poster gets another go shortly; a missing one much later.
      if (at && at - Date.now() < 5 * 60_000) retry = setTimeout(() => setAttempt((n) => n + 1), Math.max(1000, at - Date.now() + 250));
    };
    const c = cachedPoster(item.poster);
    if (c !== undefined) settle(c);
    else loadPoster(item.poster).then(settle);
    return () => { alive = false; if (retry) clearTimeout(retry); };
  }, [item.poster?.url, visible, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = hue(item.title);
  const box: React.CSSProperties = {
    width,
    aspectRatio: square ? '1 / 1' : '2 / 3',
    borderRadius: radius,
    overflow: 'hidden',
    flexShrink: 0,
    position: 'relative',
    background: `linear-gradient(160deg, hsl(${h} 35% 32%), hsl(${(h + 40) % 360} 35% 18%))`,
    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
  };
  return (
    <div ref={boxRef} style={box}>
      {src && fit === 'contain' ? (
        <>
          <img src={src} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(14px) brightness(0.55)', transform: 'scale(1.2)' }} />
          <img src={src} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
        </>
      ) : src ? (
        <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '8%', textAlign: 'center', color: 'rgba(255,255,255,0.85)' }}>
          {compact ? (
            <div style={{ fontSize: '1.1em', fontWeight: 700 }}>{item.title.trim().charAt(0).toUpperCase()}</div>
          ) : (
            <>
              <div style={{ fontSize: '0.55em', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.6 }}>{SOURCE_ICON[item.source]}</div>
              <div style={{ fontSize: '0.75em', fontWeight: 600, lineHeight: 1.15, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{item.title}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ item, tz, locale }: { item: Item; tz: string; locale?: string }) {
  const s = STATUS[item.status];
  const muted = item.status === 'upcoming' || item.status === 'queued' || item.status === 'paused';
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.35em',
      fontSize: '0.72em',
      fontWeight: 600,
      padding: '0.2em 0.6em',
      borderRadius: '999px',
      whiteSpace: 'nowrap',
      color: muted ? 'inherit' : s.color,
      background: muted ? 'rgba(255,255,255,0.08)' : `${s.color}22`,
      opacity: muted ? 0.8 : 1,
    }}>
      <span style={{ width: '0.55em', height: '0.55em', borderRadius: '50%', background: s.color, flexShrink: 0 }} />
      {statusText(item, tz, locale)}
    </span>
  );
}

function ProgressBar({ item }: { item: Item }) {
  const pct = Math.round((item.progress ?? 0) * 100);
  const color = STATUS[item.status].color;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6em', marginTop: '0.35em' }}>
      <div style={{ flex: 1, height: '0.45em', borderRadius: '999px', background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: '999px', background: color, transition: 'width 0.6s ease' }} />
      </div>
      <span style={{ fontSize: '0.72em', opacity: 0.75, fontVariantNumeric: 'tabular-nums', minWidth: '2.8em', textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

const ellipsis: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function Row({ item, config, tz, locale, now }: { item: Item; config: ArrConfig; tz: string; locale?: string; now: number }) {
  const isQueue = config.view === 'queue';
  const right = config.view === 'recent' || config.view === 'requests'
    ? (item.when !== undefined ? agoLabel(item.when, now) : '')
    : isQueue
      ? [formatTimeLeft(item.timeLeft), item.sizeLeft ? `${formatBytes(item.sizeLeft)} left` : ''].filter(Boolean).join(' · ')
      : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75em', padding: '0.35em 0' }}>
      {config.showPosters && <Poster item={item} width={scalePx(isQueue ? 34 : 40)} radius="0.3em" square={item.source === 'lidarr'} compact />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5em' }}>
          <span style={{ ...ellipsis, fontWeight: 600, fontSize: '0.98em', flexShrink: 1, minWidth: 0 }}>{item.title}</span>
          {item.badge && <span style={{ fontSize: '0.68em', opacity: 0.55, whiteSpace: 'nowrap', flexShrink: 0 }}>{item.badge}</span>}
        </div>
        {item.subtitle && <div style={{ ...ellipsis, fontSize: '0.8em', opacity: 0.7, marginTop: '0.1em' }}>{item.subtitle}</div>}
        {isQueue && <ProgressBar item={item} />}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25em', flexShrink: 0 }}>
        <Chip item={item} tz={tz} locale={locale} />
        {right && <span style={{ fontSize: '0.7em', opacity: 0.6, whiteSpace: 'nowrap' }}>{right}</span>}
      </div>
    </div>
  );
}

function ListView({ items, config, tz, locale, now }: { items: Item[]; config: ArrConfig; tz: string; locale?: string; now: number }) {
  const grouped = config.view === 'upcoming' || config.view === 'recent';
  const todayKey = dayKey(now, tz);
  const blocks: Array<{ label?: string; items: Item[] }> = [];
  for (const it of items) {
    const k = it.dateOnly ?? (it.when !== undefined ? dayKey(it.when, tz) : '');
    const label = grouped && k ? dayLabel(k, todayKey, locale) : undefined;
    const last = blocks[blocks.length - 1];
    if (last && last.label === label) last.items.push(it);
    else blocks.push({ label, items: [it] });
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {blocks.map((b, i) => (
        <div key={`${b.label ?? ''}-${i}`} style={{ marginTop: i === 0 ? 0 : '0.5em' }}>
          {b.label && (
            <div style={{ fontSize: '0.72em', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.55, padding: '0.2em 0', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: '0.15em' }}>
              {b.label}
            </div>
          )}
          {b.items.map((it) => <Row key={it.key} item={it} config={config} tz={tz} locale={locale} now={now} />)}
        </div>
      ))}
    </div>
  );
}

function PosterView({ items, config, tz, locale, now, width, height, fontSize }: {
  items: Item[]; config: ArrConfig; tz: string; locale?: string; now: number; width: number; height: number; fontSize: number;
}) {
  const gap = fontSize * 0.75;
  const textH = fontSize * 2.75;
  const minCard = fontSize * 4.5;
  const maxCard = fontSize * 8;
  // Pick the largest card size that still fits every item (whole cards only,
  // no half-cut rows). If nothing fits them all, show as many as possible.
  let best = { cols: 1, rows: 1, cardW: Math.max(minCard, (height - textH) / 1.5), cap: 1 };
  for (let r = 1; r <= 8; r++) {
    const byHeight = ((height + gap) / r - gap - textH) / 1.5;
    if (byHeight < minCard) break;
    const c = Math.max(1, Math.floor((width + gap) / (Math.min(byHeight, maxCard) + gap)));
    const cardW = Math.min(byHeight, maxCard, (width - gap * (c - 1)) / c);
    const cap = c * r;
    if (cap > best.cap || (best.cap < items.length && cap >= items.length)) best = { cols: c, rows: r, cardW, cap };
    if (cap >= items.length) { best = { cols: c, rows: r, cardW, cap }; break; }
  }
  const { cols, rows, cardW } = best;
  const visible = items.slice(0, cols * rows);
  const todayKey = dayKey(now, tz);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${cardW}px)`, gap: `${gap}px`, justifyContent: 'space-between' }}>
      {visible.map((it) => {
        const k = it.dateOnly ?? (it.when !== undefined ? dayKey(it.when, tz) : '');
        const caption = config.view === 'upcoming'
          ? [k ? shortDayLabel(k, todayKey, locale) : '', it.when !== undefined && it.status === 'upcoming' ? timeLabel(it.when, tz, locale) : ''].filter(Boolean).join(' · ')
          : it.when !== undefined ? agoLabel(it.when, now) : '';
        const s = STATUS[it.status];
        // Everything in "Recently added" is downloaded; a ribbon on every card is noise.
        const showRibbon = it.status !== 'upcoming' && config.view !== 'recent';
        return (
          <div key={it.key} style={{ minWidth: 0 }}>
            <div style={{ position: 'relative' }}>
              <Poster item={it} width="100%" radius="0.45em" fit={it.source === 'lidarr' ? 'contain' : 'cover'} />
              {showRibbon && (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '0.25em 0.4em', fontSize: '0.66em', fontWeight: 700, color: '#fff', background: `linear-gradient(0deg, ${s.color}ee, ${s.color}aa)`, borderRadius: '0 0 0.45em 0.45em', textAlign: 'center', ...ellipsis }}>
                  {STATUS[it.status].label}
                </div>
              )}
              {it.progress !== undefined && (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '0.35em', background: 'rgba(0,0,0,0.5)' }}>
                  <div style={{ width: `${Math.round(it.progress * 100)}%`, height: '100%', background: s.color }} />
                </div>
              )}
            </div>
            <div style={{ ...ellipsis, fontSize: '0.8em', fontWeight: 600, marginTop: '0.35em' }}>{it.title}</div>
            <div style={{ ...ellipsis, fontSize: '0.68em', opacity: 0.65 }}>
              {caption}{caption && it.subtitle ? ' · ' : ''}{it.subtitle && config.view !== 'requests' ? it.subtitle : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function headerSummary(config: ArrConfig, items: Item[], sab?: SabSummary): string {
  if (config.view === 'queue') {
    const parts = [`${items.length} in queue`];
    if (sab?.paused) parts.push('paused');
    else if (sab?.speed) parts.push(sab.speed);
    if (sab?.timeLeft) parts.push(formatTimeLeft(sab.timeLeft) ?? '');
    return parts.filter(Boolean).join(' · ');
  }
  if (config.view === 'upcoming') {
    const missing = items.filter((i) => i.status === 'missing').length;
    return missing ? `${items.length} · ${missing} missing` : String(items.length);
  }
  if (config.view === 'requests') {
    const pending = items.filter((i) => i.status === 'pending').length;
    return pending ? `${pending} need approval` : String(items.length);
  }
  return String(items.length);
}

function emptyText(config: ArrConfig): string {
  switch (config.view) {
    case 'upcoming': return `Nothing scheduled in the next ${config.daysAhead} day${config.daysAhead === 1 ? '' : 's'}`;
    case 'recent': return `Nothing added in the last ${config.recentDays} days`;
    case 'queue': return 'Nothing downloading';
    default: return 'No requests';
  }
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', opacity: 0.6, fontSize: '0.9em', padding: '1em', lineHeight: 1.4 }}>
      <div>{children}</div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ArrStack({ config: rawConfig, style, timezone }: PluginComponentProps) {
  const config = React.useMemo(() => readConfig(rawConfig ?? {}), [rawConfig]);
  const sdk = window.__HS_SDK__;
  const tz = timezone || sdk?.getHostSettings?.().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const locale = sdk?.locale;
  const now = useNow(60_000);
  const { data, error, loading } = useArrData(config, tz);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const size = useSize(bodyRef);
  const overflowing = useOverflowing(bodyRef);
  const fontSize = Number.isFinite(style?.fontSize) && style.fontSize > 0 ? style.fontSize : 16;

  const items = data ? sortAndTrim(config, data.results, tz) : [];
  const errors = data?.results.filter((r) => r.error).map((r) => r.error!) ?? [];
  if (error) errors.push(error);

  const settings = readSettings();
  const wanted: Source[] = config.view === 'requests'
    ? ['seerr']
    : config.sources.filter((s) => s !== 'seerr' && (config.view === 'queue' || s !== 'sabnzbd'));
  const nothingConfigured = !config.demo && wanted.every((s) => !baseUrl(settings, s));

  const layout = config.layout === 'auto'
    ? (config.view !== 'queue' && size.w > 0 && size.w / Math.max(1, size.h) >= 1.6 ? 'posters' : 'list')
    : config.layout;

  const title = config.title || VIEW_TITLE[config.view];

  let body: React.ReactNode;
  if (nothingConfigured) {
    body = (
      <Message>
        Set your {wanted.map((s) => SOURCE_LABEL[s]).join(' / ') || 'app'} URL under
        <b> Plugins → Installed → Arr Stack → Plugin settings</b>, and the API key under <b>Secrets</b> in this module&apos;s settings.
      </Message>
    );
  } else if (loading && !data) {
    body = <Message>Loading…</Message>;
  } else if (items.length === 0) {
    body = <Message>{errors.length && !items.length && data?.results.every((r) => r.error) ? errors[0] : emptyText(config)}</Message>;
  } else if (layout === 'posters') {
    body = <PosterView items={items} config={config} tz={tz} locale={locale} now={now} width={size.w} height={size.h} fontSize={fontSize} />;
  } else {
    body = <ListView items={items} config={config} tz={tz} locale={locale} now={now} />;
  }

  return (
    <div style={{ ...hostFrameStyle(style), width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box' }}>
      {config.showHeader && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.75em', marginBottom: '0.5em', flexShrink: 0 }}>
          <div style={{ ...ellipsis, fontSize: '1.15em', fontWeight: 700 }}>
            {title}
            {config.demo && <span style={{ fontSize: '0.6em', fontWeight: 600, opacity: 0.5, marginLeft: '0.6em' }}>DEMO</span>}
          </div>
          {data && !nothingConfigured && items.length > 0 && (
            <div style={{ fontSize: '0.75em', opacity: 0.6, whiteSpace: 'nowrap' }}>{headerSummary(config, items, data.sab)}</div>
          )}
        </div>
      )}
      <div
        ref={bodyRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          ...(layout === 'list' && overflowing
            ? { maskImage: 'linear-gradient(180deg, #000 88%, transparent)', WebkitMaskImage: 'linear-gradient(180deg, #000 88%, transparent)' }
            : {}),
        }}
      >
        {body}
      </div>
      {errors.length > 0 && items.length > 0 && (
        <div style={{ ...ellipsis, fontSize: '0.68em', color: '#f59e0b', opacity: 0.85, marginTop: '0.35em', flexShrink: 0 }}>
          {[...new Set(errors)].join(' · ')}
        </div>
      )}
    </div>
  );
}
