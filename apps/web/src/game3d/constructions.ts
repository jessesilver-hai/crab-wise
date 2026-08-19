// Castle constructions: every CastlePlan socket becomes a low-poly building
// assembled from KayKit pieces by a per-form recipe. Trait-bound props are
// the isomorphism surface — gates, carts, banners and storeys COUNT, and the
// manor's roof cap + banners carry the measured palette as exact material
// colors (readable back for the smoke battery). Static pieces merge by
// material so a 20-component castle stays well under the draw-call budget.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CastleForm, Socket, Traits } from "../game/castle.js";
import type { Assets, StaticModel } from "./assets.js";
import { cssHex, hashStr, hexColor } from "./util.js";

/** Raycast payloads for everything clickable in the castle scene. */
export type PickInfo =
  | { kind: "unit"; id: string }
  | { kind: "raider"; key: string; name: string }
  | { kind: "construction"; componentId: string };

/** Footprint multiplier per measured size step (1 cottage … 4 monument). */
export const SIZE_SCALE: Record<number, number> = { 1: 0.8, 2: 1.0, 3: 1.3, 4: 1.7 };

/** Default roof/banner registers when a component has no measured palette. */
const DEFAULT_ROOF = 0xb5563c;
const DEFAULT_BANNER = 0xd8a53c;
const RUBBLE_GREY = 0x8d8a82;

const RISE_MS = 700;
const SWAP_MS = 320;
const TINT_MS = 1000;
const SIZE_MS = 700;

// ---------------------------------------------------------------------------
// Recipe vocabulary
// ---------------------------------------------------------------------------

type Place = {
  key: string; // MODEL_FILES key, or "__roofcap" for the procedural roof prism
  x?: number;
  y?: number;
  z?: number;
  rotY?: number;
  s?: number;
  sy?: number;
  /** roof/banner get per-construction cloned materials; grey = rubble mute. */
  role?: "roof" | "banner" | "grey";
};

export type Built = {
  group: THREE.Group;
  roofMats: THREE.MeshStandardMaterial[];
  bannerMats: THREE.MeshStandardMaterial[];
  disposables: { geoms: THREE.BufferGeometry[]; mats: THREE.Material[] };
  height: number;
  radius: number;
};

/** Procedural roof prism (unit footprint, ridge along x, grounded at y=0). */
let ROOFCAP_GEO: THREE.BufferGeometry | null = null;
function roofcapGeometry(): THREE.BufferGeometry {
  if (ROOFCAP_GEO) return ROOFCAP_GEO;
  const g = new THREE.BufferGeometry();
  // triangular prism: base 1×1, apex ridge at y=1 along x
  const v = [
    // south slope
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 0, 0.5], [0.5, 1, 0], [-0.5, 1, 0],
    // north slope
    [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 0, -0.5], [-0.5, 1, 0], [0.5, 1, 0],
    // east gable
    [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, 0],
    // west gable
    [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0],
  ].flat();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  ROOFCAP_GEO = g;
  return g;
}

/** Box stand-ins for kit pieces that failed to load — warn once, never crash. */
const boxModels = new Map<string, StaticModel>();
const warnedMissing = new Set<string>();
export function missingPieces(): string[] {
  return [...warnedMissing].sort();
}
function modelOrBox(assets: Assets, key: string): StaticModel {
  const m = assets.statics.get(key);
  if (m) return m;
  let box = boxModels.get(key);
  if (!box) {
    if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      console.warn(`[castle3d] kit piece missing: ${key} — box fallback`);
    }
    const geo = new THREE.BoxGeometry(0.9, 0.8, 0.9).translate(0, 0.4, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9f8f78 + ((hashStr(key) % 0x30) << 8),
      roughness: 0.9,
    });
    box = { parts: [{ geometry: geo, material: mat }], size: new THREE.Vector3(0.9, 0.8, 0.9) };
    boxModels.set(key, box);
  }
  return box;
}

function modelHeight(assets: Assets, key: string): number {
  return modelOrBox(assets, key).size.y;
}

// ---------------------------------------------------------------------------
// Form recipes — each form's silhouette from kit pieces + trait-bound props.
// Local +Z is the socket's outward direction (the building's "front").
// ---------------------------------------------------------------------------

function recipeFor(assets: Assets, form: CastleForm, t: Traits): Place[] {
  const k = SIZE_SCALE[t.size] ?? 1;
  const h = (key: string, s: number) => modelHeight(assets, key) * s;
  const places: Place[] = [];
  switch (form) {
    case "keep": {
      const s = 3.0 * k;
      places.push({ key: "castle", s });
      const top = h("castle", s);
      places.push({ key: "flag", s: 0.7, x: -0.34 * s, z: -0.34 * s, y: top * 0.92, role: "banner" });
      places.push({ key: "flag", s: 0.7, x: 0.34 * s, z: 0.34 * s, y: top * 0.92, role: "banner" });
      break;
    }
    case "manor": {
      const s = 1.8 * k;
      places.push({ key: "home_B", s });
      const bh = h("home_B", s);
      // the repaint surface: an exact-color roof cap over the kit roof
      places.push({ key: "__roofcap", s: s * 1.06, sy: bh * 0.42, y: bh * 0.58, role: "roof" });
      places.push({ key: "banner", s: 0.6, x: -0.62 * s, z: 0.58 * s, role: "banner" });
      places.push({ key: "banner", s: 0.6, x: 0.62 * s, z: 0.58 * s, role: "banner" });
      break;
    }
    case "gatehouse": {
      const s = 1.9 * k;
      places.push({ key: "wall_straight", s, sy: 1.5 });
      places.push({ key: "flag", s: 0.6, y: h("wall_straight", s) * 1.5, role: "banner" });
      const n = Math.max(1, t.gates);
      for (let i = 0; i < n; i++) {
        places.push({ key: "wall_gate", s: 0.62 * k, x: (i - (n - 1) / 2) * 0.68 * k, z: 0.7 * s * 0.5 + 0.35 });
      }
      break;
    }
    case "ore-mine": {
      const s = 1.7 * k;
      places.push({ key: "mine", s });
      places.push({ key: "rock_B", s: 0.85, x: -0.85 * s, z: 0.35 * s });
      places.push({ key: "rock_C", s: 0.6, x: -0.6 * s, z: 0.75 * s });
      places.push({ key: "fence", s: 0.9, x: 0.8 * s, z: 0.2, rotY: Math.PI / 2 });
      const n = Math.max(1, t.shafts);
      for (let i = 0; i < n; i++) {
        const a = -0.7 + (i / Math.max(1, n - 1)) * 1.4;
        places.push({
          key: "wheelbarrow",
          s: 0.52,
          x: Math.sin(a) * 1.15 * s,
          z: Math.cos(a) * 1.15 * s,
          rotY: a + Math.PI / 2,
        });
      }
      break;
    }
    case "enginehouse": {
      const s = 1.7 * k;
      places.push({ key: "watermill", s });
      places.push({ key: "crate_big", s: 0.55, x: 0.8 * s, z: 0.5 * s });
      places.push({ key: "barrel", s: 0.45, x: -0.8 * s, z: 0.55 * s });
      break;
    }
    case "smithy": {
      const s = 1.6 * k;
      places.push({ key: "blacksmith", s });
      places.push({ key: "barrel", s: 0.45, x: 0.75 * s, z: 0.5 * s });
      places.push({ key: "weaponrack", s: 0.55, x: -0.75 * s, z: 0.55 * s });
      break;
    }
    case "foundry": {
      const s = 1.7 * k;
      places.push({ key: "lumbermill", s });
      places.push({ key: "resource_lumber", s: 0.6, x: 0.8 * s, z: 0.45 * s });
      places.push({ key: "resource_stone", s: 0.55, x: -0.8 * s, z: 0.5 * s });
      break;
    }
    case "training-yard": {
      const r = 1.35 * k;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        places.push({ key: "fence", s: 0.85, x: Math.cos(a) * r, z: Math.sin(a) * r, rotY: -a + Math.PI / 2 });
      }
      places.push({ key: "target", s: 0.6, x: 0.35 * r, z: -0.2 * r });
      places.push({ key: "weaponrack", s: 0.55, x: -0.45 * r, z: 0.25 * r, rotY: 0.8 });
      const n = Math.max(1, t.banners);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.3;
        places.push({ key: "banner", s: 0.6, x: Math.cos(a) * r * 0.72, z: Math.sin(a) * r * 0.72, role: "banner" });
      }
      break;
    }
    case "library-tower": {
      const n = Math.max(1, t.storeys);
      let y = 0;
      for (let i = 0; i < n; i++) {
        const s = 1.15 * k * Math.pow(0.93, i);
        places.push({ key: "tower_B", s, y, rotY: (i % 2) * (Math.PI / 2) });
        y += h("tower_B", s) * 0.92;
      }
      places.push({ key: "book_set", s: 0.5, x: 0.55 * k, z: 0.75 * k });
      break;
    }
    case "signal-tower": {
      const n = Math.max(1, t.storeys);
      let y = 0;
      let topS = 1.1 * k;
      for (let i = 0; i < n; i++) {
        topS = 1.1 * k * Math.pow(0.93, i);
        places.push({ key: "tower_A", s: topS, y, rotY: (i % 2) * (Math.PI / 2) });
        y += h("tower_A", topS) * 0.92;
      }
      places.push({ key: "torch_lit", s: 0.55, y: y + 0.02 });
      break;
    }
    case "reliquary": {
      const s = 1.5 * k;
      places.push({ key: "market", s });
      places.push({ key: "chest", s: 0.45, x: 0.6 * s, z: 0.55 * s, rotY: 0.5 });
      places.push({ key: "chest", s: 0.4, x: -0.62 * s, z: 0.5 * s, rotY: -0.4 });
      places.push({ key: "sack", s: 0.4, x: 0.1 * s, z: 0.8 * s });
      break;
    }
    case "well": {
      places.push({ key: "well", s: 1.25 * k });
      places.push({ key: "barrel", s: 0.4, x: 0.75 * k, z: 0.4 * k });
      break;
    }
    case "chapel": {
      places.push({ key: "church", s: 1.6 * k });
      break;
    }
  }
  return places;
}

function scaffoldRecipe(): Place[] {
  return [
    { key: "scaffolding", s: 1.45 },
    { key: "crate_big", s: 0.5, x: 0.75, z: 0.55 },
    { key: "crate_A_small", s: 0.42, x: -0.72, z: 0.5, rotY: 0.6 },
    { key: "barrel", s: 0.4, x: 0.55, z: -0.7 },
  ];
}

function rubbleRecipe(k: number): Place[] {
  return [
    { key: "destroyed", s: 1.5 * k, role: "grey" },
    { key: "rock_A", s: 0.7, x: -0.7 * k, z: 0.5 * k, role: "grey" },
    { key: "rock_D", s: 0.55, x: 0.72 * k, z: 0.42 * k, rotY: 1.1, role: "grey" },
    { key: "resource_lumber", s: 0.65, x: 0.2 * k, z: 0.85 * k, rotY: 0.7, role: "grey" },
  ];
}

// ---------------------------------------------------------------------------
// Compose: placements → merged meshes (+ per-construction cloned materials)
// ---------------------------------------------------------------------------

function compose(assets: Assets, places: Place[], tint: number, banner: number): Built {
  const group = new THREE.Group();
  const disposables = { geoms: [] as THREE.BufferGeometry[], mats: [] as THREE.Material[] };
  const roofMats: THREE.MeshStandardMaterial[] = [];
  const bannerMats: THREE.MeshStandardMaterial[] = [];
  const shared = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const roleGeo = new Map<string, { mat: THREE.MeshStandardMaterial; geoms: THREE.BufferGeometry[] }[]>();
  const m4 = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();

  for (const p of places) {
    const s = p.s ?? 1;
    const sy = p.sy ?? s;
    m4.makeRotationY(p.rotY ?? 0);
    tmp.makeScale(s, sy, s);
    m4.multiply(tmp);
    m4.setPosition(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    const parts =
      p.key === "__roofcap"
        ? [{ geometry: roofcapGeometry(), material: null as THREE.Material | null }]
        : modelOrBox(assets, p.key).parts;
    for (const part of parts) {
      const geo = part.geometry.clone().applyMatrix4(m4);
      disposables.geoms.push(geo);
      if (p.role) {
        // one cloned material per (role) per construction; role-mates merge
        let buckets = roleGeo.get(p.role);
        if (!buckets) {
          buckets = [];
          roleGeo.set(p.role, buckets);
        }
        let bucket = buckets.find((b) => b.mat.userData.src === (part.material ?? "roofcap"));
        if (!bucket) {
          const mat = part.material
            ? ((part.material as THREE.MeshStandardMaterial).clone() as THREE.MeshStandardMaterial)
            : new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, flatShading: true });
          mat.userData.src = part.material ?? "roofcap";
          if (p.role === "roof") {
            mat.color.set(tint);
            roofMats.push(mat);
          } else if (p.role === "banner") {
            mat.color.set(banner);
            bannerMats.push(mat);
          } else {
            mat.color.set(RUBBLE_GREY);
          }
          disposables.mats.push(mat);
          bucket = { mat, geoms: [] };
          buckets.push(bucket);
        }
        bucket.geoms.push(geo);
      } else if (part.material) {
        const list = shared.get(part.material) ?? [];
        list.push(geo);
        shared.set(part.material, list);
      }
    }
  }

  const addMesh = (geoms: THREE.BufferGeometry[], material: THREE.Material, role?: string) => {
    let geo: THREE.BufferGeometry | null = geoms[0] ?? null;
    if (geoms.length > 1) {
      try {
        geo = mergeGeometries(geoms, false);
        if (geo) disposables.geoms.push(geo);
      } catch {
        geo = null;
      }
    }
    const list = geo ? [geo] : geoms;
    for (const g of list) {
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (role) mesh.userData.role = role;
      group.add(mesh);
    }
  };
  for (const [mat, geoms] of shared) addMesh(geoms, mat);
  for (const [role, buckets] of roleGeo) {
    for (const b of buckets) addMesh(b.geoms, b.mat, role);
  }

  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  return {
    group,
    roofMats,
    bannerMats,
    disposables,
    height: Math.max(0.5, box.max.y),
    radius: Math.max(0.6, Math.max(size.x, size.z) / 2),
  };
}

// ---------------------------------------------------------------------------
// The construction manager — sockets in, animated meshes out.
// ---------------------------------------------------------------------------

export type ConstructionState = "scaffold" | "built" | "rubble";

type Rec = {
  componentId: string;
  socket: Socket;
  label: string;
  form: CastleForm;
  traits: Traits;
  state: ConstructionState;
  root: THREE.Group; // world placement (never moves — ledger law)
  inner: THREE.Group; // built content; scale-animated
  built: Built | null;
  pick: THREE.Mesh;
  builtSize: number; // size step the current geometry was built at
  // animation state
  riseAt: number;
  riseDur: number;
  swapDeadline: number | null; // scaffold → real construction
  pendingSwap: { form: CastleForm; traits: Traits; state: ConstructionState } | null;
  swapPhase: "down" | "up" | null;
  swapT: number;
  tintT: number | null;
  tintFromRoof: THREE.Color;
  tintToRoof: THREE.Color;
  tintFromBanner: THREE.Color;
  tintToBanner: THREE.Color;
  scaleFrom: number;
  scaleTo: number;
  scaleT: number | null;
};

export class Constructions {
  readonly group = new THREE.Group();
  readonly pickables: THREE.Object3D[] = [];
  groundY: (x: number, z: number) => number = () => 0;
  /** Dust/spark hook (renderer wires fx in; null under particle degrade). */
  onPuff: ((x: number, y: number, z: number, kind: "dust" | "spark" | "shimmer") => void) | null = null;

  private assets: Assets;
  private recs = new Map<string, Rec>();

  constructor(assets: Assets) {
    this.assets = assets;
  }

  get count(): number {
    return this.recs.size;
  }

  ids(): string[] {
    return [...this.recs.keys()];
  }

  has(id: string): boolean {
    return this.recs.has(id);
  }

  stateOf(id: string): ConstructionState | null {
    return this.recs.get(id)?.state ?? null;
  }

  formOf(id: string): CastleForm | null {
    return this.recs.get(id)?.form ?? null;
  }

  labelOf(id: string): string | null {
    return this.recs.get(id)?.label ?? null;
  }

  socketOf(id: string): Socket | null {
    return this.recs.get(id)?.socket ?? null;
  }

  worldPos(id: string): { x: number; y: number; z: number } | null {
    const r = this.recs.get(id);
    return r ? { x: r.root.position.x, y: r.root.position.y, z: r.root.position.z } : null;
  }

  topOf(id: string): { x: number; y: number; z: number } | null {
    const r = this.recs.get(id);
    if (!r) return null;
    const h = (r.built?.height ?? 1) * r.inner.scale.y;
    return { x: r.root.position.x, y: r.root.position.y + h, z: r.root.position.z };
  }

  tintOf(id: string): { roof: string | null; banner: string | null } {
    const r = this.recs.get(id);
    const roof = r?.built?.roofMats[0] ?? null;
    const banner = r?.built?.bannerMats[0] ?? null;
    return {
      roof: roof ? cssHex(roof.color.getHex()) : null,
      banner: banner ? cssHex(banner.color.getHex()) : null,
    };
  }

  scaffoldCount(): number {
    let n = 0;
    for (const r of this.recs.values()) if (r.state === "scaffold") n++;
    return n;
  }

  scaffoldPositions(): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const r of this.recs.values()) {
      if (r.state === "scaffold") {
        out.push({ x: r.root.position.x, y: r.root.position.y, z: r.root.position.z });
      }
    }
    return out;
  }

  /** Place a socket's construction. `theater` = scaffold first, swap later. */
  add(socket: Socket, label: string, opts: { theater: boolean; riseDelay?: number; instant?: boolean }): void {
    const existing = this.recs.get(socket.componentId);
    if (existing) {
      this.update(socket, label, opts.instant ?? false);
      return;
    }
    const root = new THREE.Group();
    root.position.set(socket.x, this.groundY(socket.x, socket.z), socket.z);
    root.rotation.y = Math.PI / 2 - socket.angle; // face outward along the spoke
    const inner = new THREE.Group();
    root.add(inner);
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pick.userData.pick = { kind: "construction", componentId: socket.componentId } satisfies PickInfo;
    root.add(pick);
    const now = performance.now();
    const rec: Rec = {
      componentId: socket.componentId,
      socket,
      label,
      form: socket.form,
      traits: socket.traits,
      state: socket.razed ? "rubble" : opts.theater ? "scaffold" : "built",
      root,
      inner,
      built: null,
      pick,
      builtSize: socket.traits.size,
      riseAt: now + (opts.riseDelay ?? 0),
      riseDur: opts.instant ? 1 : RISE_MS,
      swapDeadline: opts.theater && !socket.razed ? now + 6000 : null,
      pendingSwap: null,
      swapPhase: null,
      swapT: 0,
      tintT: null,
      tintFromRoof: new THREE.Color(),
      tintToRoof: new THREE.Color(),
      tintFromBanner: new THREE.Color(),
      tintToBanner: new THREE.Color(),
      scaleFrom: 1,
      scaleTo: 1,
      scaleT: null,
    };
    this.rebuild(rec);
    inner.scale.setScalar(opts.instant ? 1 : 0.001);
    this.group.add(root);
    this.recs.set(socket.componentId, rec);
    this.pickables.push(pick);
  }

  /** Socket data refresh (traits/form/razed) without animation decisions. */
  private update(socket: Socket, label: string, instant: boolean): void {
    const rec = this.recs.get(socket.componentId);
    if (!rec) return;
    rec.socket = socket;
    rec.label = label;
    if (instant) {
      rec.form = socket.form;
      rec.traits = socket.traits;
      rec.state = socket.razed ? "rubble" : rec.state === "scaffold" ? rec.state : "built";
      this.rebuild(rec);
    }
  }

  /** Scaffold → the real construction (dust puff; called by timer or event). */
  completeScaffold(id: string): boolean {
    const rec = this.recs.get(id);
    if (!rec || rec.state !== "scaffold") return false;
    rec.swapDeadline = null;
    this.beginSwap(rec, { form: rec.socket.form, traits: rec.socket.traits, state: "built" });
    this.puffAt(rec, "dust");
    return true;
  }

  /** Scaffolds whose 6s deadline passed (renderer completes + narrates). */
  dueScaffolds(now: number): string[] {
    const due: string[] = [];
    for (const rec of this.recs.values()) {
      if (rec.state === "scaffold" && rec.swapDeadline !== null && now >= rec.swapDeadline) due.push(rec.componentId);
    }
    return due;
  }

  /** Animate a traits diff. Returns what visibly changed (for examine lines). */
  applyTraits(id: string, socket: Socket, animate: boolean): { tint: boolean; size: boolean; counts: boolean } {
    const rec = this.recs.get(id);
    if (!rec) return { tint: false, size: false, counts: false };
    const before = rec.traits;
    const after = socket.traits;
    rec.socket = socket;
    const tintChanged = before.tint !== after.tint || before.banner !== after.banner;
    const sizeChanged = before.size !== after.size;
    const countsChanged =
      before.gates !== after.gates ||
      before.shafts !== after.shafts ||
      before.banners !== after.banners ||
      before.storeys !== after.storeys;
    if (rec.state === "scaffold") {
      // construction theater ends early: the facts moved before the timer
      rec.traits = after;
      this.completeScaffold(id);
      return { tint: tintChanged, size: sizeChanged, counts: countsChanged };
    }
    rec.traits = after;
    if (!animate) {
      this.rebuild(rec);
      return { tint: tintChanged, size: sizeChanged, counts: countsChanged };
    }
    if (countsChanged || rec.state === "rubble") {
      const fromRoof = rec.built?.roofMats[0]?.color.clone() ?? null;
      const fromBanner = rec.built?.bannerMats[0]?.color.clone() ?? null;
      this.rebuild(rec);
      if (tintChanged) this.startTintLerp(rec, fromRoof, fromBanner);
      this.puffAt(rec, "dust");
    } else {
      if (sizeChanged) {
        rec.scaleFrom = rec.inner.scale.x;
        rec.scaleTo = (SIZE_SCALE[after.size] ?? 1) / (SIZE_SCALE[rec.builtSize] ?? 1);
        rec.scaleT = 0;
      }
      if (tintChanged) {
        this.startTintLerp(rec, null, null);
        this.puffAt(rec, "shimmer");
      }
    }
    return { tint: tintChanged, size: sizeChanged, counts: countsChanged };
  }

  /** Representation swap: crossfade to the new form's construction. */
  swapForm(id: string, socket: Socket, animate: boolean): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    rec.socket = socket;
    if (rec.state === "scaffold") {
      rec.traits = socket.traits;
      rec.form = socket.form;
      this.completeScaffold(id);
      return;
    }
    if (!animate) {
      rec.form = socket.form;
      rec.traits = socket.traits;
      this.rebuild(rec);
      return;
    }
    this.beginSwap(rec, { form: socket.form, traits: socket.traits, state: rec.state === "rubble" ? "rubble" : "built" });
  }

  /** Collapse to rubble. Returns false when it was still scaffolding. */
  raze(id: string, socket: Socket, animate: boolean): boolean {
    const rec = this.recs.get(id);
    if (!rec) return false;
    rec.socket = socket;
    if (rec.state === "scaffold") {
      this.remove(id);
      return false;
    }
    if (!animate) {
      rec.state = "rubble";
      this.rebuild(rec);
      return true;
    }
    this.beginSwap(rec, { form: rec.form, traits: rec.traits, state: "rubble" });
    this.puffAt(rec, "dust");
    return true;
  }

  remove(id: string): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    this.disposeBuilt(rec);
    rec.pick.geometry.dispose();
    (rec.pick.material as THREE.Material).dispose();
    const pi = this.pickables.indexOf(rec.pick);
    if (pi >= 0) this.pickables.splice(pi, 1);
    rec.root.removeFromParent();
    this.recs.delete(id);
  }

  private beginSwap(rec: Rec, next: { form: CastleForm; traits: Traits; state: ConstructionState }): void {
    rec.pendingSwap = next;
    rec.swapPhase = "down";
    rec.swapT = 0;
  }

  private startTintLerp(rec: Rec, fromRoof: THREE.Color | null, fromBanner: THREE.Color | null): void {
    const roof = rec.built?.roofMats[0];
    const banner = rec.built?.bannerMats[0];
    rec.tintFromRoof.copy(fromRoof ?? roof?.color ?? new THREE.Color(DEFAULT_ROOF));
    rec.tintFromBanner.copy(fromBanner ?? banner?.color ?? new THREE.Color(DEFAULT_BANNER));
    rec.tintToRoof.set(hexColor(rec.traits.tint ?? "") ?? DEFAULT_ROOF);
    rec.tintToBanner.set(hexColor(rec.traits.banner ?? "") ?? DEFAULT_BANNER);
    if (fromRoof) for (const m of rec.built?.roofMats ?? []) m.color.copy(fromRoof);
    if (fromBanner) for (const m of rec.built?.bannerMats ?? []) m.color.copy(fromBanner);
    rec.tintT = 0;
  }

  private puffAt(rec: Rec, kind: "dust" | "spark" | "shimmer"): void {
    const h = (rec.built?.height ?? 1) * 0.7;
    this.onPuff?.(rec.root.position.x, rec.root.position.y + h, rec.root.position.z, kind);
  }

  /** (Re)build the inner meshes for the rec's current form/traits/state. */
  private rebuild(rec: Rec): void {
    const keepScale = rec.inner.scale.x;
    this.disposeBuilt(rec);
    const roof = hexColor(rec.traits.tint ?? "") ?? DEFAULT_ROOF;
    const banner = hexColor(rec.traits.banner ?? "") ?? DEFAULT_BANNER;
    const places =
      rec.state === "rubble"
        ? rubbleRecipe(SIZE_SCALE[rec.traits.size] ?? 1)
        : rec.state === "scaffold"
          ? scaffoldRecipe()
          : recipeFor(this.assets, rec.form, rec.traits);
    rec.built = compose(this.assets, places, roof, banner);
    rec.builtSize = rec.traits.size;
    rec.inner.add(rec.built.group);
    rec.inner.scale.setScalar(keepScale > 0.002 ? 1 : keepScale);
    rec.scaleT = null;
    // pick volume matches the new bounds
    rec.pick.geometry.dispose();
    rec.pick.geometry = new THREE.BoxGeometry(
      rec.built.radius * 2,
      rec.built.height,
      rec.built.radius * 2,
    ).translate(0, rec.built.height / 2, 0);
  }

  private disposeBuilt(rec: Rec): void {
    if (!rec.built) return;
    rec.built.group.removeFromParent();
    for (const g of rec.built.disposables.geoms) g.dispose();
    for (const m of rec.built.disposables.mats) m.dispose();
    rec.built = null;
  }

  tick(now: number, dt: number): void {
    for (const rec of this.recs.values()) {
      // founding rise
      if (rec.inner.scale.x < 1 && rec.swapPhase === null && rec.scaleT === null) {
        const p = Math.min(1, Math.max(0, (now - rec.riseAt) / rec.riseDur));
        const e = 1 - Math.pow(1 - p, 3);
        rec.inner.scale.setScalar(Math.max(0.001, e));
      }
      // crossfade swap
      if (rec.swapPhase !== null) {
        rec.swapT += dt * 1000;
        const p = Math.min(1, rec.swapT / SWAP_MS);
        if (rec.swapPhase === "down") {
          rec.inner.scale.setScalar(Math.max(0.001, 1 - p));
          if (p >= 1 && rec.pendingSwap) {
            rec.form = rec.pendingSwap.form;
            rec.traits = rec.pendingSwap.traits;
            rec.state = rec.pendingSwap.state;
            rec.pendingSwap = null;
            this.rebuild(rec);
            rec.inner.scale.setScalar(0.001);
            rec.swapPhase = "up";
            rec.swapT = 0;
          }
        } else {
          rec.inner.scale.setScalar(Math.max(0.001, p));
          if (p >= 1) {
            rec.swapPhase = null;
            rec.swapT = 0;
          }
        }
      }
      // size tween
      if (rec.scaleT !== null) {
        rec.scaleT += dt * 1000;
        const p = Math.min(1, rec.scaleT / SIZE_MS);
        const e = 1 - Math.pow(1 - p, 3);
        rec.inner.scale.setScalar(rec.scaleFrom + (rec.scaleTo - rec.scaleFrom) * e);
        if (p >= 1) rec.scaleT = null;
      }
      // tint lerp
      if (rec.tintT !== null && rec.built) {
        rec.tintT += dt * 1000;
        const p = Math.min(1, rec.tintT / TINT_MS);
        for (const m of rec.built.roofMats) m.color.lerpColors(rec.tintFromRoof, rec.tintToRoof, p);
        for (const m of rec.built.bannerMats) m.color.lerpColors(rec.tintFromBanner, rec.tintToBanner, p);
        if (p >= 1) rec.tintT = null;
      }
    }
  }

  dispose(): void {
    for (const id of [...this.recs.keys()]) this.remove(id);
    for (const box of boxModels.values()) {
      for (const p of box.parts) {
        p.geometry.dispose();
        p.material.dispose();
      }
    }
    boxModels.clear();
  }
}
