/** The visual themes. Colors, fonts, radii, glass and glow live in CSS
 * (styles.css, one block per theme); what lives here are the few STRUCTURAL
 * choices a theme makes, which components read to pick a layout variant. */
export type ThemeId = 'aurora' | 'vetro' | 'proiezione';

export interface ThemeLayout {
  /** Where the main navigation sits on a computer: a top bar, a vertical
   * icon rail on the left, or a floating glass pill centered at the top. */
  nav: 'top' | 'rail' | 'glass';
  /** Card titles under posters: always shown, or only for the focused card. */
  captions: 'always' | 'focus';
  /** Home hero: edge-to-edge backdrop, or a rounded card inside the page. */
  hero: 'full' | 'card';
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  layout: ThemeLayout;
}

export const THEMES: ThemeDefinition[] = [
  { id: 'aurora', name: 'Aurora', layout: { nav: 'rail', captions: 'always', hero: 'card' } },
  { id: 'vetro', name: 'Vetro', layout: { nav: 'glass', captions: 'focus', hero: 'full' } },
  { id: 'proiezione', name: 'Proiezione', layout: { nav: 'top', captions: 'always', hero: 'full' } },
];

export const DEFAULT_THEME: ThemeId = 'aurora';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function themeById(id: ThemeId): ThemeDefinition {
  return THEMES.find((t) => t.id === id)!;
}
