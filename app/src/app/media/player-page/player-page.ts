import { Component, computed, effect, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MediaDbService } from '../../core/db/media-db.service';
import { MediaItem } from '../../core/db/schema';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { LibraryService } from '../../core/media/library.service';
import { AudioPlayer } from './audio-player';
import { PhotoViewer } from './photo-viewer';
import { VideoPlayer } from './video-player';

/** /play/:id — picks the right player for the item. */
@Component({
  selector: 'app-player-page',
  standalone: true,
  imports: [RouterLink, VideoPlayer, AudioPlayer, PhotoViewer, TranslatePipe],
  template: `
    @if (!mediaDb.ready()) {
      <div class="fixed inset-0 flex items-center justify-center bg-black"><span class="loading loading-spinner loading-lg text-white"></span></div>
    } @else if (item(); as it) {
      @switch (it.mediaType) {
        @case ('music') {
          <app-audio-player [item]="it" [backLink]="backLink()" />
        }
        @case ('photo') {
          <app-photo-viewer [item]="it" [backLink]="backLink()" />
        }
        @default {
          <app-video-player [item]="it" [backLink]="backLink()" />
        }
      }
    } @else {
      <div class="flex flex-col items-start gap-4 px-[var(--s3-gutter)] py-16">
        <p class="text-[var(--s3-text-muted)]">{{ 'detail.notFound' | t }}</p>
        <a routerLink="/library" class="s3-btn s3-btn-glass">{{ 'nav.home' | t }}</a>
      </div>
    }
  `,
})
export class PlayerPage {
  protected readonly mediaDb = inject(MediaDbService);
  private readonly library = inject(LibraryService);
  private readonly router = inject(Router);

  readonly mediaItemId = input.required<string>();

  readonly item = computed<MediaItem | null>(() => {
    this.mediaDb.version();
    const item = this.mediaDb.ready() ? this.mediaDb.getMediaItem(Number(this.mediaItemId())) : null;
    return item && this.library.canAccess(item.directoryId) ? item : null;
  });

  /** Back goes where the user came from in the library: the movie, the
   * episode's season, the track's album, the photo's section. */
  readonly backLink = computed<(string | number)[]>(() => {
    const item = this.item();
    if (!item) {
      return ['/library'];
    }
    if (item.mediaType === 'tvshow') {
      const tv = this.mediaDb.getTvMeta(item.id);
      if (tv) {
        return ['/library', item.directoryId, 'show', tv.showTitle, 'season', tv.season];
      }
    }
    if (item.mediaType === 'music') {
      const music = this.mediaDb.getMusicMeta(item.id);
      if (music) {
        return ['/library', item.directoryId, 'artist', music.artist, 'album', music.album];
      }
    }
    if (item.mediaType === 'movie') {
      return ['/library', item.directoryId, 'movie', item.id];
    }
    return ['/library', item.directoryId];
  });

  constructor() {
    void this.mediaDb.ensureLoaded();
    effect(() => {
      // Signed in but this item isn't (or is no longer) theirs to see.
      if (this.mediaDb.ready() && this.library.directories().length && !this.item() && this.mediaDb.getMediaItem(Number(this.mediaItemId()))) {
        void this.router.navigateByUrl('/library');
      }
    });
  }
}
