import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '../core/i18n/i18n.service';
import { Icon } from './icon';

/** A titled, horizontally scrolling row of cards ("Continue watching",
 * "New arrivals", one per library section). Arrow buttons page through it
 * with a mouse; touch and remotes just scroll/move focus. */
@Component({
  selector: 's3-shelf',
  standalone: true,
  imports: [RouterLink, Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'group/shelf flex min-w-0 flex-col gap-3' },
  template: `
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-[var(--s3-gutter)]">
      <h2 class="font-display text-[22px] font-semibold tracking-tight sm:text-2xl">
        @if (link(); as to) {
          <a [routerLink]="to" class="inline-flex items-center gap-1.5 hover:text-primary">
            {{ heading() }} <s3-icon name="forward" [size]="18" [stroke]="2.2" class="opacity-60" />
          </a>
        } @else {
          {{ heading() }}
        }
      </h2>
      <ng-content select="[shelf-actions]" />
    </div>
    <div class="relative">
      <div #track class="s3-row flex snap-x gap-[var(--s3-row-gap)] overflow-x-auto scroll-smooth px-[var(--s3-gutter)] pt-3 pb-7 scroll-px-[var(--s3-gutter)]">
        <ng-content />
      </div>
      <button type="button" tabindex="-1" class="s3-shelf-arrow left-1" [attr.aria-label]="'shelf.previous' | t" (click)="page(-1)">
        <s3-icon name="back" [size]="22" [stroke]="2.4" />
      </button>
      <button type="button" tabindex="-1" class="s3-shelf-arrow right-1" [attr.aria-label]="'shelf.next' | t" (click)="page(1)">
        <s3-icon name="forward" [size]="22" [stroke]="2.4" />
      </button>
    </div>
  `,
})
export class Shelf {
  readonly heading = input.required<string>();
  readonly link = input<(string | number)[] | null>(null);
  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');

  protected page(direction: number): void {
    const el = this.track().nativeElement;
    el.scrollBy({ left: direction * el.clientWidth * 0.85 });
  }
}
