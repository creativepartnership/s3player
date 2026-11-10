import { Injectable, signal } from '@angular/core';

export interface WatchProgress {
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
  updatedAt: string;
}

const STORAGE_PREFIX = 's3player.watch.';
/** Fraction of the way through playback at which an item counts as "watched". */
const WATCHED_THRESHOLD = 0.9;

/**
 * Tracks per-item playback position and watched status in localStorage.
 *
 * This is deliberately per-browser, not synced through the shared SQLite
 * catalog: regular (non-admin) users only ever get read access to the media
 * bucket (see infra/lib/s3player-stack.ts — the Users IAM role has no
 * PutObject), so there is no write path available to them for persisting
 * progress server-side without changing that security model. Per-browser
 * storage is a reasonable trade-off for a personal/family media player.
 */
@Injectable({ providedIn: 'root' })
export class WatchProgressService {
  /** Bumped on every save, so computed()s and templates that read progress
   * update (localStorage itself isn't reactive). */
  private readonly version = signal(0);

  get(mediaItemId: number): WatchProgress | null {
    this.version();
    try {
      const raw = localStorage.getItem(this.key(mediaItemId));
      return raw ? (JSON.parse(raw) as WatchProgress) : null;
    } catch {
      return null;
    }
  }

  isWatched(mediaItemId: number): boolean {
    return this.get(mediaItemId)?.watched ?? false;
  }

  /** Everything with saved, unfinished progress — for a "Continue Watching" row.
   * Most-recently-updated first. */
  listInProgress(): { mediaItemId: number; progress: WatchProgress }[] {
    this.version();
    const results: { mediaItemId: number; progress: WatchProgress }[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(STORAGE_PREFIX)) {
          continue;
        }
        const mediaItemId = Number(key.slice(STORAGE_PREFIX.length));
        const raw = localStorage.getItem(key);
        if (!Number.isFinite(mediaItemId) || !raw) {
          continue;
        }
        try {
          const progress = JSON.parse(raw) as WatchProgress;
          if (!progress.watched && progress.positionSeconds > 0) {
            results.push({ mediaItemId, progress });
          }
        } catch {
          /* skip malformed entry */
        }
      }
    } catch {
      /* localStorage unavailable */
    }
    return results.sort((a, b) => b.progress.updatedAt.localeCompare(a.progress.updatedAt));
  }

  save(mediaItemId: number, positionSeconds: number, durationSeconds: number): void {
    if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return;
    }
    const watched = positionSeconds / durationSeconds >= WATCHED_THRESHOLD;
    const progress: WatchProgress = { positionSeconds, durationSeconds, watched, updatedAt: new Date().toISOString() };
    try {
      localStorage.setItem(this.key(mediaItemId), JSON.stringify(progress));
    } catch {
      /* ignore — storage full or unavailable, progress just won't persist */
    }
    this.version.update((v) => v + 1);
  }

  /** Forgets an item's progress ("start over" / "mark as unwatched"). */
  clear(mediaItemId: number): void {
    try {
      localStorage.removeItem(this.key(mediaItemId));
    } catch {
      /* ignore */
    }
    this.version.update((v) => v + 1);
  }

  /** Marks an item as fully watched without playing it. */
  markWatched(mediaItemId: number, durationSeconds = 1): void {
    this.save(mediaItemId, durationSeconds, durationSeconds);
  }

  private key(mediaItemId: number): string {
    return `${STORAGE_PREFIX}${mediaItemId}`;
  }
}
