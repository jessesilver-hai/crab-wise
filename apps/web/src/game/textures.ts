import Phaser from "phaser";
import type { Primitive, WorldSpec } from "@agent-empires/protocol";
import { TILE_W, TILE_H } from "./map.js";

/**
 * Procedural canvas textures that complement the sprite atlases: fog blobs,
 * sky gradients, WorldSpec silhouettes (props / landmarks / quest hooks),
 * ambient particles, and small UI/FX marks. Structures, terrain, and units
 * come from the pixel sheets in atlas.ts.
 */

/** Canvases are drawn at 2x and displayed at 0.5 scale for crispness. */
export const TEX_RES = 2;
export const TEX_SCALE = 1 / TEX_RES;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

function css(color: number, alpha = 1): string {
  const hex = (color & 0xffffff).toString(16).padStart(6, "0");
  if (alpha >= 1) return `#${hex}`;
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** "#rrggbb" → numeric color; undefined when malformed. */
import { visibleFloor } from "./palette";

export function hexColor(s: string): number | undefined {
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return undefined;
  return parseInt(s.slice(1), 16);
}

/** Multiply a color's channels by `f` (>1 lightens, <1 darkens). */
export function shade(color: number, f: number): number {
  const ch = (n: number) => Math.max(0, Math.min(255, Math.round(n * f)));
  return (ch((color >> 16) & 0xff) << 16) | (ch((color >> 8) & 0xff) << 8) | ch(color & 0xff);
}

function canvasTexture(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (ctx: Ctx) => void,
): string {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * TEX_RES);
  canvas.height = Math.ceil(h * TEX_RES);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(TEX_RES, TEX_RES);
  draw(ctx);
  scene.textures.addCanvas(key, canvas);
  return key;
}

function poly(ctx: Ctx, points: [number, number][], fill: string): void {
  ctx.beginPath();
  ctx.moveTo(points[0]![0], points[0]![1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i]![0], points[i]![1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function groundShadow(ctx: Ctx, rx: number, ry: number, alpha = 0.3): void {
  ctx.beginPath();
  ctx.ellipse(0, 1, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = css(0x000000, alpha);
  ctx.fill();
}

function circle(ctx: Ctx, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function ring(ctx: Ctx, x: number, y: number, rx: number, ry: number, stroke: string, width: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Terrain: per-tile ground stamping now lives in ground.ts (painterly canvas);
// only the fog-of-war blob remains here. Fog blobs are soft ellipses that are
// placed per tile but overlap heavily, so the unexplored area reads as one
// organic cloud rather than a diamond grid.
// ---------------------------------------------------------------------------

export function fogTexture(scene: Phaser.Scene, color: number, gen: number): string {
  const w = TILE_W * 1.8;
  const h = TILE_H * 1.8;
  return canvasTexture(scene, `g${gen}-fog`, w, h, (ctx) => {
    ctx.translate(w / 2, h / 2);
    ctx.save();
    ctx.scale(1, h / w);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
    grad.addColorStop(0, css(color, 1));
    grad.addColorStop(0.55, css(color, 0.96));
    grad.addColorStop(1, css(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(-w / 2, -w / 2, w, w);
    ctx.restore();
  });
}

// ---------------------------------------------------------------------------
// WorldSpec interpretation — bounded LLM data composed by fixed code
// ---------------------------------------------------------------------------

/**
 * Draw one primitive with its base at the current origin (y grows downward;
 * structures rise into negative y). Tilt rotates around the base point.
 */
function drawPrimitive(ctx: Ctx, prim: Primitive): void {
  const c = hexColor(prim.color) ?? 0x8d8577;
  const { w, h } = prim;
  ctx.save();
  ctx.rotate((prim.tilt * Math.PI) / 180);
  switch (prim.shape) {
    case "slab": {
      ctx.fillStyle = css(c);
      ctx.fillRect(-w / 2, -h, w, h);
      ctx.fillStyle = css(shade(c, 0.76));
      ctx.fillRect(w / 6, -h, w / 3, h);
      ctx.fillStyle = css(shade(c, 1.24));
      ctx.fillRect(-w / 2, -h, w, Math.max(1, h * 0.08));
      break;
    }
    case "obelisk": {
      poly(ctx, [[-w / 2, 0], [-w * 0.18, -h], [w * 0.18, -h], [w / 2, 0]], css(c));
      poly(ctx, [[0, -h], [w * 0.18, -h], [w / 2, 0], [0, 0]], css(shade(c, 0.74)));
      poly(ctx, [[-w * 0.18, -h], [w * 0.18, -h], [0, -h - Math.max(2, w * 0.2)]], css(shade(c, 1.28)));
      break;
    }
    case "arch": {
      const t = Math.max(2, w * 0.18);
      const r = w / 2 - t / 2;
      ctx.strokeStyle = css(c);
      ctx.lineWidth = t;
      ctx.beginPath();
      ctx.moveTo(-w / 2 + t / 2, 0);
      ctx.lineTo(-w / 2 + t / 2, -Math.max(0, h - w / 2));
      ctx.arc(0, -Math.max(0, h - w / 2), r, Math.PI, 0);
      ctx.lineTo(w / 2 - t / 2, 0);
      ctx.stroke();
      break;
    }
    case "mast": {
      const t = Math.max(1.5, w * 0.12);
      ctx.fillStyle = css(c);
      ctx.fillRect(-t / 2, -h, t, h);
      ctx.fillStyle = css(shade(c, 1.12));
      ctx.fillRect(-w / 2, -h * 0.78, w, Math.max(1.2, t * 0.8));
      circle(ctx, 0, -h, Math.max(1.2, t * 0.7), css(shade(c, 1.4)));
      break;
    }
    case "orb": {
      ctx.beginPath();
      ctx.ellipse(0, -h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = css(c);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(-w * 0.14, -h * 0.62, w * 0.16, h * 0.14, 0, 0, Math.PI * 2);
      ctx.fillStyle = css(shade(c, 1.4), 0.6);
      ctx.fill();
      break;
    }
    case "shard": {
      poly(ctx, [[-w / 2, 0], [0, -h], [w / 2, 0]], css(c));
      poly(ctx, [[0, -h], [w / 2, 0], [0, 0]], css(shade(c, 0.7)));
      break;
    }
    case "frond": {
      const blades = 5;
      ctx.lineWidth = Math.max(1, w * 0.08);
      for (let i = 0; i < blades; i++) {
        const f = i / (blades - 1) - 0.5; // -0.5..0.5 fan position
        ctx.strokeStyle = css(shade(c, 0.85 + Math.abs(f) * 0.5));
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(f * w * 0.4, -h * 0.62, f * w, -h * (1 - Math.abs(f) * 0.4));
        ctx.stroke();
      }
      break;
    }
    case "coil": {
      const t = Math.max(2, w * 0.28);
      ctx.strokeStyle = css(c);
      ctx.lineWidth = t;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      const segs = 4;
      for (let i = 1; i <= segs; i++) {
        const y = (-h * i) / segs;
        const x = (i % 2 === 0 ? -1 : 1) * (w / 2 - t / 2);
        ctx.quadraticCurveTo(x, y + h / (segs * 2), i === segs ? 0 : x * 0.4, y);
      }
      ctx.stroke();
      circle(ctx, 0, -h, t * 0.7, css(shade(c, 1.3)));
      break;
    }
    case "ring": {
      ring(ctx, 0, -h / 2, w / 2, h / 2, css(c), Math.max(2, Math.min(w, h) * 0.14));
      break;
    }
    case "beam": {
      const grad = ctx.createLinearGradient(0, -h, 0, 0);
      grad.addColorStop(0, css(c, 0));
      grad.addColorStop(0.35, css(c, 0.28));
      grad.addColorStop(1, css(c, 0.5));
      ctx.fillStyle = grad;
      ctx.fillRect(-w / 2, -h, w, h);
      ctx.fillStyle = css(shade(c, 1.3), 0.55);
      ctx.fillRect(-w / 6, -h, w / 3, h);
      break;
    }
  }
  ctx.restore();
}

/**
 * Compose a silhouette's primitives, side by side at the ground, into a
 * texture. Used for WorldSpec props and DistrictPatch landmarks alike.
 */
export function silhouetteTexture(
  scene: Phaser.Scene,
  key: string,
  prims: Primitive[],
  glow?: { color: string },
): string {
  const spread = prims.length > 1 ? prims.reduce((s, p) => s + p.w, 0) * 0.62 : 0;
  const maxW = Math.max(...prims.map((p) => p.w));
  const maxH = Math.max(...prims.map((p) => p.h));
  const w = Math.min(128, Math.max(44, spread + maxW + 24));
  const h = Math.min(104, maxH + 22);
  // positions across the cluster; primitives overlap slightly like a rock pile
  let cursor = -spread / 2;
  const xs = prims.map((p) => {
    if (prims.length === 1) return 0;
    const x = cursor + p.w * 0.31;
    cursor += p.w * 0.62;
    return x;
  });
  let tallest = 0;
  prims.forEach((p, i) => {
    if (p.h > (prims[tallest]?.h ?? 0)) tallest = i;
  });
  return canvasTexture(scene, key, w, h, (ctx) => {
    ctx.translate(w / 2, h - 4);
    groundShadow(ctx, Math.max(7, (spread + maxW) / 2.6), 3.2);
    prims.forEach((p, i) => {
      ctx.save();
      ctx.translate(xs[i]!, 0);
      drawPrimitive(ctx, p);
      ctx.restore();
    });
    if (glow) {
      const g = hexColor(glow.color) ?? 0xe3b264;
      const gx = xs[tallest]!;
      const gy = -maxH - 3;
      circle(ctx, gx, gy, 2.2, css(g, 0.95));
      ring(ctx, gx, gy, 4.6, 4.6, css(g, 0.35), 1);
    }
  });
}

/** Vertical sky gradient from a WorldSpec: top → horizon → haze. */
export function specSkyTexture(scene: Phaser.Scene, sky: WorldSpec["sky"], gen: number): string {
  const top = visibleFloor(hexColor(sky.top) ?? 0x2a2118, 0x22);
  const horizon = visibleFloor(hexColor(sky.horizon) ?? 0x2a2118, 0x22);
  return canvasTexture(scene, `g${gen}-sky`, 16, 160, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, css(top, 0.95));
    grad.addColorStop(0.6, css(horizon, 0.75));
    grad.addColorStop(1, css(horizon, Math.min(0.8, sky.hazeAlpha * 1.6)));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 160);
  });
}

/** Horizon gradient fixed to the top of the viewport (skyline tint). */
export function skyTexture(scene: Phaser.Scene, color: number, gen: number): string {
  return canvasTexture(scene, `g${gen}-sky`, 16, 160, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, css(color, 0.9));
    grad.addColorStop(1, css(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 160);
  });
}

/** Shared ambient-particle textures (tinted per archetype at spawn). */
export function particleTextures(scene: Phaser.Scene): { soft: string; mist: string; streak: string } {
  const soft = canvasTexture(scene, "fx-soft", 24, 24, (ctx) => {
    const grad = ctx.createRadialGradient(12, 12, 0, 12, 12, 12);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 24, 24);
  });
  const mist = canvasTexture(scene, "fx-mist", 96, 96, (ctx) => {
    const grad = ctx.createRadialGradient(48, 48, 0, 48, 48, 48);
    grad.addColorStop(0, "rgba(255,255,255,0.9)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 96, 96);
  });
  const streak = canvasTexture(scene, "fx-streak", 28, 6, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 28, 0);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 1, 28, 4);
  });
  return { soft, mist, streak };
}

/** Elliptical drop shadow shared by all units (static key). */
export function shadowTexture(scene: Phaser.Scene): string {
  if (scene.textures.exists("fx-shadow")) return "fx-shadow";
  return canvasTexture(scene, "fx-shadow", 36, 16, (ctx) => {
    ctx.translate(18, 8);
    ctx.save();
    ctx.scale(1, 16 / 36);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
    grad.addColorStop(0, "rgba(0,0,0,0.42)");
    grad.addColorStop(0.7, "rgba(0,0,0,0.22)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(-18, -18, 36, 36);
    ctx.restore();
  });
}

/** Small rolled parchment for scroll-authored fanfare (static key). */
export function parchmentTexture(scene: Phaser.Scene): string {
  if (scene.textures.exists("fx-scroll")) return "fx-scroll";
  return canvasTexture(scene, "fx-scroll", 26, 20, (ctx) => {
    ctx.translate(13, 10);
    ctx.fillStyle = css(0xe8d9b0);
    ctx.fillRect(-9, -6, 18, 12);
    ctx.strokeStyle = css(0x5a4527);
    ctx.lineWidth = 1;
    ctx.strokeRect(-9, -6, 18, 12);
    // rolled ends
    ctx.fillStyle = css(0xd4c294);
    ctx.beginPath();
    ctx.ellipse(-9, 0, 2.6, 6.5, 0, 0, Math.PI * 2);
    ctx.ellipse(9, 0, 2.6, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = css(0x5a4527, 0.8);
    ctx.stroke();
    // faint script lines
    ctx.strokeStyle = css(0x7a6a48, 0.8);
    ctx.lineWidth = 0.8;
    for (const y of [-3, -0.5, 2]) {
      ctx.beginPath();
      ctx.moveTo(-5.5, y);
      ctx.lineTo(5.5, y);
      ctx.stroke();
    }
  });
}

/** Half-buried obelisk marker for quest hooks, tinted per district accent. */
export function hookMarkerTexture(scene: Phaser.Scene, key: string, accent: number): string {
  return canvasTexture(scene, key, 40, 56, (ctx) => {
    ctx.translate(20, 50);
    groundShadow(ctx, 9, 3.4);
    // rubble mound it juts from
    ctx.beginPath();
    ctx.ellipse(0, -1, 10, 4.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = css(0x4c463c);
    ctx.fill();
    ctx.save();
    ctx.rotate(-0.14);
    poly(ctx, [[-5, 2], [-3, -26], [0, -30], [3, -27], [5, 2]], css(0x6a6154));
    poly(ctx, [[0, -30], [3, -27], [5, 2], [0, 2]], css(0x524b40));
    // etched sigils
    ctx.fillStyle = css(accent, 0.9);
    ctx.fillRect(-0.8, -24, 1.6, 4);
    ctx.fillRect(-0.8, -17, 1.6, 2.6);
    circle(ctx, 0, -27.5, 1.8, css(accent, 0.95));
    ctx.restore();
    // soft glow halo around the tip
    const grad = ctx.createRadialGradient(-2, -30, 0, -2, -30, 11);
    grad.addColorStop(0, css(accent, 0.4));
    grad.addColorStop(1, css(accent, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(-13, -41, 22, 22);
  });
}

/** Drop every canvas texture belonging to an older generation. */
export function pruneGeneration(scene: Phaser.Scene, gen: number): void {
  const prefix = `g${gen}-`;
  for (const key of Object.keys(scene.textures.list)) {
    if (key.startsWith(prefix)) scene.textures.remove(key);
  }
}
