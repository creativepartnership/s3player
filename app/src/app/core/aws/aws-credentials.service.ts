import { Injectable, inject } from '@angular/core';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { AuthService } from '../auth/auth.service';
import { environment } from '../../../environments/environment';

/**
 * Federates the current Cognito User Pool session to temporary, role-scoped
 * AWS credentials via the Identity Pool. Which IAM role comes back (Admin vs
 * User) is decided by Cognito itself, based on the signed-in user's group —
 * see infra/lib/s3player-stack.ts.
 */
@Injectable({ providedIn: 'root' })
export class AwsCredentialsService {
  private readonly auth = inject(AuthService);

  private cachedForToken: string | null = null;
  private cachedProvider: AwsCredentialIdentityProvider | null = null;

  /** Returns a credentials provider for the current session. Each call
   * first makes sure the ID token is fresh (renewing it after its one-hour
   * lifetime), and federates again whenever the token changed. */
  getCredentialsProvider(): AwsCredentialIdentityProvider {
    return async (props) => {
      const idToken = await this.auth.freshIdToken();
      if (this.cachedForToken !== idToken || !this.cachedProvider) {
        const providerName = `cognito-idp.${environment.aws.region}.amazonaws.com/${environment.aws.userPoolId}`;
        this.cachedProvider = fromCognitoIdentityPool({
          identityPoolId: environment.aws.identityPoolId,
          clientConfig: { region: environment.aws.region },
          logins: { [providerName]: idToken },
        });
        this.cachedForToken = idToken;
      }
      return this.cachedProvider(props);
    };
  }
}
