import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CatalogSyncService } from '../../core/aws/catalog-sync.service';
import { S3Service } from '../../core/aws/s3.service';
import { CatalogConflictError, MediaDbService } from '../../core/db/media-db.service';
import { MediaDirectory, MediaType } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { LibraryService, MEDIA_TYPE_NAV_KEY } from '../../core/media/library.service';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Icon, IconName } from '../../ui/icon';

interface SectionForm {
  id?: number;
  displayName: string;
  mediaType: MediaType;
  /** The folder under media/, without slashes. */
  folder: string;
  categoryKey: string;
}

const MEDIA_ROOT = 'media/';

/** Library sections: each one a folder of the media bucket, with a name
 * for the menu, a kind of content, and an access code (Cognito
 * custom:categories) deciding who sees it. */
@Component({
  selector: 'app-directories-page',
  standalone: true,
  imports: [FormsModule, Icon, ConfirmDialog, TranslatePipe],
  templateUrl: './directories-page.html',
})
export class DirectoriesPage {
  private readonly mediaDb = inject(MediaDbService);
  protected readonly library = inject(LibraryService);
  private readonly s3 = inject(S3Service);
  private readonly catalogSync = inject(CatalogSyncService);
  private readonly i18n = inject(I18nService);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly confirmDelete = viewChild.required<ConfirmDialog>('confirmDelete');

  protected readonly types: { id: MediaType; icon: IconName }[] = [
    { id: 'movie', icon: 'movie' },
    { id: 'tvshow', icon: 'tvshow' },
    { id: 'music', icon: 'music' },
    { id: 'photo', icon: 'photo' },
  ];

  protected readonly directories = computed<MediaDirectory[]>(() => {
    this.mediaDb.version();
    return this.mediaDb.ready() ? this.mediaDb.listDirectories() : [];
  });

  /** The section being edited (or created), null when the panel is closed. */
  protected readonly form = signal<SectionForm | null>(null);
  /** The folder can't move once files are catalogued from it. */
  protected readonly folderLocked = computed(() => {
    const id = this.form()?.id;
    return id != null && this.mediaDb.listMediaItems(id).length > 0;
  });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly deleting = signal<MediaDirectory | null>(null);

  protected typeLabel(type: MediaType): string {
    return this.i18n.t(MEDIA_TYPE_NAV_KEY[type]);
  }

  protected openCreate(): void {
    this.openForm({ displayName: '', mediaType: 'movie', folder: '', categoryKey: '' });
  }

  protected openEdit(dir: MediaDirectory): void {
    this.openForm({
      id: dir.id,
      displayName: dir.displayName,
      mediaType: dir.mediaType,
      folder: dir.s3Prefix.replace(/^media\//, '').replace(/\/$/, ''),
      categoryKey: dir.categoryKey,
    });
  }

  private openForm(form: SectionForm): void {
    this.form.set(form);
    this.error.set(null);
    // On narrow screens the panel is below the list: bring it into view.
    setTimeout(() => {
      const el = this.panel()?.nativeElement;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  }

  protected close(): void {
    this.form.set(null);
  }

  protected update(patch: Partial<SectionForm>): void {
    this.form.update((f) => (f ? { ...f, ...patch } : f));
  }

  protected async save(): Promise<void> {
    const form = this.form();
    if (!form) {
      return;
    }
    this.error.set(null);
    const displayName = form.displayName.trim();
    const folder = form.folder.trim().replace(/^\/+|\/+$/g, '').replace(/^media\//, '');
    if (!displayName || !folder) {
      this.error.set(this.i18n.t('sections.required'));
      return;
    }
    // The access code defaults to the folder name.
    const categoryKey = (form.categoryKey.trim() || folder.split('/').pop() || folder).toLowerCase();
    const s3Prefix = `${MEDIA_ROOT}${folder}/`;

    this.saving.set(true);
    try {
      // A zero-byte "folder/" object: the S3 convention for a folder, so it
      // shows in the console and is ready for uploads.
      await this.s3.putObject(s3Prefix, new Uint8Array(0));
      const id = await this.mediaDb.upsertDirectory({ id: form.id, s3Prefix, categoryKey, mediaType: form.mediaType, displayName });
      // Catalogue files already in the folder (they never fired a sync).
      void this.catalogSync.resync(id).catch((err) => console.error('Catalog resync failed', err));
      this.form.set(null);
    } catch (err) {
      this.error.set(this.messageFor(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(dir: MediaDirectory): Promise<void> {
    this.deleting.set(dir);
    if (!(await this.confirmDelete().ask())) {
      return;
    }
    try {
      await this.mediaDb.deleteDirectory(dir.id);
      if (this.form()?.id === dir.id) {
        this.form.set(null);
      }
    } catch (err) {
      this.error.set(this.messageFor(err));
    }
  }

  private messageFor(err: unknown): string {
    if (err instanceof CatalogConflictError) {
      return this.i18n.t('admin.conflict');
    }
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE constraint failed')) {
      return this.i18n.t('sections.duplicate');
    }
    return this.i18n.t('sections.saveFailed');
  }
}
