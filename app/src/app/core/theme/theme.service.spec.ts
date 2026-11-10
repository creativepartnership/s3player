import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaDbService } from '../db/media-db.service';
import { I18nService } from '../i18n/i18n.service';
import { DeviceKind, DeviceService } from './device.service';
import { DEFAULT_THEME_SETTING_KEY, ThemeService } from './theme.service';

// Node's test environment has no usable localStorage: give it an in-memory one.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, String(v)),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
  },
});

describe('ThemeService', () => {
  const settings = new Map<string, string>();
  const kind = signal<DeviceKind>('desktop');
  const version = signal(0);

  function setup(): ThemeService {
    TestBed.configureTestingModule({
      providers: [
        { provide: DeviceService, useValue: { kind } },
        {
          provide: MediaDbService,
          useValue: {
            ready: signal(true),
            version,
            getSetting: (key: string) => settings.get(key) ?? null,
            setSetting: async (key: string, value: string) => {
              settings.set(key, value);
              version.update((v) => v + 1);
            },
          },
        },
      ],
    });
    return TestBed.inject(ThemeService);
  }

  beforeEach(() => {
    localStorage.clear();
    settings.clear();
    kind.set('desktop');
  });

  it('defaults to Aurora, then the admin default, then this device’s own choice', async () => {
    const service = setup();
    expect(service.theme()).toBe('aurora');

    await service.setDefault('proiezione');
    expect(settings.get(DEFAULT_THEME_SETTING_KEY)).toBe('proiezione');
    expect(service.theme()).toBe('proiezione');

    service.set('vetro');
    expect(service.theme()).toBe('vetro');
    expect(localStorage.getItem('s3player.theme')).toBe('vetro');
  });

  it('ignores the old light/dark values', () => {
    localStorage.setItem('s3player.theme', 'dark');
    expect(setup().theme()).toBe('aurora');
  });

  it('adapts the theme layout to phones and TVs', () => {
    const service = setup();
    service.set('vetro');
    expect(service.layout()).toEqual({ nav: 'glass', captions: 'focus', hero: 'full' });

    kind.set('phone');
    expect(service.layout().nav).toBe('bottom');

    kind.set('tv');
    expect(service.layout()).toEqual({ nav: 'glass', captions: 'always', hero: 'full' });
  });

  it('exposes the theme and layout on <html>', () => {
    const service = setup();
    service.set('aurora');
    TestBed.tick();
    const root = document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('s3player-aurora');
    expect(root.getAttribute('data-nav')).toBe('rail');
    expect(root.getAttribute('data-device')).toBe('desktop');
  });
});

describe('I18nService', () => {
  beforeEach(() => localStorage.clear());

  it('translates, fills placeholders and remembers the choice', () => {
    const i18n = TestBed.inject(I18nService);
    i18n.set('it');
    expect(i18n.t('nav.shows')).toBe('Serie TV');
    i18n.set('en');
    expect(i18n.t('nav.shows')).toBe('TV shows');
    TestBed.tick();
    expect(localStorage.getItem('s3player.lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
