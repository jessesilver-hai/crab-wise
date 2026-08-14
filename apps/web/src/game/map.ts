import type { FileNode } from "@agent-empires/protocol";

export const TILE_W = 64;
export const TILE_H = 32;
/** Screen px one terrace level lifts the ground (classic 2:1 dimetric step). */
export const STEP = 10;

export type Rect = { x: number; y: number; w: number; h: number };

export type MapLayout = {
  side: number;
  regions: { path: string; label: string; rect: Rect; depth: number }[];
  plots: Map<string, { tx: number; ty: number }>;
  /** Tiles occupied by buildings (so trees avoid them). */
  used: Set<string>;
  townCenter: { tx: number; ty: number };
  rng: () => number;
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function countFiles(node: FileNode): number {
  if (node.kind === "file") return 1;
  return (node.children ?? []).reduce((n, c) => n + countFiles(c), 0);
}

export function isoX(tx: number, ty: number): number {
  return ((tx - ty) * TILE_W) / 2;
}
export function isoY(tx: number, ty: number): number {
  return ((tx + ty) * TILE_H) / 2;
}

/** Classic 2:1 dimetric projection; h is terrace levels (lifts the point). */
export function worldToScreen(x: number, y: number, h: number): { sx: number; sy: number } {
  return { sx: isoX(x, y), sy: isoY(x, y) - h * STEP };
}

/** Inverse projection at a given height level (h = 0 for flat picking). */
export function screenToWorld(sx: number, sy: number, h = 0): { x: number; y: number } {
  const syh = sy + h * STEP;
  const u = sx / (TILE_W / 2); // x − y
  const v = syh / (TILE_H / 2); // x + y
  return { x: (u + v) / 2, y: (v - u) / 2 };
}

/**
 * Slice-and-dice treemap over the tile grid: each directory gets a rectangle
 * proportional to its file count; files get plot cells inside their rectangle.
 */
export function layoutMap(tree: FileNode, seed: number): MapLayout {
  const fileCount = Math.max(1, countFiles(tree));
  const side = Math.max(16, Math.ceil(Math.sqrt(fileCount * 12)) + 10);
  const rng = mulberry32(seed);
  const regions: MapLayout["regions"] = [];
  const plots = new Map<string, { tx: number; ty: number }>();
  const used = new Set<string>();

  const rootRect: Rect = { x: 1, y: 1, w: side - 2, h: side - 2 };

  function placeFiles(files: FileNode[], rect: Rect) {
    // Prefer every-other-tile spacing; densify if the plot overflows.
    const cells: { tx: number; ty: number }[] = [];
    for (let step of [2, 1]) {
      cells.length = 0;
      for (let ty = rect.y; ty < rect.y + rect.h; ty += step) {
        for (let tx = rect.x; tx < rect.x + rect.w; tx += step) {
          if (!used.has(`${tx},${ty}`)) cells.push({ tx, ty });
        }
      }
      if (cells.length >= files.length) break;
    }
    // Center-out ordering so important files sit mid-region.
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    cells.sort((a, b) => (Math.abs(a.tx - cx) + Math.abs(a.ty - cy)) - (Math.abs(b.tx - cx) + Math.abs(b.ty - cy)));
    files.forEach((f, i) => {
      const cell = cells[i] ?? cells[cells.length - 1] ?? { tx: rect.x, ty: rect.y };
      plots.set(f.path, cell);
      used.add(`${cell.tx},${cell.ty}`);
    });
  }

  function layout(node: FileNode, rect: Rect) {
    const children = node.children ?? [];
    const dirs = children.filter((c) => c.kind === "dir" && countFiles(c) > 0);
    const files = children.filter((c) => c.kind === "file");

    // Weight includes the dir's own loose files as a pseudo-child region.
    const parts: { node: FileNode | null; weight: number }[] = dirs.map((d) => ({
      node: d,
      weight: countFiles(d),
    }));
    if (files.length > 0) parts.push({ node: null, weight: files.length });
    if (parts.length === 0) return;

    const total = parts.reduce((n, p) => n + p.weight, 0);
    const horizontal = rect.w >= rect.h;
    let offset = horizontal ? rect.x : rect.y;
    const span = horizontal ? rect.w : rect.h;

    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      const size = isLast
        ? (horizontal ? rect.x + rect.w : rect.y + rect.h) - offset
        : Math.max(2, Math.round((part.weight / total) * span));
      const sub: Rect = horizontal
        ? { x: offset, y: rect.y, w: size, h: rect.h }
        : { x: rect.x, y: offset, w: rect.w, h: size };
      offset += size;
      if (part.node) {
        const depth = part.node.path.length === 0 ? 0 : part.node.path.split("/").length;
        regions.push({ path: part.node.path, label: part.node.name + "/", rect: sub, depth });
        layout(part.node, sub);
      } else {
        placeFiles(files, sub);
      }
    });
  }

  layout(tree, rootRect);

  // The Town Center stands at package.json's plot, or map center.
  const pkg = [...plots.keys()].find((p) => /(^|\/)package\.json$/.test(p));
  const center = Math.floor(side / 2);
  let townCenter = pkg ? plots.get(pkg)! : { tx: center, ty: center };
  if (!pkg) used.add(`${center},${center}`);

  return { side, regions, plots, used, townCenter, rng };
}

/** Assign a plot for a file created mid-match: nearest free cell to its dir region. */
export function assignPlot(map: MapLayout, path: string): { tx: number; ty: number } {
  const existing = map.plots.get(path);
  if (existing) return existing;
  const dir = path.split("/").slice(0, -1).join("/");
  const region = map.regions.find((r) => r.path === dir);
  const rect = region?.rect ?? { x: 1, y: 1, w: map.side - 2, h: map.side - 2 };
  for (let radius = 0; radius < map.side; radius++) {
    for (let ty = rect.y - radius; ty < rect.y + rect.h + radius; ty++) {
      for (let tx = rect.x - radius; tx < rect.x + rect.w + radius; tx++) {
        if (tx < 1 || ty < 1 || tx >= map.side - 1 || ty >= map.side - 1) continue;
        if (!map.used.has(`${tx},${ty}`)) {
          const cell = { tx, ty };
          map.plots.set(path, cell);
          map.used.add(`${tx},${ty}`);
          return cell;
        }
      }
    }
  }
  const fallback = { tx: 1, ty: 1 };
  map.plots.set(path, fallback);
  return fallback;
}
