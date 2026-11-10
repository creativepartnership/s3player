import { Injectable, computed, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { MediaDbService } from '../db/media-db.service';
import { AlbumSummary, EpisodeRow, MediaDirectory, MediaInfo, MediaItem, MediaType, ShowSummary } from '../db/schema';
import { I18nService } from '../i18n/i18n.service';
import { MessageKey } from '../i18n/messages.en';
import { WatchProgressService } from './watch-progress.service';

/** What a card on screen shows, whatever it stands for (a movie, a show,
 * an album, an episode, a photo). Built here so every screen describes
 * things the same way. */
export interface Tile {
  /** Unique per tile, for @for tracking. */
  id: string;
  kind: 'movie' | 'show' | 'album' | 'photo' | 'episode' | 'track';
  title: string;
  /** Second line: year, number of seasons, artist… */
  meta: string;
  /** Portrait/square artwork (poster, cover, the photo itself). */
  image: string | null;
  /** Wide artwork (backdrop, episode still), when there is one. */
  wide: string | null;
  link: (string | number)[];
  addedAt: string;
  /** 0–100, for things started but not finished. */
  progress?: number;
  watched?: boolean;
}

/** A hero banner slide. */
export interface Feature {
  tile: Tile;
  info: MediaInfo | null;
  /** What the main button plays (a movie, or a show's next episode). */
  playId: number | null;
  /** Label for the main button: resume or start. */
  resume: boolean;
  chips: string[];
}

export const MEDIA_TYPE_NAV_KEY: Record<MediaType, MessageKey> = {
  movie: 'nav.movies',
  tvshow: 'nav.shows',
  music: 'nav.music',
  photo: 'nav.photos',
};

/** How many of each to put in a home-screen row. */
const ROW_LIMIT = 24;

export function formatRuntime(minutes: number): string {
  minutes = Math.max(1, Math.round(minutes));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

export function episodeCode(season: number, episode: number): string {
  return `S${season} · E${episode}`;
}

/** The library as the signed-in user may see it, shaped for the screens:
 * only their categories, shows and albums grouped, watch progress merged
 * in, labels in the current language. Everything is a computed() over the
 * catalog's version, so screens update when the catalog-sync Lambda adds
 * things or the language changes. */
@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly db = inject(MediaDbService);
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);
  private readonly progress = inject(WatchProgressService);

  readonly ready = this.db.ready;

  readonly directories = computed<MediaDirectory[]>(() => {
    this.db.version();
    if (!this.db.ready()) {
      return [];
    }
    const dirs = this.db.listDirectories();
    if (this.auth.isAdmin()) {
      return dirs;
    }
    const allowed = new Set(this.auth.categories());
    return dirs.filter((d) => allowed.has(d.categoryKey));
  });

  private readonly directoryIds = computed(() => new Set(this.directories().map((d) => d.id)));

  canAccess(directoryId: number): boolean {
    return this.directoryIds().has(directoryId);
  }

  directory(directoryId: number): MediaDirectory | null {
    return this.directories().find((d) => d.id === directoryId) ?? null;
  }

  // ---------------------------------------------------------------------
  // Raw lists, already filtered to what this user may see
  // ---------------------------------------------------------------------

  private readonly allItems = computed<MediaItem[]>(() => {
    this.db.version();
    return this.db.ready() ? this.db.listMediaItems().filter((i) => this.directoryIds().has(i.directoryId)) : [];
  });

  private readonly allShows = computed<ShowSummary[]>(() => {
    this.db.version();
    return this.db.ready() ? this.db.listShows().filter((s) => this.directoryIds().has(s.directoryId)) : [];
  });

  private readonly allAlbums = computed<AlbumSummary[]>(() => {
    this.db.version();
    return this.db.ready() ? this.db.listAllAlbums().filter((a) => this.directoryIds().has(a.directoryId)) : [];
  });

  // ---------------------------------------------------------------------
  // Tiles
  // ---------------------------------------------------------------------

  movieTile(item: MediaItem): Tile {
    const info = this.db.getExtra(item).info;
    const p = this.progress.get(item.id);
    return {
      id: `m${item.id}`,
      kind: 'movie',
      title: item.title,
      meta: [info?.releaseYear, info?.genres?.[0]].filter(Boolean).join(' · ') || this.i18n.t('kind.movie'),
      image: item.thumbnailS3Key,
      wide: this.db.getExtra(item).backdrop ?? null,
      link: ['/library', item.directoryId, 'movie', item.id],
      addedAt: item.dateAdded,
      progress: p && !p.watched ? (p.positionSeconds / p.durationSeconds) * 100 : undefined,
      watched: p?.watched,
    };
  }

  showTile(show: ShowSummary): Tile {
    return {
      id: `s${show.directoryId}:${show.title}`,
      kind: 'show',
      title: show.title,
      meta: this.count('count.seasons', show.seasons),
      image: show.posterS3Key,
      wide: show.backdropS3Key,
      link: ['/library', show.directoryId, 'show', show.title],
      addedAt: show.latestAdded,
    };
  }

  albumTile(album: AlbumSummary): Tile {
    return {
      id: `a${album.directoryId}:${album.artist}:${album.album}`,
      kind: 'album',
      title: album.album || this.i18n.t('music.unknownAlbum'),
      meta: album.artist || this.i18n.t('music.unknownArtist'),
      image: album.coverS3Key,
      wide: null,
      link: ['/library', album.directoryId, 'artist', album.artist, 'album', album.album],
      addedAt: album.latestAdded,
    };
  }

  photoTile(item: MediaItem): Tile {
    return {
      id: `p${item.id}`,
      kind: 'photo',
      title: item.title,
      meta: '',
      image: item.s3Key,
      wide: item.s3Key,
      link: ['/play', item.id],
      addedAt: item.dateAdded,
    };
  }

  /** Tiles for one directory, in the directory's natural form. */
  tilesFor(directory: MediaDirectory, sort: 'recent' | 'title' = 'title'): Tile[] {
    let tiles: Tile[];
    switch (directory.mediaType) {
      case 'tvshow':
        tiles = this.allShows().filter((s) => s.directoryId === directory.id).map((s) => this.showTile(s));
        break;
      case 'music':
        tiles = this.allAlbums().filter((a) => a.directoryId === directory.id).map((a) => this.albumTile(a));
        break;
      case 'photo':
        tiles = this.allItems().filter((i) => i.directoryId === directory.id).map((i) => this.photoTile(i));
        break;
      default:
        tiles = this.allItems().filter((i) => i.directoryId === directory.id).map((i) => this.movieTile(i));
    }
    if (sort === 'recent') {
      tiles.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    } else {
      tiles.sort((a, b) => a.title.localeCompare(b.title, this.i18n.locale(), { sensitivity: 'base', numeric: true }));
    }
    return tiles;
  }

  /** "128 movies", "14 shows", "62 albums", "300 photos". */
  sectionCount(directory: MediaDirectory): string {
    const n = this.tilesFor(directory).length;
    const base = { movie: 'count.movies', tvshow: 'count.shows', music: 'count.albums', photo: 'count.photos' }[directory.mediaType];
    return this.i18n.t(`${base}.${n === 1 ? 'one' : 'other'}` as MessageKey, { n });
  }

  /** Home-screen rows, one per directory. */
  readonly directoryRows = computed(() =>
    this.directories()
      .map((directory) => ({ directory, tiles: this.tilesFor(directory, 'recent').slice(0, ROW_LIMIT) }))
      .filter((row) => row.tiles.length > 0),
  );

  /** Newest movies, shows (by their newest episode) and albums. */
  readonly recent = computed<Tile[]>(() => {
    const tiles = [
      ...this.allItems().filter((i) => i.mediaType === 'movie').map((i) => this.movieTile(i)),
      ...this.allShows().map((s) => this.showTile(s)),
      ...this.allAlbums().map((a) => this.albumTile(a)),
    ];
    return tiles.sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, ROW_LIMIT);
  });

  /** Hero banner: the newest movies and shows that have a backdrop. */
  readonly featured = computed<Feature[]>(() => {
    // Pick the five newest first, then do the (per-show) work only for them.
    const picks = [
      ...this.allItems()
        .filter((i) => i.mediaType === 'movie' && this.db.getExtra(i).backdrop)
        .map((item) => ({ at: item.dateAdded, item, show: null as ShowSummary | null })),
      ...this.allShows()
        .filter((s) => s.backdropS3Key)
        .map((show) => ({ at: show.latestAdded, item: null as MediaItem | null, show })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 5);
    return picks.map(({ item, show }): Feature => {
      if (item) {
        const p = this.progress.get(item.id);
        const info = this.db.getExtra(item).info ?? null;
        return { tile: this.movieTile(item), info, playId: item.id, resume: !!p && !p.watched, chips: this.movieChips(info) };
      }
      const next = this.nextEpisode(show!.directoryId, show!.title);
      return {
        tile: this.showTile(show!),
        info: show!.info,
        playId: next?.episode.id ?? null,
        resume: next?.resume ?? false,
        chips: this.showChips(show!),
      };
    });
  });

  /** Things started and not finished, most recent first. */
  readonly continueWatching = computed<Tile[]>(() => {
    this.db.version();
    if (!this.db.ready()) {
      return [];
    }
    const tiles: Tile[] = [];
    for (const { mediaItemId, progress } of this.progress.listInProgress()) {
      const item = this.db.getMediaItem(mediaItemId);
      if (!item || !this.directoryIds().has(item.directoryId) || item.mediaType === 'photo') {
        continue;
      }
      const left = this.i18n.t('time.left', {
        time: formatRuntime(Math.max(1, (progress.durationSeconds - progress.positionSeconds) / 60)),
      });
      const extra = this.db.getExtra(item);
      const tile: Tile = {
        id: `c${item.id}`,
        kind: item.mediaType === 'tvshow' ? 'episode' : item.mediaType === 'music' ? 'track' : 'movie',
        title: item.title,
        meta: left,
        image: item.thumbnailS3Key,
        wide: extra.episode?.stillS3Key ?? extra.backdrop ?? null,
        link: ['/play', item.id],
        addedAt: progress.updatedAt,
        progress: Math.min(100, (progress.positionSeconds / progress.durationSeconds) * 100),
      };
      if (item.mediaType === 'tvshow') {
        const tv = this.db.getTvMeta(item.id);
        if (tv) {
          tile.title = tv.showTitle;
          tile.meta = `${episodeCode(tv.season, tv.episode)} · ${left}`;
        }
      }
      tiles.push(tile);
      if (tiles.length >= 12) {
        break;
      }
    }
    return tiles;
  });

  // ---------------------------------------------------------------------
  // Shows
  // ---------------------------------------------------------------------

  /** The episode a show's play button should start: the one in progress,
   * else the one after the last watched, else the first. */
  nextEpisode(directoryId: number, showTitle: string, episodes?: EpisodeRow[]): { episode: EpisodeRow; resume: boolean } | null {
    const list = episodes ?? this.db.listShowEpisodes(directoryId, showTitle);
    if (!list.length) {
      return null;
    }
    let latest: { index: number; at: string; watched: boolean } | null = null;
    list.forEach((ep, index) => {
      const p = this.progress.get(ep.id);
      if (p && (!latest || p.updatedAt > latest.at)) {
        latest = { index, at: p.updatedAt, watched: p.watched };
      }
    });
    if (!latest) {
      return { episode: list[0], resume: false };
    }
    const { index, watched } = latest as { index: number; watched: boolean };
    if (!watched) {
      return { episode: list[index], resume: true };
    }
    const after = list.slice(index + 1).find((ep) => !this.progress.get(ep.id)?.watched);
    if (!after) {
      return { episode: list[0], resume: false };
    }
    const started = this.progress.get(after.id);
    return { episode: after, resume: !!started && started.positionSeconds > 0 };
  }

  movieChips(info: MediaInfo | null | undefined): string[] {
    return [
      info?.releaseYear ? String(info.releaseYear) : '',
      info?.genres?.[0] ?? '',
      info?.runtimeMinutes ? formatRuntime(info.runtimeMinutes) : '',
      info?.rating ? `★ ${this.formatRating(info.rating)}` : '',
    ].filter(Boolean);
  }

  showChips(show: ShowSummary): string[] {
    const info = show.info;
    const first = info?.firstAirYear ?? info?.releaseYear;
    const last = info?.lastAirYear;
    return [
      first ? (last && last !== first ? `${first} – ${last}` : String(first)) : '',
      info?.genres?.[0] ?? '',
      this.count('count.seasons', show.seasons),
      info?.rating ? `★ ${this.formatRating(info.rating)}` : '',
    ].filter(Boolean);
  }

  formatRating(rating: number): string {
    return rating.toLocaleString(this.i18n.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  /** "1 season" / "3 seasons" (keys `<base>.one` / `<base>.other`). */
  count(base: 'count.seasons' | 'count.episodes' | 'count.tracks' | 'count.items' | 'count.photos', n: number): string {
    return this.i18n.t(`${base}.${n === 1 ? 'one' : 'other'}` as MessageKey, { n });
  }
}
