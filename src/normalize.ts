// Pure functions that turn raw *arr / SABnzbd / Seerr JSON into Items.
// No network here, so these are what the unit tests exercise.

import type { Item, PosterRef, Source, Status } from './types';
import { dateOnlyOf, parseInstant } from './time';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export interface NormalizeContext {
  /** Base URL of the app, no trailing slash. */
  base: string;
  now: number;
  /** Today in the household timezone, YYYY-MM-DD. */
  todayKey: string;
  posterSource: 'local' | 'remote';
  /** IDs currently in the app's download queue (episode/movie/album ids). */
  queued?: Set<number>;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function episodeCode(season: number, episode: number): string {
  return `S${pad2(season)}E${pad2(episode)}`;
}

/** Downsize TMDB "original" artwork so a poster isn't a multi-megabyte JPEG. */
export function smallRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace('image.tmdb.org/t/p/original/', 'image.tmdb.org/t/p/w342/');
}

function remoteOf(images: Raw[] | undefined, type: string): string | undefined {
  const img = (images ?? []).find((i) => i?.coverType === type);
  return smallRemote(img?.remoteUrl);
}

/** Local MediaCover poster (small resized copy), with the CDN copy as fallback. */
export function posterFor(
  source: Source,
  ctx: NormalizeContext,
  localPath: string | undefined,
  remote: string | undefined,
): PosterRef | undefined {
  const local = localPath ? `${ctx.base}${localPath}` : undefined;
  if (ctx.posterSource === 'remote' && remote) return { url: remote, fallback: local, fallbackAuth: local ? source : undefined };
  if (local) return { url: local, auth: source, fallback: remote };
  if (remote) return { url: remote };
  return undefined;
}

// ─── Sonarr ──────────────────────────────────────────────────────────────────

export function sonarrCalendar(raw: Raw[], ctx: NormalizeContext): Item[] {
  return (raw ?? []).map((ep: Raw): Item => {
    const when = parseInstant(ep.airDateUtc);
    const runtimeMs = (ep.runtime || ep.series?.runtime || 30) * 60_000;
    let status: Status;
    if (ep.hasFile) status = 'downloaded';
    else if (ctx.queued?.has(ep.id)) status = 'downloading';
    else if (when !== undefined && when + runtimeMs < ctx.now) status = 'missing';
    else status = 'upcoming';
    return {
      key: `sonarr:ep:${ep.id}`,
      source: 'sonarr',
      title: ep.series?.title ?? 'Unknown series',
      subtitle: `${episodeCode(ep.seasonNumber, ep.episodeNumber)}${ep.title && ep.title !== 'TBA' ? ` · ${ep.title}` : ''}`,
      badge: ep.series?.network || undefined,
      when,
      dateOnly: when === undefined ? dateOnlyOf(ep.airDate) : undefined,
      status,
      poster: posterFor('sonarr', ctx, `/MediaCover/${ep.seriesId}/poster-250.jpg`, remoteOf(ep.series?.images, 'poster')),
      _group: { series: ep.seriesId, season: ep.seasonNumber, episode: ep.episodeNumber },
    } as Item;
  });
}

export function sonarrHistory(raw: Raw, ctx: NormalizeContext): Item[] {
  return (raw?.records ?? []).map((r: Raw): Item => {
    const ep = r.episode ?? {};
    return {
      key: `sonarr:hist:${r.id}`,
      source: 'sonarr',
      title: r.series?.title ?? r.sourceTitle ?? 'Unknown series',
      subtitle: ep.seasonNumber !== undefined
        ? `${episodeCode(ep.seasonNumber, ep.episodeNumber)}${ep.title ? ` · ${ep.title}` : ''}`
        : r.sourceTitle,
      badge: r.quality?.quality?.name,
      when: parseInstant(r.date),
      status: 'downloaded',
      poster: posterFor('sonarr', ctx, `/MediaCover/${r.seriesId}/poster-250.jpg`, remoteOf(r.series?.images, 'poster')),
      _group: { series: r.seriesId, season: ep.seasonNumber, episode: ep.episodeNumber },
    } as Item;
  });
}

// ─── Radarr ──────────────────────────────────────────────────────────────────

const RADARR_TYPES: Array<{ field: string; type: string; label: string }> = [
  { field: 'inCinemas', type: 'cinemas', label: 'In cinemas' },
  { field: 'digitalRelease', type: 'digital', label: 'Digital' },
  { field: 'physicalRelease', type: 'physical', label: 'Physical' },
];

/**
 * One item per release event that falls inside [startKey, endKey]. A movie
 * whose digital and physical releases are both in range shows once, on the
 * earlier date, labelled with both.
 */
export function radarrCalendar(
  raw: Raw[],
  ctx: NormalizeContext,
  startKey: string,
  endKey: string,
  types: string[],
): Item[] {
  const out: Item[] = [];
  for (const m of raw ?? []) {
    const hits = RADARR_TYPES
      .filter((t) => types.includes(t.type))
      .map((t) => ({ ...t, day: dateOnlyOf(m[t.field]) }))
      .filter((t): t is typeof t & { day: string } => !!t.day && t.day >= startKey && t.day <= endKey)
      .sort((a, b) => a.day.localeCompare(b.day));
    if (hits.length === 0) continue;
    const first = hits[0];
    const labels = hits.filter((h) => h.day === first.day).map((h) => h.label);
    let status: Status;
    if (m.hasFile) status = 'downloaded';
    else if (ctx.queued?.has(m.id)) status = 'downloading';
    else if (first.day <= ctx.todayKey && first.type !== 'cinemas') status = 'missing';
    else status = 'upcoming';
    out.push({
      key: `radarr:movie:${m.id}:${first.type}`,
      source: 'radarr',
      title: m.title ?? 'Unknown movie',
      subtitle: m.year ? String(m.year) : undefined,
      badge: labels.join(' + '),
      dateOnly: first.day,
      status,
      poster: posterFor('radarr', ctx, `/MediaCover/${m.id}/poster-250.jpg`, remoteOf(m.images, 'poster')),
    });
  }
  return out;
}

export function radarrHistory(raw: Raw, ctx: NormalizeContext): Item[] {
  return (raw?.records ?? []).map((r: Raw): Item => ({
    key: `radarr:hist:${r.id}`,
    source: 'radarr',
    title: r.movie?.title ?? r.sourceTitle ?? 'Unknown movie',
    subtitle: r.movie?.year ? String(r.movie.year) : undefined,
    badge: r.quality?.quality?.name,
    when: parseInstant(r.date),
    status: 'downloaded',
    poster: posterFor('radarr', ctx, `/MediaCover/${r.movieId}/poster-250.jpg`, remoteOf(r.movie?.images, 'poster')),
  }));
}

// ─── Lidarr ──────────────────────────────────────────────────────────────────

function lidarrCover(album: Raw, ctx: NormalizeContext): PosterRef | undefined {
  const local = (album?.images ?? []).find((i: Raw) => i?.coverType === 'cover')?.url as string | undefined;
  // `url` is a path like /MediaCover/Albums/2159/cover.jpg?lastWrite=…
  const path = local?.startsWith('/') ? local.replace(/\/cover\.jpg/, '/cover-250.jpg') : undefined;
  return posterFor('lidarr', ctx, path ?? (album?.id ? `/MediaCover/Albums/${album.id}/cover-250.jpg` : undefined), remoteOf(album?.images, 'cover'));
}

export function lidarrCalendar(raw: Raw[], ctx: NormalizeContext): Item[] {
  return (raw ?? []).map((a: Raw): Item => {
    const day = dateOnlyOf(a.releaseDate);
    const pct = a.statistics?.percentOfTracks ?? 0;
    let status: Status;
    if (pct >= 100) status = 'downloaded';
    else if (ctx.queued?.has(a.id)) status = 'downloading';
    else if (pct > 0) status = 'partial';
    else if (day && day <= ctx.todayKey) status = 'missing';
    else status = 'upcoming';
    return {
      key: `lidarr:album:${a.id}`,
      source: 'lidarr',
      title: a.title ?? 'Unknown album',
      subtitle: a.artist?.artistName,
      badge: a.albumType || undefined,
      dateOnly: day,
      status,
      poster: lidarrCover(a, ctx),
    };
  });
}

export function lidarrHistory(raw: Raw, ctx: NormalizeContext): Item[] {
  return (raw?.records ?? []).map((r: Raw): Item => ({
    key: `lidarr:hist:${r.id}`,
    source: 'lidarr',
    title: r.album?.title ?? r.sourceTitle ?? 'Unknown album',
    subtitle: r.artist?.artistName,
    badge: r.quality?.quality?.name,
    when: parseInstant(r.date),
    status: 'downloaded',
    poster: lidarrCover({ ...(r.album ?? {}), id: r.albumId }, ctx),
  }));
}

// ─── Queues ──────────────────────────────────────────────────────────────────

export function queueStatus(r: Raw): Status {
  const s = String(r.status ?? '').toLowerCase();
  const tracked = String(r.trackedDownloadState ?? '').toLowerCase();
  const health = String(r.trackedDownloadStatus ?? '').toLowerCase();
  if (s === 'failed' || tracked === 'failedpending' || tracked === 'failed' || tracked === 'importfailed' || health === 'error') return 'failed';
  // A warning outranks "importing": an import stuck for weeks (wrong path,
  // no match) reports importPending + warning and needs a person, not patience.
  if (health === 'warning' || s === 'warning' || tracked === 'importblocked') return 'warning';
  if (tracked === 'importpending' || tracked === 'importing') return 'importing';
  if (s === 'paused') return 'paused';
  if (s === 'queued' || s === 'delay' || s === 'downloadclientunavailable') return 'queued';
  if (s === 'completed') return 'importing';
  return 'downloading';
}

function progressOf(size: number | undefined, left: number | undefined): number | undefined {
  if (!size || size <= 0 || left === undefined) return undefined;
  return Math.min(1, Math.max(0, (size - left) / size));
}

/** Sonarr, Radarr and Lidarr share the queue resource shape. */
export function arrQueue(source: 'sonarr' | 'radarr' | 'lidarr', raw: Raw, ctx: NormalizeContext): Item[] {
  return (raw?.records ?? []).map((r: Raw): Item => {
    let title = r.title ?? 'Download';
    let subtitle: string | undefined;
    let poster: PosterRef | undefined;
    if (source === 'sonarr') {
      title = r.series?.title ?? title;
      const ep = r.episode;
      subtitle = ep ? `${episodeCode(ep.seasonNumber, ep.episodeNumber)}${ep.title ? ` · ${ep.title}` : ''}` : r.title;
      if (r.seriesId) poster = posterFor('sonarr', ctx, `/MediaCover/${r.seriesId}/poster-250.jpg`, remoteOf(r.series?.images, 'poster'));
    } else if (source === 'radarr') {
      title = r.movie?.title ?? title;
      subtitle = r.movie?.year ? String(r.movie.year) : undefined;
      if (r.movieId) poster = posterFor('radarr', ctx, `/MediaCover/${r.movieId}/poster-250.jpg`, remoteOf(r.movie?.images, 'poster'));
    } else {
      title = r.album?.title ?? title;
      subtitle = r.artist?.artistName;
      if (r.albumId) poster = lidarrCover({ ...(r.album ?? {}), id: r.albumId }, ctx);
    }
    return {
      key: `${source}:queue:${r.id}`,
      source,
      title,
      subtitle,
      badge: r.quality?.quality?.name,
      status: queueStatus(r),
      poster,
      size: r.size,
      sizeLeft: r.sizeleft,
      progress: progressOf(r.size, r.sizeleft),
      timeLeft: r.timeleft,
      downloadId: r.downloadId ? String(r.downloadId).toLowerCase() : undefined,
      _group: source === 'sonarr' && r.seriesId
        ? { series: r.seriesId, season: r.episode?.seasonNumber, episode: r.episode?.episodeNumber, downloadId: r.downloadId }
        : undefined,
    } as Item;
  });
}

/** IDs of queued episodes / movies / albums, for marking calendar items. */
export function queuedIds(source: 'sonarr' | 'radarr' | 'lidarr', raw: Raw): Set<number> {
  const field = source === 'sonarr' ? 'episodeId' : source === 'radarr' ? 'movieId' : 'albumId';
  const out = new Set<number>();
  for (const r of raw?.records ?? []) if (typeof r[field] === 'number') out.add(r[field]);
  return out;
}

export interface SabSummary {
  speed?: string;
  timeLeft?: string;
  paused?: boolean;
  count: number;
}

export function sabQueue(raw: Raw): { items: Item[]; summary: SabSummary } {
  const q = raw?.queue ?? {};
  const items = (q.slots ?? []).map((s: Raw): Item => {
    const mb = parseFloat(s.mb);
    const mbleft = parseFloat(s.mbleft);
    const st = String(s.status ?? '').toLowerCase();
    const status: Status = st === 'paused' ? 'paused' : st === 'downloading' ? 'downloading' : st === 'queued' ? 'queued' : st === 'failed' ? 'failed' : 'downloading';
    return {
      key: `sabnzbd:${s.nzo_id}`,
      source: 'sabnzbd',
      title: String(s.filename ?? 'Download').replace(/\./g, ' '),
      subtitle: s.cat && s.cat !== '*' ? s.cat : undefined,
      status,
      size: Number.isFinite(mb) ? mb * 1048576 : undefined,
      sizeLeft: Number.isFinite(mbleft) ? mbleft * 1048576 : undefined,
      progress: s.percentage !== undefined ? Math.min(1, Math.max(0, Number(s.percentage) / 100)) : progressOf(mb, mbleft),
      timeLeft: s.timeleft,
      downloadId: s.nzo_id ? String(s.nzo_id).toLowerCase() : undefined,
    };
  });
  const kb = parseFloat(q.kbpersec);
  return {
    items,
    summary: {
      speed: Number.isFinite(kb) && kb > 0 ? formatSpeed(kb * 1024) : undefined,
      timeLeft: q.timeleft && q.timeleft !== '0:00:00' ? q.timeleft : undefined,
      paused: q.paused === true || q.status === 'Paused',
      count: items.length,
    },
  };
}

/**
 * Merge SABnzbd slots into the *arr queue: a slot whose nzo_id matches an arr
 * item's downloadId updates that item (SAB's numbers are live), the rest are
 * added as plain downloads.
 */
export function mergeQueues(arr: Item[], sab: Item[]): Item[] {
  const byId = new Map<string, Item>();
  for (const a of arr) if (a.downloadId) byId.set(a.downloadId, a);
  const extra: Item[] = [];
  for (const s of sab) {
    const match = s.downloadId ? byId.get(s.downloadId) : undefined;
    if (match) {
      if (s.progress !== undefined) match.progress = s.progress;
      if (s.timeLeft) match.timeLeft = s.timeLeft;
      if (s.sizeLeft !== undefined) match.sizeLeft = s.sizeLeft;
      if (s.status === 'paused') match.status = 'paused';
    } else {
      extra.push(s);
    }
  }
  return [...arr, ...extra];
}

// ─── Seerr ───────────────────────────────────────────────────────────────────

/** Request status (Seerr/Overseerr): 1 pending, 2 approved, 3 declined, 4 failed, 5 completed.
 *  Media status: 3 processing, 4 partially available, 5 available. */
export function seerrStatus(req: Raw): Status {
  const rs = req?.status;
  const ms = req?.media?.status;
  if (rs === 1) return 'pending';
  if (rs === 3) return 'declined';
  if (rs === 4) return 'failed';
  if (ms === 5) return 'available';
  if (ms === 4) return 'partial';
  return 'approved';
}

export interface SeerrDetails {
  title?: string;
  year?: string;
  posterPath?: string;
}

export function seerrDetails(raw: Raw): SeerrDetails {
  const date: string | undefined = raw?.releaseDate ?? raw?.firstAirDate;
  return {
    title: raw?.title ?? raw?.name ?? raw?.originalTitle ?? raw?.originalName,
    year: date ? date.slice(0, 4) : undefined,
    posterPath: raw?.posterPath ?? undefined,
  };
}

export function seerrRequest(req: Raw, details: SeerrDetails | undefined): Item {
  const isTv = req?.type === 'tv' || req?.media?.mediaType === 'tv';
  const seasons: number[] = (req?.seasons ?? []).map((s: Raw) => s.seasonNumber).filter((n: unknown) => typeof n === 'number');
  const who = req?.requestedBy?.displayName ?? req?.requestedBy?.username ?? req?.requestedBy?.plexUsername;
  const parts = [
    isTv ? (seasons.length ? `Season${seasons.length > 1 ? 's' : ''} ${seasons.join(', ')}` : 'TV') : 'Movie',
    who ? `by ${who}` : undefined,
  ].filter(Boolean);
  return {
    key: `seerr:req:${req.id}`,
    source: 'seerr',
    title: details?.title ?? `TMDB ${req?.media?.tmdbId ?? '?'}`,
    subtitle: parts.join(' · '),
    badge: req?.is4k ? '4K' : details?.year,
    when: parseInstant(req?.createdAt),
    status: seerrStatus(req),
    poster: details?.posterPath ? { url: `https://image.tmdb.org/t/p/w185${details.posterPath}` } : undefined,
  };
}

// ─── Grouping ────────────────────────────────────────────────────────────────

interface GroupInfo {
  series?: number;
  season?: number;
  episode?: number;
}

function groupOf(item: Item): GroupInfo | undefined {
  return (item as Item & { _group?: GroupInfo })._group;
}

const STATUS_RANK: Status[] = ['failed', 'missing', 'warning', 'downloading', 'importing', 'paused', 'queued', 'partial', 'upcoming', 'downloaded'];

/** The status a group of episodes should show: the most urgent of its members. */
function groupStatus(items: Item[]): Status {
  const all = new Set(items.map((i) => i.status));
  if (all.has('downloaded') && all.size > 1 && !all.has('missing') && !all.has('failed')) {
    // Some downloaded, some still coming: show as partial unless something's wrong.
    if (all.has('upcoming')) return 'partial';
  }
  for (const s of STATUS_RANK) if (all.has(s)) return s;
  return items[0].status;
}

/**
 * Collapse several episodes of the same series on the same day (a season drop,
 * a double episode) into one row: "S02E01–E08 · 8 episodes".
 * `bucket` decides what "the same day" means for the caller.
 */
export function groupEpisodes(items: Item[], bucket: (i: Item) => string): Item[] {
  const out: Item[] = [];
  const groups = new Map<string, Item[]>();
  for (const it of items) {
    const g = groupOf(it);
    if (it.source !== 'sonarr' || !g?.series || it.progress !== undefined) {
      out.push(it);
      continue;
    }
    const k = `${g.series}:${g.season}:${bucket(it)}`;
    const list = groups.get(k);
    if (list) list.push(it);
    else {
      const fresh = [it];
      groups.set(k, fresh);
      out.push(it); // placeholder at the first member's position
    }
  }
  return out.map((it) => {
    const g = groupOf(it);
    if (it.source !== 'sonarr' || !g?.series || it.progress !== undefined) return it;
    const list = groups.get(`${g.series}:${g.season}:${bucket(it)}`)!;
    if (list.length === 1) return it;
    const eps = list.map((m) => groupOf(m)?.episode ?? 0).sort((a, b) => a - b);
    const uniq = [...new Set(eps)];
    const range = uniq.length > 1
      ? `${episodeCode(g.season ?? 0, uniq[0])}–E${pad2(uniq[uniq.length - 1])}`
      : episodeCode(g.season ?? 0, uniq[0]);
    return {
      ...it,
      key: `${it.key}+${list.length}`,
      subtitle: `${range} · ${uniq.length} episode${uniq.length === 1 ? '' : 's'}`,
      status: groupStatus(list),
      when: Math.min(...list.map((m) => m.when ?? Infinity)) === Infinity ? it.when : Math.min(...list.map((m) => m.when ?? Infinity)),
    };
  }).filter((it, idx, arr) => arr.findIndex((o) => o.key === it.key) === idx);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** "0:12:31" / "1.02:03:04" / "02:03:04" → "12m", "1d 2h", "2h 3m". */
export function formatTimeLeft(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const m = /^(?:(\d+)[.:])?(\d+):(\d+):(\d+)$/.exec(t.trim());
  if (!m) return t;
  const d = m[1] ? +m[1] : 0;
  const h = +m[2];
  const min = +m[3];
  const s = +m[4];
  const totalH = d * 24 + h;
  if (totalH === 0 && min === 0 && s === 0) return undefined;
  if (totalH >= 24) return `${Math.floor(totalH / 24)}d ${totalH % 24}h`;
  if (totalH > 0) return `${totalH}h ${min}m`;
  if (min > 0) return `${min}m`;
  return `${s}s`;
}
