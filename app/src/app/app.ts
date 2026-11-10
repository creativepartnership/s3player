import { Component, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { SpatialNavService } from './core/theme/spatial-nav.service';
import { ThemeService } from './core/theme/theme.service';
import { MediaDbService } from './core/db/media-db.service';
import { AuthService } from './core/auth/auth.service';
import { I18nService } from './core/i18n/i18n.service';
import { AppNav } from './shell/app-nav';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AppNav],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  // Injected here so the theme and language are applied (they set
  // attributes on <html>) from the very first screen, login included.
  protected readonly theme = inject(ThemeService);
  protected readonly i18n = inject(I18nService);
  // TV remotes: arrows move focus spatially (no-op on other devices).
  private readonly spatialNav = inject(SpatialNavService);
  protected readonly mediaDb = inject(MediaDbService);
  protected readonly auth = inject(AuthService);
  private readonly titleService = inject(Title);
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** No navigation on the login page (it has its own full-bleed header) or
   * while playing (the player is full screen). */
  protected readonly showNav = computed(
    () => this.auth.isAuthenticated() && !/^\/(login|play)(\/|$|\?)/.test(this.url()),
  );

  constructor() {
    effect(() => this.titleService.setTitle(this.mediaDb.appTitle()));
  }
}
