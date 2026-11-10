import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { ArtworkService } from '../core/media/artwork.service';

/** A deterministic hue per title, so artwork-less items still look
 * distinct (and look the same every time). */
function hueOf(text: string): number {
  let hash = 0;
  for (const ch of text) {
    hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  }
  return Math.abs(hash) % 360;
}

/** The image's dominant color, as "r g b": the average of its pixels,
 * weighted towards saturated, mid-bright ones (so a poster's black bars or
 * white title don't win). Undefined if the canvas can't read the image. */
function dominantColor(img: HTMLImageElement): string | undefined {
  try {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return undefined;
    }
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [pr, pg, pb] = [data[i], data[i + 1], data[i + 2]];
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const brightness = max / 255;
      const weight = 0.05 + saturation * (1 - Math.abs(brightness - 0.6));
      r += pr * weight;
      g += pg * weight;
      b += pb * weight;
      total += weight;
    }
    return `${Math.round(r / total)} ${Math.round(g / total)} ${Math.round(b / total)}`;
  } catch {
    return undefined; // tainted canvas (no CORS): just no glow
  }
}

/** Artwork from the media bucket: fades in once loaded, measures its own
 * color into --art-rgb (themes use it for the glow under posters), and
 * until then — or if there's no artwork at all — shows a gradient with the
 * title on it. Size and shape come from the host's classes. */
@Component({
  selector: 's3-art',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 's3-art block overflow-hidden',
    '[style.--art-rgb]': 'rgb()',
    '[style.background]': 'fallback()',
  },
  template: `
    @if (!loaded() && showTitle()) {
      <span aria-hidden="true" class="font-display absolute inset-x-[8%] bottom-[8%] line-clamp-3 text-[clamp(14px,1.1em,24px)] leading-none font-bold text-white/90">
        {{ title() }}
      </span>
    }
    @if (url(); as src) {
      <img
        [src]="src"
        [alt]="alt()"
        crossorigin="anonymous"
        [attr.loading]="eager() ? 'eager' : 'lazy'"
        decoding="async"
        class="absolute inset-0 h-full w-full object-cover transition-opacity duration-500"
        [class.opacity-0]="!loaded()"
        [style.object-position]="position()"
        (load)="onLoad($event)"
        (error)="failed.set(true)"
      />
    }
    <ng-content />
  `,
})
export class ArtImage {
  private readonly artwork = inject(ArtworkService);

  readonly key = input<string | null | undefined>(null);
  readonly title = input('');
  /** Empty for decorative artwork next to its own visible title. */
  readonly alt = input('');
  readonly eager = input(false);
  readonly showTitle = input(true);
  readonly position = input('center');

  // All reset when the key changes (the same component showing new art).
  protected readonly loaded = linkedSignal({ source: this.key, computation: () => false });
  protected readonly failed = linkedSignal({ source: this.key, computation: () => false });
  private readonly measured = linkedSignal<string | null | undefined, string | undefined>({ source: this.key, computation: () => undefined });

  protected readonly url = computed(() => (this.failed() ? undefined : this.artwork.url(this.key())));

  protected readonly rgb = computed(() => {
    const key = this.key();
    const fromCache = key ? this.artwork.color(key) : undefined;
    const measured = this.measured() ?? fromCache;
    if (measured) {
      return measured;
    }
    // Before (or without) the image: the fallback gradient's own color.
    const [r, g, b] = hslToRgb(hueOf(this.title()), 0.45, 0.42);
    return `${r} ${g} ${b}`;
  });

  protected readonly fallback = computed(() => {
    const hue = hueOf(this.title());
    return `linear-gradient(160deg, oklch(26% 0.09 ${hue}), oklch(48% 0.14 ${(hue + 40) % 360}) 60%, oklch(70% 0.12 ${(hue + 70) % 360}))`;
  });

  protected onLoad(event: Event): void {
    this.loaded.set(true);
    const key = this.key();
    if (!key || this.artwork.color(key)) {
      return;
    }
    const color = dominantColor(event.target as HTMLImageElement);
    if (color) {
      this.artwork.rememberColor(key, color);
      this.measured.set(color);
    }
  }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
