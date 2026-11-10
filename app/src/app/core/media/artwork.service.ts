import { Injectable, inject, signal } from '@angular/core';
import { S3Service } from '../aws/s3.service';

/** Presigned URLs last 15 minutes (S3Service); sign again a bit before. */
const URL_REUSE_MS = 12 * 60_000;

interface SignedUrl {
  url: string;
  signedAt: number;
}

/** Presigned URLs for artwork (posters, backdrops, stills, covers, photos),
 * shared by every screen so the same image isn't signed (and downloaded)
 * once per component. Reading url(key) inside a template or computed()
 * returns undefined the first time and starts signing; the signal update
 * then re-renders with the URL. */
@Injectable({ providedIn: 'root' })
export class ArtworkService {
  private readonly s3 = inject(S3Service);
  private readonly urls = signal<ReadonlyMap<string, SignedUrl>>(new Map());
  private readonly pending = new Set<string>();
  /** Average color per image key, measured once it loads (ArtImage). */
  private readonly colors = new Map<string, string>();

  url(key: string | null | undefined): string | undefined {
    if (!key) {
      return undefined;
    }
    const signed = this.urls().get(key);
    if (!signed || Date.now() - signed.signedAt > URL_REUSE_MS) {
      // Never write a signal synchronously while a template is reading.
      queueMicrotask(() => this.sign(key));
    }
    return signed?.url;
  }

  color(key: string): string | undefined {
    return this.colors.get(key);
  }

  rememberColor(key: string, color: string): void {
    this.colors.set(key, color);
  }

  private async sign(key: string): Promise<void> {
    const current = this.urls().get(key);
    if (this.pending.has(key) || (current && Date.now() - current.signedAt <= URL_REUSE_MS)) {
      return;
    }
    this.pending.add(key);
    try {
      const url = await this.s3.getPresignedUrl(key);
      this.urls.update((map) => new Map(map).set(key, { url, signedAt: Date.now() }));
    } catch {
      /* not signed in (yet) or offline: the fallback art stays */
    } finally {
      this.pending.delete(key);
    }
  }
}
