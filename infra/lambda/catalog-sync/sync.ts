import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Database, SqlJsStatic } from 'sql.js';
import { CATALOG_S3_KEY, EpisodeInfo, MediaDirectory, NewMediaItem, SCHEMA_SQL } from '../../../app/src/app/core/db/schema';
import {
  CURRENT_META_VERSION,
  deleteMediaItemRows,
  deleteOrphanItemRows,
  insertMediaItem,
  listDirectoryRows,
  listSyncItemRows,
  SyncItemRow,
  updateEnrichment,
  updateSidecars,
} from '../../../app/src/app/core/db/catalog-ops';
import { classifyDirectoryFiles, ScanCandidate } from '../../../app/src/app/core/media/media-scan';
import {
  convertSubtitles,
  EnrichmentContext,
  enrichCandidates,
  fetchArtwork,
  MetadataProvider,
} from '../../../app/src/app/core/media/media-enrichment';

/** How many times to redo a sync whose catalog write lost the ETag race (an
 * admin edit, or another sync run, saved in between). */
const MAX_ATTEMPTS = 5;

export type SyncScope =
  | { kind: 'all' }
  | { kind: 'directories'; directoryIds: number[] }
  | { kind: 'keys'; keys: string[] };

export interface SyncSummary {
  directories: string[];
  added: number;
  updated: number;
  removed: number;
  /** Directories with enrichment work left over because the time budget ran
   * out; the caller queues a follow-up run for them. */
  pendingDirectoryIds: number[];
  /** How many items that left-over work covers. */
  pendingItems: number;
  /** Videos added by this run: the caller hands them to the transcode
   * function, which makes them playable in every browser if needed. */
  newVideoKeys: string[];
  /** Every video in the synced directories (for a full resync, so files
   * catalogued before the transcode function existed get checked too; it
   * skips files it has already seen). */
  videoKeys: string[];
}

export interface SyncDeps {
  s3: S3Client;
  bucket: string;
  SQL: SqlJsStatic;
  metadata: MetadataProvider;
  /** Epoch ms after which no new enrichment work is started (TMDb lookups
   * are the slow part); what's done by then is saved and the rest is
   * reported as pending. Omit for no limit. */
  deadline?: number;
}

/** Enrichment results that survive ETag-race retries within one invocation,
 * so a retry doesn't re-query TMDb or re-convert subtitles. Keyed by the
 * candidate's full S3 key. */
interface Caches {
  fresh: Map<string, ScanCandidate>;
  refreshed: Map<string, ScanCandidate>;
}

function emptySummary(): SyncSummary {
  return { directories: [], added: 0, updated: 0, removed: 0, pendingDirectoryIds: [], pendingItems: 0, newVideoKeys: [], videoKeys: [] };
}

/** Makes the catalog mirror the media bucket for the directories in scope:
 * every playable file the classifier finds becomes an item, sidecars
 * (subtitles/artwork) that arrived after their video are attached, items
 * whose file is gone are removed, and items enriched by an older version of
 * this code get the newer details. Idempotent — re-running it with nothing
 * changed in S3 writes nothing, which is what keeps the S3 events fired by
 * its own writes (converted .vtt, fetched images) from looping. */
export async function syncCatalog(deps: SyncDeps, scope: SyncScope): Promise<SyncSummary> {
  const caches: Caches = { fresh: new Map(), refreshed: new Map() };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const catalog = await loadCatalog(deps);
    if (!catalog) {
      // No catalog yet means no directories have been defined — nothing to sync into.
      return emptySummary();
    }
    const { db, etag } = catalog;
    try {
      const targets = resolveDirectories(listDirectoryRows(db), scope);
      const summary: SyncSummary = { ...emptySummary(), directories: targets.map((d) => d.displayName) };
      if (scope.kind === 'all') {
        summary.removed += deleteOrphanItemRows(db);
      }
      for (const dir of targets) {
        await syncDirectory(deps, db, dir, summary, caches);
      }
      if (summary.added + summary.updated + summary.removed === 0) {
        return summary;
      }
      try {
        await deps.s3.send(
          new PutObjectCommand({
            Bucket: deps.bucket,
            Key: CATALOG_S3_KEY,
            Body: db.export(),
            IfMatch: etag,
            ContentType: 'application/vnd.sqlite3',
          }),
        );
        return summary;
      } catch (err) {
        if (!isWriteConflict(err)) {
          throw err;
        }
        console.warn(`Catalog changed during sync (attempt ${attempt}/${MAX_ATTEMPTS}), retrying.`);
      }
    } finally {
      db.close();
    }
  }
  throw new Error(`Catalog sync gave up after ${MAX_ATTEMPTS} write conflicts.`);
}

function resolveDirectories(dirs: MediaDirectory[], scope: SyncScope): MediaDirectory[] {
  if (scope.kind === 'all') {
    return dirs;
  }
  if (scope.kind === 'directories') {
    return dirs.filter((d) => scope.directoryIds.includes(d.id));
  }
  // A key belongs to the directory with the longest matching prefix; keys
  // under no directory's prefix are simply not part of the library.
  const byPrefixLength = [...dirs].sort((a, b) => b.s3Prefix.length - a.s3Prefix.length);
  const hit = new Map<number, MediaDirectory>();
  for (const key of scope.keys) {
    const dir = byPrefixLength.find((d) => key.startsWith(d.s3Prefix));
    if (dir) {
      hit.set(dir.id, dir);
    }
  }
  return [...hit.values()];
}

/** Candidates that share looked-up artwork/details (one movie, one show, one
 * album) are enriched together, so a time-budget cut never splits them and
 * the show/album lookup happens once. */
function enrichmentGroupKey(dir: MediaDirectory, c: ScanCandidate): string {
  if (dir.mediaType === 'tvshow') {
    return `tv:${c.tvMeta?.showTitle ?? c.primaryRelativePath.split('/')[0]}`;
  }
  if (dir.mediaType === 'music' && c.musicMeta) {
    return `music:${c.musicMeta.artist}/${c.musicMeta.album}`;
  }
  return `item:${c.primaryRelativePath}`;
}

function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return [...groups.values()];
}

async function syncDirectory(
  deps: SyncDeps,
  db: Database,
  dir: MediaDirectory,
  summary: SyncSummary,
  caches: Caches,
): Promise<void> {
  const prefix = dir.s3Prefix;
  const objects = await listAllObjects(deps, prefix);
  const present = new Set(objects.map((o) => o.key.slice(prefix.length)));
  const candidates = classifyDirectoryFiles(
    dir.mediaType,
    dir.displayName,
    objects.map((o) => ({ relativePath: o.key.slice(prefix.length), size: o.size })),
  );

  const isVideo = dir.mediaType === 'movie' || dir.mediaType === 'tvshow';
  if (isVideo) {
    summary.videoKeys.push(...candidates.map((c) => prefix + c.primaryRelativePath));
  }

  const rows = listSyncItemRows(db, dir.id);
  const rowByKey = new Map(rows.map((r) => [r.s3Key, r]));
  const candidateKeys = new Set(candidates.map((c) => prefix + c.primaryRelativePath));

  for (const row of rows) {
    if (!candidateKeys.has(row.s3Key)) {
      deleteMediaItemRows(db, row.id);
      summary.removed++;
    }
  }

  const ctx: EnrichmentContext = {
    readSubtitleText: async (relativePath) => getText(deps, prefix + relativePath),
    writeText: async (relativePath, text, contentType) => {
      await putBytes(deps, prefix + relativePath, new TextEncoder().encode(text), contentType);
      present.add(relativePath);
    },
    writeBinary: async (relativePath, blob, contentType) => {
      await putBytes(deps, prefix + relativePath, new Uint8Array(await blob.arrayBuffer()), contentType);
      present.add(relativePath);
    },
    exists: (relativePath) => present.has(relativePath),
  };
  const full = (relativePath: string | undefined) => (relativePath ? prefix + relativePath : undefined);
  const outOfTime = () => deps.deadline !== undefined && Date.now() > deps.deadline;

  // Already-catalogued items: attach sidecars that showed up later (a .srt
  // uploaded after its video, a poster added to the folder) and drop ones
  // that were deleted. Title and TV/music metadata are left alone. Cheap
  // (no TMDb), so it always runs in full.
  const existing = candidates.filter((c) => rowByKey.has(prefix + c.primaryRelativePath));
  await convertSubtitles(existing, ctx);
  for (const c of existing) {
    const row = rowByKey.get(prefix + c.primaryRelativePath)!;
    const subtitles = c.subtitleRelativePaths.map((p) => prefix + p);
    const audio = (c.audioRelativePaths ?? []).map((p) => prefix + p);
    const currentThumbStillThere = row.thumbnailS3Key != null && present.has(row.thumbnailS3Key.slice(prefix.length));
    const thumbnail = currentThumbStillThere ? row.thumbnailS3Key : (full(c.thumbnailRelativePath) ?? null);
    if (!sameList(subtitles, row.extra.subtitles ?? []) || !sameList(audio, row.extra.audio ?? []) || thumbnail !== row.thumbnailS3Key) {
      updateSidecars(db, row, subtitles, audio, thumbnail);
      row.extra = { ...row.extra, subtitles, audio };
      row.thumbnailS3Key = thumbnail;
      summary.updated++;
    }
  }

  let pending = 0;

  // New files: enrich, then insert. A group not enriched before the deadline
  // is left out of the catalog for now (it's still "new" next run).
  const fresh = candidates.filter((c) => !rowByKey.has(prefix + c.primaryRelativePath));
  for (const group of groupBy(fresh, (c) => enrichmentGroupKey(dir, c))) {
    const todo = group.filter((c) => !caches.fresh.has(prefix + c.primaryRelativePath));
    if (todo.length > 0) {
      if (outOfTime()) {
        pending += group.length;
        continue;
      }
      await enrichCandidates(dir.mediaType, todo, deps.metadata, ctx);
      for (const c of todo) {
        caches.fresh.set(prefix + c.primaryRelativePath, c);
      }
    }
    for (const original of group) {
      const c = caches.fresh.get(prefix + original.primaryRelativePath)!;
      const item: NewMediaItem = {
        mediaType: dir.mediaType,
        directoryId: dir.id,
        s3Key: prefix + c.primaryRelativePath,
        title: c.title,
        tvMeta: dir.mediaType === 'tvshow' ? c.tvMeta : undefined,
        musicMeta: dir.mediaType === 'music' ? c.musicMeta : undefined,
        thumbnailS3Key: full(c.thumbnailRelativePath),
        subtitleS3Keys: c.subtitleRelativePaths.map((p) => prefix + p),
        audioS3Keys: (c.audioRelativePaths ?? []).map((p) => prefix + p),
        info: c.info,
        backdropS3Key: full(c.backdropRelativePath),
        episode: toEpisodeInfo(c, prefix),
      };
      insertMediaItem(db, item);
      summary.added++;
      if (isVideo) {
        summary.newVideoKeys.push(item.s3Key);
      }
    }
  }

  // Items enriched by an older version of this code (or never, e.g. before
  // a TMDb key was configured): look up the newer details once.
  if (dir.mediaType !== 'photo') {
    const stale = existing.filter((c) => (rowByKey.get(prefix + c.primaryRelativePath)!.extra.metaVersion ?? 0) < CURRENT_META_VERSION);
    for (const group of groupBy(stale, (c) => enrichmentGroupKey(dir, c))) {
      const todo = group.filter((c) => !caches.refreshed.has(prefix + c.primaryRelativePath));
      if (todo.length > 0) {
        if (outOfTime()) {
          pending += group.length;
          continue;
        }
        await fetchArtwork(dir.mediaType, todo, deps.metadata, ctx);
        for (const c of todo) {
          caches.refreshed.set(prefix + c.primaryRelativePath, c);
        }
      }
      for (const original of group) {
        const c = caches.refreshed.get(prefix + original.primaryRelativePath)!;
        const row: SyncItemRow = rowByKey.get(prefix + c.primaryRelativePath)!;
        updateEnrichment(db, row, {
          info: c.info,
          backdrop: full(c.backdropRelativePath),
          episode: toEpisodeInfo(c, prefix),
          thumbnailS3Key: full(c.thumbnailRelativePath),
        });
        summary.updated++;
      }
    }
  }

  if (pending > 0) {
    summary.pendingDirectoryIds.push(dir.id);
    summary.pendingItems += pending;
  }
}

function toEpisodeInfo(c: ScanCandidate, prefix: string): EpisodeInfo | undefined {
  if (!c.episode) {
    return undefined;
  }
  return {
    title: c.episode.title,
    overview: c.episode.overview,
    runtimeMinutes: c.episode.runtimeMinutes,
    stillS3Key: c.episode.stillRelativePath ? prefix + c.episode.stillRelativePath : undefined,
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function loadCatalog(deps: SyncDeps): Promise<{ db: Database; etag: string | undefined } | null> {
  try {
    const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: CATALOG_S3_KEY }));
    const bytes = await res.Body!.transformToByteArray();
    const db = new deps.SQL.Database(bytes);
    db.run(SCHEMA_SQL);
    return { db, etag: res.ETag };
  } catch (err) {
    if (err instanceof NoSuchKey) {
      return null;
    }
    throw err;
  }
}

async function listAllObjects(deps: SyncDeps, prefix: string): Promise<{ key: string; size: number }[]> {
  const results: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const res = await deps.s3.send(new ListObjectsV2Command({ Bucket: deps.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const obj of res.Contents ?? []) {
      // Zero-byte "folder" markers (created by the admin directory form) aren't files.
      if (obj.Key && !obj.Key.endsWith('/')) {
        results.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return results;
}

async function getText(deps: SyncDeps, key: string): Promise<string | undefined> {
  try {
    const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: key }));
    return await res.Body?.transformToString('utf-8');
  } catch (err) {
    if (err instanceof NoSuchKey) {
      return undefined;
    }
    throw err;
  }
}

async function putBytes(deps: SyncDeps, key: string, body: Uint8Array, contentType: string): Promise<void> {
  await deps.s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: body, ContentType: contentType }));
}

/** 412 = the catalog's ETag no longer matches (someone saved in between);
 * 409 = S3 saw two conditional writes race on the same key. Both mean
 * "reload and redo". */
function isWriteConflict(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 412 || status === 409;
}
