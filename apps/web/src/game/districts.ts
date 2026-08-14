import Phaser from "phaser";
import type { DistrictArchetype } from "@agent-empires/protocol";
import { isoX, MapLayout, Quarter, TILE_H } from "./map.js";
import { TerrainInfo } from "./terrain.js";
import { P, SHEET, W, WALL_LOW, WALL_SEGS, WALL_TOWERS } from "./atlas.js";

/**
 * Quarter dressing: a wall ring following the quarter's treemap rect with a
 * gate on the road edge, plus archetype furniture (training dummies for
 * proving grounds, scroll racks for scriptoria, …). Walls trace structure —
 * they are never placed off the rect. Furniture without a source sprite is
 * drawn as a tiny procedural pixel object in the same palette.
 */

/** Slightly green-grey multiply to pull the brown extradave stone toward Yar. */
export const WALL_TINT = 0xc9c9b4;

const DPRX = 2;

type Ctx = CanvasRenderingContext2D;

function miniTexture(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (ctx: Ctx) => void,
): string {
  if (scene.textures.exists(key)) return key;
  const canvas = document.createElement("canvas");
  canvas.width = w * DPRX;
  canvas.height = h * DPRX;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(DPRX, DPRX);
  ctx.imageSmoothingEnabled = false;
  draw(ctx);
  scene.textures.addCanvas(key, canvas);
  return key;
}

const css = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;

/** Straw training dummy on a pole (proving grounds). */
export function dummyTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-dummy", 22, 34, (ctx) => {
    ctx.fillStyle = css(0x6b4e2e);
    ctx.fillRect(10, 12, 3, 20); // pole
    ctx.fillRect(3, 15, 17, 3); // crossbar
    ctx.fillStyle = css(0xc9a860);
    ctx.fillRect(7, 8, 9, 12); // straw torso
    ctx.fillStyle = css(0xd8bc74);
    ctx.fillRect(9, 2, 6, 6); // head
    ctx.fillStyle = css(0x8a6f3a);
    ctx.fillRect(7, 12, 9, 2); // rope belt
  });
}

/** Archery target on a tripod (proving grounds). */
export function targetTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-target", 24, 30, (ctx) => {
    ctx.fillStyle = css(0x6b4e2e);
    ctx.fillRect(6, 18, 2, 12);
    ctx.fillRect(16, 18, 2, 12);
    ctx.fillRect(11, 20, 2, 10);
    const rings: [number, number][] = [
      [9, 0xe8e0c8],
      [6, 0xb8443a],
      [3, 0xe8e0c8],
    ];
    for (const [r, c] of rings) {
      ctx.fillStyle = css(c);
      ctx.beginPath();
      ctx.arc(12, 11, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = css(0xb8443a);
    ctx.fillRect(11, 10, 2, 2);
  });
}

/** Reading lectern with an open book (scriptorium). */
export function lecternTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-lectern", 20, 28, (ctx) => {
    ctx.fillStyle = css(0x6b4e2e);
    ctx.fillRect(8, 12, 4, 16);
    ctx.fillRect(4, 26, 12, 2);
    ctx.save();
    ctx.translate(10, 10);
    ctx.rotate(-0.3);
    ctx.fillStyle = css(0x8a6f3a);
    ctx.fillRect(-8, -3, 16, 6);
    ctx.fillStyle = css(0xe8dcb8);
    ctx.fillRect(-7, -4, 7, 6);
    ctx.fillRect(0, -4, 7, 6);
    ctx.fillStyle = css(0x9a8a68);
    ctx.fillRect(-5, -2, 4, 1);
    ctx.fillRect(2, -2, 4, 1);
    ctx.restore();
  });
}

/** Scroll rack: shelf of rolled parchments (scriptorium). */
export function scrollRackTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-scrollrack", 26, 26, (ctx) => {
    ctx.fillStyle = css(0x5c452a);
    ctx.fillRect(2, 4, 22, 20);
    ctx.fillStyle = css(0x3c2d1c);
    ctx.fillRect(4, 6, 18, 16);
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = css(0xe8dcb8);
        ctx.beginPath();
        ctx.arc(7 + i * 4.4, 10 + r * 8, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = css(0xb9a06a);
        ctx.beginPath();
        ctx.arc(7 + i * 4.4, 10 + r * 8, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
}

/** Anvil on a stump (forge). */
export function anvilTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-anvil", 22, 22, (ctx) => {
    ctx.fillStyle = css(0x6b4e2e);
    ctx.fillRect(7, 14, 8, 8);
    ctx.fillStyle = css(0x585a60);
    ctx.fillRect(4, 8, 14, 5);
    ctx.fillRect(2, 8, 4, 3);
    ctx.fillStyle = css(0x74767c);
    ctx.fillRect(4, 8, 14, 2);
    ctx.fillStyle = css(0x3c3e44);
    ctx.fillRect(8, 13, 6, 2);
  });
}

/** Grain crate stack (granary / bazaar). */
export function crateTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-crates", 26, 24, (ctx) => {
    const box = (x: number, y: number, s: number) => {
      ctx.fillStyle = css(0x9a7b4a);
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = css(0x5c452a);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + s, y + s);
      ctx.stroke();
    };
    box(2, 12, 11);
    box(13, 12, 11);
    box(7, 2, 11);
  });
}

/** Banner pole with a pennant; tint per faction accent. */
export function bannerTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-banner", 18, 40, (ctx) => {
    ctx.fillStyle = css(0x6b4e2e);
    ctx.fillRect(4, 2, 2, 38);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(6, 3);
    ctx.lineTo(17, 7);
    ctx.lineTo(6, 12);
    ctx.closePath();
    ctx.fill();
  });
}

/** Waypoint flag for move orders (smaller, brighter). */
export function flagTexture(scene: Phaser.Scene): string {
  return miniTexture(scene, "mini-flag", 14, 26, (ctx) => {
    ctx.fillStyle = css(0xe8dcb8);
    ctx.fillRect(3, 2, 1.5, 24);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(4.5, 3);
    ctx.lineTo(13, 6);
    ctx.lineTo(4.5, 9.5);
    ctx.closePath();
    ctx.fill();
  });
}

// ---------------------------------------------------------------------------

export type Dressing = {
  objs: (Phaser.GameObjects.Image | Phaser.GameObjects.Sprite)[];
  banners: Phaser.GameObjects.Image[];
};

type Placer = {
  scene: Phaser.Scene;
  map: MapLayout;
  t: TerrainInfo;
  rng: () => number;
  out: Dressing;
};

function groundPoint(p: Placer, tx: number, ty: number): { x: number; y: number } {
  return { x: isoX(tx, ty), y: p.t.groundY(tx, ty) + TILE_H / 4 };
}

function placeWorld(
  p: Placer,
  tx: number,
  ty: number,
  tex: string,
  frame: string | undefined,
  opts: { tint?: number; oy?: number; claim?: boolean } = {},
): Phaser.GameObjects.Image | null {
  if (tx < 1 || ty < 1 || tx >= p.map.side - 1 || ty >= p.map.side - 1) return null;
  if (p.t.isWater(tx, ty) || p.t.isRoad(tx, ty)) return null;
  const key = `${tx},${ty}`;
  if (opts.claim !== false) {
    if (p.map.used.has(key)) return null;
    p.map.used.add(key);
  }
  const g = groundPoint(p, tx, ty);
  const img = p.scene.add
    .image(g.x, g.y, tex, frame)
    .setOrigin(0.5, opts.oy ?? 1)
    .setDepth(g.y);
  if (opts.tint !== undefined) img.setTint(opts.tint);
  p.out.objs.push(img);
  return img;
}

/**
 * Wall ring tracing the quarter's treemap rect, with the gate left open.
 * Watchtower quarters get full-height segments and corner towers; everyone
 * else gets low walls (denser for depth-1 quarters).
 */
function buildWalls(p: Placer, q: Quarter): void {
  const { rect, gate } = q;
  const tall = q.archetype === "watchtower";
  const segs = tall ? WALL_SEGS : WALL_LOW;
  const x1 = rect.x + rect.w - 1;
  const y1 = rect.y + rect.h - 1;
  // spaced posts keep buildings the primary mass; only watchtowers run solid
  const step = tall ? 1 : 2;
  const border: { tx: number; ty: number; corner: boolean }[] = [];
  for (let tx = rect.x; tx <= x1; tx++) {
    border.push({ tx, ty: rect.y, corner: tx === rect.x || tx === x1 });
    if (y1 !== rect.y) border.push({ tx, ty: y1, corner: tx === rect.x || tx === x1 });
  }
  for (let ty = rect.y + 1; ty < y1; ty++) {
    border.push({ tx: rect.x, ty, corner: false });
    if (x1 !== rect.x) border.push({ tx: x1, ty, corner: false });
  }
  for (const b of border) {
    const nearGate = Math.abs(b.tx - gate.tx) + Math.abs(b.ty - gate.ty) <= 1;
    if (nearGate) continue;
    if (!b.corner && (b.tx + b.ty) % step !== 0) continue;
    const frame = b.corner
      ? tall
        ? WALL_TOWERS[(b.tx * 7 + b.ty) % WALL_TOWERS.length]!
        : W.towerB
      : segs[(b.tx * 5 + b.ty * 3) % segs.length]!;
    // wall blocks: base sits ~18px above the frame bottom (skirt overlaps ground)
    placeWorld(p, b.tx, b.ty, SHEET.walls, frame, { tint: WALL_TINT, oy: 0.86 });
  }
  // the gate arch stands on the gate tile itself (road passes beneath)
  const g = groundPoint(p, gate.tx, gate.ty);
  const arch = p.scene.add
    .image(g.x, g.y, SHEET.walls, W.arch)
    .setOrigin(0.5, 0.86)
    .setDepth(g.y)
    .setTint(WALL_TINT);
  p.out.objs.push(arch);
}

const FURN: Record<DistrictArchetype, number> = {
  quarter: 2,
  proving: 4,
  scriptorium: 3,
  granary: 3,
  watchtower: 2,
  forge: 3,
  bazaar: 4,
};

function furnitureFor(
  p: Placer,
  arch: DistrictArchetype,
  i: number,
): { tex: string; frame?: string; fx?: "fire" } {
  const s = p.scene;
  switch (arch) {
    case "proving":
      return i % 2 === 0 ? { tex: dummyTexture(s) } : { tex: targetTexture(s) };
    case "scriptorium":
      return i % 2 === 0 ? { tex: lecternTexture(s) } : { tex: scrollRackTexture(s) };
    case "granary":
      return i % 3 === 0 ? { tex: SHEET.parts, frame: P.chimneyOpen } : { tex: crateTexture(s) };
    case "watchtower":
      return { tex: SHEET.parts, frame: P.pillarTall };
    case "forge":
      return i === 0
        ? { tex: anvilTexture(s), fx: "fire" }
        : i % 2 === 0
          ? { tex: anvilTexture(s) }
          : { tex: SHEET.parts, frame: P.chimney };
    case "bazaar":
      return i % 2 === 0 ? { tex: SHEET.parts, frame: P.table } : { tex: crateTexture(s) };
    default:
      return i % 2 === 0
        ? { tex: SHEET.parts, frame: P.well }
        : { tex: SHEET.parts, frame: i % 3 === 0 ? P.stoolA : P.table };
  }
}

export function dressQuarter(
  scene: Phaser.Scene,
  map: MapLayout,
  t: TerrainInfo,
  q: Quarter,
  accent: number,
  rng: () => number,
): Dressing {
  const out: Dressing = { objs: [], banners: [] };
  const p: Placer = { scene, map, t, rng, out };
  buildWalls(p, q);

  // archetype furniture on free interior tiles (depth 1-2 quarters only —
  // depth-3 quarters are usually too tight)
  if (q.depth <= 2) {
    const area = q.rect.w * q.rect.h;
    const want = Math.min(FURN[q.archetype], Math.max(1, Math.floor(area / 24)));
    let placed = 0;
    let tries = 0;
    const cx = q.rect.x + q.rect.w / 2;
    const cy = q.rect.y + q.rect.h / 2;
    while (placed < want && tries++ < 40) {
      const tx = Math.round(cx + (rng() - 0.5) * Math.max(2, q.rect.w - 4));
      const ty = Math.round(cy + (rng() - 0.5) * Math.max(2, q.rect.h - 4));
      if (
        tx < q.rect.x + 1 ||
        ty < q.rect.y + 1 ||
        tx > q.rect.x + q.rect.w - 2 ||
        ty > q.rect.y + q.rect.h - 2
      )
        continue;
      const f = furnitureFor(p, q.archetype, placed);
      const img = placeWorld(p, tx, ty, f.tex, f.frame);
      if (!img) continue;
      if (f.fx === "fire") {
        const fire = scene.add
          .sprite(img.x, img.y - 8, SHEET.fire32, 0)
          .setOrigin(0.5, 1)
          .setDepth(img.y + 1);
        fire.play({ key: "fx-fire32-burn", delay: Math.floor(rng() * 500) });
        out.objs.push(fire);
      }
      placed++;
    }
  }

  // banners flank the gate for the showy quarters
  if (
    q.depth === 1 &&
    (q.archetype === "proving" || q.archetype === "bazaar" || q.archetype === "watchtower")
  ) {
    const btex = bannerTexture(scene);
    const horizontalGate = q.gate.ty === q.rect.y || q.gate.ty === q.rect.y + q.rect.h - 1;
    for (const off of [-1, 1]) {
      const tx = q.gate.tx + (horizontalGate ? off * 2 : 0);
      const ty = q.gate.ty + (horizontalGate ? 0 : off * 2);
      const b = placeWorld(p, tx, ty, btex, undefined, { tint: accent, claim: false });
      if (b) out.banners.push(b);
    }
  }
  return out;
}
