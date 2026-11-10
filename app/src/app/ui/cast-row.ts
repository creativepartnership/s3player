import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CastMember, MediaInfo } from '../core/db/schema';
import { TranslatePipe } from '../core/i18n/i18n.service';

/** Cast with photos (TMDb profile images, loaded straight from TMDb's CDN —
 * they're public), plus director/creators and genres. */
@Component({
  selector: 's3-cast-row',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-6' },
  template: `
    @if (cast().length) {
      <section class="flex flex-col gap-3" aria-labelledby="cast-heading">
        <h2 id="cast-heading" class="font-display px-[var(--s3-gutter)] text-[22px] font-semibold sm:text-2xl">{{ 'detail.cast' | t }}</h2>
        <ul class="s3-row flex gap-5 overflow-x-auto px-[var(--s3-gutter)] pt-2 pb-4">
          @for (person of cast(); track person.name + $index) {
            <li class="flex w-[112px] flex-none flex-col items-center gap-2 text-center">
              <span class="relative flex h-[104px] w-[104px] items-center justify-center overflow-hidden rounded-full bg-[var(--s3-surface)] text-2xl font-bold text-[var(--s3-text-muted)]">
                {{ initials(person.name) }}
                @if (person.profileUrl) {
                  <img [src]="person.profileUrl" alt="" loading="lazy" class="absolute inset-0 h-full w-full object-cover" />
                }
              </span>
              <span class="line-clamp-2 text-sm leading-tight font-semibold">{{ person.name }}</span>
              @if (person.character) {
                <span class="-mt-1 line-clamp-2 text-xs leading-tight text-[var(--s3-text-muted)]">{{ person.character }}</span>
              }
            </li>
          }
        </ul>
      </section>
    }
    @if (facts().length) {
      <dl class="s3-cast-facts flex flex-wrap gap-x-12 gap-y-4 px-[var(--s3-gutter)]">
        @for (fact of facts(); track fact.label) {
          <div class="flex flex-col gap-1">
            <dt class="text-xs font-semibold tracking-wider text-[var(--s3-text-muted)] uppercase">{{ fact.label | t }}</dt>
            <dd class="text-[15px]">{{ fact.value }}</dd>
          </div>
        }
      </dl>
    }
  `,
})
export class CastRow {
  readonly info = input<MediaInfo | null | undefined>(null);

  protected readonly cast = computed<CastMember[]>(() => {
    const info = this.info();
    return (info?.castMembers ?? info?.cast?.map((name) => ({ name })) ?? []).slice(0, 20);
  });

  protected readonly facts = computed(() => {
    const info = this.info();
    const facts: { label: 'detail.director' | 'detail.creators' | 'detail.genres'; value: string }[] = [];
    if (info?.director) facts.push({ label: 'detail.director', value: info.director });
    if (info?.creators?.length) facts.push({ label: 'detail.creators', value: info.creators.join(', ') });
    if (info?.genres?.length) facts.push({ label: 'detail.genres', value: info.genres.join(', ') });
    return facts;
  });

  protected initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase();
  }
}
