import { Injectable, signal } from '@angular/core';

export type DeviceKind = 'desktop' | 'phone' | 'tv';

const STORAGE_KEY = 's3player.device';
const PHONE_QUERY = '(max-width: 760px)';
/** Big screen, nothing to hover with: a TV browser driven by a remote. */
const TV_QUERY = '(hover: none) and (min-width: 1100px)';
const TV_USER_AGENT = /Android TV|GoogleTV|Google TV|BRAVIA|AFT[A-Z]|SMART-TV|SmartTV|Tizen|Web0S|webOS|HbbTV/i;

/** Which kind of screen the app runs on, which overrides some of a theme's
 * structural choices (see ThemeService.layout): phones get a bottom bar,
 * TVs get remote-friendly sizes and always-visible titles.
 *
 * TV detection is a best guess (TV browsers report themselves very
 * differently), so it can be forced: open the app once with ?tv=1 (or
 * ?tv=0 to undo) and the choice is remembered on that device. */
@Injectable({ providedIn: 'root' })
export class DeviceService {
  readonly kind = signal<DeviceKind>(this.detect());

  constructor() {
    this.applyUrlOverride();
    this.kind.set(this.detect());
    for (const query of [PHONE_QUERY, TV_QUERY]) {
      try {
        window.matchMedia(query).addEventListener('change', () => this.kind.set(this.detect()));
      } catch {
        /* matchMedia unavailable (tests): stay on the initial guess */
      }
    }
  }

  private detect(): DeviceKind {
    const forced = this.storedOverride();
    if (forced === 'tv') {
      return 'tv';
    }
    if (forced !== 'not-tv' && (TV_USER_AGENT.test(navigator.userAgent) || this.matches(TV_QUERY))) {
      return 'tv';
    }
    return this.matches(PHONE_QUERY) ? 'phone' : 'desktop';
  }

  private matches(query: string): boolean {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  }

  private applyUrlOverride(): void {
    const param = new URLSearchParams(window.location.search).get('tv');
    if (param === null) {
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, param === '1' ? 'tv' : 'not-tv');
    } catch {
      /* ignore */
    }
  }

  private storedOverride(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }
}
