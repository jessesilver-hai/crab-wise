// Pure color guards for LLM-authored palettes. No Phaser imports: the logic
// battery exercises this in plain node.

/**
 * A WorldSpec palette may be arbitrarily dark ("ink" themes); the world must
 * stay visible regardless. Scales a too-dark color up to a luminance floor,
 * preserving hue; pure black becomes a neutral night blue.
 */
export function visibleFloor(color: number, min = 0x2a): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const m = Math.max(r, g, b);
  if (m >= min) return color;
  if (m === 0) return (min << 16) | (min << 8) | Math.min(255, min + 9);
  const f = min / m;
  const ch = (c: number) => Math.min(255, Math.round(c * f));
  return (ch(r) << 16) | (ch(g) << 8) | ch(b);
}
