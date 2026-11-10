import { Box, pickNext } from './spatial-nav';

const box = (left: number, top: number, w = 100, h = 150): Box => ({ left, top, right: left + w, bottom: top + h });

describe('pickNext (D-pad navigation)', () => {
  // A row of posters, a second row below, a rail on the left.
  const rail = [box(0, 0, 80, 60), box(0, 70, 80, 60), box(0, 140, 80, 60)];
  const row1 = [box(120, 0), box(240, 0), box(360, 0)];
  const row2 = [box(120, 200), box(240, 200), box(360, 200)];
  const all = [...rail, ...row1, ...row2];

  it('moves along a row', () => {
    expect(all[pickNext(row1[0], 'right', all)]).toBe(row1[1]);
    expect(all[pickNext(row1[2], 'right', all)]).toBeUndefined();
  });

  it('moves straight down to the card in the same column', () => {
    // (The service only looks within the same part of the screen first, so
    // the rail isn't a candidate for up/down from the content.)
    const content = [...row1, ...row2];
    expect(content[pickNext(row1[1], 'down', content)]).toBe(row2[1]);
    expect(content[pickNext(row2[2], 'up', content)]).toBe(row1[2]);
  });

  it('goes from the first card into the rail, at the nearest height', () => {
    expect(all[pickNext(row2[0], 'left', all)]).toBe(rail[2]);
    expect(all[pickNext(row1[0], 'left', all)]).toBe(rail[1]); // centre 75 vs 100
  });

  it('goes from the rail back into the content', () => {
    expect(all[pickNext(rail[0], 'right', all)]).toBe(row1[0]);
  });

  it('from a wide button, down picks the card under its left edge', () => {
    const button = box(120, -100, 400, 50);
    const list = [button, ...row1];
    expect(list[pickNext(button, 'down', list)]).toBe(row1[0]);
  });

  it('finds nothing beyond the edge', () => {
    expect(pickNext(row1[0], 'up', all)).toBe(-1);
  });
});

describe('pickNext, row by row', () => {
  it('goes from a button to the nearer row of tabs before the episodes', () => {
    const play = box(432, 562, 187, 54);
    const tabs = [box(152, 706, 111, 44), box(273, 706, 113, 44)];
    const episodes = [box(152, 794, 406, 119), box(576, 794, 406, 119)];
    const list = [play, ...tabs, ...episodes];
    // Nearest row is the tabs; of those, the one closest sideways.
    expect(list[pickNext(play, 'down', list)]).toBe(tabs[1]);
    expect(list[pickNext(tabs[0], 'down', list)]).toBe(episodes[0]);
    expect(list[pickNext(episodes[1], 'up', list)]).toBe(tabs[1]);
  });
});
