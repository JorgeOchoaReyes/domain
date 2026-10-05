/** Darts: the board's numbers, clockwise from the top, and where a dart scores. */

export const DART_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

/** A dart's score at (dx, dy) from the center, as fractions of the board's radius. */
export function dartScore(dx: number, dy: number): number {
  const r = Math.hypot(dx, dy);
  if (r <= 0.037) return 50;
  if (r <= 0.094) return 25;
  if (r > 1) return 0;
  // 20 is at the top; segments run clockwise.
  const ang = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const seg = DART_ORDER[Math.floor((((ang + 9) % 360) + 360) % 360 / 18)];
  if (r >= 0.58 && r <= 0.63) return seg * 3;
  if (r >= 0.95) return seg * 2;
  return seg;
}
