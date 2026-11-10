import { Component, computed, effect, inject, input, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { DownloadService } from '../../core/media/download.service';
import { EpisodeRow } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { episodeCode, formatRuntime, LibraryService } from '../../core/media/library.service';
import { WatchProgressService } from '../../core/media/watch-progress.service';
import { MessageKey } from '../../core/i18n/messages.en';
import { ArtImage } from '../../ui/art-image';
import { CastRow } from '../../ui/cast-row';
import { DetailHero } from '../../ui/detail-hero';
import { Icon } from '../../ui/icon';

/** A TV show: hero, season tabs, the season's episodes (with stills and
 * plots from TMDb, watched/progress marks), cast. Also serves
 * …/season/:season links, opening on that season. */
@Component({
  selector: 'app-show-page',
  standalone: true,
  imports: [RouterLink, DetailHero, CastRow, ArtImage, Icon, TranslatePipe],
  templateUrl: './show-page.html',
})
export class ShowPage {
  protected readonly mediaDb = inject(MediaDbService);
  protected readonly library = inject(LibraryService);
  private readonly router = inject(Router);
  private readonly progress = inject(WatchProgressService);
  private readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  private readonly downloads = inject(DownloadService);

  /** Episode whose download link is being prepared. */
  protected readonly downloadingId = signal<number | null>(null);
  protected readonly downloadError = signal(false);

  readonly directoryId = input.required<string>();
  readonly showTitle = input.required<string>();
  readonly season = input<string | undefined>(undefined);

  private readonly dirId = computed(() => Number(this.directoryId()));
  protected readonly directory = computed(() => this.library.directory(this.dirId()));

  protected readonly show = computed(() => {
    this.mediaDb.version();
    return this.mediaDb.ready() && this.library.canAccess(this.dirId()) ? this.mediaDb.getShow(this.dirId(), this.showTitle()) : null;
  });

  protected readonly episodes = computed<EpisodeRow[]>(() => {
    this.mediaDb.version();
    return this.show() ? this.mediaDb.listShowEpisodes(this.dirId(), this.showTitle()) : [];
  });

  protected readonly seasons = computed(() => [...new Set(this.episodes().map((e) => e.season))]);

  protected readonly next = computed(() => this.library.nextEpisode(this.dirId(), this.showTitle(), this.episodes()));

  /** The open season: the link's, else the next episode's, else the first. */
  protected readonly selectedSeason = linkedSignal(() => {
    const fromLink = Number(this.season());
    const seasons = this.seasons();
    if (seasons.includes(fromLink)) {
      return fromLink;
    }
    return this.next()?.episode.season ?? seasons[0] ?? 1;
  });

  protected readonly seasonEpisodes = computed(() => this.episodes().filter((e) => e.season === this.selectedSeason()));

  protected readonly watchedCount = computed(() => this.seasonEpisodes().filter((e) => this.progress.get(e.id)?.watched).length);

  protected readonly chips = computed(() => {
    const show = this.show();
    return show ? this.library.showChips(show) : [];
  });

  /** For themes with a facts panel (Vetro). */
  protected readonly facts = computed(() => {
    const show = this.show();
    const info = show?.info;
    const facts: { label: MessageKey; value: string }[] = [];
    if (info?.rating) facts.push({ label: 'detail.rating', value: `★ ${this.library.formatRating(info.rating)}` });
    if (info?.creators?.length) facts.push({ label: 'detail.creators', value: info.creators.join(', ') });
    if (info?.genres?.length) facts.push({ label: 'detail.genres', value: info.genres.slice(0, 3).join(' · ') });
    if (show) facts.push({ label: 'show.episodes', value: this.library.count('count.episodes', show.episodes) });
    return facts;
  });

  protected readonly playLabel = computed(() => {
    const next = this.next();
    if (!next) {
      return '';
    }
    const code = episodeCode(next.episode.season, next.episode.episode);
    return this.i18n.t(next.resume ? 'action.resumeEpisode' : 'action.playEpisode', { code });
  });

  constructor() {
    void this.mediaDb.ensureLoaded();
    effect(() => {
      if (this.mediaDb.ready() && this.directory() === null && this.library.directories().length) {
        this.router.navigateByUrl('/library');
      }
    });
  }

  protected seasonLabel(season: number): string {
    return season === 0 ? this.i18n.t('show.specials') : this.i18n.t('show.season', { n: season });
  }

  protected episodeTitle(ep: EpisodeRow): string {
    return ep.details?.title || ep.episodeTitle || ep.title;
  }

  protected episodeMeta(ep: EpisodeRow): string {
    const minutes = ep.details?.runtimeMinutes ?? (ep.durationSeconds ? ep.durationSeconds / 60 : 0);
    const label = this.i18n.t('show.episode', { n: ep.episode });
    return minutes ? `${label} · ${formatRuntime(minutes)}` : label;
  }

  protected percent(ep: EpisodeRow): number | null {
    const p = this.progress.get(ep.id);
    return p && !p.watched && p.positionSeconds > 0 ? (p.positionSeconds / p.durationSeconds) * 100 : null;
  }

  protected isWatched(ep: EpisodeRow): boolean {
    return !!this.progress.get(ep.id)?.watched;
  }

  protected playNext(): void {
    const next = this.next();
    if (next) {
      this.router.navigate(['/play', next.episode.id]);
    }
  }

  protected async download(ep: EpisodeRow): Promise<void> {
    if (!this.auth.canDownload() || this.downloadingId() !== null) {
      return;
    }
    this.downloadingId.set(ep.id);
    this.downloadError.set(false);
    try {
      await this.downloads.downloadFile({ s3Key: ep.s3Key });
    } catch {
      this.downloadError.set(true);
    } finally {
      this.downloadingId.set(null);
    }
  }

  protected playRandom(): void {
    const list = this.episodes();
    if (list.length) {
      this.router.navigate(['/play', list[Math.floor(Math.random() * list.length)].id]);
    }
  }
}
