/** Converts SubRip (.srt) subtitle text to WebVTT — the only subtitle format
 * HTML5 <track> elements can render. Comma millisecond separators become dots
 * and a WEBVTT header is prepended; cue numbering/text otherwise carries over
 * unchanged since VTT's cue syntax is a superset of SRT's. */
export function srtToVtt(srtText: string): string {
  const body = srtText.replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body.trim()}\n`;
}
