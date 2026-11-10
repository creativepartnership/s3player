import { DestroyRef, Injectable, effect, inject } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs';
import { DeviceService } from './device.service';
import { Box, Direction, pickNext } from './spatial-nav';

const KEY_DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};
const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack', 'Backspace']);
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** These handle the remote themselves (seek, volume, next photo). */
const SELF_HANDLED = 'app-video-player, app-photo-viewer';

/** TV remotes have arrows, OK and Back, not Tab: on TVs the arrows move
 * focus to the nearest control in that direction, OK presses it (native),
 * Back goes back. Each page also starts with something focused, so the
 * first press does something visible. Off on computers and phones. */
@Injectable({ providedIn: 'root' })
export class SpatialNavService {
  private readonly device = inject(DeviceService);
  private readonly router = inject(Router);
  private enabled = false;
  private readonly lastFocus = new WeakMap<Element, HTMLElement>();
  /** URL → what was focused there (see describe()). */
  private readonly focusByUrl = new Map<string, string>();
  private returning = false;

  constructor() {
    const onKey = (event: KeyboardEvent) => this.onKey(event);
    document.addEventListener('keydown', onKey);
    effect(() => {
      this.enabled = this.device.kind() === 'tv';
    });
    const sub = this.router.events
      .pipe(filter((e) => e instanceof NavigationStart || e instanceof NavigationEnd))
      .subscribe((e) => {
        if (!this.enabled) {
          return;
        }
        if (e instanceof NavigationStart) {
          // Remember where focus was, to put it back when coming back here.
          this.focusByUrl.set(this.router.url, describe(document.activeElement));
          this.returning = e.navigationTrigger === 'popstate';
          return;
        }
        const returning = this.returning;
        // After the new page renders (and its data loads).
        setTimeout(() => this.focusInitial(false, returning), 120);
        setTimeout(() => this.focusInitial(false, returning), 800);
      });
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('keydown', onKey);
      sub.unsubscribe();
    });
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.enabled || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (document.querySelector(SELF_HANDLED)) {
      return;
    }
    const target = event.target as HTMLElement;
    const direction = KEY_DIRECTIONS[event.key];
    if (direction) {
      if (this.keepsArrow(target, direction)) {
        return;
      }
      event.preventDefault();
      this.move(direction);
      return;
    }
    if (BACK_KEYS.has(event.key) && !isTextField(target) && !document.querySelector('dialog[open]')) {
      if (this.router.url !== '/library') {
        event.preventDefault();
        history.back();
      }
    }
  }

  /** Text fields keep left/right (caret) and selects keep up/down (options). */
  private keepsArrow(target: HTMLElement, direction: Direction): boolean {
    if (isTextField(target)) {
      return direction === 'left' || direction === 'right';
    }
    if (target.tagName === 'SELECT') {
      return direction === 'up' || direction === 'down';
    }
    if (target instanceof HTMLInputElement && target.type === 'range') {
      return direction === 'left' || direction === 'right';
    }
    return false;
  }

  private move(direction: Direction): void {
    const current = document.activeElement as HTMLElement | null;
    const candidates = this.focusables().filter((el) => el !== current);
    if (!current || current === document.body || !this.isVisible(current)) {
      this.focusInitial(true);
      return;
    }
    const from = toBox(current.getBoundingClientRect());
    const target = this.pick(current, from, direction, candidates);
    if (target) {
      this.focus(target);
    } else if (direction === 'up') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  /** Left/right stay within the current row; past its end they only cross
   * into another part of the screen (content → menu and back), landing on
   * the menu's current section. Up/down go to the nearest thing below or
   * above in the same part of the screen first. */
  private pick(current: HTMLElement, from: Box, direction: Direction, candidates: HTMLElement[]): HTMLElement | null {
    const boxes = candidates.map((el) => toBox(el.getBoundingClientRect()));
    const region = regionOf(current);
    const horizontal = direction === 'left' || direction === 'right';
    const sameRegion = candidates.map((el) => regionOf(el) === region);
    const inLane = boxes.map((b) => (horizontal ? overlaps(from.top, from.bottom, b.top, b.bottom) : true));

    const choose = (allowed: (i: number) => boolean): HTMLElement | null => {
      const subset = candidates.filter((_, i) => allowed(i));
      const index = pickNext(from, direction, boxes.filter((_, i) => allowed(i)));
      return index >= 0 ? subset[index] : null;
    };

    const local = choose((i) => sameRegion[i] && inLane[i]);
    if (local) {
      return local;
    }
    if (!horizontal) {
      const nearby = choose((i) => sameRegion[i]);
      if (nearby) {
        return nearby;
      }
    }
    // Up/down only cross into a bar above or below (top bar, phone bar);
    // the side rail is reached with left/right.
    const stacked = (el: Element | null) => !!el?.matches('.s3-topbar, .s3-bottom-nav');
    const other = choose(
      (i) => !sameRegion[i] && (horizontal || stacked(regionOf(candidates[i])) || stacked(region)),
    );
    if (!other) {
      return null;
    }
    if (!horizontal) {
      return other;
    }
    // Back where we last were in that part of the screen (menu → content
    // returns to the same card); the first time into a menu, its current
    // section.
    const otherRegion = regionOf(other);
    const remembered = otherRegion ? this.lastFocus.get(otherRegion) : undefined;
    if (remembered?.isConnected && this.isVisible(remembered)) {
      return remembered;
    }
    const active = otherRegion?.matches('.s3-rail, .s3-topbar, .s3-bottom-nav')
      ? otherRegion.querySelector<HTMLElement>('.is-active')
      : null;
    return active && this.isVisible(active) ? active : other;
  }

  /** Focuses the page's main action, unless the user already focused
   * something on it. */
  private focusInitial(force = false, returning = false): void {
    if (document.querySelector(SELF_HANDLED)) {
      return; // the player focuses its own play button
    }
    const active = document.activeElement as HTMLElement | null;
    if (!force && active && active !== document.body && this.isVisible(active)) {
      return;
    }
    const previous = returning ? this.focusByUrl.get(this.router.url) : undefined;
    if (previous) {
      const match = this.focusables().find((el) => describe(el) === previous);
      if (match) {
        this.focus(match);
        return;
      }
    }
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const preferred = scope.querySelector<HTMLElement>('.s3-btn-primary, .s3-hero .s3-btn, .s3-card, .s3-episode, .s3-track');
    const first = preferred && this.isVisible(preferred) ? preferred : this.focusables(scope)[0];
    if (first) {
      this.focus(first);
    }
  }

  private focus(el: HTMLElement): void {
    const region = regionOf(el);
    if (region) {
      this.lastFocus.set(region, el);
    }
    el.focus({ preventScroll: true });
    // Keep the focused item comfortably on screen: centred vertically, and
    // fully inside its horizontal row.
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }

  private focusables(scope: ParentNode = document.querySelector('dialog[open]') ?? document): HTMLElement[] {
    return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      // tabindex="-1" / data-tv-skip: pointer helpers (a row's scroll
      // arrows, the banner's dots) that would only be extra stops on a TV.
      (el) => el.getAttribute('tabindex') !== '-1' && !el.hasAttribute('data-tv-skip') && this.isVisible(el),
    );
  }

  private isVisible(el: HTMLElement): boolean {
    if (el.closest('[inert], [aria-hidden="true"]')) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
}

/** Enough to find "the same" element again after its page is re-created. */
function describe(el: Element | null): string {
  if (!el || el === document.body) {
    return '';
  }
  return `${el.tagName}|${el.getAttribute('href') ?? ''}|${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 60) ?? ''}`;
}

/** The part of the screen an element belongs to: a menu, a dialog, or the
 * page itself. */
function regionOf(el: HTMLElement): Element | null {
  return el.closest('.s3-rail, .s3-topbar, .s3-bottom-nav, dialog, main');
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0;
}

function toBox(rect: DOMRect): Box {
  // Viewport coordinates: right for fixed menus (where they are on screen)
  // and, since everything shares them, for items scrolled out of view too.
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function isTextField(el: HTMLElement): boolean {
  return el.tagName === 'TEXTAREA' || (el instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(el.type));
}
