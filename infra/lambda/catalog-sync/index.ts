import { S3Client } from '@aws-sdk/client-s3';
import { SendMessageBatchCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Context, SQSEvent } from 'aws-lambda';
import type { SqlJsStatic } from 'sql.js';
// The sql.js build with its WebAssembly embedded in the JS file: no separate
// .wasm file to ship alongside the esbuild bundle.
import initSqlJs from 'sql.js/dist/sql-wasm-inline.js';
import { MetadataClient } from '../../../app/src/app/core/media/metadata-client';
import { SyncScope, SyncSummary, syncCatalog } from './sync';

/** Direct invocation from the admin UI's "Resync" button (or the CLI):
 * resync one directory, or every directory when directoryId is omitted. */
interface ResyncEvent {
  action: 'resync';
  directoryId?: number;
}

/** Queued by this function itself when a run's time budget ran out. */
interface ContinueMessage {
  action: 'continue';
  directoryIds: number[];
}

interface S3EventNotification {
  Records?: { eventName?: string; s3?: { object?: { key?: string } } }[];
}

/** Stop starting new TMDb work this long before the Lambda timeout, leaving
 * time to save the catalog. */
const SAFETY_MARGIN_MS = 60_000;

const s3 = new S3Client({});
const sqs = new SQSClient({});
const metadata = new MetadataClient({
  tmdbApiKey: process.env['TMDB_API_KEY'] ?? '',
  language: process.env['TMDB_LANGUAGE'] || undefined,
  userAgent: 'S3Player/1.0 (self-hosted media catalog)',
});
let sqlPromise: Promise<SqlJsStatic> | null = null;

export async function handler(event: SQSEvent | ResyncEvent, context?: Context): Promise<SyncSummary> {
  const bucket = process.env['MEDIA_BUCKET_NAME'];
  if (!bucket) {
    throw new Error('MEDIA_BUCKET_NAME is not set.');
  }
  sqlPromise ??= initSqlJs();
  const deadline = context ? Date.now() + context.getRemainingTimeInMillis() - SAFETY_MARGIN_MS : undefined;
  const deps = { s3, bucket, SQL: await sqlPromise, metadata, deadline };

  let scope: SyncScope;
  if ('Records' in event) {
    const { keys, directoryIds } = parseSqs(event);
    if (keys.length === 0 && directoryIds.length === 0) {
      return { directories: [], added: 0, updated: 0, removed: 0, pendingDirectoryIds: [], pendingItems: 0, newVideoKeys: [], videoKeys: [] };
    }
    if (keys.length > 0) {
      scope = { kind: 'keys', keys };
      // Continuations batched together with S3 events: run them right after.
      if (directoryIds.length > 0) {
        await enqueueContinuation(directoryIds);
      }
    } else {
      scope = { kind: 'directories', directoryIds };
    }
  } else if (event.action === 'resync') {
    scope = event.directoryId == null ? { kind: 'all' } : { kind: 'directories', directoryIds: [event.directoryId] };
  } else {
    throw new Error('Unrecognized event.');
  }

  const summary = await syncCatalog(deps, scope);
  if (summary.pendingDirectoryIds.length > 0) {
    await enqueueContinuation(summary.pendingDirectoryIds);
  }
  // New videos always; on an explicit resync, every video in scope.
  const toCheck = 'Records' in event ? summary.newVideoKeys : summary.videoKeys;
  await enqueueTranscode(toCheck);
  const { videoKeys, newVideoKeys, ...logged } = summary;
  console.log(JSON.stringify({ scope: scope.kind, ...logged, newVideos: newVideoKeys.length, videosChecked: toCheck.length }));
  // The key lists can be long; the admin UI only needs the counts.
  return { ...logged, newVideoKeys: [], videoKeys: [] };
}

/** Hands videos to the media-transcode function (if deployed), one per
 * message so a long conversion doesn't hold up the others. */
async function enqueueTranscode(keys: string[]): Promise<void> {
  const queueUrl = process.env['TRANSCODE_QUEUE_URL'];
  if (!queueUrl || keys.length === 0) {
    return;
  }
  for (let i = 0; i < keys.length; i += 10) {
    const batch = keys.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((key, n) => ({ Id: String(n), MessageBody: JSON.stringify({ keys: [key] }) })),
      }),
    );
  }
}

/** Hands left-over work to the next run via the same queue S3 events use, so
 * it's processed within a minute or two, one run at a time. */
async function enqueueContinuation(directoryIds: number[]): Promise<void> {
  const queueUrl = process.env['CATALOG_SYNC_QUEUE_URL'];
  if (!queueUrl) {
    console.warn('CATALOG_SYNC_QUEUE_URL is not set; left-over work waits for the next sync.');
    return;
  }
  const message: ContinueMessage = { action: 'continue', directoryIds: [...new Set(directoryIds)] };
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }));
}

/** Each SQS message body is either an S3 event notification (or the one-off
 * s3:TestEvent S3 sends when notifications are first configured, which has
 * no Records and is ignored), or a ContinueMessage from this function.
 * Object keys arrive URL-encoded, spaces as '+'. */
function parseSqs(event: SQSEvent): { keys: string[]; directoryIds: number[] } {
  const keys = new Set<string>();
  const directoryIds = new Set<number>();
  for (const record of event.Records) {
    let body: S3EventNotification & Partial<ContinueMessage>;
    try {
      body = JSON.parse(record.body) as S3EventNotification & Partial<ContinueMessage>;
    } catch {
      continue;
    }
    if (body.action === 'continue' && Array.isArray(body.directoryIds)) {
      for (const id of body.directoryIds) {
        if (typeof id === 'number') {
          directoryIds.add(id);
        }
      }
      continue;
    }
    for (const r of body.Records ?? []) {
      const raw = r.s3?.object?.key;
      if (raw) {
        keys.add(decodeURIComponent(raw.replace(/\+/g, ' ')));
      }
    }
  }
  return { keys: [...keys], directoryIds: [...directoryIds] };
}
