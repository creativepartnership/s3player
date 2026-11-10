/** Geometry for D-pad ("spatial") navigation, kept free of the DOM so it
 * can be unit-tested: given where focus is and where everything focusable
 * is, which one does an arrow key go to? */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How much a sideways offset counts against a candidate, relative to the
 * distance along the arrow's direction. Higher keeps moves in "lanes"
 * (rows, columns) instead of jumping diagonally to something nearer. */
const OFF_AXIS_WEIGHT = 3;
/** Overlap tolerance in px, so items that touch or barely overlap still
 * count as being in that direction. */
const EPSILON = 2;

/** Index of the best candidate in `direction` from `from`, or -1.
 *
 * Up/down work row by row, as on TV interfaces: first the nearest row in
 * that direction, then, within it, the item most in line with this one.
 * Left/right take the nearest item in that direction, preferring the same
 * row. */
export function pickNext(from: Box, direction: Direction, candidates: Box[]): number {
  if (direction === 'up' || direction === 'down') {
    return pickVertical(from, direction, candidates);
  }
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((box, index) => {
    const score = scoreCandidate(from, direction, box);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** Items whose start is within this many px of the nearest one count as
 * the same row (cards with different heights, a title link above). */
const ROW_TOLERANCE = 16;

function pickVertical(from: Box, direction: 'up' | 'down', candidates: Box[]): number {
  const gap = (to: Box) => (direction === 'down' ? to.top - from.bottom : from.top - to.bottom);
  const a = center(from);
  const ahead = candidates
    .map((box, index) => ({ box, index }))
    .filter(({ box }) => {
      const b = center(box);
      return direction === 'down' ? b.y > a.y + EPSILON && box.bottom > from.bottom : b.y < a.y - EPSILON && box.top < from.top;
    });
  if (ahead.length === 0) {
    return -1;
  }
  const nearest = Math.min(...ahead.map(({ box }) => Math.max(0, gap(box))));
  const row = ahead.filter(({ box }) => Math.max(0, gap(box)) <= nearest + ROW_TOLERANCE);
  let best = -1;
  let bestScore = Infinity;
  for (const { box, index } of row) {
    // Horizontal distance between the two boxes (0 if they overlap), then
    // how well their left edges line up.
    const sideways = Math.max(0, box.left - from.right, from.left - box.right);
    const score = sideways * 10 + Math.abs(box.left - from.left);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

function scoreCandidate(from: Box, direction: Direction, to: Box): number {
  const a = center(from);
  const b = center(to);
  const horizontal = direction === 'left' || direction === 'right';
  // Has to lie in that direction: its centre beyond ours, and its far edge
  // beyond our far edge (so a big box we're inside doesn't count).
  const ahead =
    direction === 'right' ? b.x > a.x + EPSILON && to.right > from.right
    : direction === 'left' ? b.x < a.x - EPSILON && to.left < from.left
    : direction === 'down' ? b.y > a.y + EPSILON && to.bottom > from.bottom
    : b.y < a.y - EPSILON && to.top < from.top;
  if (!ahead) {
    return Infinity;
  }
  const along = Math.max(
    0,
    direction === 'right' ? to.left - from.right
    : direction === 'left' ? from.left - to.right
    : direction === 'down' ? to.top - from.bottom
    : from.top - to.bottom,
  );
  const overlap = horizontal
    ? Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)
    : Math.min(from.right, to.right) - Math.max(from.left, to.left);
  // In the same row/column: only the distance matters. Otherwise penalise
  // the sideways offset; for up/down also accept left edges lining up
  // (posters under a wide button).
  const offAxis = overlap > 0
    ? 0
    : horizontal
      ? Math.abs(a.y - b.y)
      : Math.min(Math.abs(a.x - b.x), Math.abs(from.left - to.left));
  // Ties (several items overlapping a wide one): prefer the one lined up
  // with our start edge / centre line.
  const tieBreak = horizontal ? Math.abs(a.y - b.y) : Math.abs(from.left - to.left);
  return along + offAxis * OFF_AXIS_WEIGHT + tieBreak * 0.01;
}

function center(box: Box): { x: number; y: number } {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}
