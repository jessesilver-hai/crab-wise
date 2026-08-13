import Phaser from "phaser";
import type {
  BuildingSpec,
  PixelSprite,
  Primitive,
  ThemePack,
  WorldProp,
  WorldSpec,
} from "@agent-empires/protocol";
import { TILE_W, TILE_H } from "./map.js";
import type { Archetype } from "./archetypes.js";

/**
 * Default world skin: ancient-future — a civilization so old its technology
 * reads as ritual. All art is drawn procedurally into canvas textures keyed
 * into Phaser's texture manager; a repo's ThemePack overrides pieces with
 * LLM-drawn pixel sprites, and the world archetype decides terrain patterns,
 * prop sets, and glow accents.
 */

/** Canvases are drawn at 2x and displayed at 0.5 scale for crispness. */
export const TEX_RES = 2;
export const TEX_SCALE = 1 / TEX_RES;

/** A WorldSpec prop rendered to a texture plus its placement directives. */
export type SpecProp = {
  tex: string;
  density: number;
  placement: WorldProp["placement"];
  pulseSec: number | null;
};

export type TextureSet = {
  ground: string[];
  fog: string;
  /** Archetype prop variants (monoliths, masts, shards, …). */
  props: string[];
  buildings: Record<string, { built: string; scaffold: string }>;
  wonder: string;
  villager: string;
  king: string;
  raider: string;
  highlight: string;
  /** WorldSpec waterline tile; band of tiles at the map's low corner. */
  water?: string;
  /** WorldSpec props (replace archetype props when present). */
  specProps?: SpecProp[];
};

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

function diamondPath(ctx: Ctx, cx: number, cy: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy);
  ctx.lineTo(cx, cy + h / 2);
  ctx.lineTo(cx - w / 2, cy);
  ctx.closePath();
}

/** Isometric box drawn around a translated origin at the base center. */
function isoBox(
  ctx: Ctx,
  w: number,
  depth: number,
  height: number,
  top: number,
  left: number,
  right: number,
): void {
  const hw = w / 2;
  const hd = depth / 2;
  poly(ctx, [[-hw, -height], [0, hd - height], [0, hd], [-hw, 0]], css(left));
  poly(ctx, [[hw, -height], [0, hd - height], [0, hd], [hw, 0]], css(right));
  poly(ctx, [[0, -hd - height], [hw, -height], [0, hd - height], [-hw, -height]], css(top));
}

/** Thin vertical glow seam on a structure face. */
function seam(ctx: Ctx, x: number, yTop: number, height: number, glow: number, alpha = 0.9): void {
  ctx.fillStyle = css(glow, alpha);
  ctx.fillRect(x - 0.8, yTop, 1.6, height);
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
// Terrain
// ---------------------------------------------------------------------------

function drawTilePattern(ctx: Ctx, arch: Archetype, base: number): void {
  const dark = css(shade(base, 0.78));
  const light = css(shade(base, 1.22));
  const r = Math.random;
  switch (arch.pattern) {
    case "cinder": {
      for (let i = 0; i < 5; i++) {
        circle(ctx, (r() - 0.5) * TILE_W * 0.6, (r() - 0.5) * TILE_H * 0.6, 0.8 + r(), dark);
      }
      if (r() < 0.25) circle(ctx, (r() - 0.5) * 20, (r() - 0.5) * 10, 0.9, css(arch.glow, 0.35));
      break;
    }
    case "wave": {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let i = 0; i < 2; i++) {
        const y = (r() - 0.5) * TILE_H * 0.5;
        ctx.beginPath();
        ctx.moveTo(-14 + r() * 6, y);
        ctx.quadraticCurveTo(0, y - 2 - r() * 2, 14 - r() * 6, y);
        ctx.stroke();
      }
      break;
    }
    case "crack": {
      ctx.strokeStyle = css(shade(base, 0.6));
      ctx.lineWidth = 1;
      const x0 = (r() - 0.5) * 20;
      const y0 = (r() - 0.5) * 8;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + 5 + r() * 5, y0 + (r() - 0.5) * 6);
      ctx.lineTo(x0 + 12 + r() * 6, y0 + (r() - 0.5) * 8);
      ctx.stroke();
      if (r() < 0.3) circle(ctx, x0 + 6, y0, 1, css(arch.glow, 0.45));
      break;
    }
    case "shard": {
      ctx.strokeStyle = light;
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 3; i++) {
        const x = (r() - 0.5) * TILE_W * 0.5;
        const y = (r() - 0.5) * TILE_H * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (r() - 0.5) * 12, y + (r() - 0.5) * 6);
        ctx.stroke();
      }
      break;
    }
    case "moss": {
      for (let i = 0; i < 3; i++) {
        circle(ctx, (r() - 0.5) * TILE_W * 0.55, (r() - 0.5) * TILE_H * 0.55, 1.6 + r() * 2, css(shade(base, 0.82), 0.8));
      }
      if (r() < 0.4) circle(ctx, (r() - 0.5) * 18, (r() - 0.5) * 8, 1, light);
      break;
    }
    case "ripple": {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const y = -TILE_H * 0.3 + i * (TILE_H * 0.3) + (r() - 0.5) * 3;
        ctx.beginPath();
        ctx.arc((r() - 0.5) * 10, y + 8, 10 + r() * 6, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
      break;
    }
  }
}

export function groundTextures(
  scene: Phaser.Scene,
  arch: Archetype,
  colors: number[],
  gen: number,
  tag: string,
): string[] {
  const w = TILE_W + 2;
  const h = TILE_H + 2;
  return colors.map((color, i) =>
    canvasTexture(scene, `g${gen}-${tag}-${i}`, w, h, (ctx) => {
      ctx.translate(w / 2, h / 2);
      diamondPath(ctx, 0, 0, TILE_W, TILE_H);
      ctx.fillStyle = css(color);
      ctx.fill();
      ctx.save();
      diamondPath(ctx, 0, 0, TILE_W, TILE_H);
      ctx.clip();
      drawTilePattern(ctx, arch, color);
      ctx.restore();
      diamondPath(ctx, 0, 0, TILE_W, TILE_H);
      ctx.strokeStyle = css(0x2e2a22, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }),
  );
}

export function fogTexture(scene: Phaser.Scene, color: number, gen: number): string {
  const w = TILE_W + 2;
  const h = TILE_H + 2;
  return canvasTexture(scene, `g${gen}-fog`, w, h, (ctx) => {
    ctx.translate(w / 2, h / 2);
    diamondPath(ctx, 0, 0, TILE_W + 2, TILE_H + 2);
    ctx.fillStyle = css(color);
    ctx.fill();
  });
}

// ---------------------------------------------------------------------------
// Props — per-archetype scatter objects, 3 variants each
// ---------------------------------------------------------------------------

const PROP_W = 56;
const PROP_H = 76;

function drawProp(ctx: Ctx, arch: Archetype, variant: number): void {
  const glow = arch.glow;
  switch (arch.id) {
    case "ash-steppe": {
      groundShadow(ctx, 8, 3);
      if (variant === 0) {
        // standing stone with sigil glow
        poly(ctx, [[-5, 0], [-3, -26], [3, -28], [5, 0]], css(0x4a453d));
        poly(ctx, [[-3, -26], [3, -28], [5, 0], [1, 0]], css(0x3a362f));
        circle(ctx, 0, -18, 1.6, css(glow, 0.8));
      } else if (variant === 1) {
        // taller shard-stone, twin sigils
        poly(ctx, [[-4, 0], [-2, -36], [2, -40], [5, 0]], css(0x504b42));
        poly(ctx, [[-2, -36], [2, -40], [5, 0], [1, 0]], css(0x3e3a33));
        circle(ctx, 0, -30, 1.3, css(glow, 0.8));
        circle(ctx, 0.5, -22, 1.1, css(glow, 0.55));
      } else {
        // leaning slab with bone banner pole
        poly(ctx, [[-8, 0], [-12, -18], [-6, -20], [0, 0]], css(0x46423a));
        ctx.fillStyle = css(0x8d8577);
        ctx.fillRect(5, -30, 1.4, 30);
        poly(ctx, [[6.4, -30], [16, -27], [6.4, -22]], css(0x9a9184, 0.85));
      }
      break;
    }
    case "harbor-citadel": {
      groundShadow(ctx, 8, 3);
      if (variant === 0) {
        // mast with yard and rope
        ctx.fillStyle = css(0x4c443a);
        ctx.fillRect(-1, -42, 2, 42);
        ctx.fillRect(-11, -34, 22, 1.6);
        ctx.strokeStyle = css(0x6d6152, 0.9);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(-11, -33);
        ctx.quadraticCurveTo(-8, -14, 0, 0);
        ctx.moveTo(11, -33);
        ctx.quadraticCurveTo(8, -14, 0, 0);
        ctx.stroke();
        circle(ctx, 0, -43, 1.6, css(glow, 0.9));
      } else if (variant === 1) {
        // mooring bollard with rope loop
        isoBox(ctx, 8, 6, 10, 0x5b5b60, 0x47474d, 0x38383e);
        ring(ctx, 0, -10, 5.5, 2.4, css(0x6d6152), 1.6);
      } else {
        // signal lantern pole
        ctx.fillStyle = css(0x44444a);
        ctx.fillRect(-1, -30, 2, 30);
        circle(ctx, 0, -32, 2.6, css(glow, 0.9));
        ring(ctx, 0, -32, 4.6, 4.6, css(glow, 0.35), 1);
      }
      break;
    }
    case "oracle-forge": {
      groundShadow(ctx, 9, 3.2);
      if (variant === 0) {
        // obsidian slag mound, ember seams
        poly(ctx, [[-12, 0], [-6, -9], [0, -12], [7, -8], [12, 0]], css(0x201c1c));
        poly(ctx, [[0, -12], [7, -8], [12, 0], [3, 0]], css(0x161314));
        ctx.strokeStyle = css(glow, 0.6);
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(-7, -4);
        ctx.lineTo(-2, -8);
        ctx.moveTo(3, -6);
        ctx.lineTo(7, -3);
        ctx.stroke();
      } else if (variant === 1) {
        // obsidian shard cluster
        poly(ctx, [[-9, 0], [-6, -16], [-3, 0]], css(0x231f20));
        poly(ctx, [[-2, 0], [2, -24], [6, 0]], css(0x1a1718));
        poly(ctx, [[5, 0], [9, -12], [12, 0]], css(0x262223));
        ctx.strokeStyle = css(glow, 0.5);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(2, -24);
        ctx.lineTo(4, -6);
        ctx.stroke();
      } else {
        // broken ritual ring
        ctx.strokeStyle = css(0x3c3436);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, -12, 10, Math.PI * 0.85, Math.PI * 2.05);
        ctx.stroke();
        circle(ctx, 0, -12, 1.6, css(glow, 0.85));
      }
      break;
    }
    case "glacier-vault": {
      groundShadow(ctx, 9, 3.2, 0.22);
      if (variant === 0) {
        // ice shard cluster
        poly(ctx, [[-10, 0], [-6, -18], [-2, 0]], css(0xb8d2e2, 0.92));
        poly(ctx, [[-3, 0], [2, -28], [7, 0]], css(0xcfe4f0, 0.92));
        poly(ctx, [[6, 0], [10, -12], [13, 0]], css(0xaac6d8, 0.92));
        ctx.strokeStyle = css(0xffffff, 0.7);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(2, -28);
        ctx.lineTo(4, -4);
        ctx.stroke();
      } else if (variant === 1) {
        // frost-etched pillar
        poly(ctx, [[-4, 0], [-3, -30], [3, -32], [4, 0]], css(0x9db4c2));
        poly(ctx, [[-3, -30], [3, -32], [4, 0], [1, 0]], css(0x84a0b0));
        seam(ctx, 0, -28, 24, glow, 0.6);
      } else {
        // snowdrift with embedded shard
        ctx.beginPath();
        ctx.ellipse(0, -2, 11, 5, 0, 0, Math.PI * 2);
        ctx.fillStyle = css(0xdcebf4);
        ctx.fill();
        poly(ctx, [[2, -4], [6, -16], [9, -3]], css(0xb8d2e2));
      }
      break;
    }
    case "verdant-ruin": {
      groundShadow(ctx, 9, 3.4);
      if (variant === 0) {
        // broken column, moss cap
        poly(ctx, [[-5, 0], [-5, -20], [5, -22], [5, 0]], css(0x8a8474));
        poly(ctx, [[0, -21], [5, -22], [5, 0], [1, 0]], css(0x6e695b));
        ctx.beginPath();
        ctx.ellipse(0, -21, 6, 2.6, 0, 0, Math.PI * 2);
        ctx.fillStyle = css(0x5d7a4a);
        ctx.fill();
        circle(ctx, -3, -10, 2, css(0x55704a, 0.85));
      } else if (variant === 1) {
        // vine-choked arch stump
        ctx.strokeStyle = css(0x7d7568);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(0, -4, 9, Math.PI, Math.PI * 1.8);
        ctx.stroke();
        ctx.strokeStyle = css(0x5d7a4a, 0.9);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-9, -4);
        ctx.quadraticCurveTo(-4, -16, 4, -11);
        ctx.stroke();
        circle(ctx, 3, -11, 1.2, css(glow, 0.7));
      } else {
        // relic stone swallowed by growth
        poly(ctx, [[-6, 0], [-4, -16], [4, -18], [6, 0]], css(0x6f6a5c));
        circle(ctx, -2, -14, 3, css(0x55704a));
        circle(ctx, 3, -6, 2.4, css(0x5d7a4a));
        circle(ctx, 0, -10, 1, css(glow, 0.6));
      }
      break;
    }
    case "dune-monolith": {
      groundShadow(ctx, 10, 3.2, 0.24);
      if (variant === 0) {
        // half-buried tilted monolith
        ctx.save();
        ctx.rotate(-0.16);
        poly(ctx, [[-5, 2], [-4, -24], [4, -26], [5, 2]], css(0x8a7c60));
        poly(ctx, [[-4, -24], [4, -26], [5, 2], [1, 2]], css(0x6f6350));
        circle(ctx, 0, -18, 1.4, css(glow, 0.7));
        ctx.restore();
        ctx.beginPath();
        ctx.ellipse(0, 0, 10, 3.4, 0, 0, Math.PI * 2);
        ctx.fillStyle = css(0xa3936f);
        ctx.fill();
      } else if (variant === 1) {
        // colossal rib bones
        ctx.strokeStyle = css(0xcfc2a4);
        ctx.lineWidth = 2;
        for (const [dx, r] of [[-6, 12], [0, 15], [6, 11]] as const) {
          ctx.beginPath();
          ctx.arc(dx, 0, r, Math.PI * 1.05, Math.PI * 1.6);
          ctx.stroke();
        }
      } else {
        // cairn of stones
        circle(ctx, -4, -3, 4, css(0x847a64));
        circle(ctx, 4, -3, 3.4, css(0x8f8266));
        circle(ctx, 0, -8, 3, css(0x9a8c6e));
        circle(ctx, 0, -8, 0.9, css(glow, 0.6));
      }
      break;
    }
  }
}

function propTextures(scene: Phaser.Scene, arch: Archetype, gen: number): string[] {
  return [0, 1, 2].map((v) =>
    canvasTexture(scene, `g${gen}-prop-${v}`, PROP_W, PROP_H, (ctx) => {
      ctx.translate(PROP_W / 2, PROP_H - 4);
      drawProp(ctx, arch, v);
    }),
  );
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

/** Compose a WorldSpec prop's primitives, side by side at the ground, into a texture. */
function specPropTexture(scene: Phaser.Scene, key: string, prop: WorldProp): string {
  const prims = prop.silhouette;
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
    if (prop.glow) {
      const g = hexColor(prop.glow.color) ?? 0xe3b264;
      const gx = xs[tallest]!;
      const gy = -maxH - 3;
      circle(ctx, gx, gy, 2.2, css(g, 0.95));
      ring(ctx, gx, gy, 4.6, 4.6, css(g, 0.35), 1);
    }
  });
}

/** Stack a BuildingSpec's primitives bottom→top over a wall-colored plinth. */
function specBuildingTexture(scene: Phaser.Scene, key: string, spec: BuildingSpec): string {
  const prims = spec.silhouette;
  const sumH = prims.reduce((s, p) => s + p.h, 0);
  const maxW = Math.max(...prims.map((p) => p.w));
  const s = Math.min(1, 74 / sumH, 68 / maxW);
  const wall = hexColor(spec.wallColor) ?? 0x6e675b;
  const roof = hexColor(spec.roofColor) ?? 0x77705f;
  const emissive = spec.emissive ? hexColor(spec.emissive) : undefined;
  return buildingTexture(scene, key, (ctx) => {
    const baseW = Math.max(18, maxW * s + 8);
    groundShadow(ctx, baseW * 0.62, baseW * 0.2);
    isoBox(ctx, baseW, baseW * 0.6, 4, shade(wall, 1.1), wall, shade(wall, 0.78));
    let y = -4;
    let topW = baseW;
    for (const p of prims) {
      ctx.save();
      ctx.translate(0, y);
      ctx.scale(s, s);
      drawPrimitive(ctx, p);
      ctx.restore();
      y -= p.h * s;
      topW = p.w * s;
    }
    // roof cap: a diamond lid in roofColor over the top primitive
    const rw = Math.max(8, topW * 1.15);
    poly(ctx, [[0, y - rw * 0.28], [rw / 2, y], [0, y + rw * 0.28], [-rw / 2, y]], css(roof));
    poly(ctx, [[rw / 2, y], [0, y + rw * 0.28], [-rw / 2, y]], css(shade(roof, 0.8)));
    if (emissive !== undefined) {
      seam(ctx, 0, y + 4, Math.max(6, -y * 0.55), emissive);
      ctx.fillStyle = css(emissive, 0.85);
      ctx.fillRect(-2.4, -8, 4.8, 8); // lit doorway
      circle(ctx, 0, y - 3, 1.8, css(emissive, 0.95));
    }
  });
}

/** WorldSpec tile detailing; reliefIntensity scales contrast and clutter. */
function drawSpecTilePattern(
  ctx: Ctx,
  pattern: WorldSpec["terrain"]["pattern"],
  base: number,
  relief: number,
): void {
  const dark = css(shade(base, 1 - 0.12 - 0.3 * relief));
  const light = css(shade(base, 1 + 0.1 + 0.3 * relief));
  const r = Math.random;
  const n = 1 + Math.round(relief * 2);
  switch (pattern) {
    case "plates": {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const y0 = (r() - 0.5) * TILE_H * 0.6;
        ctx.beginPath();
        ctx.moveTo(-16 + r() * 8, y0);
        ctx.lineTo(-2 + r() * 4, y0 + (r() - 0.5) * 5);
        ctx.lineTo(14 - r() * 6, y0 + (r() - 0.5) * 8);
        ctx.stroke();
      }
      if (r() < 0.3) {
        poly(ctx, [[-4, -2], [4, -3], [6, 2], [-3, 3]], css(shade(base, 1.08), 0.7));
      }
      break;
    }
    case "dunes": {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let i = 0; i < n + 1; i++) {
        const y = -TILE_H * 0.3 + i * ((TILE_H * 0.6) / (n + 1)) + (r() - 0.5) * 3;
        ctx.beginPath();
        ctx.moveTo(-13 + r() * 5, y);
        ctx.quadraticCurveTo(0, y - 2.5 - relief * 2, 13 - r() * 5, y);
        ctx.stroke();
      }
      break;
    }
    case "floes": {
      for (let i = 0; i < n; i++) {
        const x = (r() - 0.5) * TILE_W * 0.45;
        const y = (r() - 0.5) * TILE_H * 0.45;
        poly(
          ctx,
          [[x - 6, y], [x - 1, y - 3.5], [x + 6, y - 1], [x + 4, y + 3], [x - 3, y + 3.4]],
          light,
        );
        ctx.strokeStyle = dark;
        ctx.lineWidth = 0.8;
        ctx.strokeRect(x - 6, y - 3.5, 12, 7);
      }
      break;
    }
    case "moss": {
      for (let i = 0; i < n + 1; i++) {
        circle(
          ctx,
          (r() - 0.5) * TILE_W * 0.55,
          (r() - 0.5) * TILE_H * 0.55,
          1.4 + r() * (1.5 + relief * 1.6),
          css(shade(base, 0.84), 0.85),
        );
      }
      if (r() < 0.4) circle(ctx, (r() - 0.5) * 18, (r() - 0.5) * 8, 0.9, light);
      break;
    }
    case "tessellae": {
      // mosaic fragments on a loose diamond grid
      for (let i = 0; i < n + 2; i++) {
        const x = (r() - 0.5) * TILE_W * 0.55;
        const y = (r() - 0.5) * TILE_H * 0.55;
        const sz = 1.6 + r() * 2;
        poly(
          ctx,
          [[x, y - sz / 2], [x + sz, y], [x, y + sz / 2], [x - sz, y]],
          r() < 0.5 ? dark : light,
        );
      }
      break;
    }
    case "shale": {
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.9;
      for (let i = 0; i < n + 1; i++) {
        const y = (r() - 0.5) * TILE_H * 0.7;
        const x = (r() - 0.5) * 10;
        ctx.beginPath();
        ctx.moveTo(x - 9, y);
        ctx.lineTo(x + 9, y - 1 - relief * 2);
        ctx.stroke();
      }
      if (r() < 0.3) {
        ctx.strokeStyle = light;
        ctx.beginPath();
        const y = (r() - 0.5) * 8;
        ctx.moveTo(-6, y);
        ctx.lineTo(7, y - 2);
        ctx.stroke();
      }
      break;
    }
  }
}

function specGroundTextures(
  scene: Phaser.Scene,
  terrain: WorldSpec["terrain"],
  gen: number,
): string[] {
  const w = TILE_W + 2;
  const h = TILE_H + 2;
  const colors = terrain.base
    .map((c) => hexColor(c))
    .filter((c): c is number => c !== undefined);
  return colors.map((color, i) =>
    canvasTexture(scene, `g${gen}-wground-${i}`, w, h, (ctx) => {
      ctx.translate(w / 2, h / 2);
      diamondPath(ctx, 0, 0, TILE_W, TILE_H);
      ctx.fillStyle = css(color);
      ctx.fill();
      ctx.save();
      diamondPath(ctx, 0, 0, TILE_W, TILE_H);
      ctx.clip();
      drawSpecTilePattern(ctx, terrain.pattern, color, terrain.reliefIntensity);
      ctx.restore();
      diamondPath(ctx, 0, 0, TILE_W, TILE_H);
      ctx.strokeStyle = css(0x2e2a22, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }),
  );
}

function waterTexture(scene: Phaser.Scene, color: number, gen: number): string {
  const w = TILE_W + 2;
  const h = TILE_H + 2;
  return canvasTexture(scene, `g${gen}-water`, w, h, (ctx) => {
    ctx.translate(w / 2, h / 2);
    diamondPath(ctx, 0, 0, TILE_W, TILE_H);
    ctx.fillStyle = css(color);
    ctx.fill();
    ctx.save();
    diamondPath(ctx, 0, 0, TILE_W, TILE_H);
    ctx.clip();
    ctx.strokeStyle = css(shade(color, 1.35), 0.8);
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const y = (Math.random() - 0.5) * TILE_H * 0.5;
      ctx.beginPath();
      ctx.moveTo(-12 + Math.random() * 6, y);
      ctx.quadraticCurveTo(0, y - 2, 12 - Math.random() * 6, y);
      ctx.stroke();
    }
    ctx.restore();
    diamondPath(ctx, 0, 0, TILE_W, TILE_H);
    ctx.strokeStyle = css(shade(color, 0.7), 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

/** Vertical sky gradient from a WorldSpec: top → horizon → haze. */
export function specSkyTexture(scene: Phaser.Scene, sky: WorldSpec["sky"], gen: number): string {
  const top = hexColor(sky.top) ?? 0x2a2118;
  const horizon = hexColor(sky.horizon) ?? 0x2a2118;
  return canvasTexture(scene, `g${gen}-sky`, 16, 160, (ctx) => {
    const grad = ctx.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, css(top, 0.95));
    grad.addColorStop(0.6, css(horizon, 0.75));
    grad.addColorStop(1, css(horizon, Math.min(0.8, sky.hazeAlpha * 1.6)));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 160);
  });
}

/**
 * Override archetype visuals with WorldSpec geometry: ground ramp + pattern,
 * waterline tile, composed props, and per-kind building silhouettes. Pixel
 * sprites (applyTheme) still layer over whatever the spec does not claim.
 */
export function applyWorldSpec(
  scene: Phaser.Scene,
  base: TextureSet,
  spec: WorldSpec,
  gen: number,
): TextureSet {
  const out: TextureSet = { ...base, buildings: { ...base.buildings } };

  const ground = specGroundTextures(scene, spec.terrain, gen);
  if (ground.length >= 2) out.ground = ground;

  if (spec.terrain.waterline) {
    const c = hexColor(spec.terrain.waterline.color);
    if (c !== undefined) out.water = waterTexture(scene, c, gen);
  }

  out.specProps = spec.props.map((prop, i) => ({
    tex: specPropTexture(scene, `g${gen}-wprop-${i}`, prop),
    density: prop.density,
    placement: prop.placement,
    pulseSec: prop.glow ? prop.glow.pulseSec : null,
  }));

  for (const [kind, b] of Object.entries(spec.architecture)) {
    if (!b) continue;
    out.buildings[kind] = {
      built: specBuildingTexture(scene, `g${gen}-w-${kind}`, b),
      scaffold: base.buildings[kind]?.scaffold ?? base.buildings.house!.scaffold,
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Structures + figures
// ---------------------------------------------------------------------------

const B_W = 100;
const B_H = 100;

function buildingTexture(scene: Phaser.Scene, key: string, draw: (ctx: Ctx) => void): string {
  return canvasTexture(scene, key, B_W, B_H, (ctx) => {
    ctx.translate(B_W / 2, B_H - 4);
    draw(ctx);
  });
}

function drawScaffold(ctx: Ctx, w: number, d: number, h: number, glow: number): void {
  isoBox(ctx, w, d, h * 0.4, 0x5c554a, 0x4a4439, 0x3b362d);
  for (const x of [-w / 2 + 2, w / 2 - 2, 0]) {
    ctx.fillStyle = css(0x55503f);
    ctx.fillRect(x - 1, -h, 2, h);
  }
  ctx.fillStyle = css(glow, 0.35);
  ctx.fillRect(-w / 4, -h - 2, w / 2, 2);
}

export function buildTextures(scene: Phaser.Scene, arch: Archetype, gen: number): TextureSet {
  const glow = arch.glow;
  const g = (name: string) => `g${gen}-${name}`;

  const ground = groundTextures(scene, arch, arch.groundColors, gen, "ground");
  const fog = fogTexture(scene, arch.fogColor, gen);
  const props = propTextures(scene, arch, gen);

  const scaffoldFor = (name: string, w: number, d: number, h: number): string =>
    buildingTexture(scene, g(`${name}-scaffold`), (ctx) => drawScaffold(ctx, w, d, h, glow));

  const buildings: TextureSet["buildings"] = {
    // dwelling: low adobe block, one glow door
    house: {
      built: buildingTexture(scene, g("house"), (ctx) => {
        groundShadow(ctx, 22, 7);
        isoBox(ctx, 40, 24, 22, 0x8d8577, 0x6e675b, 0x585247);
        seam(ctx, 10, -18, 18, glow);
        poly(ctx, [[0, -34], [20, -22], [0, -12], [-20, -22]], css(0x77705f));
      }),
      scaffold: scaffoldFor("house", 40, 24, 24),
    },
    // bastion: angular fortress with antenna-spike
    barracks: {
      built: buildingTexture(scene, g("barracks"), (ctx) => {
        groundShadow(ctx, 26, 8);
        isoBox(ctx, 48, 30, 28, 0x6f6f74, 0x55555c, 0x424248);
        poly(ctx, [[-24, -28], [-14, -40], [-4, -28]], css(0x62626a));
        ctx.fillStyle = css(0x50505a);
        ctx.fillRect(-0.8, -54, 1.6, 26);
        circle(ctx, 0, -55, 1.8, css(0xb5564a, 0.95));
        seam(ctx, -18, -22, 20, 0xb5564a);
      }),
      scaffold: scaffoldFor("barracks", 48, 30, 28),
    },
    // trade-vault: low dome over a causeway gate
    market: {
      built: buildingTexture(scene, g("market"), (ctx) => {
        groundShadow(ctx, 25, 8);
        isoBox(ctx, 46, 28, 14, 0x8d8577, 0x6e675b, 0x585247);
        circle(ctx, 0, -20, 13, css(0x77705f));
        ring(ctx, 0, -20, 13, 13, css(0x4a4439), 1.5);
        ctx.fillStyle = css(glow, 0.5);
        ctx.fillRect(-6, -12, 12, 12);
        seam(ctx, -16, -12, 10, glow);
        seam(ctx, 16, -12, 10, glow);
      }),
      scaffold: scaffoldFor("market", 46, 28, 22),
    },
    // sanctum: tall thin obelisk, apex glow
    monastery: {
      built: buildingTexture(scene, g("monastery"), (ctx) => {
        groundShadow(ctx, 12, 4);
        poly(ctx, [[-9, 0], [-5, -44], [0, -48], [5, -44], [9, 0]], css(0x7d7568));
        poly(ctx, [[0, -48], [5, -44], [9, 0], [0, 0]], css(0x655e51));
        circle(ctx, 0, -50, 2.4, css(glow, 0.95));
        seam(ctx, 0, -40, 34, glow);
      }),
      scaffold: scaffoldFor("monastery", 38, 24, 30),
    },
    // engine-granary: tiered silo with a slow ring
    mill: {
      built: buildingTexture(scene, g("mill"), (ctx) => {
        groundShadow(ctx, 20, 7);
        isoBox(ctx, 34, 22, 18, 0x837b6c, 0x685f50, 0x534b3e);
        ctx.save();
        ctx.translate(0, -17);
        isoBox(ctx, 24, 16, 10, 0x8d8577, 0x6e675b, 0x585247);
        ctx.restore();
        ring(ctx, 0, -31, 15, 5, css(glow, 0.7), 1.4);
      }),
      scaffold: scaffoldFor("mill", 34, 22, 24),
    },
    // the Citadel: stepped monolith, apex beacon
    towncenter: {
      built: buildingTexture(scene, g("towncenter"), (ctx) => {
        groundShadow(ctx, 34, 11);
        isoBox(ctx, 64, 40, 20, 0x7d7568, 0x615a4c, 0x4c463b);
        ctx.save();
        ctx.translate(0, -20);
        isoBox(ctx, 46, 30, 16, 0x877f70, 0x6a6254, 0x544d40);
        ctx.translate(0, -16);
        isoBox(ctx, 28, 18, 14, 0x91897a, 0x746c5c, 0x5c5547);
        ctx.restore();
        seam(ctx, -20, -34, 30, glow);
        seam(ctx, 20, -34, 30, glow);
        circle(ctx, 0, -66, 3, css(glow));
        ring(ctx, 0, -66, 6, 6, css(glow, 0.4), 1);
      }),
      scaffold: scaffoldFor("towncenter", 64, 40, 34),
    },
  };

  // the Beacon: a spire casting a light column
  const W_W = 140;
  const W_H = 240;
  const wonder = canvasTexture(scene, g("wonder"), W_W, W_H, (ctx) => {
    ctx.translate(W_W / 2, W_H - 6);
    ctx.fillStyle = css(glow, 0.12);
    ctx.fillRect(-6, -226, 12, 162);
    ctx.fillStyle = css(glow, 0.2);
    ctx.fillRect(-2.5, -226, 5, 162);
    groundShadow(ctx, 18, 6);
    poly(ctx, [[-14, 0], [-6, -58], [0, -64], [6, -58], [14, 0]], css(0x8d8577));
    poly(ctx, [[0, -64], [6, -58], [14, 0], [0, 0]], css(0x6e675b));
    seam(ctx, 0, -58, 52, glow);
    circle(ctx, 0, -68, 4, css(glow));
    ring(ctx, 0, -68, 9, 9, css(glow, 0.5), 1.2);
  });

  // --- figures ---------------------------------------------------------------
  const U_W = 44;
  const U_H = 44;
  const unitTexture = (name: string, draw: (ctx: Ctx) => void): string =>
    canvasTexture(scene, g(name), U_W, U_H, (ctx) => {
      ctx.translate(U_W / 2, U_H - 4);
      draw(ctx);
    });

  // robed worker
  const villager = unitTexture("villager", (ctx) => {
    groundShadow(ctx, 8, 3.5, 0.35);
    poly(ctx, [[-5, 0], [-4, -13], [4, -13], [5, 0]], css(0xa39a86));
    circle(ctx, 0, -15, 4, css(0x8d8577));
    poly(ctx, [[-4, -15], [0, -20], [4, -15]], css(0xa39a86)); // hood
    ctx.fillStyle = css(0x4a4439);
    ctx.fillRect(-1, -10, 2, 6); // sash
  });
  // hierophant: taller, halo ring
  const king = unitTexture("king", (ctx) => {
    groundShadow(ctx, 9, 4, 0.35);
    poly(ctx, [[-6, 0], [-4, -17], [4, -17], [6, 0]], css(0x8a7a58));
    circle(ctx, 0, -19, 4, css(0x9a8f79));
    poly(ctx, [[-4, -19], [0, -25], [4, -19]], css(0x8a7a58));
    ring(ctx, 0, -22, 8, 3, css(glow, 0.9), 1.3);
  });
  // specter: black wraith, pale eyes
  const raider = unitTexture("raider", (ctx) => {
    groundShadow(ctx, 8, 3.5, 0.25);
    poly(ctx, [[-5, 0], [-4, -14], [0, -18], [4, -14], [5, 0]], css(0x16141a, 0.95));
    poly(ctx, [[-5, 0], [-2, -4], [1, 0]], css(0x16141a, 0.5));
    circle(ctx, -1.6, -13, 1, css(0xbfd4d8));
    circle(ctx, 1.6, -13, 1, css(0xbfd4d8));
  });

  const hlW = TILE_W + 8;
  const hlH = TILE_H + 8;
  const highlight = canvasTexture(scene, g("highlight"), hlW, hlH, (ctx) => {
    ctx.translate(hlW / 2, hlH / 2);
    diamondPath(ctx, 0, 0, TILE_W, TILE_H);
    ctx.fillStyle = css(glow, 0.08);
    ctx.fill();
    diamondPath(ctx, 0, 0, TILE_W, TILE_H);
    ctx.strokeStyle = css(glow);
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  return { ground, fog, props, buildings, wonder, villager, king, raider, highlight };
}

// ---------------------------------------------------------------------------
// Theme application: LLM pixel sprites → textures
// ---------------------------------------------------------------------------

export function pixelSpriteTexture(
  scene: Phaser.Scene,
  key: string,
  sprite: PixelSprite,
  pixelSize: number,
): string {
  const width = Math.max(...sprite.rows.map((r) => r.length));
  const height = sprite.rows.length;
  const w = width * pixelSize + 8;
  const h = height * pixelSize + 10;
  return canvasTexture(scene, key, w, h, (ctx) => {
    ctx.translate(w / 2, h - 4);
    // soft ground shadow so themed sprites sit in the world
    groundShadow(ctx, (width * pixelSize) / 3, 3.5);
    const ox = (-width * pixelSize) / 2;
    sprite.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x]!;
        if (ch === "." || ch === " ") continue;
        const hex = sprite.palette[ch];
        if (!hex) continue;
        ctx.fillStyle = hex;
        ctx.fillRect(ox + x * pixelSize, (y - height) * pixelSize, pixelSize, pixelSize);
      }
    });
  });
}

const UNIT_KEYS = new Set(["villager", "hero", "raider"]);
const BUILDING_KEYS = new Set(["house", "barracks", "market", "monastery", "mill", "towncenter"]);

/**
 * Merge a ThemePack over the default set. Missing pieces keep defaults.
 * When a WorldSpec is present it owns terrain, props, and any building kind
 * named in its architecture; pixel sprites keep the rest (notably units).
 */
export function applyTheme(
  scene: Phaser.Scene,
  base: TextureSet,
  theme: ThemePack,
  arch: Archetype,
  gen: number,
  spec?: WorldSpec,
): TextureSet {
  const out: TextureSet = { ...base, buildings: { ...base.buildings } };
  const specOwnsProps = (spec?.props.length ?? 0) > 0;
  const specBuildingKinds = new Set(
    spec ? Object.entries(spec.architecture).filter(([, b]) => b).map(([k]) => k) : [],
  );

  const grassColors = theme.biome.grassColors
    .map((c) => parseInt(c.slice(1), 16))
    .filter((n) => !Number.isNaN(n));
  if (!spec && grassColors.length >= 2) {
    out.ground = groundTextures(scene, arch, grassColors, gen, "tground");
  }

  const fogColor = parseInt(theme.biome.fogColor.slice(1), 16);
  if (!Number.isNaN(fogColor)) {
    out.fog = canvasTexture(scene, `g${gen}-tfog`, TILE_W + 2, TILE_H + 2, (ctx) => {
      ctx.translate((TILE_W + 2) / 2, (TILE_H + 2) / 2);
      diamondPath(ctx, 0, 0, TILE_W + 2, TILE_H + 2);
      ctx.fillStyle = css(fogColor);
      ctx.fill();
    });
  }

  for (const sprite of theme.sprites) {
    const key = `g${gen}-t-${sprite.key}`;
    if (UNIT_KEYS.has(sprite.key)) {
      const tex = pixelSpriteTexture(scene, key, sprite, 2);
      if (sprite.key === "villager") out.villager = tex;
      if (sprite.key === "hero") out.king = tex;
      if (sprite.key === "raider") out.raider = tex;
    } else if (sprite.key === "tree") {
      if (specOwnsProps) continue; // spec props are the world's flora
      // themed relic/flora replaces every archetype prop variant
      const tex = pixelSpriteTexture(scene, key, sprite, 2);
      out.props = [tex, tex, tex];
    } else if (BUILDING_KEYS.has(sprite.key)) {
      if (specBuildingKinds.has(sprite.key)) continue; // spec architecture wins
      out.buildings[sprite.key] = {
        built: pixelSpriteTexture(scene, key, sprite, sprite.key === "towncenter" ? 3 : 2.5),
        scaffold: base.buildings[sprite.key]?.scaffold ?? base.buildings.house!.scaffold,
      };
    } else if (sprite.key === "wonder") {
      out.wonder = pixelSpriteTexture(scene, key, sprite, 3);
    }
  }
  return out;
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

/** Drop every canvas texture belonging to an older generation. */
export function pruneGeneration(scene: Phaser.Scene, gen: number): void {
  const prefix = `g${gen}-`;
  for (const key of Object.keys(scene.textures.list)) {
    if (key.startsWith(prefix)) scene.textures.remove(key);
  }
}
