/** SQLite DDL for the catalog file stored at db/library.sqlite in the media
 * bucket. Run once against a freshly-created in-memory database, whether
 * that's a brand new (never-saved) catalog or one just loaded from S3 —
 * IF NOT EXISTS makes it safe either way. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  s3_prefix TEXT NOT NULL UNIQUE,
  category_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie','tvshow','music','photo')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie','tvshow','music','photo')),
  directory_id INTEGER NOT NULL REFERENCES media_directories(id),
  s3_key TEXT NOT NULL,
  title TEXT NOT NULL,
  thumbnail_s3_key TEXT,
  duration_seconds INTEGER,
  date_added TEXT NOT NULL DEFAULT (datetime('now')),
  extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(media_type);
CREATE INDEX IF NOT EXISTS idx_media_items_directory ON media_items(directory_id);

CREATE TABLE IF NOT EXISTS tvshow_episode_meta (
  media_item_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  show_title TEXT NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  episode_title TEXT
);

CREATE TABLE IF NOT EXISTS music_meta (
  media_item_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  artist TEXT,
  album TEXT,
  track_number INTEGER
);

CREATE TABLE IF NOT EXISTS photo_meta (
  media_item_id INTEGER PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  taken_at TEXT,
  camera_model TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS media_item_tags (
  media_item_id INTEGER REFERENCES media_items(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_item_id, tag_id)
);
`;

export const CATALOG_S3_KEY = 'db/library.sqlite';

export type MediaType = 'movie' | 'tvshow' | 'music' | 'photo';

export interface MediaDirectory {
  id: number;
  s3Prefix: string;
  categoryKey: string;
  mediaType: MediaType;
  displayName: string;
  createdAt: string;
}

export interface MediaItem {
  id: number;
  mediaType: MediaType;
  directoryId: number;
  s3Key: string;
  title: string;
  thumbnailS3Key: string | null;
  durationSeconds: number | null;
  dateAdded: string;
  extraJson: string | null;
}

export interface TvShowMeta {
  showTitle: string;
  season: number;
  episode: number;
  episodeTitle?: string;
}

export interface MusicMeta {
  artist: string;
  album: string;
  trackNumber?: number;
}

export interface CastMember {
  name: string;
  character?: string;
  /** Absolute URL of the actor's photo on TMDb's image CDN. */
  profileUrl?: string;
}

/** Plot/cast/etc looked up from TMDb by the catalog-sync Lambda, stored in
 * extra_json as {"info": {...}}. For TV episodes this describes the show
 * (denormalized onto every episode); per-episode details are in
 * EpisodeInfo. */
export interface MediaInfo {
  overview?: string;
  genres?: string[];
  releaseYear?: number;
  /** Names only, kept for catalogs written before castMembers existed. */
  cast?: string[];
  castMembers?: CastMember[];
  tagline?: string;
  /** TMDb average vote, 0–10, one decimal. */
  rating?: number;
  /** Movies only. */
  runtimeMinutes?: number;
  /** Movies only. */
  director?: string;
  /** TV shows only. */
  creators?: string[];
  /** TV shows only: number of seasons/years as TMDb reports them. */
  firstAirYear?: number;
  lastAirYear?: number;
}

/** One TV episode's own details (stored in extra_json as {"episode": {...}}). */
export interface EpisodeInfo {
  title?: string;
  overview?: string;
  runtimeMinutes?: number;
  /** S3 key of the episode's still image. */
  stillS3Key?: string;
}

export interface NewMediaItem {
  mediaType: MediaType;
  directoryId: number;
  s3Key: string;
  title: string;
  tvMeta?: TvShowMeta;
  musicMeta?: MusicMeta;
  thumbnailS3Key?: string;
  /** Sidecar subtitle file keys — stored in extra_json as {"subtitles": [...]}.
   * Detected during scan/upload; not yet rendered by the player. */
  subtitleS3Keys?: string[];
  /** Alternate-language audio files ("<video stem>.<lang>.m4a"). */
  audioS3Keys?: string[];
  info?: MediaInfo;
  /** Wide background image (movie or show). */
  backdropS3Key?: string;
  episode?: EpisodeInfo;
}

/** A TV show as a whole (aggregated from its episodes' rows). */
export interface ShowSummary {
  directoryId: number;
  title: string;
  episodes: number;
  seasons: number;
  latestAdded: string;
  posterS3Key: string | null;
  backdropS3Key: string | null;
  info: MediaInfo | null;
}

export interface EpisodeRow extends MediaItem, TvShowMeta {
  /** Per-episode TMDb details (title, plot, still), when found. */
  details: EpisodeInfo | null;
}

export interface AlbumSummary {
  directoryId: number;
  artist: string;
  album: string;
  tracks: number;
  coverS3Key: string | null;
  latestAdded: string;
}
