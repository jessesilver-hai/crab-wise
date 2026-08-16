// Pure helpers for the 3D renderer. No three.js imports: keeps color math
// testable and avoids accidental scene coupling.
import type { DistrictArchetype } from "@agent-empires/protocol";

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mix a color toward white so it works as a subtle multiply tint. */
export function soften(color: number, keep = 0.35): number {
  const ch = (c: number) => Math.round(255 - (255 - c) * keep);
  return (ch((color >> 16) & 0xff) << 16) | (ch((color >> 8) & 0xff) << 8) | ch(color & 0xff);
}

/** Parse "#rrggbb" → number; undefined when malformed. */
export function hexColor(s: string | undefined): number | undefined {
  if (!s || !/^#[0-9a-fA-F]{6}$/.test(s)) return undefined;
  return parseInt(s.slice(1), 16);
}

export function cssHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function mixColor(a: number, b: number, t: number): number {
  const ch = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t);
  return (
    (ch((a >> 16) & 0xff, (b >> 16) & 0xff) << 16) |
    (ch((a >> 8) & 0xff, (b >> 8) & 0xff) << 8) |
    ch(a & 0xff, b & 0xff)
  );
}

export function scaleColor(color: number, f: number): number {
  const ch = (c: number) => Math.max(0, Math.min(255, Math.round(c * f)));
  return (ch((color >> 16) & 0xff) << 16) | (ch((color >> 8) & 0xff) << 8) | ch(color & 0xff);
}

/** First meaningful word of a villager name ("Ashka the Mason" → "Ashka"). */
export function shortName(name: string): string {
  const words = name.split(" ");
  const first = words[0] ?? name;
  return /^(the|a|an|of)$/i.test(first) && words[1] ? words[1] : first;
}

/** District ground tints per archetype (softened before painting). */
export const ARCH_TINT: Record<DistrictArchetype, number> = {
  quarter: 0x8a9a5b, // olive commons
  proving: 0xa0785a, // trampled clay
  scriptorium: 0x7a8fa6, // slate blue
  granary: 0xc2a05a, // wheat gold
  watchtower: 0x8a8a92, // cold stone
  forge: 0x9a6a4a, // rust and soot
  bazaar: 0xb07a9a, // dyed cloth
};
