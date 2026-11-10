import { Injectable, inject } from '@angular/core';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { environment } from '../../../environments/environment';
import { AwsCredentialsService } from './aws-credentials.service';

export type UserRole = 'viewer' | 'uploader' | 'admin';

/** Mirrors infra/lambda/user-admin (UserSummary). */
export interface ManagedUser {
  username: string;
  email: string;
  name: string;
  role: UserRole;
  categories: string[];
  /** May use the Download buttons (always true for admins). */
  canDownload: boolean;
  /** Cognito status: CONFIRMED, FORCE_CHANGE_PASSWORD (invited, not signed in yet), … */
  status: string;
  enabled: boolean;
  createdAt: string | null;
}

export type UserAdminErrorCode = 'adminProtected' | 'exists' | 'invalid' | 'notFound' | 'failed';

export class UserAdminError extends Error {
  constructor(
    readonly code: UserAdminErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Response = { ok: true; users?: ManagedUser[]; user?: ManagedUser } | { ok: false; error: UserAdminErrorCode; message: string };

/** Admin › Users, through the s3player-user-admin Lambda (which holds the
 * Cognito permissions and enforces the rules: viewers and uploaders only,
 * admin accounts untouchable). Requires the Admin IAM role. */
@Injectable({ providedIn: 'root' })
export class UserAdminService {
  private readonly creds = inject(AwsCredentialsService);
  private readonly client = new LambdaClient({
    region: environment.aws.region,
    credentials: () => this.creds.getCredentialsProvider()(),
  });

  /** False on deployments configured before this feature existed (rerun
   * scripts/configure-app.sh after deploying). */
  readonly available = !!this.functionName();

  async list(): Promise<ManagedUser[]> {
    return (await this.call({ action: 'list' })).users ?? [];
  }

  async invite(input: { email: string; name: string; role: 'viewer' | 'uploader'; categories: string[]; canDownload: boolean }): Promise<void> {
    await this.call({ action: 'invite', ...input });
  }

  async update(input: { username: string; name: string; role: 'viewer' | 'uploader'; categories: string[]; canDownload: boolean }): Promise<void> {
    await this.call({ action: 'update', ...input });
  }

  async setEnabled(username: string, enabled: boolean): Promise<void> {
    await this.call({ action: 'setEnabled', username, enabled });
  }

  async resendInvite(username: string): Promise<void> {
    await this.call({ action: 'resendInvite', username });
  }

  async remove(username: string): Promise<void> {
    await this.call({ action: 'delete', username });
  }

  private functionName(): string {
    return (environment.aws as { userAdminFunctionName?: string }).userAdminFunctionName ?? '';
  }

  private async call(request: Record<string, unknown>): Promise<Extract<Response, { ok: true }>> {
    const response = await this.client.send(
      new InvokeCommand({ FunctionName: this.functionName(), Payload: new TextEncoder().encode(JSON.stringify(request)) }),
    );
    const text = response.Payload ? new TextDecoder().decode(response.Payload) : '';
    if (response.FunctionError) {
      throw new UserAdminError('failed', text);
    }
    const body = JSON.parse(text) as Response;
    if (!body.ok) {
      throw new UserAdminError(body.error, body.message);
    }
    return body;
  }
}
