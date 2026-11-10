import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { APP_TITLE_SETTING_KEY, CatalogConflictError, DEFAULT_APP_TITLE, MediaDbService } from '../../core/db/media-db.service';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';

/** Site-wide settings: the site's name. (Resync lives on the Library tab.) */
@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  private readonly mediaDb = inject(MediaDbService);
  private readonly i18n = inject(I18nService);

  protected readonly appTitle = signal(this.mediaDb.appTitle());
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async save(): Promise<void> {
    this.error.set(null);
    this.saving.set(true);
    try {
      await this.mediaDb.setSetting(APP_TITLE_SETTING_KEY, this.appTitle().trim() || DEFAULT_APP_TITLE);
      this.saved.set(true);
      setTimeout(() => this.saved.set(false), 2500);
    } catch (err) {
      this.error.set(this.i18n.t(err instanceof CatalogConflictError ? 'admin.conflict' : 'site.saveFailed'));
    } finally {
      this.saving.set(false);
    }
  }
}
