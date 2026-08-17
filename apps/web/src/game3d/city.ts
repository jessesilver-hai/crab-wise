// Instanced city: every file is a building instance, walls trace quarter
// rects, wilderness gets instanced trees/rocks, and the census-derived world
// DNA drives fortifications, district props, foliage tint/density, and
// building tinting. One InstancedMesh per (model part) keeps ~1500 buildings
// to a handful of draw calls. Placement is a pure function of the map layout
// + hashed paths + the seeded rng — never Math.random.
import * as THREE from "three";
import { buildingKindFor, type DistrictArchetype } from "@agent-empires/protocol";
import { mulberry32, type MapLayout, type Quarter, type Rect, type SizeBucket } from "../game/map.js";
import type { WorldDNA } from "../game/worlddna.js";
import type { Assets, StaticModel } from "./assets.js";
import { makeBillboard, type Billboard } from "./billboards.js";
import { hashStr, mixColor, soften } from "./util.js";

const BUCKET_SCALE: Record<SizeBucket, number> = { 0: 0.55, 1: 0.8, 2: 1.05 };
const HEADROOM = 48;
/** Perf budgets for DNA decoration (instanced, but vertices still cost). */
const MAX_FORT_SEGMENTS = 600;
const MAX_PROPS = 180;
/** How far the whole building instance leans toward the DNA roof color. */
const BUILDING_TINT_MIX = 0.35;

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
  rotY: number;
  scale: number;
  /** file path when this instance is a pickable building */
  path: string | null;
  tileKey: string | null;
  /** Per-instance color multiplier (uint24); undefined = untinted. */
  tint?: number;
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

/** Deterministic model choice for a file building. */
export function modelKeyFor(path: string, kind: string, archetype: DistrictArchetype): string {
  const h = hashStr(path);
  const pick = (list: string[]): string => list[h % list.length]!;
  switch (kind) {
    case "barracks":
      return pick(["barracks", "archeryrange"]);
    case "market":
      return "market";
    case "monastery":
      return "church";
    case "mill":
      return pick(["grain", "windmill", "watermill"]);
    case "towncenter":
      return "tavern"; // a file named package.json; the Citadel is separate
    default:
      break;
  }
  switch (archetype) {
    case "proving":
      return pick(["barracks", "archeryrange"]);
    case "scriptorium":
      return pick(["church", "home_B"]);
    case "granary":
      return pick(["grain", "windmill", "watermill"]);
    case "watchtower":
      return pick(["tower_A", "tower_B"]);
    case "forge":
      return pick(["blacksmith", "mine"]);
    case "bazaar":
      return pick(["market", "home_B"]);
    default:
      return pick(["home_A", "home_A", "home_B", "home_B", "tavern"]);
  }
}

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
  private byTile = new Map<string, { setKey: string; index: number }[]>();
  private assets: Assets;
  private badges: Billboard[] = [];
  private flagMats: THREE.MeshStandardMaterial[] = [];
  private fallbackGroup = new THREE.Group();
  private litAt: (tx: number, ty: number) => number = () => 1;
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

  buildWorld(
    map: MapLayout,
    seed: number,
    archetypeAt: (path: string) => DistrictArchetype,
    litAt: (tx: number, ty: number) => number,
    dna: WorldDNA,
    degraded = false,
  ): void {
    this.litAt = litAt;
    this.buildingTintColor = mixColor(0xffffff, dna.buildingTint.roof, BUILDING_TINT_MIX);

    // --- collect placements per model key -----------------------------------
    const add = (key: string, p: Placement) => {
      const list = this.placements.get(key) ?? [];
      list.push(p);
      this.placements.set(key, list);
    };

    // file buildings
    for (const [path, cell] of map.plots) {
      const kind = buildingKindFor(path);
      const key = modelKeyFor(path, kind, archetypeAt(path));
      const h = hashStr(path);
      const bucket = map.buckets.get(path) ?? 1;
      const scale = BUCKET_SCALE[bucket] * (0.92 + (((h >>> 9) & 7) / 7) * 0.16);
      const idx = (this.placements.get(key)?.length ?? 0);
      add(key, {
        x: cell.tx,
        z: cell.ty,
        rotY: (((h >>> 6) & 3) * Math.PI) / 2,
        scale,
        path,
        tileKey: `${cell.tx},${cell.ty}`,
        tint: this.buildingTintColor,
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
    }

    // hamlets: three miniature homes + a pick box + a badge
    for (const hm of map.hamlets) {
      const h = hashStr(hm.dirPath);
      const offs = [
        [-0.24, -0.12],
        [0.26, 0.02],
        [0.0, 0.28],
      ] as const;
      offs.forEach(([ox, oz], i) => {
        add("home_B", {
          x: hm.tx + ox,
          z: hm.ty + oz,
          rotY: ((((h >>> (i * 3)) & 3) * Math.PI) / 2),
          scale: 0.3,
          path: null,
          tileKey: `${hm.tx},${hm.ty}`,
          tint: this.buildingTintColor,
        });
      });
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.5, 0.95).translate(0, 0.25, 0),
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true }),
      );
      box.position.set(hm.tx, 0, hm.ty);
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
      badge.sprite.position.set(hm.tx, 0.62, hm.ty);
      this.group.add(badge.sprite);
      this.badges.push(badge);
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
        if (map.water.has(key) || map.used.has(key) || map.roads.has(key)) continue;
        const r = rng();
        if (r < treeP) {
          const cut = rng() < dna.vegetation.cutShare;
          add(cut ? "tree_cut" : trees[Math.floor(rng() * trees.length)]!, {
            x: tx + (rng() - 0.5) * 0.7,
            z: ty + (rng() - 0.5) * 0.7,
            rotY: Math.floor(rng() * 4) * (Math.PI / 2),
            scale: 0.8 + rng() * 0.7,
            path: null,
            tileKey: null,
            tint: cut ? undefined : foliageTint,
          });
          this.decorStatsRec.trees++;
        } else if (r < treeP + rockP) {
          add(rocks[Math.floor(rng() * rocks.length)]!, {
            x: tx + (rng() - 0.5) * 0.6,
            z: ty + (rng() - 0.5) * 0.6,
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
        rotY: ((hashStr(q.path) & 3) * Math.PI) / 2,
        scale: 0.55,
        path: null,
        tileKey: null,
      });
    }
    add("flag", { x: map.townCenter.tx - 1.6, z: map.townCenter.ty - 1.6, rotY: 0, scale: 0.7, path: null, tileKey: null });
    add("flag", { x: map.townCenter.tx + 1.6, z: map.townCenter.ty - 1.6, rotY: 0, scale: 0.7, path: null, tileKey: null });

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
      add(key, { x: tx, z: ty, rotY, scale, path: null, tileKey: null });
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
      if (seen.has(k) || map.water.has(k) || map.roads.has(k) || map.used.has(k)) return;
      seen.add(k);
      add(key, { x: tx, z: ty, rotY, scale: 1, path: null, tileKey: null });
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
        if (map.used.has(key) || map.roads.has(key) || map.water.has(key)) continue;
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
          rotY: rng() * Math.PI * 2,
          scale: 0.42 + rng() * 0.2,
          path: null,
          tileKey: null,
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
    root.position.set(tc.tx, 0, tc.ty);
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
    const model: StaticModel | undefined = this.assets.statics.get(key);
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
    this.scratch.makeRotationY(p.rotY);
    this.scratch.scale(new THREE.Vector3(p.scale, p.scale, p.scale));
    this.scratch.setPosition(p.x, 0, p.z);
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

  /** Look up the file path for an instanced-mesh raycast hit. */
  pathForInstance(mesh: THREE.InstancedMesh, instanceId: number): string | null {
    const key = mesh.userData.setKey as string | undefined;
    if (!key) return null;
    const list = this.placements.get(key);
    return list?.[instanceId]?.path ?? null;
  }

  /** New file mid-match: append an instance (or fall back to a plain mesh). */
  addBuilding(path: string, kind: string, archetype: DistrictArchetype, tx: number, ty: number): BuildingRec3D {
    const existing = this.buildings.get(path);
    if (existing) return existing;
    const key = modelKeyFor(path, kind, archetype);
    const h = hashStr(path);
    const scale = BUCKET_SCALE[1] * (0.92 + (((h >>> 9) & 7) / 7) * 0.16);
    const p: Placement = {
      x: tx,
      z: ty,
      rotY: (((h >>> 6) & 3) * Math.PI) / 2,
      scale,
      path,
      tileKey: `${tx},${ty}`,
      tint: this.buildingTintColor,
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
      root.position.set(tx, 0, ty);
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

  /** Reskin: lean every building instance toward the new DNA roof color. */
  retintBuildings(roof: number): void {
    this.buildingTintColor = mixColor(0xffffff, roof, BUILDING_TINT_MIX);
    for (const [key, list] of this.placements) {
      const set = this.sets.get(key);
      list.forEach((p, i) => {
        if (p.tint === undefined) return; // never tinted (walls-era safety)
        p.tint = this.buildingTintColor;
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
