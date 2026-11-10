import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { S3Service } from '../../core/aws/s3.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { EpisodeRow, MediaItem } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { episodeCode } from '../../core/media/library.service';
import { AudioLanguage, describeAudio } from '../../core/media/audio-tracks';
import { describeSubtitles, SubtitleTrack } from '../../core/media/subtitle-tracks';
import { WatchProgressService } from '../../core/media/watch-progress.service';
import { ArtImage } from '../../ui/art-image';
import { Icon } from '../../ui/icon';

const PROGRESS_SAVE_INTERVAL_MS = 5000;
const CONTROLS_HIDE_MS = 3200;
const SEEK_STEP_S = 10;
/** "Up next" appears this close to the end of an episode… */
const UP_NEXT_LEAD_S = 30;
/** …and, once the episode ends, plays the next one after this countdown. */
const AUTOPLAY_COUNTDOWN_S = 10;
const SUBTITLE_PREF_KEY = 's3player.subtitles';
/** Language code of the last audio language picked ('' = the file's own). */
const AUDIO_PREF_KEY = 's3player.audio';
/** Re-align the alternate audio when it drifts this far from the video. */
const AUDIO_DRIFT_S = 0.3;
/** S3 metadata the media-transcode function puts on each audio sidecar. */
const MAIN_LANGUAGE_METADATA = 's3player-main-language';

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    seconds = 0;
  }
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Full-screen video player with the app's own controls (so they look the
 * same in every browser and work with a TV remote): seek bar, ±10 s,
 * subtitles and audio-language menus, full screen, and for TV episodes "up
 * next" with autoplay. Keys: Space/Enter/K play-pause, ←/→ seek, ↑/↓
 * volume, F full screen, C subtitles, A audio language, M mute, Esc/Back
 * leave.
 *
 * Other audio languages come as separate files next to the video (browsers
 * can't switch between the tracks inside one file, except Safari): picking
 * one mutes the video and plays that file in an <audio> element kept in step
 * with it — play/pause, seeking, buffering on either side, playback rate,
 * and any drift. */
@Component({
  selector: 'app-video-player',
  standalone: true,
  imports: [RouterLink, Icon, ArtImage, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './video-player.html',
  host: {
    class: 's3-player fixed inset-0 z-50 block bg-black text-white select-none',
    '[class.is-idle]': '!controlsVisible()',
    '(mousemove)': 'reveal()',
    '(touchstart)': 'reveal()',
    '(document:keydown)': 'onKey($event)',
  },
})
export class VideoPlayer {
  private readonly s3 = inject(S3Service);
  private readonly mediaDb = inject(MediaDbService);
  private readonly progress = inject(WatchProgressService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly item = input.required<MediaItem>();
  readonly backLink = input.required<(string | number)[]>();

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly playButton = viewChild<ElementRef<HTMLButtonElement>>('playButton');
  private readonly altAudioRef = viewChild<ElementRef<HTMLAudioElement>>('altAudio');

  protected readonly src = signal<string | null>(null);
  protected readonly error = signal(false);
  protected readonly playing = signal(false);
  protected readonly buffering = signal(true);
  protected readonly current = signal(0);
  protected readonly duration = signal(0);
  protected readonly buffered = signal(0);
  protected readonly volume = signal(1);
  protected readonly muted = signal(false);
  protected readonly fullscreen = signal(false);
  protected readonly controlsVisible = signal(true);
  protected readonly menu = signal<'subtitles' | 'audio' | null>(null);
  protected readonly countdown = signal<number | null>(null);
  protected readonly upNextDismissed = signal(false);
  /** Brief icon in the middle of the screen confirming play/pause/seek. A
   * new id restarts its animation even for the same icon twice in a row. */
  protected readonly flash = signal<{ icon: 'play' | 'pause' | 'back' | 'forward'; id: number } | null>(null);
  private flashId = 0;

  // ---- What's playing ---------------------------------------------------
  private readonly tv = computed(() => (this.item().mediaType === 'tvshow' ? this.mediaDb.getTvMeta(this.item().id) : null));
  private readonly extra = computed(() => this.mediaDb.getExtra(this.item()));

  protected readonly title = computed(() => this.tv()?.showTitle ?? this.item().title);
  protected readonly subtitle = computed(() => {
    const tv = this.tv();
    if (!tv) {
      return this.extra().info?.releaseYear ? String(this.extra().info!.releaseYear) : '';
    }
    const name = this.extra().episode?.title || tv.episodeTitle;
    const code = `${this.i18n.t('show.season', { n: tv.season })} · ${this.i18n.t('show.episode', { n: tv.episode })}`;
    return name ? `${code} — ${name}` : code;
  });

  protected readonly nextEpisode = computed<EpisodeRow | null>(() => {
    const tv = this.tv();
    if (!tv) {
      return null;
    }
    const list = this.mediaDb.listShowEpisodes(this.item().directoryId, tv.showTitle);
    const index = list.findIndex((e) => e.id === this.item().id);
    return index >= 0 ? (list[index + 1] ?? null) : null;
  });
  protected readonly nextLabel = computed(() => {
    const next = this.nextEpisode();
    if (!next) {
      return '';
    }
    const name = next.details?.title || next.episodeTitle;
    return `${episodeCode(next.season, next.episode)}${name ? ` · ${name}` : ''}`;
  });
  protected readonly showUpNext = computed(
    () =>
      !!this.nextEpisode() &&
      !this.upNextDismissed() &&
      this.duration() > 0 &&
      (this.countdown() !== null || this.duration() - this.current() <= UP_NEXT_LEAD_S),
  );

  // ---- Subtitles & audio -------------------------------------------------
  protected readonly subtitleTracks = computed<SubtitleTrack[]>(() =>
    describeSubtitles(this.extra().subtitles ?? [], this.i18n.locale(), this.i18n.t('player.forced')),
  );
  protected readonly subtitleUrls = signal<Record<string, string>>({});
  /** Key of the shown subtitle file, or null for none. */
  protected readonly activeSubtitle = signal<string | null>(null);
  protected readonly activeSubtitleLabel = computed(
    () => this.subtitleTracks().find((t) => t.key === this.activeSubtitle())?.label ?? this.i18n.t('player.off'),
  );
  /** Language of an item's own track, read from its audio sidecars'
   * metadata ('' if unknown); null until read. */
  private readonly mainLanguage = signal<{ id: number; lang: string } | null>(null);
  private readonly mainLanguageKnown = computed(() => this.mainLanguage()?.id === this.item().id);
  protected readonly audioLanguages = computed<AudioLanguage[]>(() => {
    const keys = this.extra().audio ?? [];
    if (!keys.length) {
      return [];
    }
    const main = this.mainLanguageKnown() ? this.mainLanguage()!.lang : '';
    return describeAudio(keys, main, this.i18n.locale(), {
      main: this.i18n.t('player.audioMain'),
      track: (n) => this.i18n.t('player.audioTrack', { n }),
    });
  });
  /** Audio sidecar playing instead of the video's own track, or null. */
  protected readonly activeAudio = signal<string | null>(null);
  protected readonly activeAudioLabel = computed(
    () => this.audioLanguages().find((t) => t.key === this.activeAudio())?.label ?? '',
  );
  /** Item whose audio language has been picked (once per item). */
  private audioChosenFor: number | null = null;
  /** The video was paused to wait for the alternate audio to buffer. */
  private holdingForAudio = false;
  private videoWaiting = false;
  private lastAudioRetryAt = 0;

  protected readonly percent = computed(() => (this.duration() ? (this.current() / this.duration()) * 100 : 0));
  protected readonly bufferedPercent = computed(() => (this.duration() ? (this.buffered() / this.duration()) * 100 : 0));
  protected readonly clock = formatClock;

  private lastSaveAt = 0;
  private lastRetryAt = 0;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private countdownTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    effect(() => {
      const item = this.item();
      // A new item (next episode): start clean.
      this.upNextDismissed.set(false);
      this.stopCountdown();
      untracked(() => void this.switchAudio(null));
      void this.loadSource(item);
    });
    // The main track's language, recorded on the audio sidecars.
    effect(() => {
      const id = this.item().id;
      const keys = this.extra().audio ?? [];
      if (!keys.length) {
        return;
      }
      void this.s3.getObjectMetadata(keys[0]).then((meta) => {
        this.mainLanguage.set({ id, lang: meta?.[MAIN_LANGUAGE_METADATA] ?? '' });
      });
    });
    // Pick the remembered audio language (else the UI language) once the
    // item's languages are known; otherwise the file's own track.
    effect(() => {
      const id = this.item().id;
      const languages = this.audioLanguages();
      if (this.audioChosenFor === id) {
        return;
      }
      if (!languages.length) {
        this.audioChosenFor = id;
        return;
      }
      if (!this.mainLanguageKnown()) {
        return;
      }
      this.audioChosenFor = id;
      let pref: string | null = null;
      try {
        pref = localStorage.getItem(AUDIO_PREF_KEY);
      } catch {
        /* ignore */
      }
      const wanted = pref ?? this.i18n.language();
      const choice = languages.find((l) => l.lang === wanted) ?? languages[0];
      untracked(() => void this.switchAudio(choice.key));
    });
    effect(() => {
      for (const track of this.subtitleTracks()) {
        if (!this.subtitleUrls()[track.key]) {
          void this.s3.getPresignedUrl(track.key).then((url) => this.subtitleUrls.update((m) => ({ ...m, [track.key]: url })));
        }
      }
    });
    // Pick the remembered subtitle language (or a forced track in the UI
    // language) once the item's tracks are known.
    effect(() => {
      const tracks = this.subtitleTracks();
      let pref: string | null = null;
      try {
        pref = localStorage.getItem(SUBTITLE_PREF_KEY);
      } catch {
        /* ignore */
      }
      const lang = this.i18n.language();
      const choice =
        (pref && pref !== 'off' ? tracks.find((t) => t.lang === pref && !t.forced) : undefined) ??
        tracks.find((t) => t.forced && t.lang === lang);
      this.activeSubtitle.set(choice?.key ?? null);
    });
    // Show the chosen track (track elements render after their URLs load).
    effect(() => {
      const active = this.activeSubtitle();
      this.subtitleUrls();
      queueMicrotask(() => this.applySubtitleMode(active));
    });
    const onFullscreen = () => this.fullscreen.set(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreen);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      clearTimeout(this.hideTimer);
      this.stopCountdown();
      this.saveProgress(true);
    });
  }

  private get video(): HTMLVideoElement | undefined {
    return this.videoRef()?.nativeElement;
  }

  private get altAudio(): HTMLAudioElement | undefined {
    return this.altAudioRef()?.nativeElement;
  }

  /** The element whose sound is heard (and whose volume the controls set). */
  private get output(): HTMLMediaElement | undefined {
    const audio = this.altAudio;
    return this.activeAudio() && audio?.getAttribute('src') ? audio : this.video;
  }

  private async loadSource(item: MediaItem): Promise<void> {
    this.error.set(false);
    this.buffering.set(true);
    try {
      this.src.set(await this.s3.getPresignedUrl(item.s3Key));
    } catch {
      this.error.set(true);
    }
  }

  // ---- Media element events ---------------------------------------------

  protected onLoadedMetadata(): void {
    const video = this.video;
    if (!video) {
      return;
    }
    this.duration.set(video.duration);
    const saved = this.progress.get(this.item().id);
    if (saved && !saved.watched && saved.positionSeconds < video.duration - 5) {
      video.currentTime = saved.positionSeconds;
    }
    this.syncAudio();
    this.playButton()?.nativeElement.focus({ preventScroll: true });
  }

  protected onTimeUpdate(): void {
    const video = this.video;
    if (!video) {
      return;
    }
    this.current.set(video.currentTime);
    if (video.buffered.length) {
      this.buffered.set(video.buffered.end(video.buffered.length - 1));
    }
    this.saveProgress();
    this.syncAudio();
  }

  protected onPlay(): void {
    this.playing.set(true);
    this.scheduleHide();
    this.syncAudio();
  }

  protected onPause(): void {
    this.syncAudio();
    if (this.holdingForAudio) {
      return; // a short wait for the other audio language, not a real pause
    }
    this.playing.set(false);
    this.reveal(false);
    this.saveProgress(true);
  }

  protected onEnded(): void {
    const video = this.video;
    if (video?.duration) {
      this.progress.save(this.item().id, video.duration, video.duration);
    }
    if (this.nextEpisode() && !this.upNextDismissed()) {
      this.startCountdown();
    } else {
      this.reveal(false);
    }
  }

  protected onVideoWaiting(): void {
    this.buffering.set(true);
    this.videoWaiting = true;
    this.syncAudio();
  }

  protected onVideoPlaying(): void {
    this.buffering.set(false);
    this.videoWaiting = false;
    this.syncAudio();
  }

  // ---- Alternate audio language ----------------------------------------

  /** Keeps the alternate audio (if one is playing) in step with the video. */
  protected syncAudio(): void {
    const audio = this.altAudio;
    const video = this.video;
    if (!audio || !video || !this.activeAudio() || !audio.getAttribute('src') || audio.readyState === 0) {
      return;
    }
    if (audio.playbackRate !== video.playbackRate) {
      audio.playbackRate = video.playbackRate;
    }
    const stopped = video.paused || video.seeking || this.videoWaiting;
    if (stopped) {
      if (!audio.paused) {
        audio.pause();
      }
      if (Math.abs(audio.currentTime - video.currentTime) > 0.05) {
        audio.currentTime = video.currentTime;
      }
      return;
    }
    if (Math.abs(audio.currentTime - video.currentTime) > AUDIO_DRIFT_S) {
      audio.currentTime = video.currentTime;
    }
    if (audio.paused) {
      audio.play().catch(() => {
        // Sound blocked until the user interacts (opened by a link, no
        // click yet): pause, so pressing Play starts both together.
        video.pause();
        this.reveal(false);
      });
    }
  }

  /** The alternate audio ran out of data while the video plays: hold the
   * video until it can carry on. */
  protected onAudioWaiting(): void {
    const video = this.video;
    if (video && !video.paused && this.activeAudio()) {
      this.holdingForAudio = true;
      this.buffering.set(true);
      video.pause();
    }
  }

  protected onAudioCanPlay(): void {
    const video = this.video;
    if (this.holdingForAudio && video) {
      this.holdingForAudio = false;
      this.buffering.set(false);
      void video.play();
    } else {
      this.syncAudio();
    }
  }

  /** Expired URL (long pause): sign again once; otherwise fall back to the
   * video's own track rather than playing silence. */
  protected async onAudioError(): Promise<void> {
    const key = this.activeAudio();
    const audio = this.altAudio;
    if (!key || !audio?.getAttribute('src')) {
      return;
    }
    if (Date.now() - this.lastAudioRetryAt < 60_000) {
      this.holdingForAudio = false;
      await this.switchAudio(null);
      return;
    }
    this.lastAudioRetryAt = Date.now();
    await this.switchAudio(key, true);
  }

  /** Plays `key` (an audio sidecar) instead of the video's own track, or
   * the video's track again for null. Volume and mute carry over. */
  private async switchAudio(key: string | null, force = false): Promise<void> {
    if (!force && key === this.activeAudio() && (key === null || this.altAudio?.getAttribute('src'))) {
      return;
    }
    const audio = this.altAudio;
    const previous = this.output;
    const volume = previous?.volume ?? this.volume();
    const muted = previous?.muted ?? this.muted();
    this.activeAudio.set(key);
    this.holdingForAudio = false;
    if (!key) {
      if (audio?.getAttribute('src')) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      const video = this.video;
      if (video) {
        video.volume = volume;
        video.muted = muted;
      }
      this.onVolumeChange();
      return;
    }
    let url: string;
    try {
      url = await this.s3.getPresignedUrl(key);
    } catch {
      this.activeAudio.set(null);
      return;
    }
    if (this.activeAudio() !== key || !audio) {
      return;
    }
    audio.volume = volume;
    audio.muted = muted;
    audio.src = url;
    audio.load();
    const video = this.video;
    if (video) {
      video.muted = true;
      audio.currentTime = video.currentTime;
    }
    this.onVolumeChange();
  }

  /** The presigned URL expires after 15 minutes of not being re-requested
   * (seeking far ahead after a long pause): sign again and carry on. */
  protected async onError(): Promise<void> {
    const video = this.video;
    if (!video) {
      return;
    }
    // Re-signing only helps once: a file that's really missing or can't be
    // decoded would otherwise retry forever.
    if (Date.now() - this.lastRetryAt < 60_000) {
      this.error.set(true);
      this.buffering.set(false);
      return;
    }
    this.lastRetryAt = Date.now();
    const at = video.currentTime;
    const wasPlaying = !video.paused;
    await this.loadSource(this.item());
    queueMicrotask(() => {
      video.currentTime = at;
      if (wasPlaying) {
        void video.play();
      }
    });
  }

  // ---- Controls ------------------------------------------------------------

  protected togglePlay(): void {
    const video = this.video;
    if (!video) {
      return;
    }
    if (video.paused) {
      void video.play();
      this.showFlash('play');
    } else {
      video.pause();
      this.showFlash('pause');
    }
  }

  private showFlash(icon: 'play' | 'pause' | 'back' | 'forward'): void {
    this.flash.set({ icon, id: ++this.flashId });
  }

  protected seekBy(seconds: number): void {
    const video = this.video;
    if (video) {
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
      this.current.set(video.currentTime);
      this.showFlash(seconds < 0 ? 'back' : 'forward');
    }
    this.reveal();
  }

  protected seekTo(event: Event): void {
    const video = this.video;
    const value = Number((event.target as HTMLInputElement).value);
    if (video && Number.isFinite(value)) {
      video.currentTime = value;
      this.current.set(value);
    }
  }

  protected setVolume(event: Event): void {
    const output = this.output;
    const value = Number((event.target as HTMLInputElement).value);
    if (output) {
      output.volume = value;
      output.muted = value === 0;
    }
  }

  protected onVolumeChange(): void {
    const output = this.output;
    if (output) {
      this.volume.set(output.volume);
      this.muted.set(output.muted);
    }
  }

  protected toggleMute(): void {
    const output = this.output;
    if (output) {
      output.muted = !output.muted;
    }
  }

  protected toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void this.host.nativeElement.requestFullscreen?.().catch(() => undefined);
    }
  }

  protected toggleMenu(menu: 'subtitles' | 'audio'): void {
    this.menu.update((open) => (open === menu ? null : menu));
    this.reveal(false);
  }

  protected chooseSubtitle(track: SubtitleTrack | null): void {
    this.activeSubtitle.set(track?.key ?? null);
    try {
      localStorage.setItem(SUBTITLE_PREF_KEY, track && !track.forced ? track.lang || 'on' : 'off');
    } catch {
      /* ignore */
    }
    this.menu.set(null);
    this.scheduleHide();
  }

  protected chooseAudio(track: AudioLanguage): void {
    void this.switchAudio(track.key);
    try {
      localStorage.setItem(AUDIO_PREF_KEY, track.lang);
    } catch {
      /* ignore */
    }
    this.menu.set(null);
    this.scheduleHide();
  }

  protected playNext(): void {
    const next = this.nextEpisode();
    this.stopCountdown();
    if (next) {
      void this.router.navigate(['/play', next.id], { replaceUrl: true });
    }
  }

  protected dismissUpNext(): void {
    this.stopCountdown();
    this.upNextDismissed.set(true);
  }

  protected leave(): void {
    void this.router.navigate(this.backLink());
  }

  /** Shows the controls; while playing they fade again after a while. */
  protected reveal(autoHide = true): void {
    this.controlsVisible.set(true);
    if (autoHide) {
      this.scheduleHide();
    } else {
      clearTimeout(this.hideTimer);
    }
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const target = event.target as HTMLElement;
    const onControl = target.closest('button, input, a') !== null;
    const hidden = !this.controlsVisible();
    switch (event.key) {
      case ' ':
      case 'k':
      case 'MediaPlayPause':
        if (event.key === ' ' && onControl && !hidden && target.tagName === 'BUTTON') {
          return; // a focused button: Space presses it
        }
        event.preventDefault();
        this.togglePlay();
        this.reveal();
        return;
      case 'Enter':
        if (hidden || !onControl) {
          event.preventDefault();
          this.togglePlay();
          this.reveal();
        }
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        // Visible controls: arrows move between them (or along the seek bar).
        if (hidden || !onControl) {
          event.preventDefault();
          this.seekBy(event.key === 'ArrowLeft' ? -SEEK_STEP_S : SEEK_STEP_S);
        } else if (target.tagName !== 'INPUT') {
          event.preventDefault();
          this.moveFocus(event.key === 'ArrowLeft' ? -1 : 1);
        }
        return;
      case 'ArrowUp':
      case 'ArrowDown':
        if (hidden || !onControl) {
          event.preventDefault();
          const output = this.output;
          if (output) {
            output.volume = Math.max(0, Math.min(1, output.volume + (event.key === 'ArrowUp' ? 0.1 : -0.1)));
            output.muted = false;
          }
        }
        this.reveal();
        return;
      case 'MediaTrackNext':
        this.playNext();
        return;
      case 'f':
        this.toggleFullscreen();
        return;
      case 'm':
        this.toggleMute();
        this.reveal();
        return;
      case 'c': {
        const tracks = this.subtitleTracks();
        const index = tracks.findIndex((t) => t.key === this.activeSubtitle());
        this.chooseSubtitle(index + 1 < tracks.length ? tracks[index + 1] : null);
        this.reveal();
        return;
      }
      case 'a': {
        const languages = this.audioLanguages();
        if (languages.length > 1) {
          const index = languages.findIndex((l) => l.key === this.activeAudio());
          this.chooseAudio(languages[(index + 1) % languages.length]);
        }
        this.reveal();
        return;
      }
      case 'Escape':
      case 'GoBack':
      case 'BrowserBack':
        if (this.menu()) {
          this.menu.set(null);
        } else if (!document.fullscreenElement) {
          event.preventDefault();
          this.leave();
        }
        return;
      default:
        this.reveal();
    }
  }

  // ---- Internals -------------------------------------------------------------

  private moveFocus(direction: number): void {
    const controls = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLElement>('.s3-player-bar button, .s3-player-bar input'),
    ).filter((el) => el.offsetParent !== null);
    const index = controls.indexOf(document.activeElement as HTMLElement);
    controls[Math.max(0, Math.min(controls.length - 1, index + direction))]?.focus();
    this.reveal();
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.playing() && !this.menu()) {
        this.controlsVisible.set(false);
      }
    }, CONTROLS_HIDE_MS);
  }

  private saveProgress(force = false): void {
    const video = this.video;
    if (!video || !video.duration || video.currentTime < 1) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastSaveAt < PROGRESS_SAVE_INTERVAL_MS) {
      return;
    }
    this.lastSaveAt = now;
    this.progress.save(this.item().id, video.currentTime, video.duration);
  }

  private applySubtitleMode(activeKey: string | null): void {
    const video = this.video;
    if (!video) {
      return;
    }
    const elements = Array.from(video.querySelectorAll('track'));
    elements.forEach((el) => {
      el.track.mode = el.dataset['key'] === activeKey ? 'showing' : 'disabled';
    });
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.countdown.set(AUTOPLAY_COUNTDOWN_S);
    this.reveal(false);
    this.countdownTimer = setInterval(() => {
      const left = (this.countdown() ?? 1) - 1;
      if (left <= 0) {
        this.playNext();
      } else {
        this.countdown.set(left);
      }
    }, 1000);
  }

  private stopCountdown(): void {
    clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
    this.countdown.set(null);
  }
}
