import { Injectable, inject } from '@angular/core';
import {
  AbortMultipartUploadCommand,
  CompletedPart,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AwsCredentialsService } from './aws-credentials.service';
import { environment } from '../../../environments/environment';

export interface GetObjectResult {
  bytes: Uint8Array;
  etag: string | undefined;
}

const PRESIGNED_URL_TTL_SECONDS = 900;
/** Multipart upload: part size (S3 allows up to 10,000 parts, so this
 * covers files up to ~160 GB), parts in flight, retries per part. */
const UPLOAD_PART_SIZE = 16 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_PART_ATTEMPTS = 3;

/** Thin wrapper around the S3 operations S3Player needs, using temporary
 * credentials federated from the current Cognito session. */
@Injectable({ providedIn: 'root' })
export class S3Service {
  private readonly creds = inject(AwsCredentialsService);
  private readonly bucket = environment.aws.mediaBucketName;

  private readonly client = new S3Client({
    region: environment.aws.region,
    credentials: () => this.creds.getCredentialsProvider()(),
    // The SDK's default WHEN_SUPPORTED auto-attaches a CRC32 checksum to
    // CreateMultipartUpload, and then S3 expects a matching checksum on every
    // part, else CompleteMultipartUpload fails with "checksum ... was missing
    // for part 1". Only compute checksums when an operation requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

  /** Fetches an object's full body plus its ETag (used for the sql.js catalog's
   * optimistic-concurrency check before overwriting). Returns null if the key
   * doesn't exist yet (expected on first run, before any admin save). */
  async getObject(key: string): Promise<GetObjectResult | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await response.Body?.transformToByteArray();
      return { bytes: bytes ?? new Uint8Array(), etag: response.ETag };
    } catch (err) {
      if (err instanceof NoSuchKey) {
        return null;
      }
      throw err;
    }
  }

  /** Like getObject, but returns 'unchanged' (without downloading anything)
   * when the object's ETag still equals the one given — a cheap "has the
   * catalog changed?" check. */
  async getObjectIfChanged(key: string, etag: string | undefined): Promise<GetObjectResult | null | 'unchanged'> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, IfNoneMatch: etag }));
      const bytes = await response.Body?.transformToByteArray();
      return { bytes: bytes ?? new Uint8Array(), etag: response.ETag };
    } catch (err) {
      if (err instanceof NoSuchKey) {
        return null;
      }
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 304) {
        return 'unchanged';
      }
      throw err;
    }
  }

  /** Deletes objects one by one (DeleteObjects would need a checksum header
   * the browser SDK setup above deliberately avoids). Deleting a key that
   * doesn't exist succeeds silently. Requires the Admin IAM role. */
  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
  }

  /** Writes an object. If ifMatchEtag is given, the write is rejected with a
   * PreconditionFailed error when the object has changed since it was read —
   * the concurrency guard for the sql.js catalog file. */
  async putObject(key: string, bytes: Uint8Array, ifMatchEtag?: string): Promise<{ etag: string | undefined }> {
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        IfMatch: ifMatchEtag,
      }),
    );
    return { etag: response.ETag };
  }

  /** Short-lived, signed GET URL for streaming a media file directly from the
   * browser (via <video>/<audio>/<img> src, which can't attach SigV4 headers). */
  async getPresignedUrl(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
    });
  }

  /** Signed GET URL that makes the browser save the file (Content-Disposition:
   * attachment) under the given name instead of playing it. */
  async getDownloadUrl(key: string, fileName: string): Promise<string> {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      }),
      { expiresIn: PRESIGNED_URL_TTL_SECONDS },
    );
  }

  /** One tag's value on an object, or null (no such tag, or no object). */
  async getObjectTag(key: string, tagKey: string): Promise<string | null> {
    try {
      const { TagSet } = await this.client.send(new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key }));
      return TagSet?.find((t) => t.Key === tagKey)?.Value ?? null;
    } catch {
      return null;
    }
  }

  /** An object's user metadata (x-amz-meta-*, keys without the prefix), or
   * null if it can't be read. */
  async getObjectMetadata(key: string): Promise<Record<string, string> | null> {
    try {
      return (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))).Metadata ?? {};
    } catch {
      return null;
    }
  }

  /** Size in bytes, or null if the object doesn't exist. */
  async getObjectSize(key: string): Promise<number | null> {
    try {
      return (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))).ContentLength ?? null;
    } catch {
      return null;
    }
  }

  /** Uploads a local file (from a file/folder picker) to the media bucket.
   * Requires the Admin or Uploader IAM role (s3:PutObject on media/).
   *
   * Big files go up as an S3 multipart upload that reads the file one part
   * at a time (File.slice): reading a whole movie into memory fails in the
   * browser ("The requested file could not be read…") once it's past a
   * couple of GB, and would use that much RAM anyway. */
  async uploadFile(key: string, file: File, onProgress?: (loadedBytes: number, totalBytes: number) => void): Promise<void> {
    const contentType = file.type || undefined;
    if (file.size <= UPLOAD_PART_SIZE) {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: new Uint8Array(await file.arrayBuffer()), ContentType: contentType }),
      );
      onProgress?.(file.size, file.size);
      return;
    }

    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!UploadId) {
      throw new Error('S3 did not start the upload.');
    }
    const partCount = Math.ceil(file.size / UPLOAD_PART_SIZE);
    const parts: CompletedPart[] = new Array(partCount);
    const loadedPerPart = new Array<number>(partCount).fill(0);
    let nextPart = 0;

    const uploadPart = async (index: number): Promise<void> => {
      const start = index * UPLOAD_PART_SIZE;
      const blob = file.slice(start, Math.min(file.size, start + UPLOAD_PART_SIZE));
      for (let attempt = 1; ; attempt++) {
        try {
          const body = new Uint8Array(await blob.arrayBuffer());
          const { ETag } = await this.client.send(
            new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId, PartNumber: index + 1, Body: body }),
          );
          parts[index] = { ETag, PartNumber: index + 1 };
          loadedPerPart[index] = blob.size;
          onProgress?.(loadedPerPart.reduce((a, b) => a + b, 0), file.size);
          return;
        } catch (err) {
          if (attempt >= UPLOAD_PART_ATTEMPTS) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    };

    const worker = async (): Promise<void> => {
      while (nextPart < partCount) {
        await uploadPart(nextPart++);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, partCount) }, worker));
      await this.client.send(
        new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }),
      );
    } catch (err) {
      // Don't leave billed, invisible part data behind.
      await this.client
        .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId }))
        .catch(() => undefined);
      throw err;
    }
  }
}
