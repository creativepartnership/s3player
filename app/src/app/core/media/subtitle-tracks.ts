/** A subtitle file the player can offer (only WebVTT plays in browsers; the
 * catalog-sync Lambda converts .srt to .vtt next to it). */
export interface SubtitleTrack {
  key: string;
  /** BCP 47 code if the file name has one ("Film.it.vtt" → "it"). */
  lang: string;
  label: string;
  forced: boolean;
}

const LANG_TAG = /^[a-z]{2,3}(-[a-z]{2,4})?$/i;
const FLAGS = new Set(['forced', 'sdh', 'cc', 'hi', 'default']);
/** ISO 639-2 codes (what video files use) and other common names people use
 * in file names, to the BCP 47 codes Intl.DisplayNames knows. */
export const ALIASES: Record<string, string> = {
  ita: 'it', eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', esp: 'es', por: 'pt', jpn: 'ja', rus: 'ru',
  chi: 'zh', zho: 'zh', kor: 'ko', dut: 'nl', nld: 'nl', pol: 'pl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', gre: 'el',
  ell: 'el', tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', hun: 'hu', cze: 'cs', ces: 'cs', rum: 'ro', ron: 'ro', ukr: 'uk',
};

/** "Film.it.forced.vtt" → { lang: 'it', label: 'Italiano (forced)' }, using
 * the UI language for the language names. */
export function describeSubtitles(keys: string[], uiLocale: string, forcedLabel: string): SubtitleTrack[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([uiLocale], { type: 'language' });
  } catch {
    /* very old browser: raw codes */
  }
  const tracks = keys
    .filter((key) => /\.vtt$/i.test(key))
    .map((key, index) => {
      const file = key.split('/').pop() ?? key;
      const parts = file.replace(/\.vtt$/i, '').split('.').slice(1).map((p) => p.toLowerCase());
      const forced = parts.includes('forced');
      const tag = [...parts].reverse().find((p) => !FLAGS.has(p) && (LANG_TAG.test(p) || p in ALIASES));
      const lang = tag ? (ALIASES[tag] ?? tag) : '';
      let label = '';
      if (lang) {
        try {
          label = names?.of(lang) ?? lang;
        } catch {
          label = lang;
        }
        label = label.charAt(0).toLocaleUpperCase(uiLocale) + label.slice(1);
      }
      label ||= keys.length > 1 ? `${index + 1}` : 'Sub';
      return { key, lang, label: forced ? `${label} (${forcedLabel})` : label, forced };
    });
  return tracks.sort((a, b) => a.label.localeCompare(b.label, uiLocale));
}
