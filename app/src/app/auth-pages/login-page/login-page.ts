import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService, LoginResult } from '../../core/auth/auth.service';
import { MediaDbService } from '../../core/db/media-db.service';

const POSTER_HUES = [25, 340, 200, 145, 60, 280, 15, 190, 320, 95, 250, 30];

/** Purely decorative background tiles — the login page renders before
 * authentication, so there's no real media to show yet. */
function makePosterTiles(): string[] {
  return Array.from({ length: 27 }, (_, i) => {
    const hue = POSTER_HUES[i % POSTER_HUES.length];
    const l1 = 32 + (i % 5) * 5;
    const l2 = 48 + (i % 4) * 6;
    return `linear-gradient(160deg, oklch(${l1}% 0.16 ${hue}), oklch(${l2}% 0.19 ${(hue + 50) % 360}))`;
  });
}

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login-page.html',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly mediaDb = inject(MediaDbService);

  readonly posterTiles = makePosterTiles();

  email = '';
  password = '';
  remember = true;
  newPassword = '';
  confirmNewPassword = '';

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private readonly pendingChallenge = signal<Extract<LoginResult, { status: 'newPasswordRequired' }> | null>(null);
  readonly awaitingNewPassword = () => this.pendingChallenge() !== null;

  async submit(): Promise<void> {
    this.error.set(null);
    this.loading.set(true);
    try {
      const result = await this.auth.login(this.email, this.password, this.remember);
      this.handleResult(result);
    } catch (err) {
      this.error.set(this.messageFor(err));
    } finally {
      this.loading.set(false);
    }
  }

  async submitNewPassword(): Promise<void> {
    const challenge = this.pendingChallenge();
    if (!challenge) {
      return;
    }
    if (this.newPassword !== this.confirmNewPassword) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.error.set(null);
    this.loading.set(true);
    try {
      const result = await challenge.completeNewPassword(this.newPassword);
      this.handleResult(result);
    } catch (err) {
      this.error.set(this.messageFor(err));
    } finally {
      this.loading.set(false);
    }
  }

  private handleResult(result: LoginResult): void {
    if (result.status === 'newPasswordRequired') {
      this.pendingChallenge.set(result);
      return;
    }
    this.router.navigateByUrl('/library');
  }

  private messageFor(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
      return String((err as { message: unknown }).message);
    }
    return 'Sign-in failed. Please try again.';
  }
}
