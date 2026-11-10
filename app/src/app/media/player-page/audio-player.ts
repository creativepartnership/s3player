import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { S3Service } from '../../core/aws/s3.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { MediaItem } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { WatchProgressService } from '../../core/media/watch-progress.service';
import { ArtImage } from '../../ui/art-image';
import { Icon } from '../../ui/icon';
import { formatClock } from './video-player';

/** Now playing: the album cover large (its color filling the screen),
 * controls, and the album's other tracks; plays through the album. */
@Component({
  selector: 'app-audio-player',
  standalone: true,
  imports: [RouterLink, ArtImage, Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-h-dvh', '(document:keydown)': 'onKey($event)' },
  template: `
    <div class="s3-now-playing">
      <s3-art aria-hidden="true" class="s3-now-ambient" [key]="item().thumbnailS3Key" [title]="album()" [showTitle]="false" />
      <div class="relative flex items-center gap-4 px-[var(--s3-gutter)] pt-6">
        <a [routerLink]="backLink()" class="s3-back"><s3-icon name="back" [size]="18" [stroke]="2.2" />{{ album() || ('nav.back' | t) }}</a>
      </div>

      <div class="relative mx-auto flex w-full max-w-[1100px] flex-wrap items-center justify-center gap-10 px-[var(--s3-gutter)] py-10 lg:flex-nowrap lg:justify-between">
        <s3-art class="s3-glow aspect-square w-[min(420px,80vw)] flex-none rounded-[var(--s3-radius-hero)]" [key]="item().thumbnailS3Key" [title]="album()" [eager]="true" />

        <div class="flex w-full max-w-[520px] min-w-0 flex-col gap-6">
          <div class="flex flex-col gap-1.5">
            <h1 class="font-display text-[32px] leading-tight font-bold tracking-tight sm:text-[44px]">{{ item().title }}</h1>
            <p class="text-lg text-[var(--s3-text-muted)]">{{ artist() }}</p>
          </div>

          @if (src(); as url) {
            <audio #audio [src]="url" autoplay (loadedmetadata)="onLoaded()" (timeupdate)="onTime()" (play)="playing.set(true)" (pause)="playing.set(false)" (ended)="onEnded()" (error)="reload()"></audio>
          }

          <div class="flex flex-col gap-2">
            <div class="s3-seek">
              <div class="s3-seek-track"><div class="s3-seek-fill" [style.width.%]="duration() ? (current() / duration()) * 100 : 0"></div></div>
              <input type="range" min="0" [max]="duration() || 0" step="1" [value]="current()" [attr.aria-label]="'player.seek' | t" (input)="seek($event)" />
            </div>
            <div class="flex justify-between text-sm text-[var(--s3-text-muted)] tabular-nums">
              <span>{{ clock(current()) }}</span><span>−{{ clock(duration() - current()) }}</span>
            </div>
          </div>

          <div class="flex items-center justify-center gap-4">
            <button type="button" class="s3-player-btn" [disabled]="!previous()" [attr.aria-label]="'player.previousTrack' | t" (click)="go(previous())">
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14l-9-7z" fill="currentColor" /><rect x="5" y="5" width="3" height="14" rx="1" fill="currentColor" /></svg>
            </button>
            <button type="button" class="s3-player-btn is-main h-[72px]! w-[72px]!" [attr.aria-label]="(playing() ? 'player.pause' : 'action.play') | t" (click)="toggle()">
              @if (playing()) {
                <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
              } @else {
                <s3-icon name="play" [size]="28" />
              }
            </button>
            <button type="button" class="s3-player-btn" [disabled]="!next()" [attr.aria-label]="'player.nextTrack' | t" (click)="go(next())">
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14l9-7z" fill="currentColor" /><rect x="16" y="5" width="3" height="14" rx="1" fill="currentColor" /></svg>
            </button>
          </div>

          @if (queue().length > 1) {
            <ol class="flex max-h-[38vh] flex-col overflow-y-auto s3-surface p-2" role="list">
              @for (track of queue(); track track.id) {
                <li>
                  <button type="button" class="s3-track" [class.text-primary]="track.id === item().id" [attr.aria-current]="track.id === item().id ? 'true' : null" (click)="go(track)">
                    <span class="w-6 text-right text-sm text-[var(--s3-text-muted)] tabular-nums">{{ $index + 1 }}</span>
                    <span class="min-w-0 flex-1 truncate font-medium">{{ track.title }}</span>
                  </button>
                </li>
              }
            </ol>
          }
        </div>
      </div>
    </div>
  `,
})
export class AudioPlayer {
  private readonly s3 = inject(S3Service);
  private readonly mediaDb = inject(MediaDbService);
  private readonly progress = inject(WatchProgressService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);

  readonly item = input.required<MediaItem>();
  readonly backLink = input.required<(string | number)[]>();
  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');

  protected readonly src = signal<string | null>(null);
  protected readonly playing = signal(false);
  protected readonly current = signal(0);
  protected readonly duration = signal(0);
  protected readonly clock = formatClock;

  private readonly meta = computed(() => this.mediaDb.getMusicMeta(this.item().id));
  protected readonly artist = computed(() => this.meta()?.artist || this.i18n.t('music.unknownArtist'));
  protected readonly album = computed(() => this.meta()?.album ?? '');
  protected readonly queue = computed<MediaItem[]>(() => {
    const meta = this.meta();
    return meta ? this.mediaDb.listTracks(this.item().directoryId, meta.artist, meta.album) : [this.item()];
  });
  private readonly index = computed(() => this.queue().findIndex((t) => t.id === this.item().id));
  protected readonly previous = computed(() => this.queue()[this.index() - 1] ?? null);
  protected readonly next = computed(() => this.queue()[this.index() + 1] ?? null);

  private lastSave = 0;

  constructor() {
    effect(() => void this.load(this.item()));
    inject(DestroyRef).onDestroy(() => this.save(true));
  }

  private async load(item: MediaItem): Promise<void> {
    this.current.set(0);
    this.src.set(await this.s3.getPresignedUrl(item.s3Key).catch(() => null));
  }

  private lastRetryAt = 0;

  /** Expired URL: sign again, once a minute at most (a missing file would
   * otherwise retry forever). */
  protected reload(): void {
    if (Date.now() - this.lastRetryAt < 60_000) {
      return;
    }
    this.lastRetryAt = Date.now();
    void this.load(this.item());
  }

  protected onLoaded(): void {
    this.duration.set(this.audioRef()?.nativeElement.duration ?? 0);
  }

  protected onTime(): void {
    this.current.set(this.audioRef()?.nativeElement.currentTime ?? 0);
    this.save();
  }

  protected onEnded(): void {
    this.save(true);
    const next = this.next();
    if (next) {
      this.go(next);
    }
  }

  protected toggle(): void {
    const el = this.audioRef()?.nativeElement;
    if (el) {
      if (el.paused) {
        void el.play();
      } else {
        el.pause();
      }
    }
  }

  protected seek(event: Event): void {
    const el = this.audioRef()?.nativeElement;
    if (el) {
      el.currentTime = Number((event.target as HTMLInputElement).value);
    }
  }

  protected go(track: MediaItem | null): void {
    if (track) {
      void this.router.navigate(['/play', track.id], { replaceUrl: true });
    }
  }

  protected onKey(event: KeyboardEvent): void {
    const onButton = (event.target as HTMLElement).closest('button, a, input') !== null;
    if ((event.key === ' ' && !onButton) || event.key === 'MediaPlayPause') {
      event.preventDefault();
      this.toggle();
    } else if (event.key === 'MediaTrackNext') {
      this.go(this.next());
    } else if (event.key === 'MediaTrackPrevious') {
      this.go(this.previous());
    }
  }

  private save(force = false): void {
    const el = this.audioRef()?.nativeElement;
    if (!el?.duration || (!force && Date.now() - this.lastSave < 5000)) {
      return;
    }
    this.lastSave = Date.now();
    this.progress.save(this.item().id, el.ended ? el.duration : el.currentTime, el.duration);
  }
}
