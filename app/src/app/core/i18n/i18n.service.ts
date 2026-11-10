import { Injectable, Pipe, PipeTransform, effect, inject, signal } from '@angular/core';
import { EN, MessageKey, Messages } from './messages.en';
import { IT } from './messages.it';

export type Language = 'it' | 'en';

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'it', label: 'Italiano' },
  { id: 'en', label: 'English' },
];

const DICTIONARIES: Record<Language, Messages> = { it: IT, en: EN };
const STORAGE_KEY = 's3player.lang';

/** UI language, switchable at runtime (no reload, no separate builds). The
 * choice is remembered per browser; the first visit follows the browser's
 * language. Catalog content (titles, plots) comes in whatever language the
 * catalog-sync Lambda fetched it in. */
@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly language = signal<Language>(this.initialLanguage());

  constructor() {
    effect(() => {
      const lang = this.language();
      document.documentElement.lang = lang;
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch {
        /* storage unavailable: the choice lasts for this session only */
      }
    });
  }

  set(lang: Language): void {
    this.language.set(lang);
  }

  /** Translates a key, filling {placeholders} from params. Reading the
   * language signal makes callers inside computed()/templates update when
   * the language changes. */
  t(key: MessageKey, params?: Record<string, string | number>): string {
    const text = DICTIONARIES[this.language()][key] ?? EN[key] ?? key;
    return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
  }

  /** Locale for number/date formatting (e.g. "7,8" vs "7.8"). */
  locale(): string {
    return this.language() === 'it' ? 'it-IT' : 'en-US';
  }

  private initialLanguage(): Language {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'it' || stored === 'en') {
        return stored;
      }
    } catch {
      /* fall through */
    }
    return (navigator.language || 'en').toLowerCase().startsWith('it') ? 'it' : 'en';
  }
}

/** `{{ 'nav.home' | t }}` / `{{ 'x.y' | t: { n: 3 } }}`. Impure so it
 * re-renders when the language signal changes. */
@Pipe({ name: 't', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: MessageKey, params?: Record<string, string | number>): string {
    return this.i18n.t(key, params);
  }
}
