import { describe, expect, it } from 'vitest';
import {
  arrQueue,
  formatTimeLeft,
  groupEpisodes,
  lidarrCalendar,
  mergeQueues,
  posterFor,
  queueStatus,
  radarrCalendar,
  sabQueue,
  seerrRequest,
  sonarrCalendar,
  sonarrHistory,
  type NormalizeContext,
} from './normalize';
import { addDays, dateOnlyOf, dayKey, dayLabel } from './time';

const NOW = Date.parse('2026-11-17T01:00:00Z'); // 8pm Nov 16 in New York
const TZ = 'America/New_York';
const ctx: NormalizeContext = {
  base: 'http://192.168.1.10:8989',
  now: NOW,
  todayKey: dayKey(NOW, TZ),
  posterSource: 'local',
};

describe('time', () => {
  it('buckets instants on the household clock', () => {
    expect(dayKey(NOW, TZ)).toBe('2026-11-16');
    expect(dayKey(NOW, 'UTC')).toBe('2026-11-17');
  });

  it('keeps date-only values on their own day', () => {
    // Midnight UTC must not become the previous evening in New York.
    expect(dateOnlyOf('2026-11-17T00:00:00Z')).toBe('2026-11-17');
    expect(dateOnlyOf(undefined)).toBeUndefined();
  });

  it('labels days relative to today', () => {
    expect(dayLabel('2026-11-16', '2026-11-16', 'en-US')).toBe('Today');
    expect(dayLabel('2026-11-17', '2026-11-16', 'en-US')).toBe('Tomorrow');
    expect(dayLabel('2026-11-19', '2026-11-16', 'en-US')).toBe('Thu, Nov 19');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('sonarr', () => {
  const ep = (over: Record<string, unknown>) => ({
    id: 1, seriesId: 248, seasonNumber: 2, episodeNumber: 3, title: 'Charlie Mike',
    airDateUtc: '2026-11-17T02:00:00Z', hasFile: false, monitored: true, runtime: 45,
    series: { title: 'Fallout', network: 'Prime Video', images: [{ coverType: 'poster', remoteUrl: 'https://artworks.thetvdb.com/p.jpg' }] },
    ...over,
  });

  it('derives downloaded / missing / upcoming / downloading', () => {
    const items = sonarrCalendar([
      ep({ id: 1, hasFile: true }),
      ep({ id: 2, airDateUtc: '2026-11-16T20:00:00Z' }),
      ep({ id: 3 }),
      ep({ id: 4, airDateUtc: '2026-11-16T20:00:00Z' }),
    ], { ...ctx, queued: new Set([4]) });
    expect(items.map((i) => i.status)).toEqual(['downloaded', 'missing', 'upcoming', 'downloading']);
    expect(items[0].subtitle).toBe('S02E03 · Charlie Mike');
    expect(items[0].poster).toEqual({
      url: 'http://192.168.1.10:8989/MediaCover/248/poster-250.jpg',
      auth: 'sonarr',
      fallback: 'https://artworks.thetvdb.com/p.jpg',
    });
  });

  it('groups a season drop into one row', () => {
    const items = sonarrCalendar([1, 2, 3].map((n) => ep({ id: n, episodeNumber: n })), ctx);
    const grouped = groupEpisodes(items, (i) => dayKey(i.when!, TZ));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].subtitle).toBe('S02E01–E03 · 3 episodes');
  });

  it('reads history records', () => {
    const items = sonarrHistory({ records: [{ id: 9, seriesId: 222, date: '2026-11-16T13:07:15Z', quality: { quality: { name: 'WEBDL-2160p' } }, series: { title: 'Marshals' }, episode: { seasonNumber: 2, episodeNumber: 7, title: 'Under the Influence' } }] }, ctx);
    expect(items[0]).toMatchObject({ title: 'Marshals', subtitle: 'S02E07 · Under the Influence', badge: 'WEBDL-2160p', status: 'downloaded' });
  });
});

describe('radarr', () => {
  const movie = { id: 709, title: 'The Odyssey', year: 2026, hasFile: false, inCinemas: '2026-07-15T00:00:00Z', digitalRelease: '2026-11-17T00:00:00Z', physicalRelease: '2026-11-17T00:00:00Z', images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/x.jpg' }] };
  const rctx = { ...ctx, base: 'http://h:7878' };

  it('shows one entry per movie, labelled with every release that day', () => {
    const items = radarrCalendar([movie], rctx, '2026-11-16', '2026-11-22', ['digital', 'physical']);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ dateOnly: '2026-11-17', badge: 'Digital + Physical', status: 'upcoming' });
    // TMDB originals are downsized
    expect(items[0].poster?.fallback).toBe('https://image.tmdb.org/t/p/w342/x.jpg');
  });

  it('ignores release types that are switched off or out of range', () => {
    expect(radarrCalendar([movie], rctx, '2026-11-16', '2026-11-22', ['cinemas'])).toHaveLength(0);
  });

  it('marks a released-but-not-downloaded movie missing', () => {
    const items = radarrCalendar([{ ...movie, digitalRelease: '2026-11-16T00:00:00Z', physicalRelease: null }], rctx, '2026-11-16', '2026-11-22', ['digital']);
    expect(items[0].status).toBe('missing');
  });

  it('never sends the API key to the CDN in remote mode', () => {
    const ref = posterFor('radarr', { ...rctx, posterSource: 'remote' }, '/MediaCover/1/poster-250.jpg', 'https://image.tmdb.org/t/p/w342/x.jpg');
    expect(ref).toEqual({ url: 'https://image.tmdb.org/t/p/w342/x.jpg', fallback: 'http://h:7878/MediaCover/1/poster-250.jpg', fallbackAuth: 'radarr' });
    expect(ref?.auth).toBeUndefined();
  });
});

describe('lidarr', () => {
  it('uses track statistics for state and the resized local cover', () => {
    const items = lidarrCalendar([
      { id: 2159, title: 'Everything Under the Sun', releaseDate: '2026-10-30T00:00:00Z', statistics: { percentOfTracks: 100 }, artist: { artistName: 'Nickelback' }, images: [{ coverType: 'cover', url: '/MediaCover/Albums/2159/cover.jpg?lastWrite=1' }] },
      { id: 2259, title: 'Greetings', releaseDate: '2026-11-06T00:00:00Z', statistics: { percentOfTracks: 0 }, artist: { artistName: 'Good Charlotte' }, images: [] },
      { id: 3000, title: 'Soon', releaseDate: '2026-11-20T00:00:00Z', statistics: { percentOfTracks: 0 }, artist: { artistName: 'X' } },
    ], { ...ctx, base: 'http://h:8686' });
    expect(items.map((i) => i.status)).toEqual(['downloaded', 'missing', 'upcoming']);
    expect(items[0].poster?.url).toBe('http://h:8686/MediaCover/Albums/2159/cover-250.jpg?lastWrite=1');
  });
});

describe('queue', () => {
  it('maps arr states', () => {
    expect(queueStatus({ status: 'downloading', trackedDownloadState: 'downloading' })).toBe('downloading');
    expect(queueStatus({ status: 'completed', trackedDownloadState: 'importPending' })).toBe('importing');
    expect(queueStatus({ status: 'downloading', trackedDownloadStatus: 'warning' })).toBe('warning');
    expect(queueStatus({ status: 'paused' })).toBe('paused');
    // Lidarr's stuck imports: completed downloads that can't be imported
    expect(queueStatus({ status: 'completed', trackedDownloadState: 'importPending', trackedDownloadStatus: 'warning' })).toBe('warning');
    expect(queueStatus({ status: 'completed', trackedDownloadState: 'importFailed', trackedDownloadStatus: 'warning' })).toBe('failed');
    expect(queueStatus({ status: 'delay' })).toBe('queued');
  });

  it('merges SABnzbd slots into matching arr items and keeps the rest', () => {
    const arr = arrQueue('radarr', { records: [{ id: 1, movieId: 5, title: 'x', movie: { title: 'Dune', year: 2021 }, size: 100, sizeleft: 50, status: 'downloading', downloadId: 'SABnzbd_nzo_abc' }] }, ctx);
    const sab = sabQueue({ queue: { kbpersec: '2048', timeleft: '0:05:00', slots: [
      { nzo_id: 'SABnzbd_nzo_abc', filename: 'Dune.2021', percentage: '75', mb: '100', mbleft: '25', timeleft: '0:01:00', status: 'Downloading' },
      { nzo_id: 'SABnzbd_nzo_zzz', filename: 'Other.Thing', percentage: '10', mb: '10', mbleft: '9', status: 'Queued' },
    ] } });
    expect(sab.summary.speed).toBe('2.0 MB/s');
    const merged = mergeQueues(arr, sab.items);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ title: 'Dune', progress: 0.75, timeLeft: '0:01:00' });
    expect(merged[1]).toMatchObject({ source: 'sabnzbd', title: 'Other Thing', status: 'queued' });
  });

  it('formats time left', () => {
    expect(formatTimeLeft('00:12:31')).toBe('12m');
    expect(formatTimeLeft('1.02:03:04')).toBe('1d 2h');
    expect(formatTimeLeft('0:00:09')).toBe('9s');
    expect(formatTimeLeft('03:05:00')).toBe('3h 5m');
  });
});

describe('seerr', () => {
  it('builds a request row from the request and its media details', () => {
    const item = seerrRequest(
      { id: 3, status: 1, type: 'tv', createdAt: '2026-11-16T12:00:00Z', media: { tmdbId: 1, status: 2 }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }], requestedBy: { displayName: 'Sam' } },
      { title: 'Bluey', year: '2018', posterPath: '/b.jpg' },
    );
    expect(item).toMatchObject({ title: 'Bluey', subtitle: 'Seasons 1, 2 · by Sam', status: 'pending', poster: { url: 'https://image.tmdb.org/t/p/w185/b.jpg' } });
    expect(seerrRequest({ id: 4, status: 2, type: 'movie', media: { tmdbId: 2, status: 5 } }, undefined).status).toBe('available');
  });
});
