import { districtArchetype, type DistrictArchetype, type FileNode } from "@agent-empires/protocol";
import { analyzeCensus, classifyRole, type Census, type FileRole } from "./census.js";

/**
 * Structural-isomorphism layout: the settlement derives from the repository.
 * Every directory is a quarter whose area is proportional to its subtree
 * weight (file LOC when FileNode.lines ships, else file count); every file is
 * a building plot; roads are exactly the parent↔child tree edges. The layout
 * is a pure function of (repoTree, weights, mapSeed, depEdges) — no unseeded
 * randomness anywhere.
 *
 * Composition law (v3): the measured shape of the repo picks the world's
 * macro-form before any rect is placed —
 *   monorepo            → ARCHIPELAGO   (package isles in a real sea)
 *   nesting ≥ 4         → TERRACE MOUNT (altitude = directory depth)
 *   one dominant dir    → RING CITY     (raised core, ring road, bands)
 *   flat & wide         → CANYON STRATA (stretched gorge, the Long Road)
 * All compositions share one battle-tested allocator (treemap partition,
 * gates, staircase roads, plots, hamlets); they differ in frame aspect,
 * placement plan, terrain heights and sea structure — so silhouettes diverge
 * while every invariant (connectivity, plots-on-land, determinism) holds.
 *
 * Landmass law (v2): the water is code-made too. The coastline is a seeded
 * scallop that never bites the city; a monorepo floods the corridors between
 * its top-level packages into sea channels (an archipelago, bridged where
 * the roads cross); nesting ≥ RIVER_MIN_DEPTH sends a river from the deepest
 * quarter's gate to the sea.
 *
 * Street law (v3): real import edges (scanned in the sandbox, shipped as
 * depEdges) are routed as streets between the coupled plots — the repo's
 * dependency graph becomes the visible circulation. No edges → tree roads
 * only, honestly.
 */

/** Bumped when the layout law changes shape: prior worlds re-derive. */
export const LAYOUT_VERSION = 3;

export const TILE_W = 64;
export const TILE_H = 32;
/** Screen px one terrace level lifts the ground (kept for compatibility). */
export const STEP = 10;

/** Above this many files, the smallest overflow into per-directory hamlets. */
export const MAX_INDIVIDUAL_BUILDINGS = 1200;
export const AGGREGATE_THRESHOLD = 1500;

/** Wilderness ring around the city plateau (coast + vegetation live here). */
export const WILD_MARGIN = 9;
/** Heaviest N deduped import edges become streets; the rest stay unbuilt. */
export const MAX_STREET_EDGES = 180;
/** Nesting depth at which a river is carved from the deepest quarter. */
export const RIVER_MIN_DEPTH = 5;

export type Rect = { x: number; y: number; w: number; h: number };

/** The world's macro-form, picked from the measured census. */
export type CompositionKind = "terrace-mount" | "archipelago" | "ring-city" | "canyon-strata";

/** One measured import: `from` requires `to` (repo-relative file paths). */
export type DepEdge = { from: string; to: string };

/**
 * Deterministic composition law. Priority order matters: a deeply nested
 * monorepo is still an archipelago; a deep single-core repo is still a mount.
 */
export function pickComposition(census: Census): CompositionKind {
  if (census.monorepo && census.packageDirs >= 2) return "archipelago";
  if (census.maxDepth >= 4) return "terrace-mount";
  if (census.coreShare >= 0.55 && census.topLevelDirs >= 2) return "ring-city";
  return "canyon-strata";
}

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
  /** Tiles under water: coast, monorepo channels, rivers. Never city floor. */
  water: Set<string>;
  /** Road/street tiles that cross water — rendered as bridges. */
  bridges: Set<string>;
  /** Land tiles orthogonally adjacent to water (shore tinting). */
  coast: Set<string>;
  /** The measured macro-form this world took. */
  composition: CompositionKind;
  /** Terrain altitude per tile (absent = 0). Terraces, cores, strata. */
  heights: Map<string, number>;
  /** Structural role per file path — the building typology law. */
  roles: Map<string, FileRole>;
  /** Import-edge streets (disjoint from roads); empty when no edges ship. */
  streets: Set<string>;
  /** How many dep edges actually routed (hash + honesty in the chronicle). */
  depEdgesRouted: number;
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

export function layoutMap(tree: FileNode, seed: number, depEdges?: DepEdge[]): MapLayout {
  const rng = mulberry32(seed);
  const totalFiles = Math.max(1, countFiles(tree));
  const census = analyzeCensus(tree);
  const composition = pickComposition(census);

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

  // ---- map sizing: the frame aspect is the composition's first word --------
  const est = areaEstimate(tree, individual, 1);
  let cityW: number;
  let cityH: number;
  if (composition === "canyon-strata") {
    // stretched gorge: ~2.6:1, area-preserving, capped so the map stays sane
    cityW = Math.max(30, Math.min(138, Math.ceil(Math.sqrt(est * 1.7 * 2.6)) + 6));
    cityH = Math.max(14, Math.min(Math.floor(cityW / 2.2), Math.ceil((est * 1.7) / cityW) + 6));
  } else {
    const citySide = Math.max(22, Math.min(126, Math.ceil(Math.sqrt(est * 1.7)) + 4));
    cityW = citySide;
    cityH = citySide;
  }
  const side = Math.max(cityW, cityH) + WILD_MARGIN * 2;
  const cityRect: Rect = {
    x: Math.floor((side - cityW) / 2),
    y: Math.floor((side - cityH) / 2),
    w: cityW,
    h: cityH,
  };

  const quarters: Quarter[] = [];
  const blocks: Block[] = [];
  const plots = new Map<string, { tx: number; ty: number }>();
  const buckets = new Map<string, SizeBucket>();
  const weights = new Map<string, number>();
  const hamlets: Hamlet[] = [];
  const roads = new Set<string>();
  const used = new Set<string>();
  const roles = new Map<string, FileRole>();
  const streets = new Set<string>();
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
    const place = (item: Item, r: Rect) => {
      if (item.kind === "dir") layoutDir(item.node, r, depth + 1);
      else filesAreas.push({ dirPath: node.path, files: item.files, rect: r });
    };

    // Ring city: the dominant core sits centered (raised by the height law),
    // wrapped by a 1-tile ring road; everything else fills the four bands.
    if (depth === 0 && composition === "ring-city") {
      const coreIdx = items.findIndex((it) => it.kind === "dir" && it.node.path === census.coreDir);
      if (coreIdx >= 0 && items.length >= 2) {
        const core = items[coreIdx]!;
        const rest = items.filter((_, i) => i !== coreIdx);
        const total = items.reduce((n, i) => n + i.weight, 0);
        let coreSide = Math.round(Math.sqrt(interior.w * interior.h * (core.weight / total)) * 0.95);
        coreSide = Math.min(coreSide, Math.min(interior.w, interior.h) - 12);
        if (coreSide >= 7) {
          const cx0 = interior.x + Math.floor((interior.w - coreSide) / 2);
          const cy0 = interior.y + Math.floor((interior.h - coreSide) / 2);
          if (core.kind === "dir") layoutDir(core.node, { x: cx0, y: cy0, w: coreSide, h: coreSide }, 1);
          for (let tx = cx0 - 1; tx <= cx0 + coreSide; tx++) {
            roads.add(`${tx},${cy0 - 1}`);
            roads.add(`${tx},${cy0 + coreSide}`);
          }
          for (let ty = cy0 - 1; ty <= cy0 + coreSide; ty++) {
            roads.add(`${cx0 - 1},${ty}`);
            roads.add(`${cx0 + coreSide},${ty}`);
          }
          const bands: Rect[] = [
            { x: interior.x, y: interior.y, w: interior.w, h: cy0 - 2 - interior.y },
            { x: interior.x, y: cy0 + coreSide + 2, w: interior.w, h: interior.y + interior.h - (cy0 + coreSide + 2) },
            { x: interior.x, y: cy0 - 1, w: cx0 - 2 - interior.x, h: coreSide + 2 },
            { x: cx0 + coreSide + 2, y: cy0 - 1, w: interior.x + interior.w - (cx0 + coreSide + 2), h: coreSide + 2 },
          ].filter((r) => r.w >= 3 && r.h >= 3);
          if (bands.length > 0) {
            // deal heaviest-first into the band with the best area-per-load
            const groups: Item[][] = bands.map(() => []);
            const loads = bands.map(() => 0);
            for (const it of rest) {
              let best = 0;
              let bestScore = -Infinity;
              for (let i = 0; i < bands.length; i++) {
                const score = bands[i]!.w * bands[i]!.h / (loads[i]! + it.weight);
                if (score > bestScore + 1e-9) {
                  bestScore = score;
                  best = i;
                }
              }
              groups[best]!.push(it);
              loads[best]! += it.weight;
            }
            for (let i = 0; i < bands.length; i++) {
              if (groups[i]!.length > 0) partition(bands[i]!, groups[i]!, place);
            }
            return;
          }
        }
      }
    }

    partition(interior, items, place);
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

  // Canyon: the Long Road runs the gorge floor end to end. Quarter borders
  // stay walled — the road pierces each stratum through a gate gap.
  if (composition === "canyon-strata") {
    const onBorder = (tx: number, ty: number) =>
      quarters.some((q) => {
        const { x, y, w, h } = q.rect;
        if (tx < x || ty < y || tx >= x + w || ty >= y + h) return false;
        return tx === x || ty === y || tx === x + w - 1 || ty === y + h - 1;
      });
    const ry = cityRect.y + Math.floor(cityRect.h / 2);
    for (let tx = cityRect.x - 2; tx < cityRect.x + cityRect.w + 2; tx++) {
      if (!onBorder(tx, ry) && !used.has(`${tx},${ry}`)) roads.add(`${tx},${ry}`);
    }
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
    for (const f of area.files) roles.set(f.path, classifyRole(f.path, f.name, fileWeight(f)));
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

  // ---- streets: measured imports become the visible circulation -------------
  let depEdgesRouted = 0;
  if (depEdges && depEdges.length > 0) {
    const counts = new Map<string, number>();
    for (const e of depEdges) {
      if (!e || !e.from || !e.to || e.from === e.to) continue;
      const k = `${e.from}\u0000${e.to}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_STREET_EDGES);
    for (const [k] of ranked) {
      const [from, to] = k.split("\u0000") as [string, string];
      const a = plots.get(from);
      const b = plots.get(to);
      if (!a || !b) continue;
      // a tile is permitted unless it lies inside a quarter foreign to both ends
      const own = (qp: string) =>
        from === qp || from.startsWith(qp + "/") || to === qp || to.startsWith(qp + "/");
      const permitted = (tx: number, ty: number) =>
        !quarters.some(
          (q) =>
            !own(q.path) &&
            tx >= q.rect.x &&
            ty >= q.rect.y &&
            tx < q.rect.x + q.rect.w &&
            ty < q.rect.y + q.rect.h,
        );
      let px = a.tx;
      let py = a.ty;
      let guard = side * 4;
      while ((px !== b.tx || py !== b.ty) && guard-- > 0) {
        if (px !== b.tx && (py === b.ty || (px + py) % 2 === 0)) px += Math.sign(b.tx - px);
        else if (py !== b.ty) py += Math.sign(b.ty - py);
        const key = `${px},${py}`;
        if (permitted(px, py) && !roads.has(key) && !used.has(key)) streets.add(key);
      }
      if (guard > 0) depEdgesRouted++;
    }
  }

  // ---- water: the landmass is code-made too ---------------------------------
  const water = new Set<string>();
  const inRect = (tx: number, ty: number, r: Rect) => tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
  const inAnyQuarter = (tx: number, ty: number) => quarters.some((q) => inRect(tx, ty, q.rect));
  const dry = (tx: number, ty: number) => used.has(`${tx},${ty}`);

  // 1. Scalloped coastline: a seeded max-norm radius per angle. The scallop
  //    amplitude is capped so the sea never comes within 2 tiles of the city.
  {
    const crng = mulberry32((seed ^ 0xc0a57) >>> 0);
    const harmonics = [1, 2, 3, 5].map((k) => ({
      k,
      amp: (WILD_MARGIN - 3) * (0.2 + 0.8 * crng()) * (1 / (1 + k * 0.6)),
      phase: crng() * Math.PI * 2,
    }));
    const ampSum = harmonics.reduce((n, h) => n + h.amp, 0) || 1;
    const cx = (side - 1) / 2;
    const cy = (side - 1) / 2;
    const baseR = side / 2 - 1.5;
    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const u = tx - cx;
        const v = ty - cy;
        const rad = Math.max(Math.abs(u), Math.abs(v));
        if (Math.abs(u) <= cityW / 2 + 1 && Math.abs(v) <= cityH / 2 + 1) continue; // never near the city
        const theta = Math.atan2(v, u);
        let a = 0;
        for (const h of harmonics) a += h.amp * (1 + Math.sin(h.k * theta + h.phase)) * 0.5;
        const coastR = baseR - (a / ampSum) * (WILD_MARGIN - 3);
        if (rad > coastR && !dry(tx, ty)) water.add(`${tx},${ty}`);
      }
    }
  }

  // 2. Monorepo archipelago: each package quarter becomes an islet. A
  //    container dir (packages/, apps/, …) dissolves into a bay holding its
  //    children; other top-level quarters keep their own shores. Everything
  //    outside an islet or plaza floods; roads become the bridges.
  const MONOREPO_CONTAINER = /^(packages|apps|crates|services|libs|modules|projects|workspaces|plugins)\/?$/i;
  const depth1 = quarters.filter((q) => q.depth === 1);
  const containers = depth1.filter((q) => MONOREPO_CONTAINER.test(q.label));
  if (census.monorepo && containers.length > 0) {
    const isles: Rect[] = [
      ...quarters.filter((q) => containers.some((c) => q.depth === 2 && q.parentPath === c.path)).map((q) => q.rect),
      ...depth1.filter((q) => !containers.includes(q)).map((q) => q.rect),
    ];
    // container-interior file areas (stray root-level files of the container)
    const dryAreas = filesAreas
      .filter((a) => a.dirPath === tree.path || containers.some((c) => a.dirPath === c.path))
      .map((a) => a.rect);
    if (isles.length >= 2) {
      for (let ty = cityRect.y; ty < cityRect.y + cityRect.h; ty++) {
        for (let tx = cityRect.x; tx < cityRect.x + cityRect.w; tx++) {
          if (isles.some((r) => inRect(tx, ty, r))) continue;
          if (dryAreas.some((r) => inRect(tx, ty, r))) continue;
          if (dry(tx, ty)) continue;
          water.add(`${tx},${ty}`);
        }
      }
    }
  }

  // 3. River: deep nesting sends a river from the flank of the deepest
  //    quarter's top-level ancestor out to the sea — threading corridors,
  //    sidestepping quarters, never entering one.
  if (census.maxDepth >= RIVER_MIN_DEPTH && quarters.length > 0) {
    const byPath = new Map(quarters.map((q) => [q.path, q]));
    const deepest = [...quarters].sort((a, b) => b.depth - a.depth || (a.path < b.path ? -1 : 1))[0]!;
    let anc = deepest;
    while (anc.depth > 1) anc = byPath.get(anc.parentPath) ?? anc;
    const A = anc.rect;
    const acx = A.x + A.w / 2;
    const acy = A.y + A.h / 2;
    const exits = [
      { d: acx, dx: -1, dy: 0 },
      { d: side - acx, dx: 1, dy: 0 },
      { d: acy, dx: 0, dy: -1 },
      { d: side - acy, dx: 0, dy: 1 },
    ].sort((p, q) => p.d - q.d);
    const dir = exits[0]!;
    // headwater: just off the ancestor's flank, mid-rect on the cross axis
    let tx = dir.dx !== 0 ? (dir.dx < 0 ? A.x - 1 : A.x + A.w) : Math.floor(acx);
    let ty = dir.dy !== 0 ? (dir.dy < 0 ? A.y - 1 : A.y + A.h) : Math.floor(acy);
    const rrng = mulberry32((seed ^ 0x51e77) >>> 0);
    // upstream stretch: the river rises among the deep quarters, running along
    // the ancestor's flank corridor before it turns for the sea
    {
      let ux = tx;
      let uy = ty;
      for (let s = 0; s < 9; s++) {
        // hug the flank: move along the cross axis (perpendicular to exit)
        if (dir.dx !== 0) uy += 1;
        else ux += 1;
        if (ux <= 0 || uy <= 0 || ux >= side - 1 || uy >= side - 1) break;
        if (inAnyQuarter(ux, uy) || dry(ux, uy)) break;
        water.add(`${ux},${uy}`);
      }
    }
    let sideStep = rrng() < 0.5 ? -1 : 1;
    let guard = side * 4;
    while (tx > 0 && ty > 0 && tx < side - 1 && ty < side - 1 && guard-- > 0) {
      if (inAnyQuarter(tx, ty)) {
        // sidestep along the cross axis until clear — never enter a quarter
        if (dir.dx !== 0) ty += sideStep;
        else tx += sideStep;
        continue;
      }
      const key = `${tx},${ty}`;
      const reachedSea = water.has(key);
      if (!dry(tx, ty)) water.add(key);
      if (reachedSea) break;
      // widen to a 2-tile bed once out in the wilderness
      if (!inRect(tx, ty, cityRect)) {
        const wx = tx + (dir.dx === 0 ? 1 : 0);
        const wy = ty + (dir.dy === 0 ? 1 : 0);
        if (!dry(wx, wy) && !inAnyQuarter(wx, wy)) water.add(`${wx},${wy}`);
      }
      // seeded meander on the cross axis
      if (rrng() < 0.3) {
        const mx = tx + (dir.dx === 0 ? (rrng() < 0.5 ? -1 : 1) : 0);
        const my = ty + (dir.dy === 0 ? (rrng() < 0.5 ? -1 : 1) : 0);
        if (!inAnyQuarter(mx, my) && !dry(mx, my)) {
          tx = mx;
          ty = my;
          water.add(`${tx},${ty}`);
        }
      }
      tx += dir.dx;
      ty += dir.dy;
      if (rrng() < 0.15) sideStep = -sideStep; // rivers wander both ways
    }
  }

  // Bridges are exactly the roads and streets that cross water; the paths
  // themselves are untouched so connectivity is preserved by construction.
  const bridges = new Set<string>();
  for (const r of roads) if (water.has(r)) bridges.add(r);
  for (const s of streets) if (water.has(s)) bridges.add(s);
  const coast = new Set<string>();
  for (const key of water) {
    const [wtx, wty] = key.split(",").map(Number) as [number, number];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = wtx + dx;
      const ny = wty + dy;
      const nk = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
      if (!water.has(nk)) coast.add(nk);
    }
  }

  // ---- terrain heights: the composition's third dimension --------------------
  const heights = new Map<string, number>();
  const raiseRect = (r: Rect, lvl: number) => {
    for (let ty = r.y; ty < r.y + r.h; ty++) {
      for (let tx = r.x; tx < r.x + r.w; tx++) heights.set(`${tx},${ty}`, lvl);
    }
  };
  if (composition === "terrace-mount") {
    // altitude = directory depth; deepest writes last so summits win
    for (const q of [...quarters].sort((a, b) => a.depth - b.depth)) raiseRect(q.rect, Math.min(q.depth, 4));
    for (const b of blocks) raiseRect(b.rect, Math.min(b.depth, 5));
  } else if (composition === "ring-city") {
    const core = quarters.find((q) => q.depth === 1 && q.path === census.coreDir);
    if (core) raiseRect(core.rect, 2);
  } else if (composition === "canyon-strata") {
    // alternating shelves along the gorge; the Long Road row stays at floor 0
    const bandsQ = quarters
      .filter((q) => q.depth === 1)
      .sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
    bandsQ.forEach((q, i) => {
      if (i % 2 === 1) raiseRect(q.rect, 1);
    });
  }
  for (const key of water) heights.delete(key);
  // the canyon's roads are cuts through the shelves; elsewhere roads ride
  // the terrain and the renderer ramps them between levels
  if (composition === "canyon-strata") for (const key of roads) heights.delete(key);

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
    water,
    bridges,
    coast,
    composition,
    heights,
    roles,
    streets,
    depEdgesRouted,
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
        if (map.used.has(key) || map.roads.has(key) || map.streets.has(key) || map.water.has(key)) continue;
        map.used.add(key);
        const cell = { tx, ty };
        map.plots.set(path, cell);
        map.buckets.set(path, 1);
        const name = path.split("/").pop() ?? path;
        map.roles.set(path, classifyRole(path, name, 1));
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
  mix(`v:${LAYOUT_VERSION};c:${map.composition};d:${map.depEdgesRouted};`);
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
  const waterKeys = [...map.water].sort();
  for (const w of waterKeys) mix(`w:${w};`);
  const bridgeKeys = [...map.bridges].sort();
  for (const b of bridgeKeys) mix(`g:${b};`);
  const heightKeys = [...map.heights.entries()].map(([k, v]) => `${k}=${v}`).sort();
  for (const t of heightKeys) mix(`t:${t};`);
  const streetKeys = [...map.streets].sort();
  for (const s of streetKeys) mix(`s:${s};`);
  return h.toString(16).padStart(8, "0");
}
