import Phaser from "phaser";
import { isoX, isoY, MapLayout, Rect, STEP, TILE_H, TILE_W } from "./map.js";

/**
 * Painterly isometric ground: instead of stamping per-tile diamonds, the whole
 * diamond is rendered once into a handful of chunked canvas textures. Biome
 * colors are noise-blended fields, district boundaries are domain-warped (no
 * straight grid lines), the waterline is an organic coast, terraces come from
 * a smoothed heightfield solved per pixel, and worn trails connect district
 * centers. Everything is seeded by mapSeed so chunks tile seamlessly.
 */

// --- deterministic value noise ----------------------------------------------

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function sm(t: number): number {
  return t * t * (3 - 2 * t);
}

export function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = sm(x - ix);
  const fy = sm(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Two-octave value noise in [0,1). */
export function fbm2(x: number, y: number, seed: number): number {
  return vnoise(x, y, seed) * 0.65 + vnoise(x * 2.17, y * 2.17, seed ^ 0x9e3779) * 0.35;
}

// --- field: elevation, districts, water, trails ------------------------------

export type GroundField = {
  side: number;
  seed: number;
  /** Water threshold on (x + y + coastNoise); Infinity = no water. */
  waterT: number;
  /** Smoothed terrace heights (0..2), one value per tile center. */
  elev: Float32Array;
  /** Deepest region index per tile (−1 = repo root). */
  district: Int16Array;
  regions: MapLayout["regions"];
  /** Trail polylines in tile coordinates. */
  trails: { x: number; y: number }[][];
  elevAt(x: number, y: number): number;
  waterAt(x: number, y: number): boolean;
  /** Screen y of the ground surface under fractional tile coords. */
  groundY(x: number, y: number): number;
};

/** Tiles with x+y+coastNoise ≥ returned threshold are water (≈ coverage). */
function waterThreshold(side: number, coverage: number): number {
  if (coverage <= 0.01) return Number.POSITIVE_INFINITY;
  const target = coverage * side * side;
  let acc = 0;
  for (let v = 2 * side - 2; v >= 0; v--) {
    acc += side - Math.abs(v - (side - 1));
    if (acc >= target) return v;
  }
  return 0;
}

function coastNoise(x: number, y: number, seed: number): number {
  return (fbm2(x * 0.23, y * 0.23, seed ^ 0xaa17) - 0.5) * 7;
}

export function buildGroundField(map: MapLayout, seed: number, waterCoverage: number): GroundField {
  const side = map.side;
  const n = side * side;
  const waterT = waterThreshold(side, waterCoverage);

  // deepest region wins each tile
  const district = new Int16Array(n).fill(-1);
  const depth = new Uint8Array(n);
  map.regions.forEach((r, idx) => {
    for (let ty = r.rect.y; ty < r.rect.y + r.rect.h; ty++) {
      for (let tx = r.rect.x; tx < r.rect.x + r.rect.w; tx++) {
        if (tx < 0 || ty < 0 || tx >= side || ty >= side) continue;
        const i = ty * side + tx;
        if (r.depth >= depth[i]!) {
          depth[i] = r.depth;
          district[i] = idx;
        }
      }
    }
  });

  const waterAt = (x: number, y: number): boolean => x + y + coastNoise(x, y, seed) >= waterT;

  // raw terracing: directory depth (0–2 steps), flattened to 0 in water
  let elev: Float32Array = new Float32Array(n);
  for (let ty = 0; ty < side; ty++) {
    for (let tx = 0; tx < side; tx++) {
      const i = ty * side + tx;
      elev[i] = waterAt(tx, ty) ? 0 : Math.min(2, depth[i]!);
    }
  }

  const blurPass = (src: Float32Array, mask?: Uint8Array): Float32Array => {
    const out = new Float32Array(n);
    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const i = ty * side + tx;
        if (mask && !mask[i]) {
          out[i] = src[i]!;
          continue;
        }
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = tx + dx;
            const y = ty + dy;
            if (x < 0 || y < 0 || x >= side || y >= side) continue;
            sum += src[y * side + x]!;
            cnt++;
          }
        }
        out[i] = sum / cnt;
      }
    }
    return out;
  };
  for (let p = 0; p < 3; p++) elev = blurPass(elev);

  // trails: greedy spanning tree over sizable district centers + the citadel
  const centers: { x: number; y: number }[] = [
    { x: map.townCenter.tx, y: map.townCenter.ty },
    ...map.regions
      .filter((r) => r.rect.w * r.rect.h >= 6)
      .map((r) => ({ x: r.rect.x + r.rect.w / 2, y: r.rect.y + r.rect.h / 2 })),
  ];
  const trails: { x: number; y: number }[][] = [];
  const connected = [centers[0]!];
  const remaining = centers.slice(1);
  while (remaining.length > 0) {
    let bi = 0;
    let bj = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < connected.length; i++) {
      for (let j = 0; j < remaining.length; j++) {
        const d = Math.hypot(connected[i]!.x - remaining[j]!.x, connected[i]!.y - remaining[j]!.y);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const a = connected[bi]!;
    const b = remaining.splice(bj, 1)[0]!;
    connected.push(b);
    // wobbled polyline: perpendicular fbm offset, strongest mid-span
    const pts: { x: number; y: number }[] = [];
    const segs = Math.max(6, Math.round(best * 1.5));
    const px = -(b.y - a.y) / (best || 1);
    const py = (b.x - a.x) / (best || 1);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const wob =
        (fbm2(a.x + t * 31.7, a.y + t * 17.3, seed ^ 0x7a1) - 0.5) *
        Math.sin(Math.PI * t) *
        Math.min(4, best * 0.25);
      pts.push({ x: a.x + (b.x - a.x) * t + px * wob, y: a.y + (b.y - a.y) * t + py * wob });
    }
    trails.push(pts);
  }

  // ramp smoothing: extra blur passes restricted to cells near trails
  const trailMask = new Uint8Array(n);
  for (const line of trails) {
    for (const p of line) {
      const cx = Math.round(p.x);
      const cy = Math.round(p.y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < side && y < side) trailMask[y * side + x] = 1;
        }
      }
    }
  }
  for (let p = 0; p < 4; p++) elev = blurPass(elev, trailMask);

  const elevAt = (x: number, y: number): number => {
    const cx = Math.min(side - 1.001, Math.max(0, x));
    const cy = Math.min(side - 1.001, Math.max(0, y));
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    const fx = cx - ix;
    const fy = cy - iy;
    const i = iy * side + ix;
    const x1 = Math.min(ix + 1, side - 1) - ix;
    const y1 = (Math.min(iy + 1, side - 1) - iy) * side;
    const a = elev[i]!;
    const b = elev[i + x1]!;
    const c = elev[i + y1]!;
    const d = elev[i + x1 + y1]!;
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };

  return {
    side,
    seed,
    waterT,
    elev,
    district,
    regions: map.regions,
    trails,
    elevAt,
    waterAt,
    groundY: (x, y) => isoY(x, y) - elevAt(x, y) * STEP,
  };
}

// --- painterly rendering ------------------------------------------------------

/** How a terrain palette gets textured; both archetype + spec patterns map here. */
export type PatternMode = "bands" | "cracks" | "specks" | "blotch" | "weave";

export type GroundStyle = {
  /** Biome color ramp, darkest → lightest. */
  palette: number[];
  mode: PatternMode;
  water?: { color: number };
  /** Relief 0..1 scales pattern contrast. */
  relief: number;
};

export type PaintedGround = {
  chunks: { key: string; x: number; y: number }[];
  /** Screen-space points along the waterline (for animated foam). */
  coast: { x: number; y: number }[];
};

/** Canvas px per world px; painterly softness tolerates the upscale. */
const RES = 0.5;
const CHUNK_WORLD_W = 2048;
const MAX_COAST = 90;

function channels(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}

export function paintGround(
  scene: Phaser.Scene,
  field: GroundField,
  style: GroundStyle,
  gen: number,
): PaintedGround {
  const { side, seed, waterT } = field;
  const leftW = -side * (TILE_W / 2) - 4;
  const rightW = side * (TILE_W / 2) + 4;
  const topW = -TILE_H / 2 - 2 * STEP - 6;
  const bottomW = isoY(side - 1, side - 1) + TILE_H / 2 + 4;
  const canvasH = Math.ceil((bottomW - topW) * RES);

  const pal = style.palette.map(channels);
  const nPal = pal.length;
  const waterC = style.water ? channels(style.water.color) : null;
  const deepC = waterC ? (waterC.map((v) => v * 0.62) as [number, number, number]) : null;
  const relief = 0.35 + style.relief * 0.65;

  // per-district brightness/temperature offsets so directories read as biomes
  const dOff: number[] = field.regions.map((_, i) => (hash2(i, 7, seed) - 0.5) * 0.34);

  const chunks: PaintedGround["chunks"] = [];
  const coast: PaintedGround["coast"] = [];
  const nChunks = Math.ceil((rightW - leftW) / CHUNK_WORLD_W);

  const trailDark = pal[0]!.map((v) => v * 0.55) as [number, number, number];
  const trailLight = pal[nPal - 1]!.map((v) => Math.min(255, v * 1.12)) as [number, number, number];

  for (let ci = 0; ci < nChunks; ci++) {
    const chunkLeft = leftW + ci * CHUNK_WORLD_W;
    const chunkRight = Math.min(rightW, chunkLeft + CHUNK_WORLD_W);
    const cw = Math.ceil((chunkRight - chunkLeft) * RES);
    if (cw <= 0) continue;

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(cw, canvasH);
    const data = img.data;

    let rowH: Float32Array = new Float32Array(cw);
    let prevRowH: Float32Array = new Float32Array(cw);

    for (let cy = 0; cy < canvasH; cy++) {
      const sy = topW + (cy + 0.5) / RES;
      const tmp = prevRowH;
      prevRowH = rowH;
      rowH = tmp;
      for (let cx = 0; cx < cw; cx++) {
        const o = (cy * cw + cx) * 4;
        const sx = chunkLeft + (cx + 0.5) / RES;

        // solve the visible surface height (fixed point on the smoothed field);
        // elevAt clamps outside samples, so lifted terrain can legitimately
        // cover pixels just above the flat diamond outline
        let h = 0;
        let wx = 0;
        let wy = 0;
        const u = sx / (TILE_W / 2);
        for (let it = 0; it < 3; it++) {
          const v = (sy + h * STEP) / (TILE_H / 2);
          wx = (u + v) / 2;
          wy = (v - u) / 2;
          h = field.elevAt(wx, wy);
        }
        rowH[cx] = h;

        if (wx < -0.5 || wy < -0.5 || wx > side - 0.5 || wy > side - 0.5) {
          data[o + 3] = 0;
          continue;
        }

        let r: number;
        let g: number;
        let b: number;

        const wv = wx + wy + coastNoise(wx, wy, seed);
        if (waterC && deepC && wv >= waterT) {
          // organic water: depth-lerped color, static wave shimmer, foam rim
          const d = wv - waterT;
          const t = Math.min(1, d / 5);
          const wave = (vnoise(wx * 1.9, wy * 1.9, seed ^ 0x33) - 0.5) * 0.16 + 1;
          r = (waterC[0] + (deepC[0] - waterC[0]) * t) * wave;
          g = (waterC[1] + (deepC[1] - waterC[1]) * t) * wave;
          b = (waterC[2] + (deepC[2] - waterC[2]) * t) * wave;
          if (d < 0.5) {
            const f = (0.5 - d) * 1.4;
            r += (235 - r) * f;
            g += (240 - g) * f;
            b += (240 - b) * f;
            if (d < 0.35 && (cx & 15) === 0 && (cy & 15) === 0 && coast.length < MAX_COAST) {
              coast.push({ x: sx, y: sy });
            }
          }
        } else {
          // biome color field: domain-warped district lookup + noise ramp
          const warp = 2.6;
          const dx = (vnoise(wx * 0.35, wy * 0.35, seed ^ 0x51) - 0.5) * warp;
          const dy = (vnoise(wx * 0.35, wy * 0.35, seed ^ 0xc4) - 0.5) * warp;
          const lx = Math.min(side - 1, Math.max(0, Math.round(wx + dx)));
          const ly = Math.min(side - 1, Math.max(0, Math.round(wy + dy)));
          const di = field.district[ly * side + lx]!;
          const off = di >= 0 ? dOff[di]! : 0;

          let t = fbm2(wx * 0.33, wy * 0.33, seed ^ 0x77) + off;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const fi = t * (nPal - 1);
          const i0 = Math.min(nPal - 2, Math.floor(fi));
          const ft = fi - i0;
          const c0 = pal[i0]!;
          const c1 = pal[i0 + 1]!;
          r = c0[0]! + (c1[0]! - c0[0]!) * ft;
          g = c0[1]! + (c1[1]! - c0[1]!) * ft;
          b = c0[2]! + (c1[2]! - c0[2]!) * ft;

          // pattern flavor + per-pixel dither: kills banding, adds grain
          const hi = vnoise(wx * 3.1, wy * 3.1, seed ^ 0x1b);
          let mod = (hash2(cx + ci * 8192, cy, seed) - 0.5) * 0.06;
          switch (style.mode) {
            case "bands":
              mod += Math.sin((wx + wy) * 2.1 + fbm2(wx * 0.2, wy * 0.2, seed ^ 0x8) * 6) * 0.05 * relief;
              break;
            case "cracks":
              if (hi > 0.84) mod -= 0.11 * relief;
              break;
            case "specks":
              if (hi > 0.86) mod += 0.13 * relief;
              break;
            case "blotch":
              if (vnoise(wx * 0.9, wy * 0.9, seed ^ 0x2d) > 0.62) mod -= 0.07 * relief;
              break;
            case "weave":
              mod += Math.sin(wx * 3.2) * Math.sin(wy * 3.2) * 0.045 * relief;
              break;
          }

          // shoreline sand lightening just above the waterline
          if (Number.isFinite(waterT) && wv > waterT - 1.4) {
            mod += ((wv - (waterT - 1.4)) / 1.4) * 0.22;
          }

          // terrace lighting: height lightens, south/east-facing drops darken
          const dh = h - prevRowH[cx]!;
          let lum = 1 + h * 0.06 + mod;
          lum *= Math.min(1.25, Math.max(0.45, 1 + dh * 7));

          // soft dark rim at the diamond's edge so the island reads as carved
          const edge = Math.min(wx + 0.5, wy + 0.5, side - 0.5 - wx, side - 0.5 - wy);
          if (edge < 0.55) lum *= 0.72 + (edge / 0.55) * 0.28;

          r *= lum;
          g *= lum;
          b *= lum;
        }

        data[o] = r > 255 ? 255 : r < 0 ? 0 : r;
        data[o + 1] = g > 255 ? 255 : g < 0 ? 0 : g;
        data[o + 2] = b > 255 ? 255 : b < 0 ? 0 : b;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // worn trails: wide faded wear + lighter packed core, curved through wobble
    ctx.save();
    ctx.scale(RES, RES);
    ctx.translate(-chunkLeft, -topW);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const [wPass, width, alpha] of [
      [trailDark, 9, 0.16],
      [trailLight, 3.2, 0.2],
    ] as const) {
      ctx.strokeStyle = `rgba(${wPass[0] | 0},${wPass[1] | 0},${wPass[2] | 0},${alpha})`;
      ctx.lineWidth = width;
      for (const line of field.trails) {
        ctx.beginPath();
        line.forEach((p, i) => {
          const px = isoX(p.x, p.y);
          const py = field.groundY(p.x, p.y);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
    }
    ctx.restore();

    const key = `g${gen}-groundchunk-${ci}`;
    if (scene.textures.exists(key)) scene.textures.remove(key);
    scene.textures.addCanvas(key, canvas);
    chunks.push({ key, x: chunkLeft, y: topW });
  }

  return { chunks, coast };
}

/**
 * Soft-edged district tint blob for theme_patch: overlapping seeded radial
 * splats roughly covering the district rect, so the recolor has no straight
 * edges. Returned image is placed just above the ground chunks.
 */
export function districtTintTexture(
  scene: Phaser.Scene,
  key: string,
  field: GroundField,
  rect: Rect,
  tint: number,
): { key: string; x: number; y: number } {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [tx, ty] of corners) {
    const sx = isoX(tx, ty);
    const sy = isoY(tx, ty);
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy - 2 * STEP);
    maxY = Math.max(maxY, sy);
  }
  const pad = TILE_W;
  minX -= pad;
  maxX += pad;
  minY -= pad / 2;
  maxY += pad / 2;

  const w = Math.max(8, Math.ceil((maxX - minX) * RES));
  const h = Math.max(8, Math.ceil((maxY - minY) * RES));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(RES, RES);
  ctx.translate(-minX, -minY);

  const [r, g, b] = channels(tint);
  const seedBase = (field.seed ^ (rect.x * 73 + rect.y * 149)) | 0;
  const baseRad = (Math.max(rect.w, rect.h) * TILE_W) / 2;
  const splats = 10;
  for (let i = 0; i < splats; i++) {
    const fx = rect.x + 0.5 + hash2(i, 11, seedBase) * Math.max(1, rect.w - 1);
    const fy = rect.y + 0.5 + hash2(i, 29, seedBase) * Math.max(1, rect.h - 1);
    const cx = isoX(fx, fy);
    const cy = field.groundY(fx, fy);
    const rad = baseRad * (0.28 + hash2(i, 47, seedBase) * 0.3);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.32)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    // gradients are circular; squash vertically to match the iso ellipse
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.55);
    ctx.translate(-cx, -cy);
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    ctx.restore();
  }

  if (scene.textures.exists(key)) scene.textures.remove(key);
  scene.textures.addCanvas(key, canvas);
  return { key, x: minX, y: minY };
}

/** Display scale for painterly canvases (they render at RES canvas px/world px). */
export const GROUND_SCALE = 1 / RES;
