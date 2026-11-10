import { CastMember, MediaInfo } from '../db/schema';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'w1280';
const STILL_SIZE = 'w500';
const PROFILE_SIZE = 'w185';
const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2';
const COVER_ART_ARCHIVE_BASE = 'https://coverartarchive.org';
/** How many cast members to keep — TMDb credits lists can run to 50+ entries. */
const MAX_CAST = 12;

export interface EnrichedInfo {
  posterBlob: Blob | null;
  backdropBlob: Blob | null;
  info: MediaInfo | null;
  /** TMDb id of the movie/show, for follow-up lookups (a show's seasons). */
  tmdbId: number | null;
}

export interface EpisodeDetails {
  title?: string;
  overview?: string;
  runtimeMinutes?: number;
  /** Absolute TMDb image URL of the episode still, if any. */
  stillUrl?: string;
}

interface TmdbSearchResult {
  results?: { id: number }[];
}

interface TmdbDetails {
  overview?: string;
  tagline?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: { name: string }[];
  release_date?: string;
  first_air_date?: string;
  last_air_date?: string;
  runtime?: number;
  vote_average?: number;
  vote_count?: number;
  created_by?: { name: string }[];
  credits?: {
    cast?: { name: string; character?: string; profile_path?: string | null }[];
    crew?: { name: string; job: string }[];
  };
  aggregate_credits?: {
    cast?: { name: string; profile_path?: string | null; roles?: { character?: string }[] }[];
  };
}

interface TmdbSeason {
  episodes?: { episode_number: number; name?: string; overview?: string; runtime?: number | null; still_path?: string | null }[];
}

export interface MetadataClientOptions {
  tmdbApiKey: string;
  /** TMDb language for titles/plots, e.g. "it-IT" or "en-US". */
  language?: string;
  /** MusicBrainz asks API clients to identify themselves. */
  userAgent?: string;
}

const EMPTY: EnrichedInfo = { posterBlob: null, backdropBlob: null, info: null, tmdbId: null };

/** Best-effort poster/backdrop/plot/cast lookups (TMDb) and album cover
 * lookups (MusicBrainz + Cover Art Archive). Framework-free so the
 * catalog-sync Lambda (infra/lambda/catalog-sync) can use it — that's where
 * enrichment runs. Every method fails soft (returns nulls) on missing API
 * key, no match, or network error: enrichment is a nice-to-have, never a
 * reason to keep a file out of the catalog. */
export class MetadataClient {
  constructor(private readonly options: MetadataClientOptions) {}

  async fetchMovieInfo(title: string, year?: number): Promise<EnrichedInfo> {
    if (!this.options.tmdbApiKey) {
      return EMPTY;
    }
    const id = await this.searchId('movie', title, year);
    return id == null ? EMPTY : this.fetchDetails('movie', id);
  }

  async fetchTvInfo(showTitle: string): Promise<EnrichedInfo> {
    if (!this.options.tmdbApiKey) {
      return EMPTY;
    }
    const id = await this.searchId('tv', showTitle);
    return id == null ? EMPTY : this.fetchDetails('tv', id);
  }

  /** Per-episode titles, plots, runtimes and stills for one season, keyed by
   * episode number. Empty on any failure. */
  async fetchSeasonEpisodes(tvId: number, season: number): Promise<Map<number, EpisodeDetails>> {
    const episodes = new Map<number, EpisodeDetails>();
    if (!this.options.tmdbApiKey) {
      return episodes;
    }
    try {
      const res = await fetch(`${TMDB_API_BASE}/tv/${tvId}/season/${season}?${this.params()}`);
      if (!res.ok) {
        return episodes;
      }
      const data = (await res.json()) as TmdbSeason;
      for (const e of data.episodes ?? []) {
        episodes.set(e.episode_number, {
          title: e.name || undefined,
          overview: e.overview || undefined,
          runtimeMinutes: e.runtime || undefined,
          stillUrl: e.still_path ? `${TMDB_IMAGE_BASE}/${STILL_SIZE}${e.still_path}` : undefined,
        });
      }
    } catch {
      // fail soft
    }
    return episodes;
  }

  async fetchAlbumCover(artist: string, album: string): Promise<Blob | null> {
    try {
      const query = `release:"${album}" AND artist:"${artist}"`;
      const params = new URLSearchParams({ query, fmt: 'json', limit: '1' });
      const res = await fetch(`${MUSICBRAINZ_BASE}/release-group/?${params}`, { headers: this.headers() });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as { 'release-groups'?: { id: string }[] };
      const mbid = data['release-groups']?.[0]?.id;
      return mbid ? this.fetchImage(`${COVER_ART_ARCHIVE_BASE}/release-group/${mbid}/front-250`) : null;
    } catch {
      return null;
    }
  }

  async fetchImage(url: string): Promise<Blob | null> {
    try {
      const res = await fetch(url, { headers: this.options.userAgent ? { 'User-Agent': this.options.userAgent } : undefined });
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }

  private params(extra: Record<string, string> = {}): URLSearchParams {
    const params = new URLSearchParams({ api_key: this.options.tmdbApiKey, ...extra });
    if (this.options.language) {
      params.set('language', this.options.language);
    }
    return params;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.options.userAgent) {
      headers['User-Agent'] = this.options.userAgent;
    }
    return headers;
  }

  private async searchId(kind: 'movie' | 'tv', query: string, year?: number): Promise<number | null> {
    try {
      const params = this.params({ query });
      if (year) {
        params.set(kind === 'movie' ? 'year' : 'first_air_date_year', String(year));
      }
      const res = await fetch(`${TMDB_API_BASE}/search/${kind}?${params}`);
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as TmdbSearchResult;
      return data.results?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  private async fetchDetails(kind: 'movie' | 'tv', id: number): Promise<EnrichedInfo> {
    try {
      const append = kind === 'movie' ? 'credits' : 'aggregate_credits';
      const res = await fetch(`${TMDB_API_BASE}/${kind}/${id}?${this.params({ append_to_response: append })}`);
      if (!res.ok) {
        return EMPTY;
      }
      const data = (await res.json()) as TmdbDetails;
      const [posterBlob, backdropBlob] = await Promise.all([
        data.poster_path ? this.fetchImage(`${TMDB_IMAGE_BASE}/${POSTER_SIZE}${data.poster_path}`) : Promise.resolve(null),
        data.backdrop_path ? this.fetchImage(`${TMDB_IMAGE_BASE}/${BACKDROP_SIZE}${data.backdrop_path}`) : Promise.resolve(null),
      ]);

      const castMembers: CastMember[] =
        kind === 'movie'
          ? (data.credits?.cast ?? []).slice(0, MAX_CAST).map((c) => ({
              name: c.name,
              character: c.character || undefined,
              profileUrl: c.profile_path ? `${TMDB_IMAGE_BASE}/${PROFILE_SIZE}${c.profile_path}` : undefined,
            }))
          : (data.aggregate_credits?.cast ?? []).slice(0, MAX_CAST).map((c) => ({
              name: c.name,
              character: c.roles?.[0]?.character || undefined,
              profileUrl: c.profile_path ? `${TMDB_IMAGE_BASE}/${PROFILE_SIZE}${c.profile_path}` : undefined,
            }));
      const dateStr = data.release_date || data.first_air_date;
      const info: MediaInfo = {
        overview: data.overview || undefined,
        tagline: data.tagline || undefined,
        genres: data.genres?.length ? data.genres.map((g) => g.name) : undefined,
        releaseYear: dateStr ? Number(dateStr.slice(0, 4)) : undefined,
        cast: castMembers.length ? castMembers.slice(0, 8).map((c) => c.name) : undefined,
        castMembers: castMembers.length ? castMembers : undefined,
        rating: data.vote_count && data.vote_average ? Math.round(data.vote_average * 10) / 10 : undefined,
      };
      if (kind === 'movie') {
        info.director = data.credits?.crew?.find((c) => c.job === 'Director')?.name;
        info.runtimeMinutes = data.runtime || undefined;
      } else {
        const creators = data.created_by?.map((c) => c.name) ?? [];
        info.creators = creators.length ? creators : undefined;
        info.firstAirYear = data.first_air_date ? Number(data.first_air_date.slice(0, 4)) : undefined;
        info.lastAirYear = data.last_air_date ? Number(data.last_air_date.slice(0, 4)) : undefined;
      }
      return { posterBlob, backdropBlob, info, tmdbId: id };
    } catch {
      return EMPTY;
    }
  }
}
