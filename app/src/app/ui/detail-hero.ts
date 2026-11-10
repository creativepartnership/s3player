import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '../core/i18n/i18n.service';
import { MessageKey } from '../core/i18n/messages.en';
import { ThemeService } from '../core/theme/theme.service';
import { ArtImage } from './art-image';
import { Icon } from './icon';

/** Top of a movie/show/album page: the backdrop across the page (its
 * color bleeding into the background), poster, title, facts, plot, and the
 * page's own buttons (projected). */
@Component({
  selector: 's3-detail-hero',
  standalone: true,
  imports: [RouterLink, ArtImage, Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section class="s3-detail">
      <div aria-hidden="true" class="s3-detail-backdrop">
        <s3-art class="absolute inset-0" [key]="backdrop() ?? poster()" [title]="title()" [showTitle]="false" [eager]="true" position="center 25%" [class.is-blurred]="!backdrop()" />
        <div class="s3-detail-scrim"></div>
      </div>

      <div class="relative flex items-center justify-between gap-4 px-[var(--s3-gutter)] pt-6">
        <a [routerLink]="backLink()" class="s3-back">
          <s3-icon name="back" [size]="18" [stroke]="2.2" />{{ backLabel() || ('nav.back' | t) }}
        </a>
      </div>

      <div class="s3-detail-head">
        <s3-art
          class="s3-detail-poster s3-glow"
          [class.aspect-[2/3]]="!square()"
          [class.aspect-square]="square()"
          [key]="poster()"
          [title]="title()"
          [eager]="true"
        />
        <div class="s3-detail-info flex min-w-0 flex-1 flex-col gap-4">
          <ng-content select="[hero-badge]" />
          <h1 class="s3-detail-title font-display">{{ title() }}</h1>
          @if (tagline()) {
            <p class="-mt-1 text-lg text-white/75 italic">{{ tagline() }}</p>
          }
          @if (chips().length) {
            @if (style() === 'aurora') {
              <div class="flex flex-wrap gap-2">
                @for (chip of chips(); track chip) {
                  <span class="s3-chip">{{ chip }}</span>
                }
              </div>
            } @else {
              <div class="s3-hero-meta">
                @for (chip of metaChips(); track chip) {
                  <span>{{ chip }}</span>
                }
              </div>
            }
          }
          @if (overview()) {
            <p class="max-w-[760px] text-[17px] leading-relaxed text-white/85 max-sm:text-[15px]">{{ overview() }}</p>
          }
          <div class="mt-1 flex flex-wrap gap-3">
            <ng-content />
          </div>
        </div>
        @if (style() === 'vetro' && facts().length) {
          <dl class="s3-detail-facts">
            @for (fact of facts(); track fact.label) {
              <div class="flex justify-between gap-3">
                <dt class="text-white/60">{{ fact.label | t }}</dt>
                <dd class="text-right font-semibold">{{ fact.value }}</dd>
              </div>
            }
          </dl>
        }
      </div>
    </section>
  `,
})
export class DetailHero {
  readonly title = input.required<string>();
  readonly poster = input<string | null | undefined>(null);
  readonly backdrop = input<string | null | undefined>(null);
  readonly chips = input<string[]>([]);
  readonly tagline = input<string | undefined>(undefined);
  readonly overview = input<string | undefined>(undefined);
  readonly backLink = input.required<(string | number)[]>();
  readonly backLabel = input('');
  readonly square = input(false);
  /** Shown as a side panel by themes that have one (Vetro). */
  readonly facts = input<{ label: MessageKey; value: string }[]>([]);

  private readonly theme = inject(ThemeService);
  protected readonly style = computed(() => this.theme.theme());
  /** Rating first, as the Proiezione/Vetro mockups show it. */
  protected readonly metaChips = computed(() => {
    const chips = this.chips();
    return [...chips.filter((c) => c.startsWith('★')), ...chips.filter((c) => !c.startsWith('★'))];
  });
}
