// Instanced city: every file is a building whose typology comes from its
// measured role (map.roles → dna.structures → model), walls trace quarter
// rects, wilderness gets instanced trees/rocks, and the census-derived world
// DNA drives fortifications, district props, foliage tint/density, and
// building tinting. Structures stand on the terrain (terrain3d.heightAt) and
// heavy files rise on stone plinths. One InstancedMesh per (model part)
// keeps ~1500 buildings to a handful of draw calls. Placement is a pure
// function of the map layout + hashed paths + the seeded rng — never
// Math.random.
import * as THREE from "three";
import { buildingKindFor } from "@agent-empires/protocol";
import { mulberry32, type MapLayout, type Quarter, type Rect, type SizeBucket } from "../game/map.js";
import { classifyRole, type FileRole } from "../game/census.js";
import type { LandmarkKind, StructureKind, WorldDNA } from "../game/worlddna.js";
import type { Assets, StaticModel } from "./assets.js";
import { makeBillboard, type Billboard } from "./billboards.js";
import { heightAt } from "./terrain3d.js";
import { hashStr, mixColor, soften } from "./util.js";

const BUCKET_SCALE: Record<SizeBucket, number> = { 0: 0.55, 1: 0.8, 2: 1.05 };
const HEADROOM = 48;
/** Perf budgets for DNA decoration (instanced, but vertices still cost). */
const MAX_FORT_SEGMENTS = 600;
const MAX_PROPS = 180;
/** How far the whole building instance leans toward the DNA roof color. */
const BUILDING_TINT_MIX = 0.35;
/** Shroud-hidden instances: epsilon (not zero) keeps the instance matrix
 * invertible so raycasts stay NaN-free; visually indistinguishable from gone. */
const HIDDEN_SCALE = 1e-4;
/** Survey rise: buildings stagger over ~1.2s, props pop in after. */
const RISE_STAGGER_MS = 900;
const RISE_MS = 300;
const PROP_POP_MS = 180;

export type PickInfo =
  | { kind: "ground" }
  | { kind: "building"; path: string }
  | { kind: "hamlet"; dir: string; count: number; tx: number; ty: number }
  | { kind: "unit"; id: string }
  | { kind: "raider"; key: string; name: string }
  | { kind: "hook"; path: string; label: string; snippet: string; tx: number; ty: number }
  | { kind: "landmark"; name: string; lore: string; tx: number; ty: number }
  | { kind: "prop"; name: string; lore: string; tx: number; ty: number };

type Placement = {
  x: number;
  z: number;
  /** Base world height (terrain + plinth); 0 when unset. */
  y?: number;
  rotY: number;
  scale: number;
  /** Optional vertical scale (plinth pads stretch downward only). */
  scaleY?: number;
  /** file path when this instance is a pickable building */
  path: string | null;
  tileKey: string | null;
  /** Per-instance color multiplier (uint24); undefined = untinted. */
  tint?: number;
  /** Which DNA register the tint follows on reskin (default roof). */
  tintKind?: "roof" | "trim";
  /** Path whose shroud visibility governs this instance (file, hamlet dir,
   * or quarter path for district props); undefined = always visible. */
  vis?: string;
  /** Currently scaled to ~0 under the shroud (record itself stays intact). */
  hidden?: boolean;
};

type InstSet = {
  key: string;
  meshes: THREE.InstancedMesh[];
  capacity: number;
  used: number;
  placeholder: boolean;
  pickable: boolean;
};

export type BuildingRec3D = {
  path: string;
  kind: string;
  bucket: SizeBucket;
  tx: number;
  ty: number;
  writes: number;
  linesAdded: number;
  linesRemoved: number;
  setKey: string;
  index: number; // -1 for fallback meshes
};

const PLACEHOLDER_GEO = new THREE.BoxGeometry(0.72, 0.55, 0.72).translate(0, 0.275, 0);
const PLACEHOLDER_MAT = new THREE.MeshLambertMaterial({ color: 0x7a6a52 });

/** Stone plinth pad: a unit cube hanging below its origin, stretched by
 * scaleY so heavy files' structures stand on visible masonry. */
const PLINTH_GEO = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0);
const PLINTH_MAT = new THREE.MeshLambertMaterial({ color: 0x8f8a80 });
const GENERATED: Map<string, StaticModel> = new Map([
  ["__plinth", { parts: [{ geometry: PLINTH_GEO, material: PLINTH_MAT }], size: new THREE.Vector3(1, 1, 1) }],
]);

/** Plinth law: base Y rises with measured lines — same model class, taller
 * stance. clamp(log10(lines)/3, 0, 0.5) × 0.4 world units. */
export function plinthHeightFor(lines: number): number {
  const t = Math.log10(Math.max(1, lines)) / 3;
  return Math.min(0.5, Math.max(0, t)) * 0.4;
}

/** One structure's build order: the main model plus companion pieces. */
export type StructurePlan = {
  model: string;
  scale: number;
  /** Which DNA tint the instance leans toward ("trim" marks megastructures). */
  tint: "roof" | "trim";
  extras: { key: string; dx: number; dz: number; scale: number; rotY: number }[];
};

/**
 * The typology law: what a file IS (role → StructureKind) decides what gets
 * built on its plot. Deterministic per path; dwellings keep the LOC size
 * buckets, monuments and works read as their kind, giants dwarf dwellings.
 */
export function structurePlanFor(
  kind: StructureKind,
  path: string,
  lines: number,
  bucket: SizeBucket,
): StructurePlan {
  const h = hashStr(path);
  const pick = (list: string[]): string => list[h % list.length]!;
  const base = BUCKET_SCALE[bucket];
  const qrot = (shift: number) => (((h >>> shift) & 3) * Math.PI) / 2;
  switch (kind) {
    case "workshop":
      return { model: pick(["blacksmith", "lumbermill"]), scale: base, tint: "roof", extras: [] };
    case "watchtower":
      // test files must read as unmistakable towers
      return { model: pick(["tower_A", "tower_B"]), scale: 0.62 + bucket * 0.12, tint: "roof", extras: [] };
    case "stela":
      if (lines >= 300) return { model: "church", scale: 0.85, tint: "roof", extras: [] };
      // plinth treatment: a well-capped monument with book + banner cluster
      return {
        model: "well",
        scale: 0.52,
        tint: "roof",
        extras: [
          { key: "book_set", dx: 0.3, dz: 0.18, scale: 0.34, rotY: qrot(4) },
          { key: "banner", dx: -0.28, dz: -0.2, scale: 0.42, rotY: qrot(7) },
        ],
      };
    case "silo":
      return { model: "grain", scale: base, tint: "roof", extras: [] };
    case "reliquary":
      // props are the structure: a crate-and-chest hoard on its pad
      return {
        model: "crate_A_big",
        scale: 0.62,
        tint: "roof",
        extras: [
          { key: "chest", dx: 0.3, dz: -0.22, scale: 0.4, rotY: Math.PI / 3 },
          { key: "chest", dx: -0.26, dz: 0.26, scale: 0.36, rotY: -Math.PI / 4 },
        ],
      };
    case "gatehouse":
      // an entry plaza: market hall flanked by two banners
      return {
        model: "market",
        scale: 0.95,
        tint: "roof",
        extras: [
          { key: "banner_red", dx: 0.42, dz: 0.34, scale: 0.5, rotY: 0 },
          { key: "banner_blue", dx: -0.42, dz: 0.34, scale: 0.5, rotY: 0 },
        ],
      };
    case "megastructure":
      return {
        model: "castle",
        scale: 1.5,
        tint: "trim",
        extras: [{ key: "scaffolding", dx: 0.66, dz: 0.5, scale: 0.55, rotY: qrot(11) }],
      };
    case "dwelling":
    default:
      return { model: pick(["home_A", "home_A", "home_B", "home_B", "tavern"]), scale: base, tint: "roof", extras: [] };
  }
}

/** Landmark recipes: one Crown monument per world, cited from the census. */
const LANDMARK_NAMES: Record<LandmarkKind, string> = {
  colossus: "The Colossus",
  "harbor-beacon": "The Harbor Beacon",
  "great-library": "The Great Library",
  "garrison-keep": "The Garrison Keep",
  "crown-spire": "The Crown Spire",
};
const LANDMARK_PIECES: Record<LandmarkKind, { key: string; dx: number; dz: number; scale: number }[]> = {
  colossus: [
    { key: "castle", dx: 0, dz: 0, scale: 1.5 },
    { key: "scaffolding", dx: 0.9, dz: 0.55, scale: 0.8 },
  ],
  "harbor-beacon": [
    { key: "tower_B", dx: 0, dz: 0, scale: 2.0 },
    { key: "torch_lit", dx: 0.62, dz: 0.3, scale: 0.55 },
  ],
  "great-library": [
    { key: "church", dx: 0, dz: 0, scale: 1.6 },
    { key: "book_set", dx: 0.72, dz: 0.35, scale: 0.5 },
    { key: "book_single", dx: -0.62, dz: 0.42, scale: 0.4 },
  ],
  "garrison-keep": [
    { key: "barracks", dx: 0, dz: 0, scale: 1.6 },
    { key: "banner_red", dx: 0.7, dz: 0.45, scale: 0.55 },
    { key: "banner_red", dx: -0.7, dz: 0.45, scale: 0.55 },
  ],
  "crown-spire": [{ key: "tower_A", dx: 0, dz: 0, scale: 1.8 }],
};

export class City {
  readonly group = new THREE.Group();
  readonly pickables: THREE.Object3D[] = [];
  readonly buildings = new Map<string, BuildingRec3D>();
  private sets = new Map<string, InstSet>();
  private placements = new Map<string, Placement[]>();
  /** DNA decoration (walls, veg, props, flags): rebuilt whole on reskin. */
  private decorSets = new Map<string, InstSet>();
  private decorPlacements = new Map<string, Placement[]>();
  private decorFlagMats: THREE.MeshStandardMaterial[] = [];
  private decorStatsRec = { wallSegments: 0, props: 0, trees: 0, rocks: 0 };
  private buildingTintColor = 0xffffff;
  private trimTintColor = 0xffffff;
  private mapRef: MapLayout | null = null;
  private dnaRef: WorldDNA | null = null;
  /** path → resolved typology (debug/smoke: the skyline is auditable). */
  private structuresByPath = new Map<string, { kind: StructureKind; model: string }>();
  // the Crown landmark: one monument, never shrouded, examine cites the line
  private landmarkRec: { kind: LandmarkKind; tx: number; ty: number } | null = null;
  private landmarkGroup: THREE.Group | null = null;
  private landmarkPieces: { key: string; dx: number; dz: number; scale: number }[] = [];
  private landmarkPick: PickInfo | null = null;
  private byTile = new Map<string, { setKey: string; index: number }[]>();
  private assets: Assets;
  private badges: Billboard[] = [];
  private flagMats: THREE.MeshStandardMaterial[] = [];
  private fallbackGroup = new THREE.Group();
  private litAt: (tx: number, ty: number) => number = () => 1;
  /** Shroud law: instances whose vis path fails it are scaled to ~0. */
  private visLaw: (path: string) => boolean = () => true;
  private hamletMarkers: { dirPath: string; objects: THREE.Object3D[] }[] = [];
  private rising: { setKey: string; decor: boolean; index: number; start: number; dur: number }[] = [];
  private scratch = new THREE.Matrix4();
  private scratchColor = new THREE.Color();

  constructor(assets: Assets) {
    this.assets = assets;
    this.group.add(this.fallbackGroup);
  }

  buildingInstanceCount(): number {
    return this.buildings.size;
  }

  drawCallEstimate(): number {
    let n = 0;
    for (const s of this.sets.values()) n += s.meshes.length;
    for (const s of this.decorSets.values()) n += s.meshes.length;
    return n;
  }

  decorStats(): { wallSegments: number; props: number; trees: number; rocks: number } {
    return { ...this.decorStatsRec };
  }

  setVisibilityLaw(law: (path: string) => boolean): void {
    this.visLaw = law;
  }

  /** Rise animations still in flight (smoke/perf introspection). */
  risingCount(): number {
    return this.rising.length;
  }

  /** Instances currently scaled away under the shroud (records intact). */
  hiddenCount(): number {
    let n = 0;
    for (const list of this.placements.values()) for (const p of list) if (p.hidden) n++;
    for (const list of this.decorPlacements.values()) for (const p of list) if (p.hidden) n++;
    return n;
  }

  /** Effective scale of a file building's instance (0 while shroud-hidden). */
  plotScale(path: string): number {
    const rec = this.buildings.get(path);
    if (!rec) return 0;
    if (rec.index < 0) return 1; // plain-mesh fallback, never shrouded
    const p = this.placements.get(rec.setKey)?.[rec.index];
    if (!p) return 0;
    return p.hidden ? 0 : p.scale;
  }

  buildWorld(
    map: MapLayout,
    seed: number,
    litAt: (tx: number, ty: number) => number,
    dna: WorldDNA,
    degraded = false,
  ): void {
    this.litAt = litAt;
    this.mapRef = map;
    this.dnaRef = dna;
    this.buildingTintColor = mixColor(0xffffff, dna.buildingTint.roof, BUILDING_TINT_MIX);
    this.trimTintColor = mixColor(0xffffff, dna.buildingTint.trim, 0.5);

    // --- collect placements per model key -----------------------------------
    const add = (key: string, p: Placement) => {
      const list = this.placements.get(key) ?? [];
      list.push(p);
      this.placements.set(key, list);
    };

    // file buildings: role → StructureKind → model, on terrain + plinth
    for (const [path, cell] of map.plots) {
      const kind = buildingKindFor(path);
      const role: FileRole = map.roles.get(path) ?? "source";
      const structure = dna.structures[role];
      const lines = map.weights.get(path) ?? 1;
      const bucket = map.buckets.get(path) ?? 1;
      const plan = structurePlanFor(structure, path, lines, bucket);
      const key = plan.model;
      const h = hashStr(path);
      const scale = plan.scale * (0.92 + (((h >>> 9) & 7) / 7) * 0.16);
      const plinth = plinthHeightFor(lines);
      const baseY = heightAt(map, cell.tx, cell.ty) + plinth;
      const tint = plan.tint === "trim" ? this.trimTintColor : this.buildingTintColor;
      const idx = (this.placements.get(key)?.length ?? 0);
      add(key, {
        x: cell.tx,
        z: cell.ty,
        y: baseY,
        rotY: (((h >>> 6) & 3) * Math.PI) / 2,
        scale,
        path,
        tileKey: `${cell.tx},${cell.ty}`,
        tint,
        tintKind: plan.tint,
        vis: path,
      });
      this.buildings.set(path, {
        path,
        kind,
        bucket,
        tx: cell.tx,
        ty: cell.ty,
        writes: 0,
        linesAdded: 0,
        linesRemoved: 0,
        setKey: key,
        index: idx,
      });
      this.structuresByPath.set(path, { kind: structure, model: key });
      // companion pieces (banners, chests, scaffolds) share the plot's fate
      for (const ex of plan.extras) {
        add(ex.key, {
          x: cell.tx + ex.dx,
          z: cell.ty + ex.dz,
          y: baseY,
          rotY: ex.rotY,
          scale: ex.scale,
          path: null,
          tileKey: null,
          vis: path,
        });
      }
      if (plinth > 0.015) {
        add("__plinth", {
          x: cell.tx,
          z: cell.ty,
          y: baseY,
          rotY: 0,
          scale: 0.86,
          scaleY: plinth + 0.06,
          path: null,
          tileKey: null,
          vis: path,
        });
      }
    }

    // hamlets: three miniature homes + a pick box + a badge
    for (const hm of map.hamlets) {
      const h = hashStr(hm.dirPath);
      const hy = heightAt(map, hm.tx, hm.ty);
      const offs = [
        [-0.24, -0.12],
        [0.26, 0.02],
        [0.0, 0.28],
      ] as const;
      offs.forEach(([ox, oz], i) => {
        add("home_B", {
          x: hm.tx + ox,
          z: hm.ty + oz,
          y: hy,
          rotY: ((((h >>> (i * 3)) & 3) * Math.PI) / 2),
          scale: 0.3,
          path: null,
          tileKey: `${hm.tx},${hm.ty}`,
          tint: this.buildingTintColor,
          vis: hm.dirPath,
        });
      });
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.5, 0.95).translate(0, 0.25, 0),
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true }),
      );
      box.position.set(hm.tx, hy, hm.ty);
      box.userData.pick = {
        kind: "hamlet",
        dir: hm.dirPath,
        count: hm.count,
        tx: hm.tx,
        ty: hm.ty,
      } satisfies PickInfo;
      this.group.add(box);
      this.pickables.push(box);
      const badge = makeBillboard(`⌂ ×${hm.count}`, {
        sizePx: 20,
        bg: "rgba(18,14,8,0.72)",
        border: "#8a744a",
        worldH: 0.3,
      });
      badge.sprite.position.set(hm.tx, hy + 0.62, hm.ty);
      this.group.add(badge.sprite);
      this.badges.push(badge);
      const shown = this.visLaw(hm.dirPath);
      box.visible = shown;
      badge.sprite.visible = shown;
      this.hamletMarkers.push({ dirPath: hm.dirPath, objects: [box, badge.sprite] });
    }

    // --- realize sets --------------------------------------------------------
    for (const key of this.placements.keys()) this.realizeSet(key);

    // walls, wilderness, flags, fortifications, district props (DNA-driven)
    this.buildDecor(map, seed, dna, degraded);

    // the Citadel: a plain mesh clone so picking is trivial
    this.placeCitadel(map);
  }

  /**
   * (Re)build all DNA decoration: quarter walls, fortification rings,
   * wilderness vegetation/rocks, gate flags, and per-district props.
   * Decor model keys are disjoint from building keys by construction, so the
   * whole layer can be torn down and re-derived when a reskin changes DNA.
   * Deterministic: everything comes from mulberry32 streams of the map seed.
   */
  buildDecor(map: MapLayout, seed: number, dna: WorldDNA, degraded = false): void {
    for (const set of this.decorSets.values()) {
      for (const m of set.meshes) {
        m.removeFromParent();
        m.dispose();
      }
    }
    this.decorSets.clear();
    this.decorPlacements.clear();
    // decor placements are re-derived below; stale decor rise records would
    // point at reshuffled indices
    this.rising = this.rising.filter((r) => !r.decor);
    for (const m of this.decorFlagMats) m.dispose();
    this.decorFlagMats = [];
    this.decorStatsRec = { wallSegments: 0, props: 0, trees: 0, rocks: 0 };

    const add = (key: string, p: Placement) => {
      const list = this.decorPlacements.get(key) ?? [];
      list.push(p);
      this.decorPlacements.set(key, list);
    };

    // walls / fences on quarter perimeters (never on water: archipelago
    // container quarters have flooded perimeters)
    for (const q of map.quarters) this.placeWalls(map, q, add);
    this.placeFortifications(map, dna, add);

    // wilderness: instanced trees + rocks, density/tint/stumps from DNA
    const rng = mulberry32((seed ^ 0x7ee5a1) >>> 0);
    const c = map.cityRect;
    const trees = ["tree_A", "tree_A", "tree_B", "trees_small", "trees_medium", "trees_B_medium"];
    const rocks = ["rock_A", "rock_B", "rock_C", "rock_D"];
    const perf = degraded ? 0.5 : 1;
    const treeP = 0.33 * dna.vegetation.density * perf;
    const rockP = 0.06 * dna.rockDensity * perf;
    const foliageTint = soften(dna.vegetation.tint, 0.5);
    for (let ty = 2; ty < map.side - 2; ty++) {
      for (let tx = 2; tx < map.side - 2; tx++) {
        const inCity = tx >= c.x && ty >= c.y && tx < c.x + c.w && ty < c.y + c.h;
        if (inCity) continue;
        const key = `${tx},${ty}`;
        if (map.water.has(key) || map.used.has(key) || map.roads.has(key) || map.streets.has(key)) continue;
        // canyon dressing: the two long flanks of the gorge scatter more rock
        const onFlank = map.composition === "canyon-strata" && (ty < c.y || ty >= c.y + c.h);
        const rp = onFlank ? Math.min(0.45, rockP * 3 + 0.04) : rockP;
        const r = rng();
        const gy = heightAt(map, tx, ty);
        if (r < treeP) {
          const cut = rng() < dna.vegetation.cutShare;
          add(cut ? "tree_cut" : trees[Math.floor(rng() * trees.length)]!, {
            x: tx + (rng() - 0.5) * 0.7,
            z: ty + (rng() - 0.5) * 0.7,
            y: gy,
            rotY: Math.floor(rng() * 4) * (Math.PI / 2),
            scale: 0.8 + rng() * 0.7,
            path: null,
            tileKey: null,
            tint: cut ? undefined : foliageTint,
          });
          this.decorStatsRec.trees++;
        } else if (r < treeP + rp) {
          add(rocks[Math.floor(rng() * rocks.length)]!, {
            x: tx + (rng() - 0.5) * 0.6,
            z: ty + (rng() - 0.5) * 0.6,
            y: gy,
            rotY: rng() * Math.PI * 2,
            scale: 0.5 + rng() * 0.6,
            path: null,
            tileKey: null,
          });
          this.decorStatsRec.rocks++;
        }
      }
    }

    // banners at depth-1 gates (accent-tintable, streams in)
    for (const q of map.quarters) {
      if (q.depth !== 1) continue;
      if (map.water.has(`${q.gate.tx},${q.gate.ty}`)) continue;
      add("flag", {
        x: q.gate.tx,
        z: q.gate.ty,
        y: heightAt(map, q.gate.tx, q.gate.ty),
        rotY: ((hashStr(q.path) & 3) * Math.PI) / 2,
        scale: 0.55,
        path: null,
        tileKey: null,
      });
    }
    const tcy = heightAt(map, map.townCenter.tx, map.townCenter.ty);
    add("flag", { x: map.townCenter.tx - 1.6, z: map.townCenter.ty - 1.6, y: tcy, rotY: 0, scale: 0.7, path: null, tileKey: null });
    add("flag", { x: map.townCenter.tx + 1.6, z: map.townCenter.ty - 1.6, y: tcy, rotY: 0, scale: 0.7, path: null, tileKey: null });

    this.placeProps(map, seed, dna, add, degraded);

    for (const key of this.decorPlacements.keys()) this.realizeSet(key, true);
  }

  private placeWalls(
    map: MapLayout,
    q: Quarter,
    add: (key: string, p: Placement) => void,
  ): void {
    const stone = q.depth <= 2;
    const straightKey = stone ? "wall_straight" : "fence";
    const gateKey = stone ? "wall_gate" : "fence_gate";
    const cornerKey = stone ? "wall_corner" : "fence";
    const { x, y, w, h } = q.rect;
    const scale = stone ? 1 : 0.95;
    const isGate = (tx: number, ty: number) =>
      map.roads.has(`${tx},${ty}`) || (tx === q.gate.tx && ty === q.gate.ty);
    const put = (key: string, tx: number, ty: number, rotY: number) => {
      if (map.water.has(`${tx},${ty}`)) return;
      // walls stand on their own tile's height (terrace edges are lawful)
      add(key, { x: tx, z: ty, y: heightAt(map, tx, ty), rotY, scale, path: null, tileKey: null });
    };
    // edges (excluding corners)
    for (let tx = x + 1; tx < x + w - 1; tx++) {
      put(isGate(tx, y) ? gateKey : straightKey, tx, y, 0);
      put(isGate(tx, y + h - 1) ? gateKey : straightKey, tx, y + h - 1, Math.PI);
    }
    for (let ty = y + 1; ty < y + h - 1; ty++) {
      put(isGate(x, ty) ? gateKey : straightKey, x, ty, Math.PI / 2);
      put(isGate(x + w - 1, ty) ? gateKey : straightKey, x + w - 1, ty, -Math.PI / 2);
    }
    // corners
    const corners = [
      [x, y, Math.PI / 2],
      [x + w - 1, y, 0],
      [x + w - 1, y + h - 1, -Math.PI / 2],
      [x, y + h - 1, Math.PI],
    ] as const;
    for (const [cx, cy, rot] of corners) put(cornerKey, cx, cy, rot);
  }

  /**
   * Fortification rings from dna.fortification: 1 = citadel plaza, 2 = also
   * proving quarters, 3 = all depth-1 quarters. Rings sit one tile outside
   * the quarter walls so the extra defenses read as such; road (gate), water,
   * and occupied tiles stay open. Hard cap keeps the budget bounded.
   */
  private placeFortifications(
    map: MapLayout,
    dna: WorldDNA,
    add: (key: string, p: Placement) => void,
  ): void {
    const level = dna.fortification;
    if (level === 0) return;
    const tc = map.townCenter;
    const rects: Rect[] = [{ x: tc.tx - 3, y: tc.ty - 3, w: 7, h: 7 }];
    const expand = (r: Rect): Rect => ({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 });
    if (level >= 2) {
      for (const q of map.quarters) if (q.archetype === "proving") rects.push(expand(q.rect));
    }
    if (level >= 3) {
      for (const q of map.quarters) if (q.depth === 1) rects.push(expand(q.rect));
    }
    const seen = new Set<string>();
    let segs = 0;
    const put = (key: string, tx: number, ty: number, rotY: number) => {
      if (segs >= MAX_FORT_SEGMENTS) return;
      if (tx < 1 || ty < 1 || tx >= map.side - 1 || ty >= map.side - 1) return;
      const k = `${tx},${ty}`;
      if (seen.has(k) || map.water.has(k) || map.roads.has(k) || map.streets.has(k) || map.used.has(k)) return;
      seen.add(k);
      add(key, { x: tx, z: ty, y: heightAt(map, tx, ty), rotY, scale: 1, path: null, tileKey: null });
      segs++;
    };
    for (const r of rects) {
      for (let tx = r.x + 1; tx < r.x + r.w - 1; tx++) {
        put("wall_straight", tx, r.y, 0);
        put("wall_straight", tx, r.y + r.h - 1, Math.PI);
      }
      for (let ty = r.y + 1; ty < r.y + r.h - 1; ty++) {
        put("wall_straight", r.x, ty, Math.PI / 2);
        put("wall_straight", r.x + r.w - 1, ty, -Math.PI / 2);
      }
      const corners = [
        [r.x, r.y, Math.PI / 2],
        [r.x + r.w - 1, r.y, 0],
        [r.x + r.w - 1, r.y + r.h - 1, -Math.PI / 2],
        [r.x, r.y + r.h - 1, Math.PI],
      ] as const;
      for (const [cx, cy, rot] of corners) put("wall_corner", cx, cy, rot);
    }
    this.decorStatsRec.wallSegments = segs;
  }

  /**
   * The legibility layer: dna.props[archetype] scattered over each quarter's
   * free floor (targets in test quarters, books in docs, barrels in config).
   * ~1 prop per 14 free tiles, deepest quarter wins nested rects.
   */
  private placeProps(
    map: MapLayout,
    seed: number,
    dna: WorldDNA,
    add: (key: string, p: Placement) => void,
    degraded: boolean,
  ): void {
    const rng = mulberry32((seed ^ 0x50a75) >>> 0);
    const cap = degraded ? Math.floor(MAX_PROPS / 2) : MAX_PROPS;
    const c = map.cityRect;
    let placed = 0;
    for (let ty = c.y; ty < c.y + c.h && placed < cap; ty++) {
      for (let tx = c.x; tx < c.x + c.w && placed < cap; tx++) {
        const key = `${tx},${ty}`;
        if (map.used.has(key) || map.roads.has(key) || map.streets.has(key) || map.water.has(key)) continue;
        let best: Quarter | null = null;
        for (const q of map.quarters) {
          if (tx >= q.rect.x && ty >= q.rect.y && tx < q.rect.x + q.rect.w && ty < q.rect.y + q.rect.h) {
            if (!best || q.depth > best.depth) best = q;
          }
        }
        if (!best) continue;
        if (rng() >= 1 / 14) continue;
        const models = dna.props[best.archetype];
        if (!models || models.length === 0) continue;
        add(models[Math.floor(rng() * models.length)]!, {
          x: tx + (rng() - 0.5) * 0.5,
          z: ty + (rng() - 0.5) * 0.5,
          y: heightAt(map, tx, ty),
          rotY: rng() * Math.PI * 2,
          scale: 0.42 + rng() * 0.2,
          path: null,
          tileKey: null,
          vis: best.path,
        });
        this.decorStatsRec.props++;
        placed++;
      }
    }
  }

  private placeCitadel(map: MapLayout): void {
    const model = this.assets.statics.get("castle");
    const tc = map.townCenter;
    const root = new THREE.Group();
    root.position.set(tc.tx, heightAt(map, tc.tx, tc.ty), tc.ty);
    if (model) {
      for (const part of model.parts) {
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.scale.setScalar(2.8);
        mesh.userData.pick = { kind: "building", path: "__towncenter__" } satisfies PickInfo;
        root.add(mesh);
        this.pickables.push(mesh);
      }
    } else {
      const mesh = new THREE.Mesh(PLACEHOLDER_GEO, PLACEHOLDER_MAT);
      mesh.scale.setScalar(2.8);
      mesh.userData.pick = { kind: "building", path: "__towncenter__" } satisfies PickInfo;
      root.add(mesh);
      this.pickables.push(mesh);
    }
    this.group.add(root);
    this.buildings.set("__towncenter__", {
      path: "__towncenter__",
      kind: "towncenter",
      bucket: 2,
      tx: tc.tx,
      ty: tc.ty,
      writes: 0,
      linesAdded: 0,
      linesRemoved: 0,
      setKey: "castle",
      index: -1,
    });
  }

  /** Resolved typology for a plot (debug/smoke: the skyline is auditable). */
  structureAt(path: string): { kind: StructureKind; model: string } | null {
    return this.structuresByPath.get(path) ?? null;
  }

  /** The Crown landmark's identity + tile (debug/smoke). */
  landmarkInfo(): { kind: LandmarkKind; tx: number; ty: number } | null {
    return this.landmarkRec ? { ...this.landmarkRec } : null;
  }

  /**
   * One census-cited monument per world. Placed deterministically on the
   * nearest free tile ring-searched from the town center (the castle's 3×3
   * pad is already in map.used), preferring open ground outside any quarter
   * so the Crown property is never shrouded. Harbor beacons lean toward the
   * sea: among the first eligible ring they pick the tile nearest water.
   * Returns the claimed tile so the renderer can clear its fog.
   */
  placeLandmark(map: MapLayout, dna: WorldDNA): { tx: number; ty: number } | null {
    const kind = dna.landmark.kind;
    const tc = map.townCenter;
    const free = (tx: number, ty: number): boolean => {
      if (tx < 1 || ty < 1 || tx >= map.side - 1 || ty >= map.side - 1) return false;
      const k = `${tx},${ty}`;
      return !map.used.has(k) && !map.roads.has(k) && !map.streets.has(k) && !map.water.has(k);
    };
    const inQuarter = (tx: number, ty: number): boolean =>
      map.quarters.some(
        (q) => tx >= q.rect.x && ty >= q.rect.y && tx < q.rect.x + q.rect.w && ty < q.rect.y + q.rect.h,
      );
    let fallback: { tx: number; ty: number } | null = null;
    let spot: { tx: number; ty: number } | null = null;
    for (let radius = 3; radius < map.side && !spot; radius++) {
      const open: { tx: number; ty: number }[] = [];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const tx = tc.tx + dx;
          const ty = tc.ty + dy;
          if (!free(tx, ty)) continue;
          if (inQuarter(tx, ty)) {
            if (!fallback) fallback = { tx, ty };
            continue;
          }
          open.push({ tx, ty });
        }
      }
      if (open.length === 0) continue;
      // the fixed RTS camera looks from +x/+z: prefer that flank so the
      // monument stands proud of the citadel instead of hiding behind it
      open.sort((a, b) => b.tx + b.ty - (a.tx + a.ty) || a.tx - b.tx);
      if (kind === "harbor-beacon" && map.water.size > 0) {
        let best = open[0]!;
        let bestD = Infinity;
        for (const cand of open) {
          let d = Infinity;
          for (const wk of map.water) {
            const [wx, wy] = wk.split(",").map(Number) as [number, number];
            const dd = Math.abs(wx - cand.tx) + Math.abs(wy - cand.ty);
            if (dd < d) d = dd;
          }
          if (d < bestD) {
            bestD = d;
            best = cand;
          }
        }
        spot = best;
      } else {
        spot = open[0]!;
      }
    }
    if (!spot) spot = fallback;
    if (!spot) return null;
    map.used.add(`${spot.tx},${spot.ty}`);
    this.landmarkRec = { kind, tx: spot.tx, ty: spot.ty };
    this.landmarkPieces = LANDMARK_PIECES[kind];
    this.landmarkPick = {
      kind: "landmark",
      name: LANDMARK_NAMES[kind],
      lore: dna.landmark.line,
      tx: spot.tx,
      ty: spot.ty,
    };
    this.landmarkBaseY = heightAt(map, spot.tx, spot.ty);
    this.refreshLandmark();
    for (const piece of this.landmarkPieces) {
      if (!this.assets.statics.get(piece.key)) this.assets.onModel(piece.key, () => this.refreshLandmark());
    }
    return spot;
  }

  private landmarkBaseY = 0;

  /** (Re)build the landmark group; re-entrant as models stream in. */
  private refreshLandmark(): void {
    if (!this.landmarkRec || !this.landmarkPick) return;
    if (this.landmarkGroup) {
      for (const child of [...this.landmarkGroup.children]) {
        const pi = this.pickables.indexOf(child);
        if (pi >= 0) this.pickables.splice(pi, 1);
      }
      this.landmarkGroup.removeFromParent();
    }
    const g = new THREE.Group();
    g.position.set(this.landmarkRec.tx, this.landmarkBaseY, this.landmarkRec.ty);
    for (const piece of this.landmarkPieces) {
      const model = this.assets.statics.get(piece.key);
      const parts = model
        ? model.parts
        : [{ geometry: PLACEHOLDER_GEO, material: PLACEHOLDER_MAT as THREE.Material }];
      for (const part of parts) {
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.scale.setScalar(piece.scale);
        mesh.position.set(piece.dx, 0, piece.dz);
        mesh.userData.pick = this.landmarkPick;
        g.add(mesh);
        this.pickables.push(mesh);
      }
    }
    this.group.add(g);
    this.landmarkGroup = g;
  }

  /** Create (or re-create after stream-in) the InstancedMesh set for a key. */
  private realizeSet(key: string, decor = false): void {
    const sets = decor ? this.decorSets : this.sets;
    const list = (decor ? this.decorPlacements : this.placements).get(key);
    if (!list || list.length === 0) return;
    const old = sets.get(key);
    if (old) {
      for (const m of old.meshes) {
        m.removeFromParent();
        const pi = this.pickables.indexOf(m);
        if (pi >= 0) this.pickables.splice(pi, 1);
        m.dispose();
      }
      sets.delete(key);
    }
    const model: StaticModel | undefined = this.assets.statics.get(key) ?? GENERATED.get(key);
    const parts = model
      ? model.parts
      : [{ geometry: PLACEHOLDER_GEO, material: PLACEHOLDER_MAT as THREE.Material }];
    const pickable = !decor && list.some((p) => p.path !== null);
    const capacity = list.length + (pickable ? HEADROOM : 0);
    const set: InstSet = {
      key,
      meshes: [],
      capacity,
      used: 0,
      placeholder: !model,
      pickable,
    };
    for (const part of parts) {
      let material = part.material;
      if (key === "flag" || key === "banner") {
        material = (part.material as THREE.MeshStandardMaterial).clone();
        (decor ? this.decorFlagMats : this.flagMats).push(material as THREE.MeshStandardMaterial);
      }
      const mesh = new THREE.InstancedMesh(part.geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.userData.setKey = key;
      set.meshes.push(mesh);
      this.group.add(mesh);
      if (pickable) this.pickables.push(mesh);
    }
    sets.set(key, set);
    if (!model) this.assets.onModel(key, () => this.realizeSet(key, decor));
    for (const p of list) this.writeInstance(set, p);
  }

  private writeInstance(set: InstSet, p: Placement): void {
    const i = set.used;
    if (i >= set.capacity) return;
    set.used = i + 1;
    p.hidden = p.vis !== undefined && !this.visLaw(p.vis);
    const s = p.hidden ? HIDDEN_SCALE : p.scale;
    const sy = p.hidden ? HIDDEN_SCALE : (p.scaleY ?? p.scale);
    this.scratch.makeRotationY(p.rotY);
    this.scratch.scale(new THREE.Vector3(s, sy, s));
    this.scratch.setPosition(p.x, p.y ?? 0, p.z);
    const lit = p.tileKey ? 1 - this.litFromTileKey(p.tileKey) * 0.85 : 1;
    if (p.tint !== undefined) this.scratchColor.set(p.tint).multiplyScalar(lit);
    else this.scratchColor.setScalar(lit);
    for (const mesh of set.meshes) {
      mesh.setMatrixAt(i, this.scratch);
      mesh.setColorAt(i, this.scratchColor);
      mesh.count = set.used;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (p.tileKey && p.path) {
      const arr = this.byTile.get(p.tileKey) ?? [];
      arr.push({ setKey: set.key, index: i });
      this.byTile.set(p.tileKey, arr);
    }
  }

  private litFromTileKey(tileKey: string): number {
    const [a, b] = tileKey.split(",");
    return this.litAt(Number(a), Number(b));
  }

  /** Recompose one instance's matrix at an arbitrary scale (rise animation). */
  private writeInstanceMatrix(setKey: string, decor: boolean, index: number, p: Placement, scale: number): void {
    const set = (decor ? this.decorSets : this.sets).get(setKey);
    if (!set || index >= set.used) return;
    // preserve the placement's vertical-scale ratio through rise animations
    const sy = scale * ((p.scaleY ?? p.scale) / p.scale);
    this.scratch.makeRotationY(p.rotY);
    this.scratch.scale(new THREE.Vector3(scale, sy, scale));
    this.scratch.setPosition(p.x, p.y ?? 0, p.z);
    for (const mesh of set.meshes) {
      mesh.setMatrixAt(index, this.scratch);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Survey ceremony: everything the shroud law newly permits rises from the
   * ground — buildings smallest-first staggered over ~1.2s, then district
   * props pop in. Order is a pure sort of placement data (scale, governing
   * path, position); only the clock is wall time. instant=true (historical
   * replay) snaps everything to full scale with no animation.
   */
  riseNewlyVisible(instant: boolean, now: number): { buildings: number; props: number } {
    const collect = (decor: boolean) => {
      const out: { setKey: string; index: number; p: Placement }[] = [];
      for (const [key, list] of decor ? this.decorPlacements : this.placements) {
        list.forEach((p, i) => {
          if (p.vis === undefined || !p.hidden || !this.visLaw(p.vis)) return;
          out.push({ setKey: key, index: i, p });
        });
      }
      out.sort((a, b) => {
        if (a.p.scale !== b.p.scale) return a.p.scale - b.p.scale;
        const ka = a.p.path ?? a.p.vis!;
        const kb = b.p.path ?? b.p.vis!;
        if (ka !== kb) return ka < kb ? -1 : 1;
        return a.p.x - b.p.x || a.p.z - b.p.z;
      });
      return out;
    };
    const buildings = collect(false);
    const props = collect(true);
    const start = (e: { setKey: string; index: number; p: Placement }, at: number, dur: number, decor: boolean) => {
      e.p.hidden = false;
      if (instant) this.writeInstanceMatrix(e.setKey, decor, e.index, e.p, e.p.scale);
      else this.rising.push({ setKey: e.setKey, decor, index: e.index, start: at, dur });
    };
    buildings.forEach((e, i) =>
      start(e, now + (i / Math.max(1, buildings.length - 1)) * RISE_STAGGER_MS, RISE_MS, false),
    );
    props.forEach((e, i) => start(e, now + RISE_STAGGER_MS + RISE_MS + i * 40, PROP_POP_MS, true));
    for (const hm of this.hamletMarkers) {
      if (!this.visLaw(hm.dirPath)) continue;
      for (const o of hm.objects) o.visible = true;
    }
    return { buildings: buildings.length, props: props.length };
  }

  /** Advance rise animations (no-op unless a survey ceremony is running). */
  tick(now: number): void {
    if (this.rising.length === 0) return;
    for (let i = this.rising.length - 1; i >= 0; i--) {
      const r = this.rising[i]!;
      const p = (r.decor ? this.decorPlacements : this.placements).get(r.setKey)?.[r.index];
      if (!p) {
        this.rising.splice(i, 1);
        continue;
      }
      const t = (now - r.start) / r.dur;
      if (t < 0) continue;
      if (t >= 1) {
        this.writeInstanceMatrix(r.setKey, r.decor, r.index, p, p.scale);
        this.rising.splice(i, 1);
        continue;
      }
      // easeOutBack: a touch of overshoot sells "rising out of the ground"
      const u = t - 1;
      const k = 1 + 2.70158 * u * u * u + 1.70158 * u * u;
      this.writeInstanceMatrix(r.setKey, r.decor, r.index, p, Math.max(HIDDEN_SCALE, p.scale * k));
    }
  }

  /** Look up the file path for an instanced-mesh raycast hit. */
  pathForInstance(mesh: THREE.InstancedMesh, instanceId: number): string | null {
    const key = mesh.userData.setKey as string | undefined;
    if (!key) return null;
    const list = this.placements.get(key);
    return list?.[instanceId]?.path ?? null;
  }

  /** New file mid-match: append an instance (or fall back to a plain mesh). */
  addBuilding(path: string, kind: string, tx: number, ty: number): BuildingRec3D {
    const existing = this.buildings.get(path);
    if (existing) return existing;
    const map = this.mapRef;
    const lines = map?.weights.get(path) ?? 1;
    // files born mid-match are not in the layout's role ledger: classify live
    const role: FileRole =
      map?.roles.get(path) ?? classifyRole(path, path.split("/").pop() ?? path, lines);
    const structure = this.dnaRef?.structures[role] ?? "dwelling";
    const plan = structurePlanFor(structure, path, lines, 1);
    const key = plan.model;
    const h = hashStr(path);
    const scale = plan.scale * (0.92 + (((h >>> 9) & 7) / 7) * 0.16);
    const baseY = (map ? heightAt(map, tx, ty) : 0) + plinthHeightFor(lines);
    this.structuresByPath.set(path, { kind: structure, model: key });
    const p: Placement = {
      x: tx,
      z: ty,
      y: baseY,
      rotY: (((h >>> 6) & 3) * Math.PI) / 2,
      scale,
      path,
      tileKey: `${tx},${ty}`,
      tint: plan.tint === "trim" ? this.trimTintColor : this.buildingTintColor,
      tintKind: plan.tint,
      vis: path,
    };
    const list = this.placements.get(key) ?? [];
    const set = this.sets.get(key);
    let index = -1;
    if (set && set.used < set.capacity) {
      list.push(p);
      this.placements.set(key, list);
      index = set.used;
      this.writeInstance(set, p);
    } else {
      // capacity exhausted or unseen model type: one plain mesh, still pickable
      const model = this.assets.statics.get(key);
      const parts = model ? model.parts : [{ geometry: PLACEHOLDER_GEO, material: PLACEHOLDER_MAT as THREE.Material }];
      const root = new THREE.Group();
      root.position.set(tx, baseY, ty);
      root.rotation.y = p.rotY;
      root.scale.setScalar(scale);
      for (const part of parts) {
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.castShadow = true;
        mesh.userData.pick = { kind: "building", path } satisfies PickInfo;
        root.add(mesh);
        this.pickables.push(mesh);
      }
      this.fallbackGroup.add(root);
    }
    const rec: BuildingRec3D = {
      path,
      kind,
      bucket: 1,
      tx,
      ty,
      writes: 0,
      linesAdded: 0,
      linesRemoved: 0,
      setKey: key,
      index,
    };
    this.buildings.set(path, rec);
    return rec;
  }

  /** Fog changed on a tile: relight its building instances (tint kept). */
  setTileLight(tx: number, ty: number, veilAlpha: number): void {
    const arr = this.byTile.get(`${tx},${ty}`);
    if (!arr) return;
    const f = 1 - veilAlpha * 0.85;
    for (const { setKey, index } of arr) {
      const set = this.sets.get(setKey);
      if (!set) continue;
      const tint = this.placements.get(setKey)?.[index]?.tint;
      if (tint !== undefined) this.scratchColor.set(tint).multiplyScalar(f);
      else this.scratchColor.setScalar(f);
      for (const mesh of set.meshes) {
        mesh.setColorAt(index, this.scratchColor);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  /** Reskin: lean every building instance toward the new DNA colors
   * (megastructures keep their distinct trim register). */
  retintBuildings(roof: number, trim?: number): void {
    this.buildingTintColor = mixColor(0xffffff, roof, BUILDING_TINT_MIX);
    if (trim !== undefined) this.trimTintColor = mixColor(0xffffff, trim, 0.5);
    for (const [key, list] of this.placements) {
      const set = this.sets.get(key);
      list.forEach((p, i) => {
        if (p.tint === undefined) return; // never tinted (walls-era safety)
        p.tint = p.tintKind === "trim" ? this.trimTintColor : this.buildingTintColor;
        if (!set || i >= set.used) return;
        const lit = p.tileKey ? 1 - this.litFromTileKey(p.tileKey) * 0.85 : 1;
        this.scratchColor.set(p.tint).multiplyScalar(lit);
        for (const mesh of set.meshes) {
          mesh.setColorAt(i, this.scratchColor);
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        }
      });
    }
  }

  /** Brief white flash on a reinforced building (renderer restores it). */
  flashBuilding(rec: BuildingRec3D): void {
    if (rec.index < 0) return;
    const set = this.sets.get(rec.setKey);
    if (!set) return;
    this.scratchColor.setScalar(2.2);
    for (const mesh of set.meshes) {
      mesh.setColorAt(rec.index, this.scratchColor);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  unflashBuilding(rec: BuildingRec3D): void {
    if (rec.index < 0) return;
    this.setTileLight(rec.tx, rec.ty, this.litAt(rec.tx, rec.ty));
  }

  retintFlags(accent: number): void {
    for (const m of this.flagMats) m.color.set(soften(accent, 0.75));
    for (const m of this.decorFlagMats) m.color.set(soften(accent, 0.75));
  }

  dispose(): void {
    for (const set of this.sets.values()) for (const m of set.meshes) m.dispose();
    for (const set of this.decorSets.values()) for (const m of set.meshes) m.dispose();
    for (const m of this.decorFlagMats) m.dispose();
    for (const b of this.badges) b.dispose();
    this.sets.clear();
    this.decorSets.clear();
    this.placements.clear();
    this.decorPlacements.clear();
  }
}
