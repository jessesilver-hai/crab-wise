// Shared terrain-height law for the 3D engine: map.heights (0..5 levels)
// becomes world-space elevation. Everything that stands on the ground —
// buildings, walls, props, units, markers, the veil — asks this module so
// terraces, ring cores and canyon strata read as one coherent landform.
import type { MapLayout } from "../game/map.js";

/** World units one terrain level lifts the ground (tile = 1 unit). */
export const ELEV = 0.35;

/** Integer terrain level at a (possibly fractional) world position. */
export function levelAt(map: MapLayout, x: number, z: number): number {
  const tx = Math.round(x);
  const ty = Math.round(z);
  const key = `${tx},${ty}`;
  if (map.water.has(key)) return 0; // water is never raised, by law
  return map.heights.get(key) ?? 0;
}

/** World-space ground height (y) at a position. */
export function heightAt(map: MapLayout, x: number, z: number): number {
  return levelAt(map, x, z) * ELEV;
}
