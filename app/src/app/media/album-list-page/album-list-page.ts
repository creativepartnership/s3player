import { Component, computed, effect, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MediaDbService } from '../../core/db/media-db.service';
import { TranslatePipe } from '../../core/i18n/i18n.service';
import { LibraryService } from '../../core/media/library.service';
import { Icon } from '../../ui/icon';
import { MediaCard } from '../../ui/media-card';

/** One artist's albums. */
@Component({
  selector: 'app-album-list-page',
  standalone: true,
  imports: [RouterLink, MediaCard, Icon, TranslatePipe],
  templateUrl: './album-list-page.html',
})
export class AlbumListPage {
  protected readonly mediaDb = inject(MediaDbService);
  protected readonly library = inject(LibraryService);
  private readonly router = inject(Router);

  readonly directoryId = input.required<string>();
  readonly artistName = input.required<string>();

  protected readonly directory = computed(() => this.library.directory(Number(this.directoryId())));
  protected readonly albums = computed(() => {
    const dir = this.directory();
    this.mediaDb.version();
    return dir
      ? this.mediaDb
          .listAllAlbums(dir.id)
          .filter((a) => a.artist === this.artistName())
          .map((a) => this.library.albumTile(a))
      : [];
  });

  constructor() {
    void this.mediaDb.ensureLoaded();
    effect(() => {
      if (this.mediaDb.ready() && this.library.directories().length && !this.directory()) {
        this.router.navigateByUrl('/library');
      }
    });
  }
}
