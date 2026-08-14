import { districtArchetype, type DistrictArchetype, type FileNode } from "@agent-empires/protocol";

/**
 * Structural-isomorphism layout: the settlement is a recursive treemap of the
 * repository. Every directory is a rectangular quarter whose area is
 * proportional to its subtree weight (file LOC when FileNode.lines ships,
 * else file count); every file is a building plot; roads are exactly the
 * parent↔child tree edges. The layout is a pure function of
 * (repoTree, weights, mapSeed) — no unseeded randomness anywhere.
 */

export const TILE_W = 64;
export const TILE_H = 32;
/** Screen px one terrace level lifts the ground (kept for compatibility). */
export const STEP = 10;

/** Above this many files, the smallest overflow into per-directory hamlets. */
export const MAX_INDIVIDUAL_BUILDINGS = 1200;
export const AGGREGATE_THRESHOLD = 1500;

/** Wilderness ring around the city plateau (purely cosmetic terrain). */
export const WILD_MARGIN = 7;

export type Rect = { x: number; y: number; w: number; h: number };

/** LOC bucket → building size class (0 hut, 1 house, 2 large workshop). */
export type SizeBucket = 0 | 1 | 2;

export type Quarter = {
  path: string;
  label: string;
  /** Full quarter rect including its wall ring, in tile coords. */
  rect: Rect;
  depth: number; // 1..3 → walled
  parentPath: string;
  gate: { tx: number; ty: number };
  archetype: DistrictArchetype;
};

/** Directories deeper than 3: unwalled blocks with a shared ground tint. */
export type Block = { path: string; rect: Rect; depth: number };

export type Hamlet = {
  dirPath: string;
  tx: number;
  ty: number;
  count: number;
  paths: string[];
};

export type MapLayout = {
  side: number;
  cityRect: Rect;
  quarters: Quarter[];
  blocks: Block[];
  /** One plot per individually rendered file. */
  plots: Map<string, { tx: number; ty: number }>;
  buckets: Map<string, SizeBucket>;
  weights: Map<string, number>;
  hamlets: Hamlet[];
  /** Road tiles — exactly the parent↔child edges of the tree. */
  roads: Set<string>;
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

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

type MaybeLines = FileNode & { lines?: number };

/** File weight = LOC when the protocol ships it, else 1. */
export function fileWeight(node: FileNode): number {
  const lines = (node as MaybeLines).lines;
  return typeof lines === "number" && lines > 0 ? lines : 1;
}

function subtreeWeight(node: FileNode): number {
  if (node.kind === "file") return fileWeight(node);
  return (node.children ?? []).reduce((n, c) => n + subtreeWeight(c), 0);
}

function countFiles(node: FileNode): number {
  if (node.kind === "file") return 1;
  return (node.children ?? []).reduce((n, c) => n + countFiles(c), 0);
}

export function bucketFor(weight: number, hasLines: boolean): SizeBucket {
  if (!hasLines) return 1;
  if (weight >= 400) return 2;
  if (weight >= 80) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Tile-area estimate for sizing the map before partitioning. */
function areaEstimate(node: FileNode, individual: Set<string>, depth: number): number {
  if (node.kind === "file") return individual.has(node.path) ? 3 : 0.2;
  let a = 0;
  for (const c of node.children ?? []) a += areaEstimate(c, individual, depth + 1);
  // wall ring + road gaps overhead per walled quarter
  return a + (depth <= 3 ? Math.max(14, Math.sqrt(a) * 4) : 6);
}

type Item =
  | { kind: "dir"; node: FileNode; weight: number; min: number }
  | { kind: "files"; files: FileNode[]; weight: number; min: number };

/**
 * Deterministic binary treemap split: sort-stable greedy halving along the
 * rect's longer axis, with a 1-tile road corridor between the two groups.
 * Recurses until every item owns its own sub-rect.
 */
function partition(rect: Rect, items: Item[], assign: (item: Item, r: Rect) => void): void {
  if (items.length === 0) return;
  if (items.length === 1) {
    assign(items[0]!, rect);
    return;
  }
  const total = items.reduce((n, i) => n + i.weight, 0);
  // greedy halving: walk items (already deterministically ordered) until
  // half the weight is on the left
  let acc = 0;
  let split = 1;
  for (let i = 0; i < items.length - 1; i++) {
    acc += items[i]!.weight;
    split = i + 1;
    if (acc >= total / 2) break;
  }
  const a = items.slice(0, split);
  const b = items.slice(split);
  const wa = a.reduce((n, i) => n + i.weight, 0);
  const minA = Math.max(1, ...a.map((i) => i.min));
  const minB = Math.max(1, ...b.map((i) => i.min));
  const horizontal = rect.w >= rect.h;
  const span = horizontal ? rect.w : rect.h;
  if (span < minA + minB + 1) {
    // no room for a corridor: split without one (degenerate small quarters)
    let size = Math.max(minA, Math.min(span - minB, Math.round((wa / total) * span)));
    size = Math.max(1, Math.min(span - 1, size));
    const ra: Rect = horizontal
      ? { x: rect.x, y: rect.y, w: size, h: rect.h }
      : { x: rect.x, y: rect.y, w: rect.w, h: size };
    const rb: Rect = horizontal
      ? { x: rect.x + size, y: rect.y, w: rect.w - size, h: rect.h }
      : { x: rect.x, y: rect.y + size, w: rect.w, h: rect.h - size };
    partition(ra, a, assign);
    partition(rb, b, assign);
    return;
  }
  let size = Math.round((wa / total) * (span - 1));
  size = Math.max(minA, Math.min(span - 1 - minB, size));
  const ra: Rect = horizontal
    ? { x: rect.x, y: rect.y, w: size, h: rect.h }
    : { x: rect.x, y: rect.y, w: rect.w, h: size };
  const rb: Rect = horizontal
    ? { x: rect.x + size + 1, y: rect.y, w: rect.w - size - 1, h: rect.h }
    : { x: rect.x, y: rect.y + size + 1, w: rect.w, h: rect.h - size - 1 };
  partition(ra, a, assign);
  partition(rb, b, assign);
}

export function layoutMap(tree: FileNode, seed: number): MapLayout {
  const rng = mulberry32(seed);
  const totalFiles = Math.max(1, countFiles(tree));

  // ---- aggregation set: which files render individually --------------------
  const allFiles: FileNode[] = [];
  (function collect(n: FileNode) {
    if (n.kind === "file") allFiles.push(n);
    for (const c of n.children ?? []) collect(c);
  })(tree);
  const hasLines = allFiles.some((f) => typeof (f as MaybeLines).lines === "number");
  let individual: Set<string>;
  if (totalFiles > AGGREGATE_THRESHOLD) {
    const ranked = [...allFiles].sort(
      (a, b) => fileWeight(b) - fileWeight(a) || (a.path < b.path ? -1 : 1),
    );
    individual = new Set(ranked.slice(0, MAX_INDIVIDUAL_BUILDINGS).map((f) => f.path));
  } else {
    individual = new Set(allFiles.map((f) => f.path));
  }

  // ---- map sizing -----------------------------------------------------------
  const est = areaEstimate(tree, individual, 1);
  const citySide = Math.max(22, Math.min(126, Math.ceil(Math.sqrt(est * 1.7)) + 4));
  const side = citySide + WILD_MARGIN * 2;
  const cityRect: Rect = { x: WILD_MARGIN, y: WILD_MARGIN, w: citySide, h: citySide };

  const quarters: Quarter[] = [];
  const blocks: Block[] = [];
  const plots = new Map<string, { tx: number; ty: number }>();
  const buckets = new Map<string, SizeBucket>();
  const weights = new Map<string, number>();
  const hamlets: Hamlet[] = [];
  const roads = new Set<string>();
  const used = new Set<string>();
  const filesAreas: { dirPath: string; files: FileNode[]; rect: Rect }[] = [];

  // ---- recursive rect assignment -------------------------------------------
  function layoutDir(node: FileNode, rect: Rect, depth: number): void {
    const walled = depth >= 1 && depth <= 3 && node.path !== "" && node.path !== ".";
    if (walled) {
      quarters.push({
        path: node.path,
        label: node.name + "/",
        rect,
        depth,
        parentPath: parentOf(node.path),
        gate: { tx: rect.x, ty: rect.y },
        archetype: districtArchetype(
          node.name,
          (node.children ?? []).filter((c) => c.kind === "file").map((c) => c.name),
        ),
      });
    } else if (depth > 3) {
      blocks.push({ path: node.path, rect, depth });
    }
    const interior: Rect = walled
      ? { x: rect.x + 1, y: rect.y + 1, w: Math.max(1, rect.w - 2), h: Math.max(1, rect.h - 2) }
      : rect;

    const children = node.children ?? [];
    // stable deterministic order: weight desc, then name
    const dirs = children
      .filter((c) => c.kind === "dir" && countFiles(c) > 0)
      .map((c) => ({ node: c, weight: subtreeWeight(c) }))
      .sort((a, b) => b.weight - a.weight || (a.node.name < b.node.name ? -1 : 1));
    const files = children
      .filter((c) => c.kind === "file")
      .sort((a, b) => fileWeight(b) - fileWeight(a) || (a.name < b.name ? -1 : 1));

    const items: Item[] = dirs.map((d) => ({
      kind: "dir" as const,
      node: d.node,
      weight: Math.max(1, d.weight),
      min: depth + 1 <= 3 ? 5 : 3,
    }));
    if (files.length > 0 || items.length === 0) {
      items.push({
        kind: "files",
        files,
        weight: Math.max(1, files.reduce((n, f) => n + fileWeight(f), 0)),
        min: 2,
      });
    }
    partition(interior, items, (item, r) => {
      if (item.kind === "dir") layoutDir(item.node, r, depth + 1);
      else filesAreas.push({ dirPath: node.path, files: item.files, rect: r });
    });
  }
  layoutDir(tree, cityRect, 0);

  // ---- town center: the root's own files area hosts the Citadel plaza ------
  const rootArea = filesAreas.find((a) => a.dirPath === tree.path);
  const plazaRect = rootArea?.rect ?? cityRect;
  const townCenter = {
    tx: Math.floor(plazaRect.x + plazaRect.w / 2),
    ty: Math.floor(plazaRect.y + plazaRect.h / 2),
  };
  // the castle claims a 3x3 pad
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) used.add(`${townCenter.tx + dx},${townCenter.ty + dy}`);
  }

  // ---- gates + roads: exactly the parent↔child edges ------------------------
  const quarterByPath = new Map(quarters.map((q) => [q.path, q]));
  const hubOf = (path: string): { tx: number; ty: number } => {
    const q = quarterByPath.get(path);
    return q ? q.gate : townCenter;
  };
  const insideForeign = (tx: number, ty: number, childPath: string): boolean =>
    quarters.some(
      (q) =>
        !childPath.startsWith(q.path + "/") &&
        childPath !== q.path &&
        tx >= q.rect.x &&
        ty >= q.rect.y &&
        tx < q.rect.x + q.rect.w &&
        ty < q.rect.y + q.rect.h,
    );
  // order by depth so parent gates exist before children route to them
  for (const q of [...quarters].sort((a, b) => a.depth - b.depth)) {
    const hub = hubOf(q.parentPath);
    // gate: border tile (non-corner) nearest the parent hub
    let best: { tx: number; ty: number } | null = null;
    let bestD = Infinity;
    const consider = (tx: number, ty: number) => {
      const d = Math.abs(tx - hub.tx) + Math.abs(ty - hub.ty);
      if (d < bestD) {
        bestD = d;
        best = { tx, ty };
      }
    };
    const { x, y, w, h } = q.rect;
    for (let tx = x + 1; tx < x + w - 1; tx++) {
      consider(tx, y);
      consider(tx, y + h - 1);
    }
    for (let ty = y + 1; ty < y + h - 1; ty++) {
      consider(x, ty);
      consider(x + w - 1, ty);
    }
    if (best) q.gate = best;
    // staircase road gate → parent hub; skip tiles inside unrelated quarters
    let px = q.gate.tx;
    let py = q.gate.ty;
    let guard = side * 4;
    const mark = (tx: number, ty: number) => {
      if (!insideForeign(tx, ty, q.path)) roads.add(`${tx},${ty}`);
    };
    mark(px, py);
    while ((px !== hub.tx || py !== hub.ty) && guard-- > 0) {
      if (px !== hub.tx && (py === hub.ty || (px + py) % 2 === 0)) px += Math.sign(hub.tx - px);
      else if (py !== hub.ty) py += Math.sign(hub.ty - py);
      mark(px, py);
    }
  }

  // ---- file plots ------------------------------------------------------------
  for (const area of filesAreas) {
    const rect = area.rect;
    const visible = area.files.filter((f) => individual.has(f.path));
    const overflow: FileNode[] = area.files.filter((f) => !individual.has(f.path));
    // candidate cells: prefer breathing room, densify when crowded
    let cells: { tx: number; ty: number }[] = [];
    for (const step of [2, 1]) {
      cells = [];
      for (let ty = rect.y; ty < rect.y + rect.h; ty += step) {
        for (let tx = rect.x; tx < rect.x + rect.w; tx += step) {
          const key = `${tx},${ty}`;
          if (!used.has(key) && !roads.has(key)) cells.push({ tx, ty });
        }
      }
      if (cells.length >= visible.length + (overflow.length > 0 ? 1 : 0)) break;
    }
    // center-out so heavy files sit mid-quarter (files are weight-ordered)
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    cells.sort(
      (a, b) =>
        Math.abs(a.tx - cx) + Math.abs(a.ty - cy) - (Math.abs(b.tx - cx) + Math.abs(b.ty - cy)) ||
        a.ty - b.ty ||
        a.tx - b.tx,
    );
    let ci = 0;
    for (const f of visible) {
      const cell = cells[ci++];
      if (!cell) {
        overflow.push(f); // out of room: aggregate honestly instead of stacking
        continue;
      }
      plots.set(f.path, cell);
      used.add(`${cell.tx},${cell.ty}`);
      const w = fileWeight(f);
      weights.set(f.path, w);
      buckets.set(f.path, bucketFor(w, hasLines));
    }
    if (overflow.length > 0) {
      const cell = cells[ci++] ?? { tx: rect.x, ty: rect.y };
      used.add(`${cell.tx},${cell.ty}`);
      hamlets.push({
        dirPath: area.dirPath,
        tx: cell.tx,
        ty: cell.ty,
        count: overflow.length,
        paths: overflow.map((f) => f.path),
      });
    }
  }

  return {
    side,
    cityRect,
    quarters,
    blocks,
    plots,
    buckets,
    weights,
    hamlets,
    roads,
    used,
    townCenter,
    rng,
  };
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Assign a plot for a file created mid-match: nearest free cell in its dir. */
export function assignPlot(map: MapLayout, path: string): { tx: number; ty: number } {
  const existing = map.plots.get(path);
  if (existing) return existing;
  const dir = parentOf(path);
  const quarter = map.quarters.find((q) => q.path === dir);
  const rect = quarter?.rect ?? map.cityRect;
  const cx = Math.floor(rect.x + rect.w / 2);
  const cy = Math.floor(rect.y + rect.h / 2);
  for (let radius = 0; radius < map.side; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 1 || ty < 1 || tx >= map.side - 1 || ty >= map.side - 1) continue;
        const key = `${tx},${ty}`;
        if (map.used.has(key) || map.roads.has(key)) continue;
        map.used.add(key);
        const cell = { tx, ty };
        map.plots.set(path, cell);
        map.buckets.set(path, 1);
        return cell;
      }
    }
  }
  const fallback = { tx: 1, ty: 1 };
  map.plots.set(path, fallback);
  return fallback;
}

/** Deepest quarter containing a path (for archetype styling + sieges). */
export function quarterOf(map: MapLayout, path: string): Quarter | null {
  let best: Quarter | null = null;
  for (const q of map.quarters) {
    if (path === q.path || path.startsWith(q.path + "/")) {
      if (!best || q.depth > best.depth) best = q;
    }
  }
  return best;
}

/** Stable digest of the structural layout — logged for determinism checks. */
export function layoutHash(map: MapLayout): string {
  let h = 5381 >>> 0;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  };
  mix(`side:${map.side};tc:${map.townCenter.tx},${map.townCenter.ty};`);
  for (const q of map.quarters) mix(`q:${q.path}:${q.rect.x},${q.rect.y},${q.rect.w},${q.rect.h},${q.gate.tx},${q.gate.ty};`);
  for (const b of map.blocks) mix(`b:${b.path}:${b.rect.x},${b.rect.y},${b.rect.w},${b.rect.h};`);
  const plotKeys = [...map.plots.keys()].sort();
  for (const k of plotKeys) {
    const p = map.plots.get(k)!;
    mix(`f:${k}:${p.tx},${p.ty};`);
  }
  for (const hm of map.hamlets) mix(`h:${hm.dirPath}:${hm.tx},${hm.ty},${hm.count};`);
  const roadKeys = [...map.roads].sort();
  for (const r of roadKeys) mix(`r:${r};`);
  return h.toString(16).padStart(8, "0");
}
