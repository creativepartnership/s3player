import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth/auth.service';
import { MediaDbService } from '../core/db/media-db.service';
import { I18nService, LANGUAGES, Language, TranslatePipe } from '../core/i18n/i18n.service';
import { MessageKey } from '../core/i18n/messages.en';
import { ThemeService } from '../core/theme/theme.service';
import { isThemeId, ThemeId } from '../core/theme/themes';
import { Icon } from '../ui/icon';

/** Per-user (per-device) preferences: theme and language. Admins also set
 * the default theme here, right under the theme choice it relates to. */
@Component({
  selector: 'app-user-settings-page',
  standalone: true,
  imports: [RouterLink, TranslatePipe, Icon],
  templateUrl: './settings-page.html',
})
export class UserSettingsPage {
  protected readonly theme = inject(ThemeService);
  protected readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  private readonly mediaDb = inject(MediaDbService);
  private readonly router = inject(Router);

  protected readonly languages = LANGUAGES;
  protected readonly savingDefault = signal(false);
  protected readonly defaultSaved = signal(false);
  protected readonly defaultError = signal(false);

  constructor() {
    void this.mediaDb.ensureLoaded();
  }

  protected description(id: ThemeId): MessageKey {
    return `theme.${id}.description` as MessageKey;
  }

  protected signOut(): void {
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }

  protected setLanguage(lang: Language): void {
    this.i18n.set(lang);
  }

  protected async setDefault(value: string): Promise<void> {
    if (!isThemeId(value)) {
      return;
    }
    this.savingDefault.set(true);
    this.defaultError.set(false);
    try {
      await this.theme.setDefault(value);
      this.defaultSaved.set(true);
      setTimeout(() => this.defaultSaved.set(false), 2000);
    } catch {
      this.defaultError.set(true);
    } finally {
      this.savingDefault.set(false);
    }
  }
}
