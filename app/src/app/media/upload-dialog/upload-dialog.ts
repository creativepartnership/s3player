import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { S3Service } from '../../core/aws/s3.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { classifyDirectoryFiles, ScanCandidate } from '../../core/media/media-scan';
import { MediaDirectory } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { Icon } from '../../ui/icon';

interface CandidateRow {
  candidate: ScanCandidate;
  include: boolean;
}

/** Extends the standard File type with the non-standard (but widely
 * supported) property a webkitdirectory <input> populates. */
interface FileWithRelativePath extends File {
  webkitRelativePath: string;
}

/** Uploads files into a directory's S3 folder — that's all. The
 * catalog-sync Lambda notices the new files and catalogues them (subtitle
 * conversion, poster/plot lookup included) a minute or two later. Files are
 * still grouped here the same way the Lambda will group them, so the user
 * can see and pick what's about to be added. */
@Component({
  selector: 'app-upload-dialog',
  standalone: true,
  imports: [FormsModule, Icon, TranslatePipe],
  templateUrl: './upload-dialog.html',
})
export class UploadDialog {
  private readonly s3 = inject(S3Service);
  private readonly mediaDb = inject(MediaDbService);
  private readonly i18n = inject(I18nService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly directory = input.required<MediaDirectory>();
  readonly uploaded = output<void>();

  private fileByRelativePath = new Map<string, File>();

  readonly candidateRows = signal<CandidateRow[]>([]);
  readonly uploading = signal(false);
  readonly progressText = signal<string | null>(null);
  /** 0–100 over everything being uploaded. */
  readonly progress = signal(0);
  readonly error = signal<string | null>(null);

  open(): void {
    this.candidateRows.set([]);
    this.fileByRelativePath.clear();
    this.error.set(null);
    this.progressText.set(null);
    this.progress.set(0);
    this.dialog().nativeElement.showModal();
  }

  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.classifySelection(input.files);
    input.value = '';
  }

  private classifySelection(fileList: FileList | null): void {
    if (!fileList || fileList.length === 0) {
      return;
    }
    this.error.set(null);
    this.fileByRelativePath.clear();
    const inputFiles = Array.from(fileList).map((file) => {
      const relativePath = (file as FileWithRelativePath).webkitRelativePath || file.name;
      this.fileByRelativePath.set(relativePath, file);
      return { relativePath, size: file.size };
    });

    const dir = this.directory();
    const candidates = classifyDirectoryFiles(dir.mediaType, dir.displayName, inputFiles);
    const existingKeys = new Set(this.mediaDb.listMediaItems(dir.id).map((i) => i.s3Key));
    const filtered = candidates.filter((c) => !existingKeys.has(dir.s3Prefix + c.primaryRelativePath));

    if (filtered.length === 0) {
      this.error.set(this.i18n.t('upload.nothingNew'));
      this.candidateRows.set([]);
      return;
    }

    this.candidateRows.set(filtered.map((c) => ({ candidate: c, include: true })));
  }

  /** Escape / backdrop: not while files are going up. */
  onCancel(event: Event): void {
    if (this.uploading()) {
      event.preventDefault();
    }
  }

  close(): void {
    if (!this.uploading()) {
      this.dialog().nativeElement.close();
    }
  }

  selectedCount(): number {
    return this.candidateRows().filter((r) => r.include).length;
  }

  async confirmUpload(): Promise<void> {
    const dir = this.directory();
    const selected = this.candidateRows().filter((r) => r.include);
    if (selected.length === 0) {
      return;
    }
    this.uploading.set(true);
    this.error.set(null);
    const jobs = selected.flatMap(({ candidate: c }) =>
      [c.primaryRelativePath, ...c.subtitleRelativePaths, ...(c.audioRelativePaths ?? []), ...(c.thumbnailRelativePath ? [c.thumbnailRelativePath] : [])]
        .map((relativePath) => ({ title: c.title, relativePath, file: this.fileByRelativePath.get(relativePath) }))
        .filter((job): job is { title: string; relativePath: string; file: File } => !!job.file),
    );
    const totalBytes = jobs.reduce((sum, job) => sum + job.file.size, 0) || 1;
    let doneBytes = 0;
    try {
      for (const job of jobs) {
        await this.s3.uploadFile(dir.s3Prefix + job.relativePath, job.file, (loaded) => {
          this.progress.set(Math.min(100, Math.round(((doneBytes + loaded) / totalBytes) * 100)));
          this.progressText.set(job.title);
        });
        doneBytes += job.file.size;
      }

      this.dialog().nativeElement.close();
      this.uploaded.emit();
    } catch (err) {
      this.error.set(this.i18n.t('upload.failed', { reason: err instanceof Error ? err.message : '' }));
    } finally {
      this.uploading.set(false);
      this.progressText.set(null);
    }
  }
}
