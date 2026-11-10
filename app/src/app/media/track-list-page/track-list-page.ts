import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { DownloadService } from '../../core/media/download.service';
import { MediaItem } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { LibraryService } from '../../core/media/library.service';
import { WatchProgressService } from '../../core/media/watch-progress.service';
import { DetailHero } from '../../ui/detail-hero';
import { Icon } from '../../ui/icon';

/** An album: cover (its color washing the page), tracks, play/shuffle. */
@Component({
  selector: 'app-track-list-page',
  standalone: true,
  imports: [DetailHero, Icon, TranslatePipe],
  templateUrl: './track-list-page.html',
})
export class TrackListPage {
  protected readonly mediaDb = inject(MediaDbService);
  private readonly library = inject(LibraryService);
  private readonly router = inject(Router);
  private readonly progress = inject(WatchProgressService);
  private readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  private readonly downloads = inject(DownloadService);

  /** 0–100 while the album ZIP is being put together, else null. */
  protected readonly downloadProgress = signal<number | null>(null);
  protected readonly downloadError = signal(false);

  readonly directoryId = input.required<string>();
  readonly artistName = input.required<string>();
  readonly albumName = input.required<string>();

  protected readonly directory = computed(() => this.library.directory(Number(this.directoryId())));

  protected readonly tracks = computed<MediaItem[]>(() => {
    this.mediaDb.version();
    const dir = this.directory();
    return dir ? this.mediaDb.listTracks(dir.id, this.artistName(), this.albumName()) : [];
  });

  /** Album art is denormalized onto every track row — take any. */
  protected readonly cover = computed(() => this.tracks().find((t) => t.thumbnailS3Key)?.thumbnailS3Key ?? null);

  protected readonly chips = computed(() => [this.artistName() || this.i18n.t('music.unknownArtist'), this.library.count('count.tracks', this.tracks().length)]);

  constructor() {
    void this.mediaDb.ensureLoaded();
    effect(() => {
      if (this.mediaDb.ready() && this.library.directories().length && !this.directory()) {
        this.router.navigateByUrl('/library');
      }
    });
  }

  protected play(item: MediaItem): void {
    this.router.navigate(['/play', item.id]);
  }

  protected playAlbum(shuffle = false): void {
    const list = this.tracks();
    if (list.length) {
      this.play(shuffle ? list[Math.floor(Math.random() * list.length)] : list[0]);
    }
  }

  /** The whole album as one ZIP ("Artist - Album.zip"), tracks under their
   * original file names. */
  protected async downloadAlbum(): Promise<void> {
    const tracks = this.tracks();
    if (!tracks.length || !this.auth.canDownload() || this.downloadProgress() !== null) {
      return;
    }
    const album = this.albumName() || this.i18n.t('music.unknownAlbum');
    const zipName = this.artistName() ? `${this.artistName()} - ${album}` : album;
    this.downloadProgress.set(0);
    this.downloadError.set(false);
    try {
      await this.downloads.downloadZip(
        tracks.map((t) => ({ s3Key: t.s3Key })),
        zipName,
        (fraction) => this.downloadProgress.set(Math.round(fraction * 100)),
      );
    } catch {
      this.downloadError.set(true);
    } finally {
      this.downloadProgress.set(null);
    }
  }

  protected isPlayed(item: MediaItem): boolean {
    return !!this.progress.get(item.id)?.watched;
  }

  /** Known once a track has been played at least once. */
  protected duration(item: MediaItem): string | null {
    const seconds = item.durationSeconds ?? this.progress.get(item.id)?.durationSeconds;
    if (!seconds) {
      return null;
    }
    return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  }
}
