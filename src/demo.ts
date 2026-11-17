// Sample data for the "Demo data" toggle: lets people try layouts before
// connecting anything, and shows the queue/requests views when they're empty.

import type { Item, View } from './types';
import type { LoadResult } from './data';
import { addDays, dayKey } from './time';

const H = 3_600_000;

export function demoData(view: View, now: number, tz: string): LoadResult {
  const today = dayKey(now, tz);
  const mk = (items: Item[]): LoadResult => ({ results: [{ source: items[0]?.source ?? 'sonarr', items }], unconfigured: [] });
  switch (view) {
    case 'recent':
      return mk([
        { key: 'd1', source: 'sonarr', title: 'The Expanse', subtitle: 'S03E05 · Triple Point', badge: 'WEBDL-1080p', when: now - 2 * H, status: 'downloaded' },
        { key: 'd2', source: 'radarr', title: 'Arrival', subtitle: '2016', badge: 'Bluray-2160p', when: now - 5 * H, status: 'downloaded' },
        { key: 'd3', source: 'sonarr', title: 'Severance', subtitle: 'S02E01–E03 · 3 episodes', badge: 'WEBDL-2160p', when: now - 26 * H, status: 'downloaded' },
        { key: 'd4', source: 'lidarr', title: 'In Rainbows', subtitle: 'Radiohead', badge: 'FLAC', when: now - 30 * H, status: 'downloaded' },
        { key: 'd5', source: 'radarr', title: 'Paddington 2', subtitle: '2017', badge: 'WEBDL-1080p', when: now - 50 * H, status: 'downloaded' },
      ]);
    case 'queue':
      return {
        results: [{
          source: 'sonarr',
          items: [
            { key: 'q1', source: 'sonarr', title: 'Slow Horses', subtitle: 'S04E02 · Hello Goodbye', badge: 'WEBDL-1080p', status: 'downloading', progress: 0.62, size: 2.1e9, sizeLeft: 0.8e9, timeLeft: '00:04:12' },
            { key: 'q2', source: 'radarr', title: 'Dune: Part Two', subtitle: '2024', badge: 'Bluray-2160p', status: 'downloading', progress: 0.18, size: 48e9, sizeLeft: 39e9, timeLeft: '00:41:30' },
            { key: 'q3', source: 'lidarr', title: 'Blue Rev', subtitle: 'Alvvays', badge: 'FLAC', status: 'importing', progress: 1, size: 0.4e9, sizeLeft: 0 },
            { key: 'q4', source: 'sabnzbd', title: 'Some Linux ISO x64', status: 'queued', progress: 0, size: 4.4e9, sizeLeft: 4.4e9 },
          ],
        }],
        sab: { speed: '38.2 MB/s', timeLeft: '0:45:42', count: 4 },
        unconfigured: [],
      };
    case 'requests':
      return mk([
        { key: 'r1', source: 'seerr', title: 'The Wild Robot', subtitle: 'Movie · by Sam', badge: '2024', when: now - 1 * H, status: 'pending' },
        { key: 'r2', source: 'seerr', title: 'Bluey', subtitle: 'Season 3 · by Alex', badge: '2018', when: now - 20 * H, status: 'approved' },
        { key: 'r3', source: 'seerr', title: 'Inside Out 2', subtitle: 'Movie · by Sam', badge: '2024', when: now - 70 * H, status: 'available' },
      ]);
    default:
      return mk([
        { key: 'u1', source: 'sonarr', title: 'The Last of Us', subtitle: 'S02E04 · Day One', badge: 'HBO', when: now - 20 * H, status: 'downloaded', dateOnly: today },
        { key: 'u2', source: 'radarr', title: 'Wicked: For Good', subtitle: '2025', badge: 'Digital', dateOnly: today, status: 'missing' },
        { key: 'u3', source: 'sonarr', title: 'Andor', subtitle: 'S02E07 · Messenger', badge: 'Disney+', when: now + 4 * H, status: 'upcoming' },
        { key: 'u4', source: 'lidarr', title: 'Hurry Up Tomorrow', subtitle: 'The Weeknd', badge: 'Album', dateOnly: addDays(today, 1), status: 'upcoming' },
        { key: 'u5', source: 'sonarr', title: 'Severance', subtitle: 'S02E08 · Sweet Vitriol', badge: 'Apple TV+', when: now + 50 * H, status: 'upcoming' },
        { key: 'u6', source: 'radarr', title: 'Zootopia 2', subtitle: '2025', badge: 'Digital + Physical', dateOnly: addDays(today, 4), status: 'upcoming' },
      ]);
  }
}
