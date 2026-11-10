import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { MediaDbService } from '../db/media-db.service';
import { DeviceService } from './device.service';
import { DEFAULT_THEME, isThemeId, ThemeId, ThemeLayout, themeById, THEMES } from './themes';

const STORAGE_KEY = 's3player.theme';
/** app_settings key holding the admin-chosen default theme. */
export const DEFAULT_THEME_SETTING_KEY = 'default_theme';

/** Effective layout once the device's needs are applied on top of the
 * theme's own choices. */
export interface EffectiveLayout extends Omit<ThemeLayout, 'nav'> {
  nav: ThemeLayout['nav'] | 'bottom';
}

/** The active theme: this device's own choice if it made one, else the
 * admin's default (stored in the catalog), else Aurora. Exposed to CSS as
 * <html data-theme="s3player-<id>" data-device data-nav data-captions
 * data-hero>, so most styling needs no component code at all. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly mediaDb = inject(MediaDbService);
  private readonly device = inject(DeviceService);

  readonly themes = THEMES;
  /** This device's explicit choice, if any. */
  private readonly deviceChoice = signal<ThemeId | null>(this.readStoredChoice());

  /** The admin's default, from the catalog (once it's loaded). */
  readonly defaultTheme = computed<ThemeId>(() => {
    this.mediaDb.version();
    if (!this.mediaDb.ready()) {
      return DEFAULT_THEME;
    }
    const stored = this.mediaDb.getSetting(DEFAULT_THEME_SETTING_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  });

  readonly theme = computed<ThemeId>(() => this.deviceChoice() ?? this.defaultTheme());

  readonly layout = computed<EffectiveLayout>(() => {
    const base = themeById(this.theme()).layout;
    const kind = this.device.kind();
    return {
      nav: kind === 'phone' ? 'bottom' : base.nav,
      // From across the room, a title that only appears on focus is too
      // little to go on: TVs always show them.
      captions: kind === 'tv' ? 'always' : base.captions,
      hero: base.hero,
    };
  });

  constructor() {
    effect(() => {
      const root = document.documentElement;
      const layout = this.layout();
      root.setAttribute('data-theme', `s3player-${this.theme()}`);
      root.setAttribute('data-device', this.device.kind());
      root.setAttribute('data-nav', layout.nav);
      root.setAttribute('data-captions', layout.captions);
      root.setAttribute('data-hero', layout.hero);
    });
  }

  /** Picks a theme for this device only. */
  set(id: ThemeId): void {
    this.deviceChoice.set(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage unavailable: the choice lasts for this session only */
    }
  }

  /** Admins: the theme every device uses until it picks its own. */
  async setDefault(id: ThemeId): Promise<void> {
    await this.mediaDb.setSetting(DEFAULT_THEME_SETTING_KEY, id);
  }

  private readStoredChoice(): ThemeId | null {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      // Older versions stored 'light'/'dark' here; those are simply ignored.
      return isThemeId(stored) ? stored : null;
    } catch {
      return null;
    }
  }
}
