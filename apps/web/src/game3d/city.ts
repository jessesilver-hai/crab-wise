// Instanced city: every file is a building instance, walls trace quarter
// rects, wilderness gets instanced trees/rocks. One InstancedMesh per
// (model part) keeps ~1500 buildings to a handful of draw calls.
// Placement is a pure function of the map layout + hashed paths + the
// seeded rng — never Math.random.
import * as THREE from "three";
import { buildingKindFor, type DistrictArchetype } from "@agent-empires/protocol";
import { mulberry32, type MapLayout, type Quarter, type SizeBucket } from "../game/map.js";
import type { Assets, StaticModel } from "./assets.js";
import { makeBillboard, type Billboard } from "./billboards.js";
import { hashStr, soften } from "./util.js";

const BUCKET_SCALE: Record<SizeBucket, number> = { 0: 0.55, 1: 0.8, 2: 1.05 };
const HEADROOM = 48;

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
    return n;
  }

  buildWorld(
    map: MapLayout,
    seed: number,
    archetypeAt: (path: string) => DistrictArchetype,
    litAt: (tx: number, ty: number) => number,
  ): void {
    this.litAt = litAt;

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

    // walls / fences on quarter perimeters
    for (const q of map.quarters) this.placeWalls(map, q, add);

    // wilderness: instanced trees + rocks in the forest ring
    const rng = mulberry32((seed ^ 0x7ee5a1) >>> 0);
    const c = map.cityRect;
    const trees = ["tree_A", "tree_A", "tree_B", "trees_small", "trees_medium", "trees_B_medium"];
    const rocks = ["rock_A", "rock_B", "rock_C", "rock_D"];
    for (let ty = 2; ty < map.side - 2; ty++) {
      for (let tx = 2; tx < map.side - 2; tx++) {
        const inCity = tx >= c.x && ty >= c.y && tx < c.x + c.w && ty < c.y + c.h;
        if (inCity) continue;
        const r = rng();
        if (r < 0.2) {
          add(trees[Math.floor(rng() * trees.length)]!, {
            x: tx + (rng() - 0.5) * 0.7,
            z: ty + (rng() - 0.5) * 0.7,
            rotY: Math.floor(rng() * 4) * (Math.PI / 2),
            scale: 0.8 + rng() * 0.7,
            path: null,
            tileKey: null,
          });
        } else if (r < 0.235) {
          add(rocks[Math.floor(rng() * rocks.length)]!, {
            x: tx + (rng() - 0.5) * 0.6,
            z: ty + (rng() - 0.5) * 0.6,
            rotY: rng() * Math.PI * 2,
            scale: 0.5 + rng() * 0.6,
            path: null,
            tileKey: null,
          });
        }
      }
    }

    // banners at depth-1 gates (accent-tintable, streams in)
    for (const q of map.quarters) {
      if (q.depth !== 1) continue;
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

    // --- realize sets --------------------------------------------------------
    for (const key of this.placements.keys()) this.realizeSet(key);

    // the Citadel: a plain mesh clone so picking is trivial
    this.placeCitadel(map);
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
    // edges (excluding corners)
    for (let tx = x + 1; tx < x + w - 1; tx++) {
      add(isGate(tx, y) ? gateKey : straightKey, { x: tx, z: y, rotY: 0, scale, path: null, tileKey: null });
      add(isGate(tx, y + h - 1) ? gateKey : straightKey, { x: tx, z: y + h - 1, rotY: Math.PI, scale, path: null, tileKey: null });
    }
    for (let ty = y + 1; ty < y + h - 1; ty++) {
      add(isGate(x, ty) ? gateKey : straightKey, { x, z: ty, rotY: Math.PI / 2, scale, path: null, tileKey: null });
      add(isGate(x + w - 1, ty) ? gateKey : straightKey, { x: x + w - 1, z: ty, rotY: -Math.PI / 2, scale, path: null, tileKey: null });
    }
    // corners
    const corners = [
      [x, y, Math.PI / 2],
      [x + w - 1, y, 0],
      [x + w - 1, y + h - 1, -Math.PI / 2],
      [x, y + h - 1, Math.PI],
    ] as const;
    for (const [cx, cy, rot] of corners) {
      add(cornerKey, { x: cx, z: cy, rotY: rot, scale, path: null, tileKey: null });
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
  private realizeSet(key: string): void {
    const list = this.placements.get(key);
    if (!list || list.length === 0) return;
    const old = this.sets.get(key);
    if (old) {
      for (const m of old.meshes) {
        m.removeFromParent();
        const pi = this.pickables.indexOf(m);
        if (pi >= 0) this.pickables.splice(pi, 1);
        m.dispose();
      }
      this.sets.delete(key);
    }
    const model: StaticModel | undefined = this.assets.statics.get(key);
    const parts = model
      ? model.parts
      : [{ geometry: PLACEHOLDER_GEO, material: PLACEHOLDER_MAT as THREE.Material }];
    const pickable = list.some((p) => p.path !== null);
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
        this.flagMats.push(material as THREE.MeshStandardMaterial);
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
    this.sets.set(key, set);
    if (!model) this.assets.onModel(key, () => this.realizeSet(key));
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
    this.scratchColor.setScalar(lit);
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

  /** Fog changed on a tile: relight its building instances. */
  setTileLight(tx: number, ty: number, veilAlpha: number): void {
    const arr = this.byTile.get(`${tx},${ty}`);
    if (!arr) return;
    const f = 1 - veilAlpha * 0.85;
    this.scratchColor.setScalar(f);
    for (const { setKey, index } of arr) {
      const set = this.sets.get(setKey);
      if (!set) continue;
      for (const mesh of set.meshes) {
        mesh.setColorAt(index, this.scratchColor);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
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
  }

  dispose(): void {
    for (const set of this.sets.values()) for (const m of set.meshes) m.dispose();
    for (const b of this.badges) b.dispose();
    this.sets.clear();
    this.placements.clear();
  }
}
