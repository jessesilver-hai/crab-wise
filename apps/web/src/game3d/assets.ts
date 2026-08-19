// KayKit .glb loading (see public/assets/3d/MANIFEST.json). Core set gates
// first paint; everything else streams in and swaps over placeholders.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const BASE = "/assets/3d/";

export const MODEL_FILES: Record<string, string> = {
  // buildings
  castle: "buildings/building_castle_blue.glb",
  home_A: "buildings/building_home_A_blue.glb",
  home_B: "buildings/building_home_B_blue.glb",
  tavern: "buildings/building_tavern_blue.glb",
  barracks: "buildings/building_barracks_blue.glb",
  archeryrange: "buildings/building_archeryrange_blue.glb",
  church: "buildings/building_church_blue.glb",
  grain: "buildings/building_grain.glb",
  windmill: "buildings/building_windmill_blue.glb",
  watermill: "buildings/building_watermill_blue.glb",
  tower_A: "buildings/building_tower_A_blue.glb",
  tower_B: "buildings/building_tower_B_blue.glb",
  blacksmith: "buildings/building_blacksmith_blue.glb",
  mine: "buildings/building_mine_blue.glb",
  market: "buildings/building_market_blue.glb",
  well: "buildings/building_well_blue.glb",
  scaffolding: "buildings/building_scaffolding.glb",
  lumbermill: "buildings/building_lumbermill_blue.glb",
  destroyed: "buildings/building_destroyed.glb",
  // walls
  wall_straight: "buildings/wall_straight.glb",
  wall_gate: "buildings/wall_straight_gate.glb",
  wall_corner: "buildings/wall_corner_A_outside.glb",
  fence: "buildings/fence_wood_straight.glb",
  fence_gate: "buildings/fence_wood_straight_gate.glb",
  // nature
  tree_A: "nature/tree_single_A.glb",
  tree_B: "nature/tree_single_B.glb",
  tree_cut: "nature/tree_single_A_cut.glb",
  trees_small: "nature/trees_A_small.glb",
  trees_medium: "nature/trees_A_medium.glb",
  trees_B_medium: "nature/trees_B_medium.glb",
  rock_A: "nature/rock_single_A.glb",
  rock_B: "nature/rock_single_B.glb",
  rock_C: "nature/rock_single_C.glb",
  rock_D: "nature/rock_single_D.glb",
  // props
  flag: "props/flag_blue.glb",
  banner: "props/banner_blue.glb",
  target: "props/target.glb",
  weaponrack: "props/weaponrack.glb",
  book_set: "props/book_set.glb",
  book_single: "props/book_single.glb",
  sack: "props/sack.glb",
  crate_big: "props/crate_A_big.glb",
  barrel: "props/barrel.glb",
  // world-DNA district props (keys match WorldDNA.props vocabulary)
  banner_red: "props/banner_red.glb",
  banner_blue: "props/banner_blue.glb",
  tent: "props/tent.glb",
  torch_lit: "props/torch_lit.glb",
  torch_mounted: "props/torch_mounted.glb",
  crate_A_small: "props/crate_A_small.glb",
  crate_A_big: "props/crate_A_big.glb",
  crate_open: "props/crate_open.glb",
  wheelbarrow: "props/wheelbarrow.glb",
  flag_blue: "props/flag_blue.glb",
  resource_lumber: "props/resource_lumber.glb",
  resource_stone: "props/resource_stone.glb",
  chest: "props/chest.glb",
  // dungeon-kit pieces the arcane prop set leans on
  pillar: "kits/dungeon/pillar.gltf.glb",
  // characters
  Rogue: "characters/Rogue.glb",
  Barbarian: "characters/Barbarian.glb",
  Mage: "characters/Mage.glb",
  Skeleton_Minion: "enemies/Skeleton_Minion.glb",
  Skeleton_Warrior: "enemies/Skeleton_Warrior.glb",
};

const CHARACTER_KEYS = new Set([
  "Rogue",
  "Barbarian",
  "Mage",
  "Skeleton_Minion",
  "Skeleton_Warrior",
]);

/**
 * First paint waits for these: every kit piece a castle recipe, the curtain
 * wall or the grounds scatter can ask for, plus the worker characters. The
 * whole set is small low-poly glbs, and loading it up front means recipes
 * never need re-realize machinery.
 */
export const CORE_KEYS = [
  // forms
  "castle",
  "home_B",
  "mine",
  "watermill",
  "blacksmith",
  "lumbermill",
  "market",
  "well",
  "church",
  "tower_A",
  "tower_B",
  "scaffolding",
  "destroyed",
  // walls + fences
  "wall_straight",
  "wall_gate",
  "fence",
  // props
  "flag",
  "banner",
  "target",
  "weaponrack",
  "book_set",
  "sack",
  "crate_big",
  "crate_A_small",
  "barrel",
  "wheelbarrow",
  "chest",
  "torch_lit",
  "resource_lumber",
  "resource_stone",
  "tent",
  "book_single",
  "pillar",
  // nature
  "tree_A",
  "tree_B",
  "tree_cut",
  "trees_B_medium",
  "rock_A",
  "rock_B",
  "rock_C",
  "rock_D",
  // characters
  "Rogue",
  "Barbarian",
  "Mage",
] as const;

export type StaticPart = { geometry: THREE.BufferGeometry; material: THREE.Material };
export type StaticModel = { parts: StaticPart[]; size: THREE.Vector3 };
export type CharModel = { scene: THREE.Group; clips: Map<string, THREE.AnimationClip>; height: number };

/** De-quantize an attribute to plain float32 so bakes never clamp. */
function toFloat(att: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const out = new Float32Array(att.count * att.itemSize);
  for (let i = 0; i < att.count; i++) {
    for (let c = 0; c < att.itemSize; c++) out[i * att.itemSize + c] = att.getComponent(i, c);
  }
  return new THREE.BufferAttribute(out, att.itemSize);
}

/**
 * Bake a glTF scene into normalized static parts: transforms flattened,
 * grounded at y=0, centered in x/z, uniformly scaled so the larger of the
 * x/z footprint equals 1 world unit (= 1 tile).
 */
export function bakeStatic(root: THREE.Object3D): StaticModel {
  root.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const src = mesh.geometry;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", toFloat(src.getAttribute("position")));
    const normal = src.getAttribute("normal");
    if (normal) geo.setAttribute("normal", toFloat(normal));
    const uv = src.getAttribute("uv");
    if (uv) geo.setAttribute("uv", toFloat(uv));
    // vertex-colored kits (Tiny Treats) would bake black without this
    const color = src.getAttribute("color");
    if (color) geo.setAttribute("color", toFloat(color));
    if (src.index) geo.setIndex(src.index.clone());
    geo.applyMatrix4(mesh.matrixWorld);
    const mat = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    const list = byMat.get(mat) ?? [];
    list.push(geo);
    byMat.set(mat, list);
  });
  const parts: StaticPart[] = [];
  for (const [material, geos] of byMat) {
    if (geos.length === 1) {
      parts.push({ geometry: geos[0]!, material });
      continue;
    }
    let merged: THREE.BufferGeometry | null = null;
    try {
      merged = mergeGeometries(geos, false);
    } catch {
      merged = null;
    }
    if (merged) parts.push({ geometry: merged, material });
    else for (const g of geos) parts.push({ geometry: g, material });
  }
  const box = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox!);
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const s = 1 / Math.max(1e-6, Math.max(size.x, size.z));
  const m = new THREE.Matrix4()
    .makeScale(s, s, s)
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
  for (const p of parts) {
    p.geometry.applyMatrix4(m);
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
  }
  size.multiplyScalar(s);
  return { parts, size };
}

export class Assets {
  readonly statics = new Map<string, StaticModel>();
  readonly chars = new Map<string, CharModel>();
  private loader = new GLTFLoader();
  private listeners = new Map<string, ((key: string) => void)[]>();
  private started = new Set<string>();
  private failed = new Set<string>();

  private loadOne(key: string): Promise<void> {
    if (this.started.has(key)) return Promise.resolve();
    this.started.add(key);
    const file = MODEL_FILES[key];
    if (!file) return Promise.resolve();
    return new Promise((resolve) => {
      // fetches issued in the first moments of page life can abort spuriously
      // (observed under headless SwiftShader); retry with backoff before
      // declaring the model failed
      const attempt = (triesLeft: number) => {
        this.loader.load(
          BASE + file,
          (gltf) => {
            try {
              if (CHARACTER_KEYS.has(key)) {
                const scene = gltf.scene;
                scene.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(scene);
                const clips = new Map<string, THREE.AnimationClip>();
                for (const clip of gltf.animations) {
                  clips.set(clip.name.split("|").pop() ?? clip.name, clip);
                }
                this.chars.set(key, { scene, clips, height: Math.max(0.001, box.max.y - box.min.y) });
              } else {
                this.statics.set(key, bakeStatic(gltf.scene));
              }
              for (const cb of this.listeners.get(key) ?? []) cb(key);
              this.listeners.delete(key);
            } catch (err) {
              this.failed.add(key);
              console.error(`[assets3d] bake failed for ${key}:`, err);
            }
            resolve();
          },
          undefined,
          (err) => {
            if (triesLeft > 0) {
              setTimeout(() => attempt(triesLeft - 1), 450 * (3 - triesLeft + 1));
              return;
            }
            this.failed.add(key);
            console.error(`[assets3d] load failed for ${key}:`, err);
            resolve();
          },
        );
      };
      attempt(3);
    });
  }

  async loadCore(): Promise<void> {
    await Promise.all(CORE_KEYS.map((k) => this.loadOne(k)));
  }

  /** Fire-and-forget stream of everything not yet loaded. */
  loadRest(): void {
    for (const key of Object.keys(MODEL_FILES)) void this.loadOne(key);
  }

  /** Run cb now if the model is ready, else when it arrives. */
  onModel(key: string, cb: (key: string) => void): void {
    if (this.statics.has(key) || this.chars.has(key)) {
      cb(key);
      return;
    }
    if (this.failed.has(key)) return;
    const list = this.listeners.get(key) ?? [];
    list.push(cb);
    this.listeners.set(key, list);
  }

  dispose(): void {
    this.listeners.clear();
    for (const m of this.statics.values()) {
      for (const p of m.parts) p.geometry.dispose();
    }
  }
}
