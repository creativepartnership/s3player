import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { DownloadService } from '../../core/media/download.service';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { formatRuntime, LibraryService } from '../../core/media/library.service';
import { WatchProgressService } from '../../core/media/watch-progress.service';
import { describeSubtitles } from '../../core/media/subtitle-tracks';
import { MessageKey } from '../../core/i18n/messages.en';
import { CastRow } from '../../ui/cast-row';
import { DetailHero } from '../../ui/detail-hero';
import { Icon } from '../../ui/icon';

@Component({
  selector: 'app-movie-detail-page',
  standalone: true,
  imports: [DetailHero, CastRow, Icon, TranslatePipe],
  templateUrl: './movie-detail-page.html',
})
export class MovieDetailPage {
  protected readonly mediaDb = inject(MediaDbService);
  protected readonly library = inject(LibraryService);
  private readonly router = inject(Router);
  private readonly progress = inject(WatchProgressService);
  private readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  private readonly downloads = inject(DownloadService);

  protected readonly downloading = signal(false);
  protected readonly downloadError = signal(false);

  readonly directoryId = input.required<string>();
  readonly mediaItemId = input.required<string>();

  readonly item = computed(() => {
    this.mediaDb.version();
    return this.mediaDb.ready() ? this.mediaDb.getMediaItem(Number(this.mediaItemId())) : null;
  });
  protected readonly extra = computed(() => {
    const item = this.item();
    return item ? this.mediaDb.getExtra(item) : {};
  });
  protected readonly info = computed(() => this.extra().info ?? null);
  protected readonly directory = computed(() => this.library.directory(Number(this.directoryId())));
  protected readonly chips = computed(() => this.library.movieChips(this.info()));
  /** For themes with a facts panel (Vetro). */
  protected readonly facts = computed(() => {
    const info = this.info();
    const subtitles = describeSubtitles(this.extra().subtitles ?? [], this.i18n.locale(), this.i18n.t('player.forced'))
      .filter((t) => !t.forced)
      .map((t) => t.label);
    const facts: { label: MessageKey; value: string }[] = [];
    if (info?.rating) facts.push({ label: 'detail.rating', value: `★ ${this.library.formatRating(info.rating)}` });
    if (info?.director) facts.push({ label: 'detail.director', value: info.director });
    if (info?.genres?.length) facts.push({ label: 'detail.genres', value: info.genres.slice(0, 3).join(' · ') });
    if (subtitles.length) facts.push({ label: 'player.subtitles', value: [...new Set(subtitles)].join(' · ') });
    return facts;
  });

  protected readonly watch = computed(() => {
    const item = this.item();
    return item ? this.progress.get(item.id) : null;
  });
  protected readonly inProgress = computed(() => {
    const p = this.watch();
    return !!p && !p.watched && p.positionSeconds > 0;
  });
  protected readonly resumeLabel = computed(() => {
    const p = this.watch();
    return p ? this.i18n.t('action.resumeFrom', { time: formatRuntime(p.positionSeconds / 60) }) : '';
  });

  constructor() {
    void this.mediaDb.ensureLoaded();
    effect(() => {
      const item = this.item();
      if (this.mediaDb.ready() && item && !this.library.canAccess(item.directoryId)) {
        this.router.navigateByUrl('/library');
      }
    });
  }

  protected play(fromStart = false): void {
    const item = this.item();
    if (!item) {
      return;
    }
    if (fromStart) {
      this.progress.clear(item.id);
    }
    this.router.navigate(['/play', item.id]);
  }

  protected toggleWatched(): void {
    const item = this.item();
    if (!item) {
      return;
    }
    if (this.watch()?.watched) {
      this.progress.clear(item.id);
    } else {
      this.progress.markWatched(item.id, item.durationSeconds ?? 1);
    }
  }

  protected async download(): Promise<void> {
    const item = this.item();
    if (!item || !this.auth.canDownload() || this.downloading()) {
      return;
    }
    this.downloading.set(true);
    this.downloadError.set(false);
    try {
      await this.downloads.downloadFile({ s3Key: item.s3Key });
    } catch {
      this.downloadError.set(true);
    } finally {
      this.downloading.set(false);
    }
  }
}
