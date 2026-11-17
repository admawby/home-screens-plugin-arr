// Posters are fetched through the plugin proxy (so local MediaCover images
// get the API key and the kiosk needs no route to the *arr hosts), then kept
// as blob: URLs for the life of the tab. Shared across every module instance.

import type { PosterRef, Source } from './types';
import { PLUGIN_ID } from './data';

const SECRET_HEADER: Partial<Record<Source, string>> = {
  sonarr: '{{sonarr_api_key}}',
  radarr: '{{radarr_api_key}}',
  lidarr: '{{lidarr_api_key}}',
};

const MAX_ENTRIES = 300;
const MAX_CONCURRENT = 3;
/** How long a missing poster stays missing before we try it again. */
const RETRY_AFTER_MS = 10 * 60_000;
/** After the proxy's rate limit (shared by every display on the hub) says no. */
const RATE_LIMIT_BACKOFF_MS = 20_000;

interface Entry {
  url: string | null;
  promise?: Promise<string | null>;
  /** Don't try again before this time. */
  retryAt?: number;
}

class RateLimited extends Error {}

const cache = new Map<string, Entry>();
let active = 0;
const waiting: Array<() => void> = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function fetchOne(url: string, auth?: Source): Promise<string | null> {
  const sdk = window.__HS_SDK__;
  if (!sdk?.pluginFetch) return null;
  const header = auth ? SECRET_HEADER[auth] : undefined;
  const res = await sdk.pluginFetch(PLUGIN_ID, {
    url,
    secretInjections: header ? { header: { 'X-Api-Key': header } } : undefined,
    cacheTtlMs: 0, // the proxy only caches text; we cache the blob ourselves
  });
  if (res.status === 429) throw new RateLimited();
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return null;
  const blob = await res.blob();
  if (blob.size === 0) return null;
  return URL.createObjectURL(blob);
}

function evict() {
  while (cache.size > MAX_ENTRIES) {
    const [oldest, entry] = cache.entries().next().value as [string, Entry];
    if (entry.url) URL.revokeObjectURL(entry.url);
    cache.delete(oldest);
  }
}

/** A loaded poster URL, `null` if it's known to be missing, `undefined` if not tried yet. */
export function cachedPoster(ref: PosterRef | undefined): string | null | undefined {
  if (!ref) return null;
  const e = cache.get(ref.url);
  if (!e) return undefined;
  if (e.url) return e.url;
  if (e.promise) return undefined;
  return e.retryAt && Date.now() < e.retryAt ? null : undefined;
}

/** When a poster that failed may be tried again (for scheduling a retry). */
export function posterRetryAt(ref: PosterRef | undefined): number | undefined {
  return ref ? cache.get(ref.url)?.retryAt : undefined;
}

export function loadPoster(ref: PosterRef): Promise<string | null> {
  const existing = cache.get(ref.url);
  if (existing) {
    if (existing.url) return Promise.resolve(existing.url);
    if (existing.promise) return existing.promise;
    if (existing.retryAt && Date.now() < existing.retryAt) return Promise.resolve(null);
  }
  const entry: Entry = { url: null };
  let backoff = RETRY_AFTER_MS;
  entry.promise = slot(async () => {
    try {
      let url = await fetchOne(ref.url, ref.auth);
      if (!url && ref.fallback) {
        url = await fetchOne(ref.fallback, ref.fallbackAuth);
      }
      return url;
    } catch (err) {
      if (err instanceof RateLimited) backoff = RATE_LIMIT_BACKOFF_MS;
      return null;
    }
  }).then((url) => {
    entry.url = url;
    entry.promise = undefined;
    if (!url) entry.retryAt = Date.now() + backoff;
    return url;
  });
  cache.set(ref.url, entry);
  evict();
  return entry.promise;
}
