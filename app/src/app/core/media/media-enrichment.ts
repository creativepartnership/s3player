import { MediaInfo, MediaType } from '../db/schema';
import type { EpisodeDetails, MetadataClient } from './metadata-client';
import { srtToVtt } from './subtitle-convert';
import { ScanCandidate } from './media-scan';

export type MetadataProvider = Pick<
  MetadataClient,
  'fetchMovieInfo' | 'fetchTvInfo' | 'fetchSeasonEpisodes' | 'fetchAlbumCover' | 'fetchImage'
>;

/** Where enrichment reads subtitle bytes from and writes its generated
 * artifacts (converted .vtt, fetched poster/backdrop/still/cover) to. Used by
 * the catalog-sync Lambda, which writes them straight into the media bucket. */
export interface EnrichmentContext {
  readSubtitleText(relativePath: string): Promise<string | undefined>;
  writeText(relativePath: string, text: string, contentType: string): Promise<void>;
  writeBinary(relativePath: string, blob: Blob, contentType: string): Promise<void>;
  /** True if a file already exists at this path — generated artifacts are
   * then reused rather than written again. Every write to the bucket fires
   * another S3 event (and so another sync run), so skipping redundant writes
   * keeps re-runs from doing any work. */
  exists?(relativePath: string): boolean;
}

/** Converts .srt sidecars to WebVTT (unless a .vtt with the same name already
 * exists), then looks up artwork and details: poster + backdrop + plot/cast
 * (movies and shows, via TMDb), per-episode title/plot/still (TV), cover art
 * (music, via MusicBrainz). Mutates each candidate in place. */
export async function enrichCandidates(
  mediaType: MediaType,
  candidates: ScanCandidate[],
  metadata: MetadataProvider,
  ctx: EnrichmentContext,
): Promise<void> {
  await convertSubtitles(candidates, ctx);
  await fetchArtwork(mediaType, candidates, metadata, ctx);
}

export async function convertSubtitles(candidates: ScanCandidate[], ctx: EnrichmentContext): Promise<void> {
  for (const candidate of candidates) {
    const converted: string[] = [];
    for (const relativePath of candidate.subtitleRelativePaths) {
      if (!/\.srt$/i.test(relativePath)) {
        converted.push(relativePath);
        continue;
      }
      const vttRelativePath = relativePath.replace(/\.srt$/i, '.vtt');
      if (ctx.exists?.(vttRelativePath)) {
        converted.push(vttRelativePath);
        continue;
      }
      const text = await ctx.readSubtitleText(relativePath);
      if (text == null) {
        converted.push(relativePath);
        continue;
      }
      await ctx.writeText(vttRelativePath, srtToVtt(text), 'text/vtt');
      converted.push(vttRelativePath);
    }
    // A folder holding both movie.srt and the movie.vtt generated from it
    // lists both as sidecars; after conversion they collapse to one entry.
    candidate.subtitleRelativePaths = [...new Set(converted)];
  }
}

interface GroupArt {
  posterPath?: string;
  backdropPath?: string;
  info?: MediaInfo;
  tmdbId?: number | null;
}

/** Writes a fetched image unless the file is already there; returns the path
 * if the file exists afterwards. */
async function saveImage(
  ctx: EnrichmentContext,
  relativePath: string,
  blob: Blob | null,
): Promise<string | undefined> {
  if (ctx.exists?.(relativePath)) {
    return relativePath;
  }
  if (!blob) {
    return undefined;
  }
  await ctx.writeBinary(relativePath, blob, blob.type || 'image/jpeg');
  return relativePath;
}

function stemPath(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '');
}

/** Artwork and details are fetched once per movie/show/album (and once per
 * TV season for episode details) and reused across every candidate sharing
 * it, rather than once per file. */
export async function fetchArtwork(
  mediaType: MediaType,
  candidates: ScanCandidate[],
  metadata: MetadataProvider,
  ctx: EnrichmentContext,
): Promise<void> {
  if (mediaType === 'photo') {
    return;
  }
  const groups = new Map<string, GroupArt>();
  const seasons = new Map<string, Map<number, EpisodeDetails>>();

  for (const candidate of candidates) {
    if (mediaType === 'movie') {
      const match = /^(.*) \((\d{4})\)$/.exec(candidate.title);
      const title = match ? match[1] : candidate.title;
      const year = match ? Number(match[2]) : undefined;
      const key = `movie:${title}:${year ?? ''}`;
      let group = groups.get(key);
      if (!group) {
        const r = await metadata.fetchMovieInfo(title, year);
        const stem = stemPath(candidate.primaryRelativePath);
        group = {
          posterPath: await saveImage(ctx, `${stem}.poster.jpg`, r.posterBlob),
          backdropPath: await saveImage(ctx, `${stem}.backdrop.jpg`, r.backdropBlob),
          info: r.info ?? undefined,
        };
        groups.set(key, group);
      }
      applyGroup(candidate, group);
    } else if (mediaType === 'tvshow' && candidate.tvMeta) {
      const showTitle = candidate.tvMeta.showTitle;
      const showFolder = candidate.primaryRelativePath.split('/')[0];
      const key = `tv:${showTitle}`;
      let group = groups.get(key);
      if (!group) {
        const r = await metadata.fetchTvInfo(showTitle);
        group = {
          posterPath: await saveImage(ctx, `${showFolder}/poster.jpg`, r.posterBlob),
          backdropPath: await saveImage(ctx, `${showFolder}/backdrop.jpg`, r.backdropBlob),
          info: r.info ?? undefined,
          tmdbId: r.tmdbId,
        };
        groups.set(key, group);
      }
      applyGroup(candidate, group);

      if (group.tmdbId != null) {
        const seasonKey = `${key}:${candidate.tvMeta.season}`;
        let episodes = seasons.get(seasonKey);
        if (!episodes) {
          episodes = await metadata.fetchSeasonEpisodes(group.tmdbId, candidate.tvMeta.season);
          seasons.set(seasonKey, episodes);
        }
        const details = episodes.get(candidate.tvMeta.episode);
        if (details) {
          const stillPath = `${stemPath(candidate.primaryRelativePath)}.still.jpg`;
          const stillRelativePath = ctx.exists?.(stillPath)
            ? stillPath
            : details.stillUrl
              ? await saveImage(ctx, stillPath, await metadata.fetchImage(details.stillUrl))
              : undefined;
          candidate.episode = {
            title: details.title,
            overview: details.overview,
            runtimeMinutes: details.runtimeMinutes,
            stillRelativePath,
          };
        }
      }
    } else if (mediaType === 'music' && candidate.musicMeta) {
      const { artist, album } = candidate.musicMeta;
      const key = `music:${artist}:${album}`;
      let group = groups.get(key);
      if (!group) {
        const segments = candidate.primaryRelativePath.split('/');
        const coverPath = segments.length >= 3 ? `${segments[0]}/${segments[1]}/cover.jpg` : `${segments[0]}/cover.jpg`;
        const blob = ctx.exists?.(coverPath) ? null : await metadata.fetchAlbumCover(artist, album);
        group = { posterPath: await saveImage(ctx, coverPath, blob) };
        groups.set(key, group);
      }
      applyGroup(candidate, group);
    }
  }
}

function applyGroup(candidate: ScanCandidate, group: GroupArt): void {
  // A poster/cover that came with the files (in the movie's folder, next to
  // the video) wins over a fetched one.
  if (!candidate.thumbnailRelativePath && group.posterPath) {
    candidate.thumbnailRelativePath = group.posterPath;
  }
  if (group.backdropPath) {
    candidate.backdropRelativePath = group.backdropPath;
  }
  candidate.info = group.info;
}
