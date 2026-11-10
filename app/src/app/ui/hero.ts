import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '../core/i18n/i18n.service';
import { Feature } from '../core/media/library.service';
import { I18nService } from '../core/i18n/i18n.service';
import { ThemeService } from '../core/theme/theme.service';
import { ArtImage } from './art-image';
import { Icon } from './icon';

const SLIDE_MS = 9000;

/** The home screen's banner: the newest movies and shows, full backdrop,
 * one at a time. Advances on its own (unless the pointer or focus is on it,
 * or the device asks for reduced motion). Aurora shows it as a glowing
 * card; the other themes edge to edge (layout().hero). */
@Component({
  selector: 's3-hero',
  standalone: true,
  imports: [RouterLink, ArtImage, Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (current(); as f) {
      <section
        class="s3-hero"
        [class.is-full]="full()"
        [attr.aria-roledescription]="'hero.carousel' | t"
        [attr.aria-label]="'hero.label' | t"
        (mouseenter)="hovered.set(true)"
        (mouseleave)="hovered.set(false)"
        (focusin)="focused.set(true)"
        (focusout)="focused.set(false)"
      >
        <!-- Ambient light: the current backdrop, blurred, behind the card. -->
        @if (!full()) {
          <s3-art aria-hidden="true" class="s3-hero-ambient" [key]="f.tile.wide" [title]="f.tile.title" [showTitle]="false" />
        }
        <div class="s3-hero-frame">
          @for (slide of features(); track slide.tile.id; let i = $index) {
            <div class="s3-hero-slide" [class.is-current]="i === index()" [attr.inert]="i === index() ? null : ''">
              <s3-art class="absolute inset-0" [key]="slide.tile.wide" [title]="slide.tile.title" [showTitle]="false" [eager]="i === 0" position="center 30%" />
              <div aria-hidden="true" class="s3-hero-scrim"></div>
              <div class="s3-hero-copy">
                @switch (style()) {
                  @case ('vetro') {
                    <span class="s3-hero-kicker">{{ vetroKicker(slide) }}</span>
                    <h1 class="s3-hero-title font-display">{{ slide.tile.title }}</h1>
                  }
                  @case ('proiezione') {
                    <span class="s3-hero-kicker">
                      <span class="text-primary">{{ 'hero.featured' | t }}</span>
                      @if (genre(slide); as g) {
                        <span aria-hidden="true" class="h-1 w-1 rounded-full bg-white/50"></span><span>{{ g }}</span>
                      }
                    </span>
                    <h1 class="s3-hero-title font-display">{{ slide.tile.title }}</h1>
                    @if (metaLine(slide).length) {
                      <div class="s3-hero-meta">
                        @for (part of metaLine(slide); track part) {
                          <span>{{ part }}</span>
                        }
                      </div>
                    }
                  }
                  @default {
                    <span class="s3-badge">{{ 'hero.justAdded' | t }}</span>
                    <h1 class="s3-hero-title font-display">{{ slide.tile.title }}</h1>
                    @if (slide.chips.length) {
                      <div class="flex flex-wrap gap-2">
                        @for (chip of slide.chips; track chip) {
                          <span class="s3-chip">{{ chip }}</span>
                        }
                      </div>
                    }
                  }
                }
                @if (slide.info?.overview; as overview) {
                  <p class="line-clamp-3 text-[17px] leading-relaxed text-white/85 max-sm:line-clamp-2 max-sm:text-[15px]">{{ overview }}</p>
                }
                <div class="mt-1.5 flex flex-wrap gap-3">
                  @if (slide.playId !== null) {
                    <a [routerLink]="['/play', slide.playId]" class="s3-btn s3-btn-primary">
                      <s3-icon name="play" [size]="18" />{{ (slide.resume ? 'action.resume' : 'action.play') | t }}
                    </a>
                  }
                  <a [routerLink]="slide.tile.link" class="s3-btn s3-btn-glass">{{ 'action.details' | t }}</a>
                </div>
              </div>
            </div>
          }
          @if (features().length > 1) {
            <div class="s3-hero-dots">
              @for (slide of features(); track slide.tile.id; let i = $index) {
                <button
                  type="button"
                  class="s3-hero-dot"
                  data-tv-skip
                  [class.is-current]="i === index()"
                  [attr.aria-label]="slide.tile.title"
                  [attr.aria-current]="i === index() ? 'true' : null"
                  (click)="index.set(i)"
                ></button>
              }
            </div>
          }
        </div>
      </section>
    }
  `,
})
export class Hero {
  private readonly theme = inject(ThemeService);
  private readonly i18n = inject(I18nService);

  readonly features = input.required<Feature[]>();

  protected readonly index = signal(0);
  protected readonly hovered = signal(false);
  protected readonly focused = signal(false);
  protected readonly full = computed(() => this.theme.layout().hero === 'full');
  /** Each theme words the banner its own way (see the mockups). */
  protected readonly style = computed(() => this.theme.theme());

  protected genre(slide: Feature): string {
    return slide.info?.genres?.[0] ?? '';
  }

  /** Vetro: "Film · Avventura · 2020". */
  protected vetroKicker(slide: Feature): string {
    const kind = this.i18n.t(slide.tile.kind === 'show' ? 'nav.shows' : 'kind.movie');
    const year = slide.info?.releaseYear ?? slide.info?.firstAirYear;
    return [kind, this.genre(slide), year].filter(Boolean).join(' · ');
  }

  /** Proiezione: "★ 7,8   2024   2 h 14 min" (the genre is in the kicker). */
  protected metaLine(slide: Feature): string[] {
    const genre = this.genre(slide);
    const parts = slide.chips.filter((c) => c !== genre);
    return [...parts.filter((p) => p.startsWith('★')), ...parts.filter((p) => !p.startsWith('★'))];
  }
  protected readonly current = computed(() => {
    const list = this.features();
    return list.length ? list[Math.min(this.index(), list.length - 1)] : null;
  });

  constructor() {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      return;
    }
    const timer = setInterval(() => {
      const count = this.features().length;
      if (count > 1 && !this.hovered() && !this.focused() && document.visibilityState === 'visible') {
        this.index.update((i) => (i + 1) % count);
      }
    }, SLIDE_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
