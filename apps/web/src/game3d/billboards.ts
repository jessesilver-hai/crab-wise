// Canvas-texture billboards: name tags, speech bubbles, status glyphs,
// floating text. Textures are cached by (text|style) so repeated glyphs and
// labels never re-rasterize.
import * as THREE from "three";

export type BillboardStyle = {
  font?: string;
  sizePx?: number;
  color?: string;
  bg?: string;
  border?: string;
  pad?: number;
  bold?: boolean;
  maxWidthPx?: number;
  /** World-space height of the rendered sprite. */
  worldH?: number;
};

type CacheEntry = { texture: THREE.CanvasTexture; w: number; h: number; refs: number };
const cache = new Map<string, CacheEntry>();

function rasterize(text: string, s: Required<Omit<BillboardStyle, "worldH">>): CacheEntry {
  const key = `${text}|${s.font}|${s.sizePx}|${s.color}|${s.bg}|${s.border}|${s.pad}|${s.bold}|${s.maxWidthPx}`;
  const hit = cache.get(key);
  if (hit) {
    hit.refs++;
    return hit;
  }
  const dpr = 2;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = `${s.bold ? "bold " : ""}${s.sizePx}px ${s.font}`;
  ctx.font = font;

  // word-wrap into lines
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(" ")) {
      const probe = line ? `${line} ${word}` : word;
      if (ctx.measureText(probe).width > s.maxWidthPx && line) {
        lines.push(line);
        line = word;
      } else line = probe;
    }
    lines.push(line);
  }
  const lineH = Math.ceil(s.sizePx * 1.25);
  const textW = Math.max(4, ...lines.map((l) => Math.ceil(ctx.measureText(l).width)));
  const w = textW + s.pad * 2;
  const h = lines.length * lineH + s.pad * 2;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  if (s.bg !== "none") {
    ctx.fillStyle = s.bg;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 4);
    ctx.fill();
    if (s.border !== "none") {
      ctx.strokeStyle = s.border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.font = font;
  ctx.fillStyle = s.color;
  ctx.textBaseline = "top";
  if (s.bg === "none") {
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }
  lines.forEach((l, i) => ctx.fillText(l, s.pad, s.pad + i * lineH + 1));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const entry: CacheEntry = { texture, w, h, refs: 1 };
  cache.set(key, entry);
  // hard cap: evict unreferenced textures when the cache balloons
  if (cache.size > 400) {
    for (const [k, e] of cache) {
      if (e.refs <= 0) {
        e.texture.dispose();
        cache.delete(k);
        if (cache.size <= 300) break;
      }
    }
  }
  return entry;
}

export type Billboard = {
  sprite: THREE.Sprite;
  /** World width/height of the sprite. */
  w: number;
  h: number;
  dispose(): void;
};

export function makeBillboard(text: string, style: BillboardStyle = {}): Billboard {
  const s = {
    font: style.font ?? "IBM Plex Mono, monospace",
    sizePx: style.sizePx ?? 22,
    color: style.color ?? "#efe6cd",
    bg: style.bg ?? "none",
    border: style.border ?? "none",
    pad: style.pad ?? 6,
    bold: style.bold ?? false,
    maxWidthPx: style.maxWidthPx ?? 420,
  };
  const entry = rasterize(text, s);
  const mat = new THREE.SpriteMaterial({
    map: entry.texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  const worldH = style.worldH ?? 0.34;
  const worldW = worldH * (entry.w / entry.h);
  sprite.scale.set(worldW, worldH, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 50;
  let disposed = false;
  return {
    sprite,
    w: worldW,
    h: worldH,
    dispose() {
      if (disposed) return;
      disposed = true;
      entry.refs--;
      mat.dispose();
      sprite.removeFromParent();
    },
  };
}
