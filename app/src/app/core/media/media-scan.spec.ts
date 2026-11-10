import { classifyDirectoryFiles } from './media-scan';

const tv = (paths: string[]) =>
  classifyDirectoryFiles(
    'tvshow',
    'Series',
    paths.map((relativePath) => ({ relativePath, size: 1000 })),
  );

describe('classifyDirectoryFiles (TV shows)', () => {
  it('reads a downloaded season folder (Release.S04/Show.S04E01.Title…)', () => {
    const [first, second] = tv([
      'The.Last.Ship.S04.1080p.AMZN.WEB-DL.DDP5.1.HEVC.ita.eng.ZK/The.Last.Ship.S04E01.In.Medias.Res.1080p.AMZN.WEB-DL.DDP5.1.HEVC-ZK.mp4',
      'The.Last.Ship.S04.1080p.AMZN.WEB-DL.DDP5.1.HEVC.ita.eng.ZK/The.Last.Ship.S04E09.Detect,.Deceive,.Destroy.1080p.AMZN.WEB-DL.DDP5.1.HEVC-ZK.mp4',
    ]);
    expect(first.tvMeta).toEqual({ showTitle: 'The Last Ship', season: 4, episode: 1, episodeTitle: 'In Medias Res' });
    expect(second.tvMeta?.episodeTitle).toBe('Detect, Deceive, Destroy');
    expect(first.title).toBe('The Last Ship S04E01 - In Medias Res');
  });

  it('still reads Show/Season NN/episode', () => {
    const [ep] = tv(['Lost/Season 2/03 - Orientation.mkv']);
    expect(ep.tvMeta).toEqual({ showTitle: 'Lost', season: 2, episode: 3, episodeTitle: 'Orientation' });
  });

  it('reads loose Show.SxxEyy files at the top, and skips loose files without SxxEyy', () => {
    const items = tv(['Dark.S01E02.Lies.720p.mkv', 'random.mkv']);
    expect(items.length).toBe(1);
    expect(items[0].tvMeta).toEqual({ showTitle: 'Dark', season: 1, episode: 2, episodeTitle: 'Lies' });
  });

  it('keeps subtitles with their episode in a season folder', () => {
    const [ep] = tv(['Dark.S01/Dark.S01E01.mkv', 'Dark.S01/Dark.S01E01.ita.srt']);
    expect(ep.subtitleRelativePaths).toEqual(['Dark.S01/Dark.S01E01.ita.srt']);
  });
});

const movies = (paths: string[]) =>
  classifyDirectoryFiles(
    'movie',
    'Movies',
    paths.map((relativePath) => ({ relativePath, size: 1000 })),
  );

describe('classifyDirectoryFiles (audio language sidecars)', () => {
  it('attaches <stem>.<lang>.m4a to a loose movie, not to a shorter-named one', () => {
    const result = movies(['Film.mp4', 'Film.ita.m4a', 'Film.2.mp4', 'Film.2.fra.m4a']);
    const byPath = new Map(result.map((c) => [c.primaryRelativePath, c]));
    expect(result.length).toBe(2);
    expect(byPath.get('Film.mp4')!.audioRelativePaths).toEqual(['Film.ita.m4a']);
    expect(byPath.get('Film.2.mp4')!.audioRelativePaths).toEqual(['Film.2.fra.m4a']);
  });

  it('keeps audio files with the movie in its folder', () => {
    const [movie] = movies(['Dune (2021)/Dune.mp4', 'Dune (2021)/Dune.ita.m4a', 'Dune (2021)/Dune.audio3.m4a']);
    expect(movie.audioRelativePaths).toEqual(['Dune (2021)/Dune.ita.m4a', 'Dune (2021)/Dune.audio3.m4a']);
  });

  it('keeps audio files with their episode', () => {
    const [ep] = tv(['Dark.S01/Dark.S01E01.mp4', 'Dark.S01/Dark.S01E01.ita.m4a']);
    expect(ep.audioRelativePaths).toEqual(['Dark.S01/Dark.S01E01.ita.m4a']);
  });
});
