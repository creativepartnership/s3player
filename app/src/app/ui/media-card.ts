import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Tile } from '../core/media/library.service';
import { TranslatePipe } from '../core/i18n/i18n.service';
import { ArtImage } from './art-image';
import { Icon } from './icon';

export type CardShape = 'poster' | 'wide' | 'square';

/** A tile as a card: artwork (with the theme's glow and lift on hover or
 * focus), progress/watched marks, and the title under it — or, in themes
 * with captions "on focus", over it only while focused. */
@Component({
  selector: 's3-card',
  standalone: true,
  imports: [RouterLink, ArtImage, Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    <a [routerLink]="tile().link" class="s3-card group flex flex-col gap-3 rounded-[var(--s3-radius-card)] outline-none" [attr.aria-label]="label()">
      <s3-art
        class="s3-card-art s3-glow rounded-[var(--s3-radius-card)]"
        [class.aspect-[2/3]]="shape() === 'poster'"
        [class.aspect-video]="shape() === 'wide'"
        [class.aspect-square]="shape() === 'square'"
        [key]="image()"
        [title]="tile().title"
        [eager]="eager()"
        [showTitle]="shape() !== 'wide' || !image()"
      >
        @if (shape() === 'wide' && tile().kind === 'show') {
          <span aria-hidden="true" class="absolute inset-0 bg-[linear-gradient(180deg,transparent_45%,rgb(var(--s3-scrim)/0.85))]"></span>
          <span class="font-display absolute inset-x-5 bottom-4 text-[22px] leading-tight font-bold text-white">{{ tile().title }}</span>
        }
        @if (tile().watched) {
          <span class="absolute top-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-content" role="img" [attr.aria-label]="'card.watched' | t">
            <s3-icon name="check" [size]="15" [stroke]="3" />
          </span>
        }
        @if (tile().progress !== undefined) {
          <span aria-hidden="true" class="s3-card-play"><s3-icon name="play" [size]="20" /></span>
          <span class="s3-card-progress">
            <span class="s3-progress-fill block h-full" [style.width.%]="tile().progress"></span>
          </span>
        }
      </s3-art>
      @if (!(shape() === 'wide' && tile().kind === 'show')) {
        <span class="s3-caption flex min-w-0 flex-col gap-0.5 px-1">
          <span class="truncate text-[15px] font-semibold">{{ tile().title }}</span>
          @if (tile().meta) {
            <span class="truncate text-[13px] text-[var(--s3-text-muted)]">{{ tile().meta }}</span>
          }
        </span>
      }
    </a>
  `,
})
export class MediaCard {
  readonly tile = input.required<Tile>();
  readonly shape = input<CardShape>('poster');
  readonly eager = input(false);

  protected readonly image = computed(() => {
    const tile = this.tile();
    return this.shape() === 'wide' ? (tile.wide ?? tile.image) : tile.image;
  });

  protected readonly label = computed(() => [this.tile().title, this.tile().meta].filter(Boolean).join(', '));
}
