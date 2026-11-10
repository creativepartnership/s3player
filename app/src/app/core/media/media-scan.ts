import { MediaInfo, MediaType, TvShowMeta } from '../db/schema';

export interface MusicMeta {
  artist: string;
  album: string;
  trackNumber?: number;
}

export interface ScanCandidate {
  /** Relative to the directory's S3 prefix — the actual playable file. */
  primaryRelativePath: string;
  title: string;
  mediaType: MediaType;
  tvMeta?: TvShowMeta;
  musicMeta?: MusicMeta;
  /** Subtitle files (relative paths) associated with this candidate. Detected
   * and stored (in extra_json) but not yet rendered in the player. */
  subtitleRelativePaths: string[];
  /** Extra audio languages (movies/episodes): "<video stem>.<lang>.m4a"
   * files, extracted by the media-transcode function so the player can
   * switch language in every browser. */
  audioRelativePaths?: string[];
  /** Cover art / poster image (relative path) associated with this candidate. */
  thumbnailRelativePath?: string;
  /** Plot/cast/etc, filled in by the catalog-sync Lambda's enrichment step
   * (not by classification itself — TMDb lookups need network access). */
  info?: MediaInfo;
  /** Wide background image (relative path), set by enrichment. */
  backdropRelativePath?: string;
  /** TV episodes only: the episode's own details, set by enrichment. */
  episode?: {
    title?: string;
    overview?: string;
    runtimeMinutes?: number;
    stillRelativePath?: string;
  };
}

export interface ScanInputFile {
  relativePath: string;
  size?: number;
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg']);
const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'sub', 'ass']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
/** Alternate-language audio next to a video (movie/TV directories only). */
const AUDIO_SIDECAR_EXTENSIONS = new Set(['m4a']);

const TV_EPISODE_PATTERN = /^(.*?)[ ._-]*[Ss](\d{1,2})[Ee](\d{1,2})[ ._-]*(.*)$/;
const YEAR_PATTERN = /\b(19\d{2}|20\d{2})\b/;
// Scene-release tags that show up after the real title in typical movie filenames
// (Movie.Title.2020.ITA.ENG.Sub.1080p.BluRay.x264-GROUP) — stripped so only the
// title (+ year) remains: resolution/source/codec plus common language/subtitle markers.
const RELEASE_NOISE_PATTERN =
  /\b(1080p|720p|480p|2160p|4k|uhd|blu-?ray|brrip|bdrip|webrip|web-?dl|amzn|nf|dsnp|hmax|atvp|hulu|ddp?\d*|eac3|hdr|hdr10|dv|hdtv|dvdrip|dvdscr|hdrip|x264|x265|h264|h265|hevc|aac|ac3|dts|remastered|extended|unrated|proper|repack|multi|dual|10bit|ita|eng|fre|ger|spa|vostfr|multisub|subs?|subbed|dubbed|dub)\b/i;

export function cleanupWords(text: string): string {
  return text.replace(/[._]+/g, ' ').trim();
}

/** Title-cases a name parsed from a filename: an ALL-CAPS or all-lowercase word
 * (typical of scene-release filenames) becomes "Word"; a word that's already
 * mixed-case (e.g. "McDonald", "iPhone") is left alone rather than mangled. */
export function titleCase(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => {
    const isAllUpper = word === word.toUpperCase() && word !== word.toLowerCase();
    const isAllLower = word === word.toLowerCase();
    if (isAllUpper || isAllLower) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word;
  });
}

/** Parses "Movie.Title.2020.1080p.BluRay.x264-GROUP" into { title: "Movie Title", year: 2020 },
 * discarding resolution/codec/release-group noise. Falls back to just stripping the noise (or
 * the raw cleaned-up name) when there's no recognizable year. */
export function parseMovieTitle(rawName: string): { title: string; year?: number } {
  const cleaned = cleanupWords(rawName);
  const yearMatch = cleaned.match(YEAR_PATTERN);
  if (yearMatch?.index != null) {
    const title = cleaned.slice(0, yearMatch.index).replace(/[-\s]+$/, '').trim();
    return { title: titleCase(title || cleaned), year: Number(yearMatch[1]) };
  }
  const noiseMatch = cleaned.match(RELEASE_NOISE_PATTERN);
  if (noiseMatch?.index != null) {
    const title = cleaned.slice(0, noiseMatch.index).replace(/[-\s]+$/, '').trim();
    return { title: titleCase(title || cleaned) };
  }
  return { title: titleCase(cleaned) };
}

export function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function extensionOf(relativePath: string): string {
  const filename = relativePath.split('/').pop() ?? relativePath;
  const match = /\.([^.]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : '';
}

function stemOf(filename: string): string {
  return filename.replace(/\.[^./]+$/, '');
}

/** Strips the extension off the last path segment of a relative (or full) path. */
function baseNameFromPath(path: string): string {
  return stemOf(path.split('/').pop() ?? path);
}

function pickLarger(a: ScanInputFile | undefined, b: ScanInputFile): ScanInputFile {
  if (!a) {
    return b;
  }
  return (b.size ?? 0) > (a.size ?? 0) ? b : a;
}

/** Kodi/Plex-style sidecar naming for loose files (no per-movie/episode
 * folder): "Movie.srt", "Movie.it.srt" and "Movie.en.forced.srt" belong to
 * "Movie.mkv", and so do "Movie.jpg" / "Movie-poster.jpg" for artwork. Only
 * '.' counts as a separator for subtitles (language tags), '.' or '-' for
 * images. The longest matching video name wins, so "Movie.2.srt" goes to
 * "Movie.2.mkv", not "Movie.mkv". Returns the owning video's stem. */
export function matchSidecarOwner(sidecarStem: string, videoStems: Iterable<string>, separators: string): string | undefined {
  let best: string | undefined;
  for (const videoStem of videoStems) {
    const matches =
      sidecarStem === videoStem ||
      [...separators].some((sep) => sidecarStem.startsWith(videoStem + sep));
    if (matches && (best === undefined || videoStem.length > best.length)) {
      best = videoStem;
    }
  }
  return best;
}

/** Wide backgrounds and episode stills (written by enrichment, or provided
 * Kodi-style as "-fanart"/"-backdrop") are never used as the poster. */
const NON_POSTER_IMAGE = /(\.|-|^|\/)(still|backdrop|fanart|background)\.[a-z]+$/i;
const PREFERRED_POSTER = /(poster|cover|folder)/i;

/** The image to use as a candidate's poster/cover among those that came with
 * its files, if any. */
export function pickPoster(images: ScanInputFile[]): string | undefined {
  const usable = images.filter((i) => !NON_POSTER_IMAGE.test(i.relativePath));
  const sorted = [...usable].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return (sorted.find((i) => PREFERRED_POSTER.test(i.relativePath.split('/').pop() ?? '')) ?? sorted[0])?.relativePath;
}

const SUBTITLE_SEPARATORS = '.';
const IMAGE_SEPARATORS = '.-';

/** The one entry point both the catalog-sync Lambda and the upload dialog use
 * to turn a flat list of relative file paths (S3 keys with the directory's
 * prefix stripped, or locally-selected files before upload) into playable
 * media candidates — grouping a movie's video+subs folder, an episode's
 * show/season/episode-file-or-folder nesting, or an artist/album/tracks+cover
 * tree into one candidate per playable unit. */
export function classifyDirectoryFiles(
  mediaType: MediaType,
  directoryDisplayName: string,
  files: ScanInputFile[],
): ScanCandidate[] {
  switch (mediaType) {
    case 'movie':
      return classifyMovies(files);
    case 'tvshow':
      return classifyTvShow(files);
    case 'music':
      return classifyMusic(files, directoryDisplayName);
    case 'photo':
      return classifyPhotos(files);
  }
}

// ---------------------------------------------------------------------
// Movies: a lone video file, or a folder containing the video + subs/poster.
// ---------------------------------------------------------------------

interface MovieFolderUnit {
  folderName: string;
  video?: ScanInputFile;
  subs: ScanInputFile[];
  audio: ScanInputFile[];
  images: ScanInputFile[];
}

function classifyMovies(files: ScanInputFile[]): ScanCandidate[] {
  const folderUnits = new Map<string, MovieFolderUnit>();
  const candidates: ScanCandidate[] = [];
  /** Loose video files directly under the directory, by filename stem. */
  const flatMovies = new Map<string, ScanCandidate>();
  const flatSubs: ScanInputFile[] = [];
  const flatAudio: ScanInputFile[] = [];
  const flatImages: ScanInputFile[] = [];

  for (const f of files) {
    const segments = f.relativePath.split('/');
    const ext = extensionOf(f.relativePath);

    if (segments.length === 1) {
      // Loose file directly under the directory: a video is its own
      // candidate; subtitles/images are matched to one by filename below.
      if (VIDEO_EXTENSIONS.has(ext)) {
        const parsed = parseMovieTitle(baseNameFromPath(segments[0]));
        flatMovies.set(baseNameFromPath(segments[0]), {
          primaryRelativePath: f.relativePath,
          title: parsed.year ? `${parsed.title} (${parsed.year})` : parsed.title,
          mediaType: 'movie',
          subtitleRelativePaths: [],
          audioRelativePaths: [],
        });
      } else if (SUBTITLE_EXTENSIONS.has(ext)) {
        flatSubs.push(f);
      } else if (AUDIO_SIDECAR_EXTENSIONS.has(ext)) {
        flatAudio.push(f);
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        flatImages.push(f);
      }
      continue;
    }

    const folderPath = segments.slice(0, -1).join('/');
    const folderName = segments[segments.length - 2];
    let unit = folderUnits.get(folderPath);
    if (!unit) {
      unit = { folderName, subs: [], audio: [], images: [] };
      folderUnits.set(folderPath, unit);
    }
    if (VIDEO_EXTENSIONS.has(ext)) {
      unit.video = pickLarger(unit.video, f);
    } else if (SUBTITLE_EXTENSIONS.has(ext)) {
      unit.subs.push(f);
    } else if (AUDIO_SIDECAR_EXTENSIONS.has(ext)) {
      unit.audio.push(f);
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      unit.images.push(f);
    }
  }

  for (const sub of flatSubs) {
    const owner = matchSidecarOwner(baseNameFromPath(sub.relativePath), flatMovies.keys(), SUBTITLE_SEPARATORS);
    if (owner) {
      flatMovies.get(owner)!.subtitleRelativePaths.push(sub.relativePath);
    }
  }
  for (const audio of flatAudio) {
    const owner = matchSidecarOwner(baseNameFromPath(audio.relativePath), flatMovies.keys(), SUBTITLE_SEPARATORS);
    if (owner) {
      flatMovies.get(owner)!.audioRelativePaths!.push(audio.relativePath);
    }
  }
  const imagesByOwner = new Map<string, ScanInputFile[]>();
  for (const image of flatImages) {
    const owner = matchSidecarOwner(baseNameFromPath(image.relativePath), flatMovies.keys(), IMAGE_SEPARATORS);
    if (owner) {
      imagesByOwner.set(owner, [...(imagesByOwner.get(owner) ?? []), image]);
    }
  }
  for (const [owner, images] of imagesByOwner) {
    flatMovies.get(owner)!.thumbnailRelativePath = pickPoster(images);
  }
  candidates.push(...flatMovies.values());

  for (const unit of folderUnits.values()) {
    if (!unit.video) {
      continue;
    }
    candidates.push({
      primaryRelativePath: unit.video.relativePath,
      title: titleCase(cleanupWords(unit.folderName)),
      mediaType: 'movie',
      subtitleRelativePaths: unit.subs.map((s) => s.relativePath),
      audioRelativePaths: unit.audio.map((a) => a.relativePath),
      thumbnailRelativePath: pickPoster(unit.images),
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------
// TV shows: Show/Season NN/episode-file-or-folder.
// ---------------------------------------------------------------------

interface EpisodeUnit {
  showTitle: string;
  seasonRaw: string;
  /** "Show/Season" path the unit sits in. */
  seasonFolder: string;
  /** Filename stem, for a loose file (not inside its own episode folder). */
  flatStem?: string;
  /** Filename or episode-folder name used to parse the episode number from. */
  nameForParsing: string;
  video?: ScanInputFile;
  subs: ScanInputFile[];
  audio: ScanInputFile[];
  images: ScanInputFile[];
}

function parseSeasonNumber(raw: string): number {
  const named = /(?:season|stagione)\s*(\d+)/i.exec(raw) ?? /^s(\d+)$/i.exec(raw.trim());
  if (named) {
    return Number(named[1]);
  }
  const bare = /^\d+$/.exec(raw.trim());
  return bare ? Number(bare[0]) : 1;
}

const SEASON_TOKEN = /\b(?:s(\d{1,2})(?:e\d{1,3})?|(?:season|stagione)\s*(\d+))\b/i;

/** Cuts a name at the first release tag (1080p, WEB-DL, x265…). */
function stripReleaseNoise(text: string): string {
  const noise = text.match(RELEASE_NOISE_PATTERN);
  const cut = noise?.index != null ? text.slice(0, noise.index) : text;
  return cut.replace(/[-\s,]+$/, '').trim();
}

/** "The.Last.Ship.S04.1080p.AMZN.WEB-DL" → "The Last Ship" ('' if nothing
 * is left, e.g. a folder just called "Season 4"). */
function showTitleFrom(name: string): string {
  const cleaned = cleanupWords(name);
  const season = cleaned.match(SEASON_TOKEN);
  const head = season?.index != null ? cleaned.slice(0, season.index) : cleaned;
  return titleCase(stripReleaseNoise(head));
}

/** Where an episode file sits, in any of the usual layouts:
 * - Show/Season NN/episode(.mkv | folder/…)   (Kodi/Plex)
 * - Release.Folder.S04.1080p/Show.S04E01.mkv  (a season as downloaded)
 * - Show.S04E01.Title.mkv                      (loose, at the top)
 * The show's name comes from the folder, else from the episode's filename. */
function placeEpisodeFile(
  relativePath: string,
): { showTitle: string; seasonRaw: string; seasonFolder: string; rest: string[] } | null {
  const segments = relativePath.split('/');
  const fileName = segments[segments.length - 1];
  const fromFile = TV_EPISODE_PATTERN.exec(stemOf(fileName));
  const titleFromFile = fromFile ? showTitleFrom(fromFile[1]) : '';
  if (segments.length >= 3) {
    return {
      showTitle: showTitleFrom(segments[0]) || titleFromFile || titleCase(cleanupWords(segments[0])),
      seasonRaw: segments[1],
      seasonFolder: `${segments[0]}/${segments[1]}`,
      rest: segments.slice(2),
    };
  }
  if (segments.length === 2) {
    const token = segments[0].replace(/[._]+/g, ' ').match(SEASON_TOKEN);
    return {
      showTitle: showTitleFrom(segments[0]) || titleFromFile || titleCase(cleanupWords(segments[0])),
      seasonRaw: token ? `S${token[1] ?? token[2]}` : '1',
      seasonFolder: segments[0],
      rest: [fileName],
    };
  }
  // A loose file needs SxxEyy (and a show name before it) to count as an episode.
  if (!fromFile || !titleFromFile) {
    return null;
  }
  return { showTitle: titleFromFile, seasonRaw: `S${fromFile[2]}`, seasonFolder: `::${titleFromFile}`, rest: [fileName] };
}

function classifyTvShow(files: ScanInputFile[]): ScanCandidate[] {
  const units = new Map<string, EpisodeUnit>();

  for (const f of files) {
    const placed = placeEpisodeFile(f.relativePath);
    if (!placed) {
      continue;
    }
    const { showTitle, seasonRaw, seasonFolder, rest } = placed;
    const isEpisodeFolder = rest.length > 1;
    const key = isEpisodeFolder ? `${seasonFolder}/${rest[0]}` : `${seasonFolder}/${stemOf(rest[0])}`;
    const ext = extensionOf(f.relativePath);

    let unit = units.get(key);
    if (!unit) {
      unit = {
        showTitle,
        seasonRaw,
        seasonFolder,
        flatStem: isEpisodeFolder ? undefined : stemOf(rest[0]),
        nameForParsing: rest[0],
        subs: [],
        audio: [],
        images: [],
      };
      units.set(key, unit);
    }
    if (VIDEO_EXTENSIONS.has(ext)) {
      unit.video = pickLarger(unit.video, f);
    } else if (SUBTITLE_EXTENSIONS.has(ext)) {
      unit.subs.push(f);
    } else if (AUDIO_SIDECAR_EXTENSIONS.has(ext)) {
      unit.audio.push(f);
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      unit.images.push(f);
    }
  }

  // Loose sidecars named after their episode plus a tag ("Ep.ita.srt" next
  // to "Ep.mkv") land in a video-less unit of their own: fold them into the
  // episode they belong to.
  const flatVideoUnits = new Map<string, Map<string, EpisodeUnit>>();
  for (const unit of units.values()) {
    if (unit.video && unit.flatStem != null) {
      const bySeason = flatVideoUnits.get(unit.seasonFolder) ?? new Map<string, EpisodeUnit>();
      bySeason.set(unit.flatStem, unit);
      flatVideoUnits.set(unit.seasonFolder, bySeason);
    }
  }
  for (const unit of units.values()) {
    if (unit.video || unit.flatStem == null) {
      continue;
    }
    const candidatesInSeason = flatVideoUnits.get(unit.seasonFolder);
    if (!candidatesInSeason) {
      continue;
    }
    const subOwner = matchSidecarOwner(unit.flatStem, candidatesInSeason.keys(), SUBTITLE_SEPARATORS);
    if (subOwner) {
      candidatesInSeason.get(subOwner)!.subs.push(...unit.subs);
      candidatesInSeason.get(subOwner)!.audio.push(...unit.audio);
    }
    const imageOwner = matchSidecarOwner(unit.flatStem, candidatesInSeason.keys(), IMAGE_SEPARATORS);
    if (imageOwner) {
      candidatesInSeason.get(imageOwner)!.images.push(...unit.images);
    }
  }

  interface Resolved {
    unit: EpisodeUnit;
    season: number;
    episode: number | null;
    episodeTitle?: string;
  }
  const resolved: Resolved[] = [];
  for (const unit of units.values()) {
    if (!unit.video) {
      continue;
    }
    const season = parseSeasonNumber(unit.seasonRaw);
    const fromFilename = TV_EPISODE_PATTERN.exec(baseNameFromPath(unit.video.relativePath));
    if (fromFilename) {
      resolved.push({
        unit,
        season: Number(fromFilename[2]),
        episode: Number(fromFilename[3]),
        episodeTitle: stripReleaseNoise(cleanupWords(fromFilename[4])) || undefined,
      });
      continue;
    }
    const leadingNumber = /^\s*(\d{1,3})[ ._-]+(.*)$/.exec(cleanupWords(stemOf(unit.nameForParsing)));
    if (leadingNumber) {
      resolved.push({
        unit,
        season,
        episode: Number(leadingNumber[1]),
        episodeTitle: titleCase(leadingNumber[2]) || undefined,
      });
      continue;
    }
    resolved.push({ unit, season, episode: null });
  }

  // Reserve every explicitly-parsed episode number per season, then assign the
  // lowest free number (in path order) to anything that couldn't be parsed.
  const usedBySeasonKey = new Map<string, Set<number>>();
  for (const r of resolved) {
    if (r.episode == null) {
      continue;
    }
    const seasonKey = `${r.unit.showTitle}::${r.season}`;
    const used = usedBySeasonKey.get(seasonKey) ?? new Set<number>();
    used.add(r.episode);
    usedBySeasonKey.set(seasonKey, used);
  }

  const candidates: ScanCandidate[] = [];
  const sorted = [...resolved].sort((a, b) => a.unit.video!.relativePath.localeCompare(b.unit.video!.relativePath));
  for (const r of sorted) {
    let episode = r.episode;
    if (episode == null) {
      const seasonKey = `${r.unit.showTitle}::${r.season}`;
      const used = usedBySeasonKey.get(seasonKey) ?? new Set<number>();
      let candidate = 1;
      while (used.has(candidate)) {
        candidate++;
      }
      used.add(candidate);
      usedBySeasonKey.set(seasonKey, used);
      episode = candidate;
    }
    const title = `${r.unit.showTitle} S${pad2(r.season)}E${pad2(episode)}${r.episodeTitle ? ' - ' + r.episodeTitle : ''}`;
    candidates.push({
      primaryRelativePath: r.unit.video!.relativePath,
      title,
      mediaType: 'tvshow',
      tvMeta: { showTitle: r.unit.showTitle, season: r.season, episode, episodeTitle: r.episodeTitle },
      subtitleRelativePaths: r.unit.subs.map((s) => s.relativePath),
      audioRelativePaths: r.unit.audio.map((a) => a.relativePath),
      thumbnailRelativePath: pickPoster(r.unit.images),
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------
// Music: Artist/Album/tracks (+ optional cover art image in the Album folder).
// ---------------------------------------------------------------------

interface AlbumBucket {
  artist: string;
  album: string;
  tracks: ScanInputFile[];
  images: ScanInputFile[];
}

function classifyMusic(files: ScanInputFile[], directoryDisplayName: string): ScanCandidate[] {
  const albums = new Map<string, AlbumBucket>();

  for (const f of files) {
    const segments = f.relativePath.split('/');
    const ext = extensionOf(f.relativePath);
    let artist: string;
    let album: string;
    let filename: string;
    if (segments.length >= 3) {
      artist = titleCase(cleanupWords(segments[0]));
      album = titleCase(cleanupWords(segments[1]));
      filename = segments[segments.length - 1];
    } else if (segments.length === 2) {
      artist = titleCase(cleanupWords(segments[0]));
      album = 'Unknown Album';
      filename = segments[1];
    } else {
      artist = directoryDisplayName;
      album = 'Unknown Album';
      filename = segments[0];
    }

    const albumKey = `${artist}/${album}`;
    let bucket = albums.get(albumKey);
    if (!bucket) {
      bucket = { artist, album, tracks: [], images: [] };
      albums.set(albumKey, bucket);
    }
    if (IMAGE_EXTENSIONS.has(extensionOf(filename))) {
      bucket.images.push(f);
    } else if (AUDIO_EXTENSIONS.has(ext)) {
      bucket.tracks.push(f);
    }
  }

  const candidates: ScanCandidate[] = [];
  for (const bucket of albums.values()) {
    const thumbnailRelativePath = pickPoster(bucket.images);
    for (const track of bucket.tracks) {
      const filename = baseNameFromPath(track.relativePath);
      const numMatch = /^\s*(\d{1,3})[ ._-]+(.*)$/.exec(filename);
      const trackNumber = numMatch ? Number(numMatch[1]) : undefined;
      const rawTitle = numMatch ? numMatch[2] : filename;
      const title = titleCase(cleanupWords(rawTitle)) || filename;
      candidates.push({
        primaryRelativePath: track.relativePath,
        title,
        mediaType: 'music',
        musicMeta: { artist: bucket.artist, album: bucket.album, trackNumber },
        subtitleRelativePaths: [],
        thumbnailRelativePath,
      });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------
// Photos: unchanged flat behavior — one candidate per image file.
// ---------------------------------------------------------------------

function classifyPhotos(files: ScanInputFile[]): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];
  for (const f of files) {
    if (!IMAGE_EXTENSIONS.has(extensionOf(f.relativePath))) {
      continue;
    }
    candidates.push({
      primaryRelativePath: f.relativePath,
      title: titleCase(cleanupWords(baseNameFromPath(f.relativePath))),
      mediaType: 'photo',
      subtitleRelativePaths: [],
    });
  }
  return candidates;
}
