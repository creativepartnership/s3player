import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MediaDbService } from '../core/db/media-db.service';
import { TranslatePipe } from '../core/i18n/i18n.service';

@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslatePipe],
  templateUrl: './admin-page.html',
})
export class AdminPage {
  protected readonly mediaDb = inject(MediaDbService);

  constructor() {
    void this.mediaDb.ensureLoaded();
  }
}
