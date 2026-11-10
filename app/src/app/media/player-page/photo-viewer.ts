import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MediaDbService } from '../../core/db/media-db.service';
import { MediaItem } from '../../core/db/schema';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { ArtworkService } from '../../core/media/artwork.service';
import { Icon } from '../../ui/icon';

/** A photo, full screen, with previous/next through its section (in the
 * order the section page shows them). ←/→ to move, Esc to go back. */
@Component({
  selector: 'app-photo-viewer',
  standalone: true,
  imports: [RouterLink, Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'fixed inset-0 z-50 block bg-black text-white', '(document:keydown)': 'onKey($event)' },
  template: `
    @if (url(); as src) {
      <img [src]="src" [alt]="item().title" class="absolute inset-0 h-full w-full object-contain" />
    } @else {
      <div class="absolute inset-0 flex items-center justify-center"><span class="loading loading-spinner loading-lg"></span></div>
    }
    <header class="s3-player-top">
      <a [routerLink]="backLink()" class="s3-icon-button h-12! w-12!" [attr.aria-label]="'nav.back' | t"><s3-icon name="back" [size]="22" [stroke]="2.2" /></a>
      <div class="flex min-w-0 flex-col">
        <span class="truncate font-semibold">{{ item().title }}</span>
        <span class="text-sm text-white/70 tabular-nums">{{ index() + 1 }} / {{ photos().length }}</span>
      </div>
    </header>
    @if (previous(); as p) {
      <button type="button" class="s3-player-btn absolute top-1/2 left-4 -translate-y-1/2" [attr.aria-label]="'shelf.previous' | t" (click)="go(p)"><s3-icon name="back" [size]="24" [stroke]="2.2" /></button>
    }
    @if (next(); as n) {
      <button type="button" class="s3-player-btn absolute top-1/2 right-4 -translate-y-1/2" [attr.aria-label]="'shelf.next' | t" (click)="go(n)"><s3-icon name="forward" [size]="24" [stroke]="2.2" /></button>
    }
  `,
})
export class PhotoViewer {
  private readonly mediaDb = inject(MediaDbService);
  private readonly artwork = inject(ArtworkService);
  private readonly router = inject(Router);

  readonly item = input.required<MediaItem>();
  readonly backLink = input.required<(string | number)[]>();

  protected readonly url = computed(() => this.artwork.url(this.item().s3Key));
  protected readonly photos = computed(() => {
    const list = this.mediaDb.listMediaItems(this.item().directoryId);
    let byTitle = false;
    try {
      byTitle = localStorage.getItem('s3player.sort') === 'title';
    } catch {
      /* ignore */
    }
    return byTitle ? list : [...list].sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
  });
  protected readonly index = computed(() => this.photos().findIndex((p) => p.id === this.item().id));
  protected readonly previous = computed(() => this.photos()[this.index() - 1] ?? null);
  protected readonly next = computed(() => {
    const next = this.photos()[this.index() + 1] ?? null;
    // Sign the next one ahead of time so it appears instantly.
    if (next) {
      this.artwork.url(next.s3Key);
    }
    return next;
  });

  protected go(photo: MediaItem): void {
    void this.router.navigate(['/play', photo.id], { replaceUrl: true });
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft' && this.previous()) {
      this.go(this.previous()!);
    } else if (event.key === 'ArrowRight' && this.next()) {
      this.go(this.next()!);
    } else if (event.key === 'Escape') {
      void this.router.navigate(this.backLink());
    }
  }
}
