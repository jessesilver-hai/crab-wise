import Phaser from "phaser";
import { isoX, isoY, MapLayout, mulberry32, Rect, TILE_H, TILE_W } from "./map.js";
import { FLOOR_ORIGIN_Y, SHEET, T } from "./atlas.js";

/**
 * Terrain around the structural treemap city: the city itself sits on a
 * plateau (height 1) ringed by cliff blocks; a cosmetic wilderness margin
 * (forest, organic lakes with shore transitions) surrounds it. Nothing
 * inside the walls is decorative — every structure maps to the repo.
 */

/** Screen px the city plateau lifts the ground (matches the Yar cliff block). */
export const LIFT = 32;

// -- deterministic value noise ------------------------------------------------

function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const h = (a: number, b: number) => {
    let n = (a * 374761393 + b * 668265263) ^ seed;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm2(x: number, y: number, seed: number): number {
  return 0.65 * vnoise(x, y, seed) + 0.35 * vnoise(x * 2.7, y * 2.7, seed ^ 0x9e37);
}

// ---------------------------------------------------------------------------

export type TerrainInfo = {
  side: number;
  water: Uint8Array;
  heightAt(tx: number, ty: number): number;
  isWater(tx: number, ty: number): boolean;
  isRoad(tx: number, ty: number): boolean;
  inCity(tx: number, ty: number): boolean;
  /** Painted lift (px) of a water tile's surface — in-city canals ride high. */
  waterLiftAt(tx: number, ty: number): number;
  /** Ground surface screen y at fractional tile coords (plateau-aware). */
  groundY(x: number, y: number): number;
};

export function buildTerrain(map: MapLayout, seed: number): TerrainInfo {
  const side = map.side;
  const water = new Uint8Array(side * side);
  const c = map.cityRect;
  const inBounds = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < side && ty < side;
  const inCity = (tx: number, ty: number) =>
    tx >= c.x && ty >= c.y && tx < c.x + c.w && ty < c.y + c.h;

  // organic lakes in the wilderness only, kept a respectful step off the cliffs
  for (let ty = 1; ty < side - 1; ty++) {
    for (let tx = 1; tx < side - 1; tx++) {
      if (tx >= c.x - 2 && ty >= c.y - 2 && tx < c.x + c.w + 2 && ty < c.y + c.h + 2) continue;
      if (fbm2(tx * 0.17, ty * 0.17, seed ^ 0x77aa) > 0.64) {
        water[ty * side + tx] = 1;
        map.used.add(`${tx},${ty}`);
      }
    }
  }

  // layout-law water (coastline, archipelago channels, rivers): carved to sea
  // level so city channels get cliff banks; bridge tiles stay road-height land
  const carved = new Uint8Array(side * side);
  for (const key of map.water) {
    if (map.bridges.has(key)) continue;
    const [tx, ty] = key.split(",").map(Number);
    if (!inBounds(tx!, ty!)) continue;
    const i = ty! * side + tx!;
    carved[i] = 1;
    water[i] = 1;
    map.used.add(key);
  }

  // composition heights (terraces, ring cores, canyon shelves) stack on the
  // city plateau's base level; carved water always wins back to sea level
  const heightAt = (tx: number, ty: number) =>
    inBounds(tx, ty) && carved[ty * side + tx] === 1
      ? 0
      : inCity(tx, ty)
        ? 1 + (map.heights.get(`${tx},${ty}`) ?? 0)
        : 0;

  // In-city water paints brim-full: without this a 1-tile channel hides its
  // own surface behind the near bank's cliff and the sea reads as a trench.
  // Each connected channel/bay finds one level — a lip below its lowest bank —
  // and the whole region floats there. Gameplay height stays 0 (the heights
  // law never raises water); only the painted surface and groundY lift.
  const CANAL_LIP = 10;
  const waterLift = new Uint16Array(side * side);
  {
    const seen = new Uint8Array(side * side);
    const DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const;
    for (let ty = c.y; ty < c.y + c.h; ty++) {
      for (let tx = c.x; tx < c.x + c.w; tx++) {
        const start = ty * side + tx;
        if (carved[start] !== 1 || seen[start] === 1) continue;
        const region: number[] = [start];
        seen[start] = 1;
        let bank = Infinity;
        for (let qi = 0; qi < region.length; qi++) {
          const cur = region[qi]!;
          const cx = cur % side;
          const cy = (cur - cx) / side;
          for (const [dx, dy] of DIRS) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!inBounds(nx, ny)) continue;
            const ni = ny * side + nx;
            if (carved[ni] === 1) {
              if (inCity(nx, ny) && seen[ni] !== 1) {
                seen[ni] = 1;
                region.push(ni);
              }
              continue;
            }
            if (water[ni] !== 1) bank = Math.min(bank, heightAt(nx, ny));
          }
        }
        if (!Number.isFinite(bank) || bank < 1) continue;
        const lift = bank * LIFT - CANAL_LIP;
        for (const idx of region) waterLift[idx] = lift;
      }
    }
  }

  return {
    side,
    water,
    heightAt,
    inCity,
    isWater: (tx, ty) => (inBounds(tx, ty) ? water[ty * side + tx] === 1 : false),
    isRoad: (tx, ty) => map.roads.has(`${tx},${ty}`),
    waterLiftAt: (tx, ty) => (inBounds(tx, ty) ? waterLift[ty * side + tx]! : 0),
    groundY(x: number, y: number): number {
      const tx = Math.round(x);
      const ty = Math.round(y);
      if (inBounds(tx, ty) && water[ty * side + tx] === 1) return isoY(x, y) - waterLift[ty * side + tx]!;
      return isoY(x, y) - heightAt(tx, ty) * LIFT;
    },
  };
}

// ---------------------------------------------------------------------------
// Painting: stamp floor diamonds + plateau cliffs into RenderTexture chunks.
// ---------------------------------------------------------------------------

export type PaintedTerrain = {
  images: Phaser.GameObjects.RenderTexture[];
  /** Per-tile 0xRRGGBB for the minimap underlay. */
  miniColors: Uint32Array;
};

const MINI = { grass: 0x44603a, city: 0x5a7042, water: 0x33608f, cliff: 0x6f6a58, road: 0x9a8258, street: 0xb8a878 };

/** Lighten a 0xRRGGBB toward white by t (0..1) — minimap altitude shading. */
function shade(color: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * (1 - k) + 255 * k));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * (1 - k) + 255 * k));
  const b = Math.min(255, Math.round((color & 0xff) * (1 - k) + 255 * k));
  return (r << 16) | (g << 8) | b;
}

export function paintTerrain(
  scene: Phaser.Scene,
  map: MapLayout,
  t: TerrainInfo,
  seed: number,
  depth: number,
): PaintedTerrain {
  const side = t.side;
  const rng = mulberry32((seed ^ 0x7e11a) >>> 0);
  const miniColors = new Uint32Array(side * side);
  const pick = (arr: readonly string[]) => arr[Math.floor(rng() * arr.length)]!;

  const CHUNK = 16;
  const chunks = Math.ceil(side / CHUNK);
  const rts: Phaser.GameObjects.RenderTexture[][] = [];
  const images: Phaser.GameObjects.RenderTexture[] = [];
  for (let cj = 0; cj < chunks; cj++) {
    const row: Phaser.GameObjects.RenderTexture[] = [];
    for (let ci = 0; ci < chunks; ci++) {
      const x0 = ci * CHUNK;
      const y0 = cj * CHUNK;
      const x1 = Math.min(side, x0 + CHUNK) - 1;
      const y1 = Math.min(side, y0 + CHUNK) - 1;
      const left = isoX(x0, y1) - TILE_W / 2;
      const right = isoX(x1, y0) + TILE_W / 2;
      const top = isoY(x0, y0) - TILE_H / 2 - 7 * LIFT;
      const bottom = isoY(x1, y1) + TILE_H / 2 + 4;
      const rt = scene.add
        .renderTexture(left, top, Math.ceil(right - left), Math.ceil(bottom - top))
        .setOrigin(0, 0)
        .setDepth(depth + (ci + cj) * 0.001)
        // Phaser 4's default "render" mode never executes queued stamp
        // commands; "all" flushes them on the next frame, then no-ops.
        .setRenderMode("all");
      row.push(rt);
      images.push(rt);
    }
    rts.push(row);
  }

  const stamp = (frame: string, tx: number, ty: number, oy: number, lift: number) => {
    const ci = Math.min(chunks - 1, Math.floor(tx / CHUNK));
    const cj = Math.min(chunks - 1, Math.floor(ty / CHUNK));
    const rt = rts[cj]![ci]!;
    rt.stamp(SHEET.terrain, frame, isoX(tx, ty) - rt.x, isoY(tx, ty) - lift - rt.y, {
      originX: 0.5,
      originY: oy,
    });
  };

  // painter order: back-to-front diagonals so cliff skirts layer correctly
  for (let d = 0; d <= (side - 1) * 2; d++) {
    for (let tx = Math.max(0, d - side + 1); tx <= Math.min(side - 1, d); tx++) {
      const ty = d - tx;
      const i = ty * side + tx;
      if (t.isWater(tx, ty)) {
        const lift = t.waterLiftAt(tx, ty);
        let m = 0;
        if (tx - 1 >= 0 && !t.isWater(tx - 1, ty)) m |= 1; // NW land
        if (ty - 1 >= 0 && !t.isWater(tx, ty - 1)) m |= 2; // NE land
        if (ty + 1 < side && !t.isWater(tx, ty + 1)) m |= 4; // SW land
        if (tx + 1 < side && !t.isWater(tx + 1, ty)) m |= 8; // SE land
        let frame: string;
        if (m === 0) frame = rng() < 0.03 ? pick(T.waterIsles) : pick(T.water);
        else if (lift > 0) {
          // canal tiles: banks are stone lips, never grassy shores — plain
          // water keeps the channel an unbroken ribbon
          frame = pick(T.water);
        } else {
          const table =
            T.shore[m] ?? T.shore[m & 3] ?? T.shore[m & 12] ?? T.shore[m & 5] ?? T.shore[m & 10];
          frame = table ? pick(table) : pick(T.water);
        }
        stamp(frame, tx, ty, FLOOR_ORIGIN_Y, lift);
        miniColors[i] = MINI.water;
        continue;
      }
      const h = t.heightAt(tx, ty);
      // terrace rim: stack cliff blocks from the lowest front neighbor up, so
      // multi-level drops (mounts, ring cores, canyon shelves) read as walls
      const minFront = Math.min(
        tx + 1 < side ? t.heightAt(tx + 1, ty) : h,
        ty + 1 < side ? t.heightAt(tx, ty + 1) : h,
      );
      if (h > 0 && minFront < h) {
        for (let lv = Math.max(1, minFront + 1); lv <= h; lv++) {
          // block's top diamond center sits 16px below the frame top
          stamp(pick(T.cliff), tx, ty, 16 / 64, lv * LIFT);
        }
        miniColors[i] = shade(MINI.cliff, (h - 1) * 0.1);
        continue;
      }
      let frame: string;
      if (t.isRoad(tx, ty)) {
        frame = pick(T.dirt);
        miniColors[i] = MINI.road;
      } else if (map.streets.has(`${tx},${ty}`)) {
        // dependency streets: worn paths, quieter than the tree roads
        frame = pick(T.dirt);
        miniColors[i] = MINI.street;
      } else {
        const decor = fbm2(tx * 0.5, ty * 0.5, seed ^ 0x1b) > 0.62 && rng() < 0.5;
        frame = decor ? pick(T.grassDecor) : pick(T.grass);
        miniColors[i] = h > 0 ? shade(MINI.city, (h - 1) * 0.1) : MINI.grass;
      }
      stamp(frame, tx, ty, FLOOR_ORIGIN_Y, h * LIFT);
    }
  }

  return { images, miniColors };
}

// ---------------------------------------------------------------------------
// Flora scatter: wilderness forest ring + sparse cosmetic tufts in the city.
// ---------------------------------------------------------------------------

export type FloraSpot = { frame: string; x: number; y: number };

export function floraSpots(map: MapLayout, t: TerrainInfo, seed: number, max = 620): FloraSpot[] {
  const rng = mulberry32((seed ^ 0x0f10e4) >>> 0);
  const out: FloraSpot[] = [];
  const side = t.side;
  const pick = (arr: readonly string[]) => arr[Math.floor(rng() * arr.length)]!;
  for (let ty = 0; ty < side && out.length < max; ty++) {
    for (let tx = 0; tx < side && out.length < max; tx++) {
      const key = `${tx},${ty}`;
      if (map.used.has(key) || map.roads.has(key) || map.streets.has(key)) continue;
      if (t.isWater(tx, ty)) continue;
      const city = t.inCity(tx, ty);
      const edge = Math.min(tx, ty, side - 1 - tx, side - 1 - ty);
      const mask = fbm2(tx * 0.22, ty * 0.22, seed ^ 0x51);
      let chance: number;
      if (city) chance = 0.015; // only stray tufts between buildings
      else if (edge <= 1) chance = 0.85;
      else if (edge <= 3) chance = 0.5 + mask * 0.3;
      else chance = mask > 0.55 ? 0.42 : 0.14;
      if (rng() >= chance) continue;
      map.used.add(key);
      const r = rng();
      let frame: string;
      if (city) frame = r < 0.7 ? pick(T.ground) : pick(T.bushes);
      else if (r < 0.44) frame = pick(T.pines);
      else if (r < 0.56) frame = pick(T.oaks);
      else if (r < 0.66) frame = pick(T.deadTrees);
      else if (r < 0.8) frame = pick(T.bushes);
      else if (r < 0.9) frame = pick(T.rocks);
      else frame = pick(T.ground);
      const jx = tx + (rng() - 0.5) * 0.6;
      const jy = ty + (rng() - 0.5) * 0.6;
      out.push({ frame, x: isoX(jx, jy), y: t.groundY(jx, jy) + TILE_H / 4 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Soft-edged ground tint over a tile rect (theme patches, deep-block bases).
// ---------------------------------------------------------------------------

export function tintSplatTexture(
  scene: Phaser.Scene,
  key: string,
  t: TerrainInfo,
  rect: Rect,
  color: number,
  strength = 0.3,
): { key: string; x: number; y: number } {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const x1 = rect.x + rect.w - 1;
  const y1 = rect.y + rect.h - 1;
  const left = isoX(rect.x, y1) - TILE_W / 2;
  const right = isoX(x1, rect.y) + TILE_W / 2;
  const top = isoY(rect.x, rect.y) - TILE_H / 2 - 2 * LIFT;
  const bottom = isoY(x1, y1) + TILE_H / 2;
  const w = Math.max(2, Math.ceil(right - left));
  const h = Math.max(2, Math.ceil(bottom - top));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const css = `rgba(${(color >> 16) & 0xff},${(color >> 8) & 0xff},${color & 0xff},`;
  for (let ty = rect.y; ty <= y1; ty++) {
    for (let tx = rect.x; tx <= x1; tx++) {
      if (t.isWater(tx, ty)) continue;
      const cx = isoX(tx, ty) - left;
      const cy = t.groundY(tx, ty) - top;
      const edgeDist = Math.min(tx - rect.x, ty - rect.y, x1 - tx, y1 - ty);
      const alpha = edgeDist === 0 ? strength * 0.55 : strength;
      const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, TILE_W * 0.62);
      grad.addColorStop(0, css + alpha + ")");
      grad.addColorStop(1, css + "0)");
      ctx.fillStyle = grad;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, TILE_W * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  scene.textures.addCanvas(key, canvas);
  return { key, x: left, y: top };
}
