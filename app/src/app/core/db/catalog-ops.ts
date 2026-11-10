import type { Database } from 'sql.js';
import { EpisodeInfo, MediaDirectory, MediaInfo, MediaType, NewMediaItem } from './schema';

/** Catalog read/write helpers over a raw sql.js Database, shared by the
 * Angular MediaDbService and the catalog-sync Lambda
 * (infra/lambda/catalog-sync) — the Lambda is what inserts items now, the
 * app only edits/deletes them, and both need the same row layout. */

/** Bumped whenever enrichment starts collecting something new, so the
 * catalog-sync Lambda knows which existing items to enrich again. 2 = TMDb
 * backdrops, ratings, runtimes, cast photos, per-episode details. */
export const CURRENT_META_VERSION = 2;

export interface ExtraJson {
  subtitles?: string[];
  /** Alternate-language audio sidecars, played in sync with the video. */
  audio?: string[];
  info?: MediaInfo;
  /** S3 key of the wide background image (movie, or the episode's show). */
  backdrop?: string;
  episode?: EpisodeInfo;
  /** CURRENT_META_VERSION at the time this item was last enriched. */
  metaVersion?: number;
}

export function parseExtra(extraJson: string | null): ExtraJson {
  if (!extraJson) {
    return {};
  }
  try {
    return JSON.parse(extraJson) as ExtraJson;
  } catch {
    return {};
  }
}

function serializeExtra(extra: ExtraJson): string | null {
  const clean: ExtraJson = {};
  if (extra.subtitles?.length) {
    clean.subtitles = extra.subtitles;
  }
  if (extra.audio?.length) {
    clean.audio = extra.audio;
  }
  if (extra.info) {
    clean.info = extra.info;
  }
  if (extra.backdrop) {
    clean.backdrop = extra.backdrop;
  }
  if (extra.episode && Object.values(extra.episode).some((v) => v !== undefined)) {
    clean.episode = extra.episode;
  }
  if (extra.metaVersion) {
    clean.metaVersion = extra.metaVersion;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

export function listDirectoryRows(db: Database): MediaDirectory[] {
  const result = db.exec('SELECT id, s3_prefix, category_key, media_type, display_name, created_at FROM media_directories');
  return (result[0]?.values ?? []).map((v) => ({
    id: v[0] as number,
    s3Prefix: v[1] as string,
    categoryKey: v[2] as string,
    mediaType: v[3] as MediaType,
    displayName: v[4] as string,
    createdAt: v[5] as string,
  }));
}

export interface SyncItemRow {
  id: number;
  s3Key: string;
  thumbnailS3Key: string | null;
  extra: ExtraJson;
}

export function listSyncItemRows(db: Database, directoryId: number): SyncItemRow[] {
  const stmt = db.prepare('SELECT id, s3_key, thumbnail_s3_key, extra_json FROM media_items WHERE directory_id = :dir');
  try {
    stmt.bind({ ':dir': directoryId });
    const rows: SyncItemRow[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        id: row['id'] as number,
        s3Key: row['s3_key'] as string,
        thumbnailS3Key: (row['thumbnail_s3_key'] as string | null) ?? null,
        extra: parseExtra(row['extra_json'] as string | null),
      });
    }
    return rows;
  } finally {
    stmt.free();
  }
}

export function insertMediaItem(db: Database, item: NewMediaItem): number {
  db.run(
    'INSERT INTO media_items (media_type, directory_id, s3_key, title, thumbnail_s3_key, extra_json) VALUES (:type, :dir, :key, :title, :thumb, :extra)',
    {
      ':type': item.mediaType,
      ':dir': item.directoryId,
      ':key': item.s3Key,
      ':title': item.title,
      ':thumb': item.thumbnailS3Key ?? null,
      ':extra': serializeExtra({
        subtitles: item.subtitleS3Keys,
        audio: item.audioS3Keys,
        info: item.info,
        backdrop: item.backdropS3Key,
        episode: item.episode,
        metaVersion: CURRENT_META_VERSION,
      }),
    },
  );
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0] as number;
  if (item.mediaType === 'tvshow' && item.tvMeta) {
    db.run(
      'INSERT INTO tvshow_episode_meta (media_item_id, show_title, season, episode, episode_title) VALUES (:id, :show, :season, :episode, :etitle)',
      {
        ':id': id,
        ':show': item.tvMeta.showTitle,
        ':season': item.tvMeta.season,
        ':episode': item.tvMeta.episode,
        ':etitle': item.tvMeta.episodeTitle ?? null,
      },
    );
  }
  if (item.mediaType === 'music' && item.musicMeta) {
    db.run('INSERT INTO music_meta (media_item_id, artist, album, track_number) VALUES (:id, :artist, :album, :track)', {
      ':id': id,
      ':artist': item.musicMeta.artist,
      ':album': item.musicMeta.album,
      ':track': item.musicMeta.trackNumber ?? null,
    });
  }
  return id;
}

/** Updates only the file-derived columns (sidecar subtitles and audio,
 * thumbnail) of an existing item — never its title or TV/music metadata,
 * which the admin may have edited by hand. */
export function updateSidecars(db: Database, row: SyncItemRow, subtitles: string[], audio: string[], thumbnailS3Key: string | null): void {
  db.run('UPDATE media_items SET thumbnail_s3_key = :thumb, extra_json = :extra WHERE id = :id', {
    ':thumb': thumbnailS3Key,
    ':extra': serializeExtra({ ...row.extra, subtitles, audio }),
    ':id': row.id,
  });
}

/** Replaces an existing item's looked-up metadata (plot/cast/backdrop/
 * episode details) and fills in its thumbnail if it had none — never its
 * title or TV/music metadata, which the admin may have edited by hand. */
export function updateEnrichment(
  db: Database,
  row: SyncItemRow,
  enrichment: { info?: MediaInfo; backdrop?: string; episode?: EpisodeInfo; thumbnailS3Key?: string },
): void {
  db.run('UPDATE media_items SET thumbnail_s3_key = COALESCE(thumbnail_s3_key, :thumb), extra_json = :extra WHERE id = :id', {
    ':thumb': enrichment.thumbnailS3Key ?? null,
    ':extra': serializeExtra({
      ...row.extra,
      info: enrichment.info ?? row.extra.info,
      backdrop: enrichment.backdrop ?? row.extra.backdrop,
      episode: enrichment.episode ?? row.extra.episode,
      metaVersion: CURRENT_META_VERSION,
    }),
    ':id': row.id,
  });
}

/** sql.js defaults foreign key enforcement off, so ON DELETE CASCADE in the
 * schema is inert — extension rows are deleted explicitly. */
export function deleteMediaItemRows(db: Database, id: number): void {
  db.run('DELETE FROM tvshow_episode_meta WHERE media_item_id = :id', { ':id': id });
  db.run('DELETE FROM music_meta WHERE media_item_id = :id', { ':id': id });
  db.run('DELETE FROM photo_meta WHERE media_item_id = :id', { ':id': id });
  db.run('DELETE FROM media_item_tags WHERE media_item_id = :id', { ':id': id });
  db.run('DELETE FROM media_items WHERE id = :id', { ':id': id });
}

/** Removes every item of one directory (when the directory itself is
 * deleted from the catalog). Returns how many were removed. */
export function deleteDirectoryItemRows(db: Database, directoryId: number): number {
  return deleteItemsWhere(db, 'SELECT id FROM media_items WHERE directory_id = :dir', { ':dir': directoryId });
}

/** Removes items whose directory no longer exists — left behind by
 * directory deletions made before deleteDirectoryItemRows existed. */
export function deleteOrphanItemRows(db: Database): number {
  return deleteItemsWhere(db, 'SELECT id FROM media_items WHERE directory_id NOT IN (SELECT id FROM media_directories)');
}

function deleteItemsWhere(db: Database, selectIdsSql: string, params?: Record<string, number>): number {
  const stmt = db.prepare(selectIdsSql);
  const ids: number[] = [];
  try {
    if (params) {
      stmt.bind(params);
    }
    while (stmt.step()) {
      ids.push(stmt.getAsObject()['id'] as number);
    }
  } finally {
    stmt.free();
  }
  for (const id of ids) {
    deleteMediaItemRows(db, id);
  }
  return ids.length;
}
