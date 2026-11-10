import { Injectable, inject, signal } from '@angular/core';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { GetObjectResult, S3Service } from '../aws/s3.service';
import { deleteDirectoryItemRows, deleteMediaItemRows, ExtraJson, parseExtra } from './catalog-ops';
import {
  AlbumSummary,
  CATALOG_S3_KEY,
  EpisodeRow,
  MediaDirectory,
  MediaInfo,
  MediaItem,
  MediaType,
  MusicMeta,
  SCHEMA_SQL,
  ShowSummary,
  TvShowMeta,
} from './schema';

/** Thrown when a save keeps losing the ETag race against other writers (the
 * catalog-sync Lambda, another admin tab) even after reloading and
 * re-applying the edit a few times. */
export class CatalogConflictError extends Error {
  constructor() {
    super('The library is being updated elsewhere right now. Try again in a minute.');
  }
}

const MAX_MUTATION_ATTEMPTS = 3;

export const APP_TITLE_SETTING_KEY = 'app_title';
export const DEFAULT_APP_TITLE = 'My media';

let sqlJsModulePromise: ReturnType<typeof initSqlJs> | null = null;
function loadSqlJs() {
  sqlJsModulePromise ??= initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
  return sqlJsModulePromise;
}

/** Loads the sql.js-backed catalog from S3, exposes typed query/mutation
 * helpers over it, and persists it back after every mutation. The whole
 * catalog lives in memory — see project plan for why (small personal
 * library, fetch/edit/replace pattern rather than a long-lived local DB). */
@Injectable({ providedIn: 'root' })
export class MediaDbService {
  private readonly s3 = inject(S3Service);

  private db: Database | null = null;
  private lastEtag: string | undefined;
  private loadPromise: Promise<void> | null = null;
  /** True while a mutation is being saved — a background reload must not
   * swap the database out from under it. */
  private mutating = false;

  readonly ready = signal(false);
  readonly appTitle = signal(DEFAULT_APP_TITLE);
  /** Bumped whenever the in-memory catalog changes (load, background reload,
   * successful edit). The read helpers below are plain synchronous queries,
   * so computed()s that list catalog content read this to know when to
   * re-run. */
  readonly version = signal(0);

  /** Idempotent — safe to call from multiple components; only loads once. */
  async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    this.replaceDb(await loadSqlJs(), await this.s3.getObject(CATALOG_S3_KEY));
    this.ready.set(true);
  }

  private replaceDb(SQL: SqlJsStatic, catalog: GetObjectResult | null): void {
    this.db?.close();
    this.db = catalog ? new SQL.Database(catalog.bytes) : new SQL.Database();
    this.lastEtag = catalog?.etag;
    this.db.run(SCHEMA_SQL);
    this.appTitle.set(this.getSetting(APP_TITLE_SETTING_KEY) ?? DEFAULT_APP_TITLE);
    this.version.update((v) => v + 1);
  }

  /** Re-fetches the catalog if it changed in S3 since it was loaded here —
   * the catalog-sync Lambda adds/removes items in the background as files
   * land in or leave the bucket. A cheap conditional GET when nothing
   * changed. Returns true if a newer catalog was loaded. */
  async reloadIfChanged(): Promise<boolean> {
    await this.ensureLoaded();
    if (this.mutating) {
      return false;
    }
    const result = await this.s3.getObjectIfChanged(CATALOG_S3_KEY, this.lastEtag);
    if (result === 'unchanged' || (result === null && this.lastEtag === undefined) || this.mutating) {
      return false;
    }
    this.replaceDb(await loadSqlJs(), result);
    return true;
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('MediaDbService used before ensureLoaded() completed.');
    }
    return this.db;
  }

  /** Applies an edit and saves it. If the save loses the ETag race — almost
   * always because the catalog-sync Lambda saved in between — the newer
   * catalog is loaded and the same edit re-applied on top of it, instead of
   * failing. Edits are all "by id" operations, so re-applying is safe. */
  private async mutate(apply: (db: Database) => void): Promise<void> {
    this.mutating = true;
    try {
      for (let attempt = 1; ; attempt++) {
        apply(this.requireDb());
        try {
          await this.persist();
          this.version.update((v) => v + 1);
          return;
        } catch (err) {
          if (!(err instanceof CatalogConflictError) || attempt >= MAX_MUTATION_ATTEMPTS) {
            throw err;
          }
          this.replaceDb(await loadSqlJs(), await this.s3.getObject(CATALOG_S3_KEY));
        }
      }
    } finally {
      this.mutating = false;
    }
  }

  /** Serializes the in-memory database and writes it back to S3, guarded by
   * the ETag captured at load/last-save time. Throws CatalogConflictError if
   * someone else wrote in the meantime (see S3Service.putObject's IfMatch). */
  private async persist(): Promise<void> {
    const db = this.requireDb();
    const bytes = db.export();
    try {
      const result = await this.s3.putObject(CATALOG_S3_KEY, bytes, this.lastEtag);
      this.lastEtag = result.etag;
    } catch (err) {
      if (this.isConflict(err)) {
        throw new CatalogConflictError();
      }
      throw err;
    }
  }

  /** 412: ETag mismatch. 409: S3 saw two conditional writes race. */
  private isConflict(err: unknown): boolean {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return status === 412 || status === 409;
  }

  // ---------------------------------------------------------------------
  // app_settings
  // ---------------------------------------------------------------------

  getSetting(key: string): string | null {
    const db = this.requireDb();
    const stmt = db.prepare('SELECT value FROM app_settings WHERE key = :key');
    try {
      stmt.bind({ ':key': key });
      return stmt.step() ? (stmt.getAsObject()['value'] as string) : null;
    } finally {
      stmt.free();
    }
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.mutate((db) =>
      db.run('INSERT INTO app_settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = :value', {
        ':key': key,
        ':value': value,
      }),
    );
    if (key === APP_TITLE_SETTING_KEY) {
      this.appTitle.set(value || DEFAULT_APP_TITLE);
    }
  }

  // ---------------------------------------------------------------------
  // media_directories
  // ---------------------------------------------------------------------

  listDirectories(): MediaDirectory[] {
    return this.queryAll(
      'SELECT id, s3_prefix, category_key, media_type, display_name, created_at FROM media_directories ORDER BY display_name',
      (row) => ({
        id: row['id'] as number,
        s3Prefix: row['s3_prefix'] as string,
        categoryKey: row['category_key'] as string,
        mediaType: row['media_type'] as MediaType,
        displayName: row['display_name'] as string,
        createdAt: row['created_at'] as string,
      }),
    );
  }

  /** Returns the directory's id (newly assigned for an insert). */
  async upsertDirectory(dir: Omit<MediaDirectory, 'createdAt' | 'id'> & { id?: number }): Promise<number> {
    let id = dir.id;
    await this.mutate((db) => {
      if (dir.id == null) {
        db.run(
          'INSERT INTO media_directories (s3_prefix, category_key, media_type, display_name) VALUES (:prefix, :category, :type, :name)',
          { ':prefix': dir.s3Prefix, ':category': dir.categoryKey, ':type': dir.mediaType, ':name': dir.displayName },
        );
        id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0] as number;
      } else {
        db.run(
          'UPDATE media_directories SET s3_prefix = :prefix, category_key = :category, media_type = :type, display_name = :name WHERE id = :id',
          { ':prefix': dir.s3Prefix, ':category': dir.categoryKey, ':type': dir.mediaType, ':name': dir.displayName, ':id': dir.id },
        );
      }
    });
    return id!;
  }

  /** Removes the directory and its items from the catalog. The files stay
   * in S3 (deleting a whole category's media is a step to take on purpose,
   * in the S3 console/CLI). */
  async deleteDirectory(id: number): Promise<void> {
    await this.mutate((db) => {
      deleteDirectoryItemRows(db, id);
      db.run('DELETE FROM media_directories WHERE id = :id', { ':id': id });
    });
  }

  // ---------------------------------------------------------------------
  // media_items — inserted only by the catalog-sync Lambda (from what's in
  // the bucket); the app reads, renames and deletes them.
  // ---------------------------------------------------------------------

  listMediaItems(directoryId?: number): MediaItem[] {
    const sql = directoryId == null
      ? 'SELECT id, media_type, directory_id, s3_key, title, thumbnail_s3_key, duration_seconds, date_added, extra_json FROM media_items ORDER BY title'
      : 'SELECT id, media_type, directory_id, s3_key, title, thumbnail_s3_key, duration_seconds, date_added, extra_json FROM media_items WHERE directory_id = :dir ORDER BY title';
    return this.queryAll(
      sql,
      (row) => this.mapMediaItemRow(row),
      directoryId == null ? undefined : { ':dir': directoryId },
    );
  }

  async renameMediaItem(id: number, title: string): Promise<void> {
    await this.mutate((db) => db.run('UPDATE media_items SET title = :title WHERE id = :id', { ':title': title, ':id': id }));
  }

  /** Deletes the item's files from the media bucket — the video/track/photo
   * itself, its subtitles (plus the .srt each .vtt was converted from), its
   * alternate-language audio files, and its artwork unless other items share it (a show's poster, an album's
   * cover) — then the catalog row. The catalog-sync Lambda would remove the
   * row on its own once it sees the deletion; removing it here too just
   * makes the UI update immediately. */
  async deleteMediaItemWithFiles(id: number): Promise<void> {
    const files = this.filesOf(id);
    if (!files) {
      return;
    }
    await this.s3.deleteObjects([files.video, ...files.subtitles, ...files.audio, ...files.artwork]);
    await this.mutate((db) => deleteMediaItemRows(db, id));
  }

  /** What deleting an item removes from the bucket: the file itself, its
   * subtitles (plus the .srt each .vtt was converted from), and its artwork
   * (poster, backdrop, episode still) unless other items use it too (a
   * show's poster, an album's cover). Null if the item doesn't exist. */
  filesOf(id: number): { video: string; subtitles: string[]; audio: string[]; artwork: string[] } | null {
    const item = this.getMediaItem(id);
    if (!item) {
      return null;
    }
    const extra = parseExtra(item.extraJson);
    const subtitles = new Set<string>();
    for (const subtitle of extra.subtitles ?? []) {
      subtitles.add(subtitle);
      if (/\.vtt$/i.test(subtitle)) {
        subtitles.add(subtitle.replace(/\.vtt$/i, '.srt'));
      }
    }
    const artwork = [item.thumbnailS3Key, extra.backdrop, extra.episode?.stillS3Key].filter(
      (key): key is string => !!key && key !== item.s3Key && !this.isArtworkShared(key, id),
    );
    return { video: item.s3Key, subtitles: [...subtitles], audio: extra.audio ?? [], artwork: [...new Set(artwork)] };
  }

  private isArtworkShared(key: string, exceptId: number): boolean {
    return (
      this.queryAll(
        `SELECT 1 AS hit FROM media_items
         WHERE id != :id AND (thumbnail_s3_key = :key OR instr(extra_json, :quoted) > 0) LIMIT 1`,
        (row) => row['hit'],
        { ':key': key, ':quoted': JSON.stringify(key), ':id': exceptId },
      ).length > 0
    );
  }


  getDirectory(id: number): MediaDirectory | null {
    return this.listDirectories().find((d) => d.id === id) ?? null;
  }

  getMediaItem(id: number): MediaItem | null {
    return this.queryAll(
      'SELECT id, media_type, directory_id, s3_key, title, thumbnail_s3_key, duration_seconds, date_added, extra_json FROM media_items WHERE id = :id',
      (row) => this.mapMediaItemRow(row),
      { ':id': id },
    )[0] ?? null;
  }

  // ---------------------------------------------------------------------
  // Hierarchical browsing: shows -> seasons -> episodes, artists -> albums ->
  // tracks. All derived from tvshow_episode_meta / music_meta columns that
  // already existed — no folder/tree table needed.
  // ---------------------------------------------------------------------

  listShowTitles(directoryId: number): string[] {
    return this.queryAll(
      `SELECT DISTINCT t.show_title AS show_title
       FROM tvshow_episode_meta t JOIN media_items m ON m.id = t.media_item_id
       WHERE m.directory_id = :dir ORDER BY t.show_title`,
      (row) => row['show_title'] as string,
      { ':dir': directoryId },
    );
  }

  listSeasons(directoryId: number, showTitle: string): number[] {
    return this.queryAll(
      `SELECT DISTINCT t.season AS season
       FROM tvshow_episode_meta t JOIN media_items m ON m.id = t.media_item_id
       WHERE m.directory_id = :dir AND t.show_title = :show ORDER BY t.season`,
      (row) => row['season'] as number,
      { ':dir': directoryId, ':show': showTitle },
    );
  }

  listEpisodes(directoryId: number, showTitle: string, season: number): MediaItem[] {
    return this.queryAll(
      `SELECT m.id, m.media_type, m.directory_id, m.s3_key, m.title, m.thumbnail_s3_key, m.duration_seconds, m.date_added, m.extra_json
       FROM media_items m JOIN tvshow_episode_meta t ON m.id = t.media_item_id
       WHERE m.directory_id = :dir AND t.show_title = :show AND t.season = :season
       ORDER BY t.episode`,
      (row) => this.mapMediaItemRow(row),
      { ':dir': directoryId, ':show': showTitle, ':season': season },
    );
  }

  listArtists(directoryId: number): string[] {
    return this.queryAll(
      `SELECT DISTINCT mm.artist AS artist
       FROM music_meta mm JOIN media_items m ON m.id = mm.media_item_id
       WHERE m.directory_id = :dir ORDER BY mm.artist`,
      (row) => row['artist'] as string,
      { ':dir': directoryId },
    );
  }

  listAlbums(directoryId: number, artist: string): { album: string; thumbnailS3Key: string | null }[] {
    return this.queryAll(
      `SELECT mm.album AS album, MAX(m.thumbnail_s3_key) AS thumbnail_s3_key
       FROM music_meta mm JOIN media_items m ON m.id = mm.media_item_id
       WHERE m.directory_id = :dir AND mm.artist = :artist
       GROUP BY mm.album ORDER BY mm.album`,
      (row) => ({ album: row['album'] as string, thumbnailS3Key: (row['thumbnail_s3_key'] as string | null) ?? null }),
      { ':dir': directoryId, ':artist': artist },
    );
  }

  listTracks(directoryId: number, artist: string, album: string): MediaItem[] {
    return this.queryAll(
      `SELECT m.id, m.media_type, m.directory_id, m.s3_key, m.title, m.thumbnail_s3_key, m.duration_seconds, m.date_added, m.extra_json
       FROM media_items m JOIN music_meta mm ON m.id = mm.media_item_id
       WHERE m.directory_id = :dir AND mm.artist = :artist AND mm.album = :album
       ORDER BY mm.track_number`,
      (row) => this.mapMediaItemRow(row),
      { ':dir': directoryId, ':artist': artist, ':album': album },
    );
  }

  getTvMeta(mediaItemId: number): TvShowMeta | null {
    return this.queryAll(
      'SELECT show_title, season, episode, episode_title FROM tvshow_episode_meta WHERE media_item_id = :id',
      (row) => ({
        showTitle: row['show_title'] as string,
        season: row['season'] as number,
        episode: row['episode'] as number,
        episodeTitle: (row['episode_title'] as string | null) ?? undefined,
      }),
      { ':id': mediaItemId },
    )[0] ?? null;
  }

  getMusicMeta(mediaItemId: number): MusicMeta | null {
    return this.queryAll(
      'SELECT artist, album, track_number FROM music_meta WHERE media_item_id = :id',
      (row) => ({
        artist: row['artist'] as string,
        album: row['album'] as string,
        trackNumber: (row['track_number'] as number | null) ?? undefined,
      }),
      { ':id': mediaItemId },
    )[0] ?? null;
  }

  /** Plot/cast/etc looked up by the catalog-sync Lambda (TMDb), parsed out
   * of extra_json. Absent when TMDb had no match. */
  getMediaInfo(mediaItemId: number): MediaInfo | null {
    const item = this.getMediaItem(mediaItemId);
    return this.parseInfo(item?.extraJson ?? null);
  }

  /** Poster + plot/cast for a whole show, since that's stored once (via the
   * enrichment cache) but denormalized onto every episode row — reads
   * whichever episode has it rather than requiring a per-show table. */
  getShowInfo(directoryId: number, showTitle: string): { thumbnailS3Key: string | null; info: MediaInfo | null } | null {
    const rows = this.queryAll(
      `SELECT m.thumbnail_s3_key, m.extra_json
       FROM media_items m JOIN tvshow_episode_meta t ON m.id = t.media_item_id
       WHERE m.directory_id = :dir AND t.show_title = :show
       ORDER BY (m.thumbnail_s3_key IS NULL), (m.extra_json IS NULL)`,
      (row) => ({
        thumbnailS3Key: (row['thumbnail_s3_key'] as string | null) ?? null,
        info: this.parseInfo(row['extra_json'] as string | null),
      }),
      { ':dir': directoryId, ':show': showTitle },
    );
    return rows[0] ?? null;
  }

  /** One row per show in the directory, with what a show card needs:
   * poster, backdrop and TMDb info are denormalized onto every episode, so
   * they're read from whichever episode has them. */
  listShows(directoryId?: number): ShowSummary[] {
    return this.queryAll(
      `SELECT m.directory_id AS directory_id, t.show_title AS show_title, COUNT(*) AS episodes,
         COUNT(DISTINCT t.season) AS seasons, MAX(m.date_added) AS latest, MAX(m.thumbnail_s3_key) AS thumb,
         MAX(CASE WHEN m.extra_json LIKE '%"info"%' OR m.extra_json LIKE '%"backdrop"%' THEN m.extra_json END) AS extra
       FROM tvshow_episode_meta t JOIN media_items m ON m.id = t.media_item_id
       ${directoryId == null ? '' : 'WHERE m.directory_id = :dir'}
       GROUP BY m.directory_id, t.show_title ORDER BY t.show_title`,
      (row) => {
        const extra = parseExtra(row['extra'] as string | null);
        return {
          directoryId: row['directory_id'] as number,
          title: row['show_title'] as string,
          episodes: row['episodes'] as number,
          seasons: row['seasons'] as number,
          latestAdded: row['latest'] as string,
          posterS3Key: (row['thumb'] as string | null) ?? null,
          backdropS3Key: extra.backdrop ?? null,
          info: extra.info ?? null,
        };
      },
      directoryId == null ? undefined : { ':dir': directoryId },
    );
  }

  getShow(directoryId: number, showTitle: string): ShowSummary | null {
    return this.listShows(directoryId).find((s) => s.title === showTitle) ?? null;
  }

  /** Every episode of a show, in viewing order. */
  listShowEpisodes(directoryId: number, showTitle: string): EpisodeRow[] {
    return this.queryAll(
      `SELECT m.id, m.media_type, m.directory_id, m.s3_key, m.title, m.thumbnail_s3_key, m.duration_seconds, m.date_added, m.extra_json,
         t.season AS season, t.episode AS episode, t.episode_title AS episode_title
       FROM media_items m JOIN tvshow_episode_meta t ON m.id = t.media_item_id
       WHERE m.directory_id = :dir AND t.show_title = :show
       ORDER BY t.season, t.episode`,
      (row) => ({
        ...this.mapMediaItemRow(row),
        showTitle,
        season: row['season'] as number,
        episode: row['episode'] as number,
        episodeTitle: (row['episode_title'] as string | null) ?? undefined,
        details: parseExtra(row['extra_json'] as string | null).episode ?? null,
      }),
      { ':dir': directoryId, ':show': showTitle },
    );
  }

  /** One row per album (optionally only one directory's). */
  listAllAlbums(directoryId?: number): AlbumSummary[] {
    return this.queryAll(
      `SELECT m.directory_id AS directory_id, mm.artist AS artist, mm.album AS album, COUNT(*) AS tracks,
         MAX(m.thumbnail_s3_key) AS thumb, MAX(m.date_added) AS latest
       FROM music_meta mm JOIN media_items m ON m.id = mm.media_item_id
       ${directoryId == null ? '' : 'WHERE m.directory_id = :dir'}
       GROUP BY m.directory_id, mm.artist, mm.album ORDER BY mm.artist, mm.album`,
      (row) => ({
        directoryId: row['directory_id'] as number,
        artist: (row['artist'] as string | null) ?? '',
        album: (row['album'] as string | null) ?? '',
        tracks: row['tracks'] as number,
        coverS3Key: (row['thumb'] as string | null) ?? null,
        latestAdded: row['latest'] as string,
      }),
      directoryId == null ? undefined : { ':dir': directoryId },
    );
  }

  /** The parsed extra_json of an item (backdrop, episode details, …). */
  getExtra(item: MediaItem): ExtraJson {
    return parseExtra(item.extraJson);
  }

  private parseInfo(extraJson: string | null): MediaInfo | null {
    if (!extraJson) {
      return null;
    }
    try {
      const parsed = JSON.parse(extraJson) as { info?: MediaInfo };
      return parsed.info ?? null;
    } catch {
      return null;
    }
  }

  private mapMediaItemRow(row: Record<string, unknown>): MediaItem {
    return {
      id: row['id'] as number,
      mediaType: row['media_type'] as MediaType,
      directoryId: row['directory_id'] as number,
      s3Key: row['s3_key'] as string,
      title: row['title'] as string,
      thumbnailS3Key: row['thumbnail_s3_key'] as string | null,
      durationSeconds: row['duration_seconds'] as number | null,
      dateAdded: row['date_added'] as string,
      extraJson: row['extra_json'] as string | null,
    };
  }

  private queryAll<T>(sql: string, mapRow: (row: Record<string, unknown>) => T, params?: Record<string, unknown>): T[] {
    const db = this.requireDb();
    const stmt = db.prepare(sql);
    try {
      if (params) {
        stmt.bind(params as never);
      }
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(mapRow(stmt.getAsObject()));
      }
      return rows;
    } finally {
      stmt.free();
    }
  }
}
