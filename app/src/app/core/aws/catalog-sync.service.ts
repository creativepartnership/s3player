import { Injectable, inject } from '@angular/core';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { AwsCredentialsService } from './aws-credentials.service';
import { MediaDbService } from '../db/media-db.service';
import { environment } from '../../../environments/environment';

/** What the catalog-sync Lambda reports back (see infra/lambda/catalog-sync). */
export interface SyncSummary {
  directories: string[];
  added: number;
  updated: number;
  removed: number;
  /** Items left for a follow-up run (large syncs continue in the background). */
  pendingItems: number;
}

/** Runs the catalog-sync Lambda on demand ("Resync"). Normally it runs by
 * itself, a minute or so after files land in or leave the media bucket;
 * this is for files that were there before a directory was defined, or to
 * double-check. Requires the Admin IAM role (lambda:InvokeFunction). */
@Injectable({ providedIn: 'root' })
export class CatalogSyncService {
  private readonly creds = inject(AwsCredentialsService);
  private readonly mediaDb = inject(MediaDbService);

  private readonly client = new LambdaClient({
    region: environment.aws.region,
    credentials: () => this.creds.getCredentialsProvider()(),
  });

  /** Resyncs one directory, or all of them when directoryId is omitted, then
   * reloads the catalog so the result shows up right away. */
  async resync(directoryId?: number): Promise<SyncSummary> {
    const response = await this.client.send(
      new InvokeCommand({
        FunctionName: environment.aws.catalogSyncFunctionName,
        Payload: new TextEncoder().encode(JSON.stringify({ action: 'resync', directoryId })),
      }),
    );
    const payloadText = response.Payload ? new TextDecoder().decode(response.Payload) : '';
    if (response.FunctionError) {
      let message = 'Catalog sync failed.';
      try {
        message = (JSON.parse(payloadText) as { errorMessage?: string }).errorMessage ?? message;
      } catch {
        // keep the generic message
      }
      throw new Error(message);
    }
    await this.mediaDb.reloadIfChanged();
    return JSON.parse(payloadText) as SyncSummary;
  }
}
