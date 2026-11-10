import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { MediaType } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { LibraryService, MEDIA_TYPE_NAV_KEY, Tile } from '../../core/media/library.service';
import { Hero } from '../../ui/hero';
import { CardShape, MediaCard } from '../../ui/media-card';
import { Shelf } from '../../ui/shelf';

type ArrivalFilter = 'all' | Tile['kind'];

const SHAPE_FOR: Record<MediaType, CardShape> = { movie: 'poster', tvshow: 'wide', music: 'square', photo: 'square' };
const WIDTH_FOR: Record<CardShape, string> = { poster: 's3-w-poster', wide: 's3-w-wide', square: 's3-w-square' };

/** Home: hero banner, continue watching, new arrivals (filterable), then a
 * row per library section. */
@Component({
  selector: 'app-browse-page',
  standalone: true,
  imports: [RouterLink, Hero, MediaCard, Shelf, TranslatePipe],
  templateUrl: './browse-page.html',
})
export class BrowsePage {
  protected readonly auth = inject(AuthService);
  protected readonly library = inject(LibraryService);
  private readonly mediaDb = inject(MediaDbService);
  private readonly i18n = inject(I18nService);

  protected readonly arrivalFilter = signal<ArrivalFilter>('all');

  /** Filter chips: only for kinds that actually appear among new arrivals. */
  protected readonly arrivalFilters = computed(() => {
    const kinds = new Set(this.library.recent().map((t) => t.kind));
    const options: { id: ArrivalFilter; label: string }[] = [{ id: 'all', label: this.i18n.t('filter.all') }];
    if (kinds.has('movie')) options.push({ id: 'movie', label: this.i18n.t('nav.movies') });
    if (kinds.has('show')) options.push({ id: 'show', label: this.i18n.t('nav.shows') });
    if (kinds.has('album')) options.push({ id: 'album', label: this.i18n.t('nav.music') });
    return options.length > 2 ? options : [];
  });

  protected readonly arrivals = computed(() => {
    const filter = this.arrivalFilter();
    return this.library.recent().filter((t) => filter === 'all' || t.kind === filter);
  });

  constructor() {
    // Picks up anything the catalog-sync Lambda added since the last visit.
    void this.mediaDb.reloadIfChanged();
  }

  protected shape(type: MediaType): CardShape {
    return SHAPE_FOR[type];
  }

  protected width(shape: CardShape): string {
    return WIDTH_FOR[shape];
  }

  /** New arrivals mixes kinds: albums are square, the rest are posters. */
  protected arrivalShape(tile: Tile): CardShape {
    return tile.kind === 'album' ? 'square' : 'poster';
  }

  protected sectionHeading(type: MediaType, name: string): string {
    return name || this.i18n.t(MEDIA_TYPE_NAV_KEY[type]);
  }
}
