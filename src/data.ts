// Network layer: every call goes through the host's plugin proxy, which adds
// the API key from the plugin's secret store. Keys never reach the browser.

import type { ArrConfig, ArrSettings, Item, Source, SourceResult } from './types';
import {
  arrQueue,
  lidarrCalendar,
  lidarrHistory,
  mergeQueues,
  queuedIds,
  radarrCalendar,
  radarrHistory,
  sabQueue,
  seerrDetails,
  seerrRequest,
  sonarrCalendar,
  sonarrHistory,
  type NormalizeContext,
  type SabSummary,
  type SeerrDetails,
} from './normalize';
import { addDays, dayKey } from './time';

export const PLUGIN_ID = 'arr-stack';

export const SOURCE_LABEL: Record<Source, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  lidarr: 'Lidarr',
  sabnzbd: 'SABnzbd',
  seerr: 'Seerr',
};

const SECRET: Record<Source, string> = {
  sonarr: 'sonarr_api_key',
  radarr: 'radarr_api_key',
  lidarr: 'lidarr_api_key',
  sabnzbd: 'sabnzbd_api_key',
  seerr: 'seerr_api_key',
};

export function readSettings(): ArrSettings {
  try {
    return (window.__HS_SDK__?.getPluginSettings?.(PLUGIN_ID) ?? {}) as ArrSettings;
  } catch {
    return {};
  }
}

export function baseUrl(settings: ArrSettings, source: Source): string | undefined {
  const raw = settings[`${source}Url` as keyof ArrSettings];
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let v = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  return v;
}

export class SourceError extends Error {}

/** Turn a proxy failure into something a person can act on. */
async function explain(res: Response, source: Source): Promise<string> {
  let detail = '';
  try {
    const body = await res.clone().json();
    detail = body?.error ?? body?.message ?? '';
  } catch { /* not JSON */ }
  const label = SOURCE_LABEL[source];
  if (/Secret ".*" is not configured/i.test(detail)) return `${label}: API key not set`;
  if (res.status === 401) return `${label}: API key rejected`;
  if (res.status === 400 && !detail) return `${label}: bad request (check AllowedHosts)`;
  if (res.status === 403 && /allowedDomains|blocked address/i.test(detail)) return `${label}: address blocked by the proxy`;
  if (res.status === 429) return `${label}: rate limited, retrying`;
  if (res.status >= 500 && detail) return `${label}: ${detail}`;
  return `${label}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`;
}

/** GET JSON from an app through the proxy. */
export async function arrGet<T = unknown>(
  source: Source,
  url: string,
  cacheTtlMs: number,
): Promise<T> {
  const sdk = window.__HS_SDK__;
  if (!sdk?.pluginFetch) throw new SourceError('Home Screens SDK not available');
  const secretInjections = source === 'sabnzbd'
    ? { query: { apikey: `{{${SECRET.sabnzbd}}}` } }
    : { header: { 'X-Api-Key': `{{${SECRET[source]}}}` } };
  let res: Response;
  try {
    res = await sdk.pluginFetch(PLUGIN_ID, {
      url,
      headers: { Accept: 'application/json' },
      secretInjections,
      cacheTtlMs,
    });
  } catch (err) {
    throw new SourceError(`${SOURCE_LABEL[source]}: ${err instanceof Error ? err.message : 'unreachable'}`);
  }
  if (!res.ok) throw new SourceError(await explain(res, source));
  try {
    return (await res.json()) as T;
  } catch {
    throw new SourceError(`${SOURCE_LABEL[source]}: response was not JSON (wrong URL?)`);
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const API: Record<'sonarr' | 'radarr' | 'lidarr', string> = {
  sonarr: '/api/v3',
  radarr: '/api/v3',
  lidarr: '/api/v1',
};

export interface LoadResult {
  results: SourceResult[];
  sab?: SabSummary;
  /** Sources the module asked for that have no URL configured. */
  unconfigured: Source[];
}

interface LoadContext {
  config: ArrConfig;
  settings: ArrSettings;
  tz: string;
  now: number;
}

function ctxFor(base: string, lc: LoadContext): NormalizeContext {
  return {
    base,
    now: lc.now,
    todayKey: dayKey(lc.now, lc.tz),
    posterSource: lc.settings.posterSource === 'remote' ? 'remote' : 'local',
  };
}

async function settle(source: Source, fn: () => Promise<Item[]>): Promise<SourceResult> {
  try {
    return { source, items: await fn() };
  } catch (err) {
    return { source, items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

type ArrSource = 'sonarr' | 'radarr' | 'lidarr';
const ARR: ArrSource[] = ['sonarr', 'radarr', 'lidarr'];

function pick<T extends Source>(lc: LoadContext, allowed: readonly T[]): { configured: Array<[T, string]>; unconfigured: T[] } {
  const configured: Array<[T, string]> = [];
  const unconfigured: T[] = [];
  for (const s of allowed) {
    if (!lc.config.sources.includes(s)) continue;
    const base = baseUrl(lc.settings, s);
    if (base) configured.push([s, base]);
    else unconfigured.push(s);
  }
  return { configured, unconfigured };
}

async function queueIdsFor(source: ArrSource, base: string): Promise<Set<number> | undefined> {
  try {
    const raw = await arrGet(source, `${base}${API[source]}/queue${qs({ pageSize: 200 })}`, 30_000);
    return queuedIds(source, raw);
  } catch {
    return undefined; // queue state is a nicety; the calendar still renders
  }
}

export async function loadUpcoming(lc: LoadContext): Promise<LoadResult> {
  const { configured, unconfigured } = pick(lc, ARR);
  const todayKey = dayKey(lc.now, lc.tz);
  const startKey = addDays(todayKey, -Math.max(0, lc.config.daysBack));
  const endKey = addDays(todayKey, Math.max(1, lc.config.daysAhead) - 1);
  // Ask a day wider on both sides: the apps filter in UTC, we bucket locally.
  const start = addDays(startKey, -1);
  const end = addDays(endKey, 2);
  const unmonitored = lc.config.includeUnmonitored;

  const results = await Promise.all(configured.map(([source, base]) => settle(source, async () => {
    const ctx = ctxFor(base, lc);
    if (lc.config.showQueueState) ctx.queued = await queueIdsFor(source, base);
    if (source === 'sonarr') {
      const raw = await arrGet<unknown[]>(source, `${base}/api/v3/calendar${qs({ start, end, includeSeries: true, unmonitored })}`, 60_000);
      return sonarrCalendar(raw, ctx);
    }
    if (source === 'radarr') {
      const raw = await arrGet<unknown[]>(source, `${base}/api/v3/calendar${qs({ start, end, unmonitored })}`, 60_000);
      return radarrCalendar(raw, ctx, startKey, endKey, lc.config.radarrReleaseTypes);
    }
    const raw = await arrGet<unknown[]>(source, `${base}/api/v1/calendar${qs({ start, end, includeArtist: true, unmonitored })}`, 60_000);
    return lidarrCalendar(raw, ctx);
  })));

  // Keep only the local-day window.
  for (const r of results) {
    r.items = r.items.filter((i) => {
      const k = i.dateOnly ?? (i.when !== undefined ? dayKey(i.when, lc.tz) : undefined);
      return k !== undefined && k >= startKey && k <= endKey;
    });
  }
  return { results, unconfigured };
}

export async function loadRecent(lc: LoadContext): Promise<LoadResult> {
  const { configured, unconfigured } = pick(lc, ARR);
  // Episodes collapse into groups, so over-fetch a little.
  const pageSize = Math.min(100, Math.max(10, lc.config.maxItems * 3));
  const common = { page: 1, pageSize, sortKey: 'date', sortDirection: 'descending' };
  const results = await Promise.all(configured.map(([source, base]) => settle(source, async () => {
    const ctx = ctxFor(base, lc);
    if (source === 'sonarr') {
      const raw = await arrGet(source, `${base}/api/v3/history${qs({ ...common, eventType: 3, includeSeries: true, includeEpisode: true })}`, 60_000);
      return sonarrHistory(raw, ctx);
    }
    if (source === 'radarr') {
      const raw = await arrGet(source, `${base}/api/v3/history${qs({ ...common, eventType: 3, includeMovie: true })}`, 60_000);
      return radarrHistory(raw, ctx);
    }
    // Lidarr: 8 = downloadImported (one per album), not 3 (one per track).
    const raw = await arrGet(source, `${base}/api/v1/history${qs({ ...common, eventType: 8, includeArtist: true, includeAlbum: true })}`, 60_000);
    return lidarrHistory(raw, ctx);
  })));
  const cutoff = lc.now - Math.max(1, lc.config.recentDays) * 86_400_000;
  for (const r of results) r.items = r.items.filter((i) => (i.when ?? 0) >= cutoff);
  return { results, unconfigured };
}

export async function loadQueue(lc: LoadContext): Promise<LoadResult> {
  const { configured, unconfigured } = pick(lc, [...ARR, 'sabnzbd'] as const);
  let sab: SabSummary | undefined;
  let sabItems: Item[] = [];
  let sabError: string | undefined;
  const arrResults = await Promise.all(configured.map(async ([source, base]): Promise<SourceResult | null> => {
    if (source === 'sabnzbd') {
      try {
        const raw = await arrGet(source, `${base}/api${qs({ mode: 'queue', output: 'json', limit: 50 })}`, 0);
        const q = sabQueue(raw);
        sab = q.summary;
        sabItems = q.items;
      } catch (err) {
        sabError = err instanceof Error ? err.message : String(err);
      }
      return null;
    }
    return settle(source, async () => {
      const ctx = ctxFor(base, lc);
      const include = source === 'sonarr'
        ? { includeSeries: true, includeEpisode: true }
        : source === 'radarr' ? { includeMovie: true } : { includeArtist: true, includeAlbum: true };
      const raw = await arrGet(source, `${base}${API[source]}/queue${qs({ pageSize: 100, ...include })}`, 0);
      return arrQueue(source, raw, ctx);
    });
  }));
  const results = arrResults.filter((r): r is SourceResult => r !== null);
  const merged = mergeQueues(results.flatMap((r) => r.items), sabItems);
  const arrKeys = new Set(results.flatMap((r) => r.items.map((i) => i.key)));
  for (const r of results) r.items = merged.filter((i) => i.source === r.source && arrKeys.has(i.key));
  results.push({ source: 'sabnzbd', items: merged.filter((i) => i.source === 'sabnzbd'), error: sabError });
  return { results, sab, unconfigured };
}

// Seerr has no title in the request list, so each request needs a details
// lookup. Those rarely change, so they're cached here for the tab's lifetime.
const seerrDetailCache = new Map<string, SeerrDetails>();

export async function loadRequests(lc: LoadContext): Promise<LoadResult> {
  const base = baseUrl(lc.settings, 'seerr');
  if (!base) return { results: [], unconfigured: ['seerr'] };
  const result = await settle('seerr', async () => {
    const filter = lc.config.requestFilter || 'all';
    const raw = await arrGet<{ results?: unknown[] }>('seerr', `${base}/api/v1/request${qs({ take: Math.min(50, lc.config.maxItems), skip: 0, filter, sort: 'added' })}`, 30_000);
    const reqs = (raw?.results ?? []) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    return Promise.all(reqs.map(async (req) => {
      const type = req?.type === 'tv' || req?.media?.mediaType === 'tv' ? 'tv' : 'movie';
      const tmdbId = req?.media?.tmdbId;
      const cacheKey = `${base}:${type}:${tmdbId}`;
      let details = seerrDetailCache.get(cacheKey);
      if (!details && tmdbId) {
        try {
          details = seerrDetails(await arrGet('seerr', `${base}/api/v1/${type}/${tmdbId}`, 3_600_000));
          seerrDetailCache.set(cacheKey, details);
        } catch { /* fall back to the TMDB id */ }
      }
      return seerrRequest(req, details);
    }));
  });
  return { results: [result], unconfigured: [] };
}

export function load(view: ArrConfig['view'], lc: LoadContext): Promise<LoadResult> {
  switch (view) {
    case 'recent': return loadRecent(lc);
    case 'queue': return loadQueue(lc);
    case 'requests': return loadRequests(lc);
    default: return loadUpcoming(lc);
  }
}
