// Castle constructions: every CastlePlan socket carries a BuildingGenome and
// the genome compiler (genomebuild.ts) turns it into merged low-poly
// geometry. Trait-bound laws stay visible — gates, carts, banners COUNT, and
// every built construction wears a procedural roofcap whose material color IS
// the measured palette hex (readable back for the smoke battery) while banner
// cloth wears the secondary token. Scaffold theater and rubble razing still
// compose from KayKit pieces. Static pieces merge by material so a
// 20-component castle stays well under the draw-call budget.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CastleForm, Socket, Traits } from "../game/castle.js";
import type { Assets } from "./assets.js";
import { compileGenome, familyRoofTone, DEFAULT_BANNER, SIZE_SCALE, type Built } from "./genomebuild.js";
import { disposeBoxModels, modelOrBox } from "./pieces.js";
import { cssHex, hexColor } from "./util.js";

export { SIZE_SCALE, type Built } from "./genomebuild.js";
export { missingPieces } from "./pieces.js";

/** Raycast payloads for everything clickable in the castle scene. */
export type PickInfo =
  | { kind: "unit"; id: string }
  | { kind: "raider"; key: string; name: string }
  | { kind: "construction"; componentId: string };

const RUBBLE_GREY = 0x8d8a82;
const DEFAULT_ROOF = 0xb5563c;

const RISE_MS = 700;
const SWAP_MS = 320;
const TINT_MS = 1000;
const SIZE_MS = 700;

// ---------------------------------------------------------------------------
// Scaffold + rubble recipes — the only fixed compositions left.
// ---------------------------------------------------------------------------

type Place = {
  key: string;
  x?: number;
  y?: number;
  z?: number;
  rotY?: number;
  s?: number;
  sy?: number;
  /** grey = rubble mute (per-construction cloned material). */
  role?: "grey";
};

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

/** Compose fixed placements (scaffold/rubble) into a Built. */
function compose(assets: Assets, places: Place[]): Built {
  const group = new THREE.Group();
  const disposables = { geoms: [] as THREE.BufferGeometry[], mats: [] as THREE.Material[] };
  const shared = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const greyBuckets: { src: THREE.Material; mat: THREE.MeshStandardMaterial; geoms: THREE.BufferGeometry[] }[] = [];
  const m4 = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();

  for (const p of places) {
    const s = p.s ?? 1;
    const sy = p.sy ?? s;
    m4.makeRotationY(p.rotY ?? 0);
    tmp.makeScale(s, sy, s);
    m4.multiply(tmp);
    m4.setPosition(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    for (const part of modelOrBox(assets, p.key).parts) {
      const geo = part.geometry.clone().applyMatrix4(m4);
      disposables.geoms.push(geo);
      if (p.role === "grey") {
        let bucket = greyBuckets.find((b) => b.src === part.material);
        if (!bucket) {
          const mat = (part.material as THREE.MeshStandardMaterial).clone();
          mat.color.set(RUBBLE_GREY);
          disposables.mats.push(mat);
          bucket = { src: part.material, mat, geoms: [] };
          greyBuckets.push(bucket);
        }
        bucket.geoms.push(geo);
      } else {
        const list = shared.get(part.material) ?? [];
        list.push(geo);
        shared.set(part.material, list);
      }
    }
  }

  const addMesh = (geoms: THREE.BufferGeometry[], material: THREE.Material) => {
    let geo: THREE.BufferGeometry | null = geoms[0] ?? null;
    if (geoms.length > 1) {
      try {
        geo = mergeGeometries(geoms, false);
        if (geo) disposables.geoms.push(geo);
      } catch {
        geo = null;
      }
    }
    for (const g of geo ? [geo] : geoms) {
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  };
  for (const [mat, geoms] of shared) addMesh(geoms, mat);
  for (const b of greyBuckets) addMesh(b.geoms, b.mat);

  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  return {
    group,
    roofMats: [],
    bannerMats: [],
    disposables,
    height: Math.max(0.5, box.max.y),
    radius: Math.max(0.6, Math.max(size.x, size.z) / 2),
    smokeAt: [],
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
  /** The plan seed — the genome compiler's deterministic placement salt. */
  planSeed = 0;
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

  /** Mesh + vertex signature of the current built geometry (rebuild witness). */
  sigOf(id: string): string | null {
    const r = this.recs.get(id);
    if (!r?.built) return null;
    let meshes = 0;
    let verts = 0;
    r.built.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        meshes++;
        const att = m.geometry.getAttribute("position");
        if (att) verts += att.count;
      }
    });
    return `${meshes}:${verts}`;
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

  /** World-space chimney mouths of built constructions with ornament.smoke. */
  smokeSources(): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    for (const r of this.recs.values()) {
      if (r.state !== "built" || !r.built) continue;
      for (const s of r.built.smokeAt) {
        out.push({
          x: r.root.position.x + s.x,
          y: r.root.position.y + s.y * r.inner.scale.y,
          z: r.root.position.z + s.z,
        });
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

  /** Animate a traits diff. Returns what visibly changed + whether geometry rebuilt. */
  applyTraits(
    id: string,
    socket: Socket,
    animate: boolean,
  ): { tint: boolean; size: boolean; counts: boolean; rebuilt: boolean } {
    const rec = this.recs.get(id);
    if (!rec) return { tint: false, size: false, counts: false, rebuilt: false };
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
      return { tint: tintChanged, size: sizeChanged, counts: countsChanged, rebuilt: true };
    }
    rec.traits = after;
    if (!animate) {
      this.rebuild(rec);
      return { tint: tintChanged, size: sizeChanged, counts: countsChanged, rebuilt: true };
    }
    if (countsChanged || rec.state === "rubble") {
      const fromRoof = rec.built?.roofMats[0]?.color.clone() ?? null;
      const fromBanner = rec.built?.bannerMats[0]?.color.clone() ?? null;
      this.rebuild(rec);
      if (tintChanged) this.startTintLerp(rec, fromRoof, fromBanner);
      this.puffAt(rec, "dust");
      return { tint: tintChanged, size: sizeChanged, counts: countsChanged, rebuilt: true };
    }
    if (sizeChanged) {
      rec.scaleFrom = rec.inner.scale.x;
      rec.scaleTo = (SIZE_SCALE[after.size] ?? 1) / (SIZE_SCALE[rec.builtSize] ?? 1);
      rec.scaleT = 0;
    }
    if (tintChanged) {
      this.startTintLerp(rec, null, null);
      this.puffAt(rec, "shimmer");
    }
    return { tint: tintChanged, size: sizeChanged, counts: countsChanged, rebuilt: false };
  }

  /** Representation/genome swap: crossfade to the socket's new construction. */
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
    const roofFallback = familyRoofTone(rec.socket.genome.material.family) || DEFAULT_ROOF;
    rec.tintFromRoof.copy(fromRoof ?? roof?.color ?? new THREE.Color(roofFallback));
    rec.tintFromBanner.copy(fromBanner ?? banner?.color ?? new THREE.Color(DEFAULT_BANNER));
    rec.tintToRoof.set(hexColor(rec.traits.tint ?? "") ?? roofFallback);
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
    if (rec.state === "rubble") {
      rec.built = compose(this.assets, rubbleRecipe(SIZE_SCALE[rec.traits.size] ?? 1));
    } else if (rec.state === "scaffold") {
      rec.built = compose(this.assets, scaffoldRecipe());
    } else {
      rec.built = compileGenome(this.assets, {
        componentId: rec.componentId,
        form: rec.form,
        traits: rec.traits,
        genome: rec.socket.genome,
        seed: this.planSeed,
      });
    }
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
    disposeBoxModels();
  }
}
