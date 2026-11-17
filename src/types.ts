export type Source = 'sonarr' | 'radarr' | 'lidarr' | 'sabnzbd' | 'seerr';

export type View = 'upcoming' | 'recent' | 'queue' | 'requests';

export type Status =
  | 'downloaded'
  | 'partial'
  | 'missing'
  | 'downloading'
  | 'upcoming'
  | 'queued'
  | 'paused'
  | 'importing'
  | 'warning'
  | 'failed'
  | 'pending'
  | 'approved'
  | 'declined'
  | 'available';

/** A poster to load through the plugin proxy. `fallback` is tried if `url` fails. */
export interface PosterRef {
  url: string;
  /** Which app's API key the request needs, if any (CDN images need none). */
  auth?: Source;
  fallback?: string;
  /** Which app's API key the fallback needs, if any. */
  fallbackAuth?: Source;
}

/** One row/card on the wall, normalized across every app. */
export interface Item {
  key: string;
  source: Source;
  title: string;
  /** Second line: "S02E03 · Charlie Mike", artist, requester... */
  subtitle?: string;
  /** Small label such as "Digital", "WEBDL-2160p", "Movie". */
  badge?: string;
  /** Exact instant, when the source has one (episode air time, import time). */
  when?: number;
  /** Date-only value (YYYY-MM-DD) for sources that only know the day. */
  dateOnly?: string;
  status: Status;
  poster?: PosterRef;
  /** 0..1 for queue items. */
  progress?: number;
  /** Bytes still to download / total, for queue items. */
  sizeLeft?: number;
  size?: number;
  /** Human time-left string straight from the app ("0:12:31"). */
  timeLeft?: string;
  /** IDs used to match queue entries against calendar items. */
  downloadId?: string;
}

export interface SourceResult {
  source: Source;
  items: Item[];
  error?: string;
}

/** Plugin-level settings (manifest settingsSchema). */
export interface ArrSettings {
  sonarrUrl?: string;
  radarrUrl?: string;
  lidarrUrl?: string;
  sabnzbdUrl?: string;
  seerrUrl?: string;
  posterSource?: 'local' | 'remote';
}

/** Per-module config (manifest configSchema). */
export interface ArrConfig {
  view: View;
  title: string;
  showHeader: boolean;
  sources: Source[];
  layout: 'auto' | 'list' | 'posters';
  daysAhead: number;
  daysBack: number;
  recentDays: number;
  maxItems: number;
  showPosters: boolean;
  hideDownloaded: boolean;
  includeUnmonitored: boolean;
  showQueueState: boolean;
  groupEpisodes: boolean;
  radarrReleaseTypes: string[];
  requestFilter: string;
  refreshSeconds: number;
  queueRefreshSeconds: number;
  demo: boolean;
}
