import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { MediaType } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { LibraryService } from '../../core/media/library.service';
import { Icon } from '../../ui/icon';
import { CardShape, MediaCard } from '../../ui/media-card';
import { UploadDialog } from '../upload-dialog/upload-dialog';

/** After an upload, how often / how long to look for the catalog-sync
 * Lambda's update (it batches S3 events for ~1 minute, then enriches). */
const POST_UPLOAD_POLL_MS = 20_000;
const POST_UPLOAD_POLL_MAX_MS = 5 * 60_000;

const SHAPE_FOR: Record<MediaType, CardShape> = { movie: 'poster', tvshow: 'poster', music: 'square', photo: 'square' };
const SORT_KEY = 's3player.sort';

/** One library section: everything in it as a grid (movies and shows as
 * posters, albums and photos square), sortable, plus Upload for those
 * allowed to. */
@Component({
  selector: 'app-directory-page',
  standalone: true,
  imports: [UploadDialog, MediaCard, Icon, TranslatePipe],
  templateUrl: './directory-page.html',
})
export class DirectoryPage {
  protected readonly auth = inject(AuthService);
  protected readonly mediaDb = inject(MediaDbService);
  protected readonly library = inject(LibraryService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly destroyRef = inject(DestroyRef);

  readonly directoryId = input.required<string>();

  /** Set after an upload, until the new files show up in the catalog. */
  readonly awaitingCatalog = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  protected readonly sort = signal<'recent' | 'title'>(this.storedSort());

  readonly directory = computed(() => this.library.directory(Number(this.directoryId())));
  protected readonly shape = computed<CardShape>(() => SHAPE_FOR[this.directory()?.mediaType ?? 'movie']);
  protected readonly tiles = computed(() => {
    const dir = this.directory();
    return dir ? this.library.tilesFor(dir, this.sort()) : [];
  });
  protected readonly countLabel = computed(() => {
    const n = this.tiles().length;
    switch (this.directory()?.mediaType) {
      case 'tvshow':
        return this.i18n.t(n === 1 ? 'count.shows.one' : 'count.shows.other', { n });
      case 'music':
        return this.i18n.t(n === 1 ? 'count.albums.one' : 'count.albums.other', { n });
      case 'photo':
        return this.library.count('count.photos', n);
      default:
        return this.i18n.t(n === 1 ? 'count.movies.one' : 'count.movies.other', { n });
    }
  });

  constructor() {
    // ensureLoaded() + a conditional re-fetch: picks up items the Lambda
    // catalogued since this browser session first loaded the catalog.
    void this.mediaDb.reloadIfChanged();
    this.destroyRef.onDestroy(() => clearInterval(this.pollTimer));
    effect(() => {
      // Not one of this user's sections (or deleted): back to Home.
      if (this.mediaDb.ready() && this.library.directories().length && !this.directory()) {
        this.router.navigateByUrl('/library');
      }
    });
  }

  protected setSort(sort: 'recent' | 'title'): void {
    this.sort.set(sort);
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      /* ignore */
    }
  }

  private storedSort(): 'recent' | 'title' {
    try {
      return localStorage.getItem(SORT_KEY) === 'title' ? 'title' : 'recent';
    } catch {
      return 'recent';
    }
  }

  /** Called after an upload. The files aren't in the catalog yet — the
   * catalog-sync Lambda adds them shortly — so check back periodically. */
  onUploaded(): void {
    clearInterval(this.pollTimer);
    this.awaitingCatalog.set(true);
    const startedAt = Date.now();
    this.pollTimer = setInterval(async () => {
      const changed = await this.mediaDb.reloadIfChanged().catch(() => false);
      if (changed || Date.now() - startedAt > POST_UPLOAD_POLL_MAX_MS) {
        clearInterval(this.pollTimer);
        this.awaitingCatalog.set(false);
      }
    }, POST_UPLOAD_POLL_MS);
  }
}
