import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CatalogSyncService, SyncSummary } from '../../core/aws/catalog-sync.service';
import { S3Service } from '../../core/aws/s3.service';
import { CatalogConflictError, MediaDbService } from '../../core/db/media-db.service';
import { MediaDirectory, MediaItem } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { MessageKey } from '../../core/i18n/messages.en';
import { episodeCode } from '../../core/media/library.service';
import { ArtImage } from '../../ui/art-image';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';

/** Tag the media-transcode Lambda puts on each video it has checked. */
const PLAYBACK_TAG = 's3player-playback';
/** Without the tag, a video this recent is probably still being checked. */
const CHECKING_WINDOW_MS = 30 * 60_000;
const PAGE_SIZE = 100;
const TAG_FETCH_CONCURRENCY = 6;

type PlaybackStatus = 'ok' | 'checking' | 'unsupported' | 'tooLarge' | 'attention' | 'unchecked';

interface Row {
  item: MediaItem;
  title: string;
  file: string;
  /** "S1 · E2" for episodes. */
  prefix: string;
}

interface PendingDelete {
  item: MediaItem;
  subtitles: number;
  artwork: number;
  size: string | null;
}

/** Catalog maintenance. Items are added and removed by the catalog-sync
 * Lambda as files land in / leave the bucket; here the admin fixes titles,
 * deletes media (files included), forces a resync, and sees which videos
 * play in browsers. */
@Component({
  selector: 'app-library-page',
  standalone: true,
  imports: [FormsModule, ArtImage, Icon, ConfirmDialog, TranslatePipe],
  templateUrl: './library-page.html',
})
export class LibraryPage {
  private readonly mediaDb = inject(MediaDbService);
  private readonly catalogSync = inject(CatalogSyncService);
  private readonly s3 = inject(S3Service);
  private readonly i18n = inject(I18nService);
  private readonly confirmDelete = viewChild.required<ConfirmDialog>('confirmDelete');

  protected readonly directories = computed<MediaDirectory[]>(() => {
    this.mediaDb.version();
    return this.mediaDb.ready() ? this.mediaDb.listDirectories() : [];
  });
  /** The first section, until the admin picks another. */
  private readonly pickedId = signal<number | null>(null);
  protected readonly selected = computed(() => {
    const dirs = this.directories();
    return dirs.find((d) => d.id === this.pickedId()) ?? dirs[0] ?? null;
  });
  protected readonly isVideo = computed(() => ['movie', 'tvshow'].includes(this.selected()?.mediaType ?? ''));

  protected readonly query = signal('');
  protected readonly limit = signal(PAGE_SIZE);

  private readonly rows = computed<Row[]>(() => {
    this.mediaDb.version();
    const dir = this.selected();
    if (!dir) {
      return [];
    }
    return this.mediaDb.listMediaItems(dir.id).map((item) => {
      const tv = dir.mediaType === 'tvshow' ? this.mediaDb.getTvMeta(item.id) : null;
      return {
        item,
        title: item.title,
        file: item.s3Key.slice(dir.s3Prefix.length),
        prefix: tv ? episodeCode(tv.season, tv.episode) : '',
      };
    });
  });
  protected readonly matches = computed(() => {
    const q = this.query().trim().toLocaleLowerCase();
    const rows = this.rows();
    return q ? rows.filter((r) => r.title.toLocaleLowerCase().includes(q) || r.file.toLocaleLowerCase().includes(q)) : rows;
  });
  protected readonly visible = computed(() => this.matches().slice(0, this.limit()));

  protected readonly counts = computed(() => {
    this.mediaDb.version();
    return new Map(this.directories().map((d) => [d.id, this.mediaDb.listMediaItems(d.id).length]));
  });

  /** S3 key → playback tag value ('' = no tag), as they arrive. */
  private readonly tags = signal<ReadonlyMap<string, string>>(new Map());
  private readonly requested = new Set<string>();

  protected readonly syncing = signal(false);
  protected readonly syncResult = signal<SyncSummary | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly editingId = signal<number | null>(null);
  protected readonly draft = signal('');
  protected readonly busyId = signal<number | null>(null);
  protected readonly pendingDelete = signal<PendingDelete | null>(null);

  constructor() {
    // Pick up whatever the Lambda catalogued since the catalog was loaded.
    void this.mediaDb.reloadIfChanged();
    // Playability of the videos on screen, a few requests at a time.
    effect(() => {
      if (!this.isVideo()) {
        return;
      }
      const keys = this.visible()
        .map((r) => r.item.s3Key)
        .filter((k) => !this.requested.has(k));
      keys.forEach((k) => this.requested.add(k));
      void this.fetchTags(keys);
    });
  }

  private async fetchTags(keys: string[]): Promise<void> {
    const queue = [...keys];
    const worker = async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        const value = (await this.s3.getObjectTag(key, PLAYBACK_TAG)) ?? '';
        this.tags.update((m) => new Map(m).set(key!, value));
      }
    };
    await Promise.all(Array.from({ length: TAG_FETCH_CONCURRENCY }, worker));
  }

  protected status(item: MediaItem): PlaybackStatus | null {
    const tag = this.tags().get(item.s3Key);
    if (tag === undefined) {
      return null; // not known yet
    }
    if (tag === 'ok' || tag === 'converted') {
      return 'ok';
    }
    if (tag.startsWith('unsupported')) {
      return 'unsupported';
    }
    if (tag === 'too-large') {
      return 'tooLarge';
    }
    if (tag) {
      return 'attention';
    }
    const added = Date.parse(item.dateAdded.replace(' ', 'T') + 'Z');
    return Date.now() - added < CHECKING_WINDOW_MS ? 'checking' : 'unchecked';
  }

  protected statusKey(status: PlaybackStatus): MessageKey {
    return `library.status.${status}` as MessageKey;
  }

  protected statusHint(status: PlaybackStatus): MessageKey {
    return `library.statusHint.${status}` as MessageKey;
  }

  protected select(dir: MediaDirectory): void {
    this.pickedId.set(dir.id);
    this.query.set('');
    this.limit.set(PAGE_SIZE);
    this.syncResult.set(null);
    this.error.set(null);
    this.editingId.set(null);
  }

  protected countLabel(dir: MediaDirectory): number {
    return this.counts().get(dir.id) ?? 0;
  }

  protected async resync(): Promise<void> {
    const dir = this.selected();
    if (!dir) {
      return;
    }
    this.syncing.set(true);
    this.syncResult.set(null);
    this.error.set(null);
    try {
      this.syncResult.set(await this.catalogSync.resync(dir.id));
      // Recheck playability too (the resync also queued unchecked videos).
      this.requested.clear();
      this.tags.set(new Map());
    } catch {
      this.error.set(this.i18n.t('library.resyncFailed'));
    } finally {
      this.syncing.set(false);
    }
  }

  protected syncMessage(result: SyncSummary): string {
    if (result.added + result.updated + result.removed + result.pendingItems === 0) {
      return this.i18n.t('library.inSync');
    }
    const done = this.i18n.t('library.synced', { added: result.added, updated: result.updated, removed: result.removed });
    return result.pendingItems ? `${done} ${this.i18n.t('library.pending', { n: result.pendingItems })}` : done;
  }

  protected startRename(row: Row): void {
    this.editingId.set(row.item.id);
    this.draft.set(row.item.title);
    setTimeout(() => document.getElementById(`rename-${row.item.id}`)?.focus());
  }

  protected cancelRename(): void {
    this.editingId.set(null);
  }

  protected async saveRename(item: MediaItem): Promise<void> {
    const title = this.draft().trim();
    if (!title || title === item.title) {
      this.editingId.set(null);
      return;
    }
    this.busyId.set(item.id);
    this.error.set(null);
    try {
      await this.mediaDb.renameMediaItem(item.id, title);
      this.editingId.set(null);
    } catch (err) {
      this.error.set(err instanceof CatalogConflictError ? this.i18n.t('admin.conflict') : this.i18n.t('library.renameFailed'));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async remove(item: MediaItem): Promise<void> {
    const files = this.mediaDb.filesOf(item.id);
    if (!files) {
      return;
    }
    this.busyId.set(item.id);
    const bytes = await this.s3.getObjectSize(files.video);
    this.busyId.set(null);
    this.pendingDelete.set({
      item,
      subtitles: files.subtitles.filter((k) => /\.vtt$/i.test(k)).length,
      artwork: files.artwork.length,
      size: bytes == null ? null : formatBytes(bytes, this.i18n.locale()),
    });
    if (!(await this.confirmDelete().ask())) {
      return;
    }
    this.busyId.set(item.id);
    this.error.set(null);
    try {
      await this.mediaDb.deleteMediaItemWithFiles(item.id);
    } catch {
      this.error.set(this.i18n.t('library.deleteFailed'));
    } finally {
      this.busyId.set(null);
    }
  }

  /** "il video (1,4 GB), 2 file di sottotitoli e 2 immagini". */
  protected deleteSummary(p: PendingDelete): string {
    const parts = [p.size ? this.i18n.t('library.deleteVideoSize', { size: p.size }) : this.i18n.t('library.deleteVideo')];
    if (p.subtitles) {
      parts.push(this.i18n.t(p.subtitles === 1 ? 'library.deleteSubs.one' : 'library.deleteSubs.other', { n: p.subtitles }));
    }
    if (p.artwork) {
      parts.push(this.i18n.t(p.artwork === 1 ? 'library.deleteArt.one' : 'library.deleteArt.other', { n: p.artwork }));
    }
    const and = this.i18n.t('library.and');
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} ${and} ${parts[parts.length - 1]}.` : `${parts[0]}.`;
  }
}

function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
}
