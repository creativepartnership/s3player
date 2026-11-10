import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../core/auth/auth.service';
import { MediaDbService } from '../core/db/media-db.service';
import { I18nService, TranslatePipe } from '../core/i18n/i18n.service';
import { LibraryService } from '../core/media/library.service';
import { ThemeService } from '../core/theme/theme.service';
import { Icon, IconName } from '../ui/icon';

interface NavEntry {
  label: string;
  icon: IconName;
  link: (string | number)[];
  exact: boolean;
}

/** The app's main navigation: Home, one entry per library section the user
 * can see, then Settings (and Admin). Where it sits comes from the theme
 * and device (ThemeService.layout().nav): a side rail (Aurora), a top bar
 * (Proiezione), a floating glass pill (Vetro), or a bottom bar on phones. */
@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-nav.html',
  host: { '(window:scroll)': 'onScroll()' },
})
export class AppNav {
  protected readonly theme = inject(ThemeService);
  protected readonly auth = inject(AuthService);
  protected readonly mediaDb = inject(MediaDbService);
  private readonly library = inject(LibraryService);
  private readonly i18n = inject(I18nService);

  protected readonly mode = computed(() => this.theme.layout().nav);
  /** Top bars turn solid once the page scrolls under them. */
  protected readonly scrolled = signal(false);

  protected onScroll(): void {
    this.scrolled.set(window.scrollY > 24);
  }

  protected readonly sections = computed<NavEntry[]>(() => [
    { label: this.i18n.t('nav.home'), icon: 'home', link: ['/library'], exact: true },
    ...this.library.directories().map((d) => ({
      label: d.displayName,
      icon: d.mediaType as IconName,
      link: ['/library', d.id],
      exact: false,
    })),
  ]);

  protected readonly tools = computed<NavEntry[]>(() => [
    { label: this.i18n.t('nav.settings'), icon: 'settings', link: ['/settings'], exact: false },
    ...(this.auth.isAdmin() ? [{ label: this.i18n.t('nav.admin'), icon: 'admin' as IconName, link: ['/admin'], exact: false }] : []),
  ]);

  /** Phones: Admin lives in Settings, so the bar keeps room for sections. */
  protected readonly all = computed(() => [...this.sections(), this.tools()[0]]);
}
