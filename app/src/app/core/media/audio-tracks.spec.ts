import { describeAudio, normalizeLanguage } from './audio-tracks';

const labels = { main: 'Main', track: (n: number) => `Audio ${n}` };

describe('normalizeLanguage', () => {
  it('maps ISO 639-2 codes and drops undetermined ones', () => {
    expect(normalizeLanguage('ita')).toBe('it');
    expect(normalizeLanguage('EN')).toBe('en');
    expect(normalizeLanguage('und')).toBe('');
    expect(normalizeLanguage('audio3')).toBe('');
  });
});

describe('describeAudio', () => {
  it('lists the main track first, then each sidecar by language name', () => {
    const tracks = describeAudio(['m/Film.ita.m4a', 'm/Film.fra.m4a'], 'eng', 'en', labels);
    expect(tracks.map((t) => [t.key, t.lang, t.label])).toEqual([
      [null, 'en', 'English'],
      ['m/Film.fra.m4a', 'fr', 'French'],
      ['m/Film.ita.m4a', 'it', 'Italian'],
    ]);
  });

  it('falls back to generic labels when languages are unknown', () => {
    const tracks = describeAudio(['m/Film.audio3.m4a'], '', 'en', labels);
    expect(tracks.map((t) => t.label)).toEqual(['Main', 'Audio 3']);
  });
});
