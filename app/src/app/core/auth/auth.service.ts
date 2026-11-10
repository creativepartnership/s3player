import { Injectable, computed, signal } from '@angular/core';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { environment } from '../../../environments/environment';

export interface SessionClaims {
  idToken: string;
  groups: string[];
  categories: string[];
  /** custom:download is "1": may use the Download buttons. */
  download: boolean;
}

/** Result of a login attempt. Cognito forces a password change on the first
 * sign-in for admin-created accounts (temporary password), surfaced here as
 * a distinct status so the login page can prompt for a new password without
 * a second round trip through email/password fields. */
export type LoginResult =
  | { status: 'success' }
  | { status: 'newPasswordRequired'; completeNewPassword: (newPassword: string) => Promise<LoginResult> };

/** Renew the ID token this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** A JWT's exp claim, in ms (0 if unreadable, i.e. treat as expired). */
function tokenExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly userPool = new CognitoUserPool({
    UserPoolId: environment.aws.userPoolId,
    ClientId: environment.aws.userPoolClientId,
  });

  private readonly claimsSignal = signal<SessionClaims | null>(null);

  readonly claims = this.claimsSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.claimsSignal() !== null);
  readonly isAdmin = computed(() => this.claimsSignal()?.groups.includes('Admins') ?? false);
  readonly isUploader = computed(() => this.claimsSignal()?.groups.includes('Uploaders') ?? false);
  /** Admins can always upload (their IAM role has bucket-wide PutObject); an
   * Uploaders-group account can too, scoped to their own categories. */
  readonly canUpload = computed(() => this.isAdmin() || this.isUploader());
  readonly categories = computed(() => this.claimsSignal()?.categories ?? []);
  /** Admins always can; other accounts when an admin allowed it (Admin ›
   * Users). Only gates the app's Download buttons: whoever can play a file
   * can technically fetch it, since streaming uses the same signed URLs. */
  readonly canDownload = computed(() => this.isAdmin() || (this.claimsSignal()?.download ?? false));
  /** The signed-in account's email, from the ID token (display only). */
  readonly email = computed(() => {
    const token = this.claimsSignal()?.idToken;
    if (!token) {
      return '';
    }
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
      return typeof payload['email'] === 'string' ? payload['email'] : '';
    } catch {
      return '';
    }
  });

  /** Restores a session from wherever it was persisted, if any (called once at app start). */
  async restoreSession(): Promise<void> {
    const cognitoUser = this.getCurrentUser();
    if (!cognitoUser) {
      return;
    }
    const session = await this.getSessionAsync(cognitoUser);
    if (session?.isValid()) {
      this.claimsSignal.set(this.toClaims(session));
    }
  }

  /** `remember` picks where the session is persisted: localStorage survives browser
   * restarts, sessionStorage is cleared once the tab/browser closes. */
  async login(email: string, password: string, remember: boolean): Promise<LoginResult> {
    const storage = remember ? localStorage : sessionStorage;
    const cognitoUser = new CognitoUser({ Username: email, Pool: this.userPool, Storage: storage });
    const authDetails = new AuthenticationDetails({ Username: email, Password: password });

    return new Promise<LoginResult>((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          this.claimsSignal.set(this.toClaims(session));
          resolve({ status: 'success' });
        },
        onFailure: (err) => reject(err),
        newPasswordRequired: (userAttributes) => {
          // Cognito returns read-only attributes that must be stripped before resubmitting.
          delete userAttributes['email_verified'];
          delete userAttributes['email'];
          resolve({
            status: 'newPasswordRequired',
            completeNewPassword: (newPassword: string) =>
              new Promise<LoginResult>((resolve2, reject2) => {
                cognitoUser.completeNewPasswordChallenge(newPassword, userAttributes, {
                  onSuccess: (session) => {
                    this.claimsSignal.set(this.toClaims(session));
                    resolve2({ status: 'success' });
                  },
                  onFailure: (err) => reject2(err),
                });
              }),
          });
        },
      });
    });
  }

  /** An ID token that is valid for at least a few more minutes. ID tokens
   * last an hour; past that, Cognito's refresh token gets a new one (the
   * library's getSession does the refresh), so a long-open tab keeps working.
   * Throws if the session can't be renewed (signed out, refresh token
   * expired or revoked). */
  async freshIdToken(): Promise<string> {
    const claims = this.claimsSignal();
    if (!claims) {
      throw new Error('No active session.');
    }
    if (tokenExpiry(claims.idToken) - Date.now() > TOKEN_MARGIN_MS) {
      return claims.idToken;
    }
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private refreshing: Promise<string> | null = null;

  private async refresh(): Promise<string> {
    const cognitoUser = this.getCurrentUser();
    const session = cognitoUser ? await this.getSessionAsync(cognitoUser) : null;
    if (!session?.isValid()) {
      throw new Error('The session has expired: sign in again.');
    }
    // getSession only refreshes once the token is actually expired; inside the
    // margin, force it so the next requests don't race the expiry.
    const fresh =
      tokenExpiry(session.getIdToken().getJwtToken()) - Date.now() > TOKEN_MARGIN_MS
        ? session
        : await new Promise<CognitoUserSession>((resolve, reject) =>
            cognitoUser!.refreshSession(session.getRefreshToken(), (err: Error | null, s: CognitoUserSession) => (err ? reject(err) : resolve(s))),
          );
    const claims = this.toClaims(fresh);
    this.claimsSignal.set(claims);
    return claims.idToken;
  }

  logout(): void {
    this.getCurrentUser()?.signOut();
    this.claimsSignal.set(null);
  }

  /** The pool's own `getCurrentUser()` only ever looks at its default (localStorage)
   * storage, so a session persisted to sessionStorage (i.e. "remember me" left
   * unchecked) needs to be looked up manually. */
  private getCurrentUser(): CognitoUser | null {
    const lastUserKey = `CognitoIdentityServiceProvider.${environment.aws.userPoolClientId}.LastAuthUser`;
    for (const storage of [localStorage, sessionStorage]) {
      const username = storage.getItem(lastUserKey);
      if (username) {
        return new CognitoUser({ Username: username, Pool: this.userPool, Storage: storage });
      }
    }
    return null;
  }

  private getSessionAsync(cognitoUser: CognitoUser): Promise<CognitoUserSession | null> {
    return new Promise((resolve) => {
      cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
        resolve(err ? null : session);
      });
    });
  }

  private toClaims(session: CognitoUserSession): SessionClaims {
    const payload = session.getIdToken().decodePayload() as Record<string, unknown>;
    const groups = Array.isArray(payload['cognito:groups']) ? (payload['cognito:groups'] as string[]) : [];
    const categoriesRaw = typeof payload['custom:categories'] === 'string' ? (payload['custom:categories'] as string) : '';
    const categories = categoriesRaw
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const download = payload['custom:download'] === '1';
    return { idToken: session.getIdToken().getJwtToken(), groups, categories, download };
  }
}
