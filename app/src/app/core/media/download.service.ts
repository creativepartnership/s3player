import { Injectable, inject } from '@angular/core';
import { S3Service } from '../aws/s3.service';
import { buildZip, fitsInZip, ZipEntry } from './zip';

export interface DownloadFile {
  s3Key: string;
  /** Name to save it under (defaults to the key's last segment). */
  name?: string;
}

/** The last path segment of an S3 key: the file's original name. */
export function fileNameOf(s3Key: string): string {
  return s3Key.split('/').pop() || s3Key;
}

/** Characters most file systems refuse in a name. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'download';
}

/** Saves media files to the viewer's device. Single files go straight from
 * S3 (a signed URL with Content-Disposition: attachment, so nothing passes
 * through the page); several files (an album) are fetched and packed into
 * one ZIP in the browser. Who may download is decided by the caller
 * (AuthService.canDownload). */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  private readonly s3 = inject(S3Service);

  async downloadFile(file: DownloadFile): Promise<void> {
    const name = safeName(file.name ?? fileNameOf(file.s3Key));
    this.save(await this.s3.getDownloadUrl(file.s3Key, name));
  }

  /** onProgress gets 0–1 over the bytes fetched. Falls back to one download
   * per file when the files are too big for a (non-ZIP64) archive. */
  async downloadZip(files: DownloadFile[], zipName: string, onProgress?: (fraction: number) => void): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const names = this.uniqueNames(files.map((f) => safeName(f.name ?? fileNameOf(f.s3Key))));
    const sizes = await Promise.all(files.map((f) => this.s3.getObjectSize(f.s3Key)));
    const total = sizes.reduce<number>((a, b) => a + (b ?? 0), 0) || 1;
    if (!fitsInZip(sizes.map((s) => s ?? 0), names.join('').length * 3)) {
      for (const [i, file] of files.entries()) {
        await this.downloadFile({ s3Key: file.s3Key, name: names[i] });
      }
      return;
    }

    const entries: ZipEntry[] = [];
    let done = 0;
    for (const [i, file] of files.entries()) {
      const response = await fetch(await this.s3.getPresignedUrl(file.s3Key));
      if (!response.ok || !response.body) {
        throw new Error(`${names[i]}: HTTP ${response.status}`);
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) {
          break;
        }
        chunks.push(value);
        length += value.length;
        onProgress?.(Math.min(1, (done + length) / total));
      }
      const bytes = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      done += length;
      entries.push({ name: names[i], bytes });
    }

    const url = URL.createObjectURL(buildZip(entries));
    try {
      this.save(url, `${safeName(zipName)}.zip`);
    } finally {
      // Give the browser time to start reading the blob before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  private uniqueNames(names: string[]): string[] {
    const seen = new Map<string, number>();
    return names.map((name) => {
      const n = seen.get(name.toLowerCase()) ?? 0;
      seen.set(name.toLowerCase(), n + 1);
      if (n === 0) {
        return name;
      }
      const dot = name.lastIndexOf('.');
      return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    });
  }

  private save(url: string, fileName?: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    if (fileName) {
      a.download = fileName;
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}
