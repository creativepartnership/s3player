import { ALIASES } from './subtitle-tracks';

/** One language the player can offer. `key` is the alternate-language audio
 * file to play in sync with the (muted) video, or null for the video's own
 * main track. */
export interface AudioLanguage {
  key: string | null;
  /** BCP 47 code ("it"), or '' if unknown. */
  lang: string;
  label: string;
}

/** "ita" / "it" → "it"; '' for undetermined or unknown codes. */
export function normalizeLanguage(code: string | null | undefined): string {
  const c = (code ?? '').trim().toLowerCase();
  if (!c || c === 'und' || c === 'zxx' || c === 'mis') {
    return '';
  }
  if (c in ALIASES) {
    return ALIASES[c];
  }
  return /^[a-z]{2}(-[a-z]{2,4})?$/.test(c) ? c : '';
}

/**
 * The language menu for a video: its main track (whose language the
 * media-transcode function records on the sidecars, so `mainLanguage` may be
 * unknown) plus one entry per "<video stem>.<lang>.m4a" sidecar (or
 * "<stem>.audio<N>.m4a" for a track with no language). Labels use the UI
 * language: "Italiano", "English", …
 */
export function describeAudio(
  keys: string[],
  mainLanguage: string,
  uiLocale: string,
  labels: { main: string; track: (n: number) => string },
): AudioLanguage[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([uiLocale], { type: 'language' });
  } catch {
    /* very old browser: raw codes */
  }
  const nameOf = (lang: string): string => {
    if (!lang) {
      return '';
    }
    let label = lang;
    try {
      label = names?.of(lang) ?? lang;
    } catch {
      /* keep the code */
    }
    return label.charAt(0).toLocaleUpperCase(uiLocale) + label.slice(1);
  };

  const main = normalizeLanguage(mainLanguage);
  const alternates = keys
    .filter((key) => /\.m4a$/i.test(key))
    .map((key, index) => {
      const tag = (key.split('/').pop() ?? key).replace(/\.m4a$/i, '').split('.').pop() ?? '';
      const lang = normalizeLanguage(tag);
      const numbered = /^audio(\d+)$/i.exec(tag);
      return { key, lang, label: nameOf(lang) || labels.track(numbered ? Number(numbered[1]) : index + 2) };
    })
    .sort((a, b) => a.label.localeCompare(b.label, uiLocale));
  return [{ key: null, lang: main, label: nameOf(main) || labels.main }, ...alternates];
}
