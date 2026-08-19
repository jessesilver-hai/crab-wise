// The ward wall in four StyleGenome dialects: curtain (kit stone wall +
// towers), palisade (sharpened timber posts), hedge (rounded green segments),
// obsidian (dark glassy slabs with an emissive seam). Whatever the style, the
// gate stays at the plan's gateAngle and connector crossings still gap the
// ring so rails and roads pass through instead of clipping.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CastlePlan, Connector } from "../game/castle.js";
import type { WallStyle } from "../game/genome.js";
import type { Assets } from "./assets.js";

const CHUNK_LEN = 1.35;
const GATE_HALF_ARC = 1.6; // world units of wall left open at the main gate
const CROSS_HALF_ARC = 1.0; // world units left open at a connector crossing

export type WallStats = { towers: number; segments: number; gate: boolean; gaps: number; style: WallStyle };

/** Angles (radians) where a connector polyline crosses the wall radius. */
export function wallCrossings(connectors: Connector[], radius: number): number[] {
  const out: number[] = [];
  for (const c of connectors) {
    for (let i = 0; i + 1 < c.points.length; i++) {
      const p0 = c.points[i]!;
      const p1 = c.points[i + 1]!;
      const r0 = Math.hypot(p0.x, p0.z);
      const r1 = Math.hypot(p1.x, p1.z);
      if ((r0 - radius) * (r1 - radius) >= 0) continue;
      const t = (radius - r0) / (r1 - r0);
      const x = p0.x + (p1.x - p0.x) * t;
      const z = p0.z + (p1.z - p0.z) * t;
      const a = Math.atan2(z, x);
      if (!out.some((b) => Math.abs(angDiff(a, b)) < 0.06)) out.push(a);
    }
  }
  return out;
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Non-indexed position+normal geometry so procedural pieces always merge. */
function bare(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geoms.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    if (n.getAttribute("uv")) n.deleteAttribute("uv");
    return n;
  });
  const merged = flat.length === 1 ? flat[0]! : mergeGeometries(flat, false)!;
  if (flat.length > 1) for (const g of flat) g.dispose();
  return merged;
}

export class CurtainWall {
  readonly group = new THREE.Group();
  stats: WallStats = { towers: 0, segments: 0, gate: false, gaps: 0, style: "curtain" };
  private meshes: THREE.Object3D[] = [];
  private ownGeoms: THREE.BufferGeometry[] = [];
  private ownMats: THREE.Material[] = [];

  build(
    assets: Assets,
    wall: CastlePlan["wall"],
    connectors: Connector[],
    groundY: (x: number, z: number) => number,
    style: WallStyle = "curtain",
  ): void {
    this.clear();
    this.stats.style = style;
    const R = wall.radius;
    const crossings = wallCrossings(connectors, R).filter(
      (a) => Math.abs(angDiff(a, wall.gateAngle)) > (GATE_HALF_ARC + CROSS_HALF_ARC) / R,
    );
    const openings: { a: number; half: number }[] = [
      { a: wall.gateAngle, half: GATE_HALF_ARC / R },
      ...crossings.map((a) => ({ a, half: CROSS_HALF_ARC / R })),
    ];
    const open = (a: number): boolean => openings.some((o) => Math.abs(angDiff(a, o.a)) < o.half);

    if (style === "curtain") this.buildCurtain(assets, wall, crossings, open, groundY);
    else if (style === "palisade") this.buildPalisade(wall, crossings, open, groundY);
    else if (style === "hedge") this.buildHedge(wall, crossings, open, groundY);
    else this.buildObsidian(wall, crossings, open, groundY);

    this.stats.towers = wall.towers.length;
    this.stats.gate = true;
    this.stats.gaps = crossings.length;
  }

  // --- curtain: the classic kit stone ring -----------------------------------

  private buildCurtain(
    assets: Assets,
    wall: CastlePlan["wall"],
    crossings: number[],
    open: (a: number) => boolean,
    groundY: (x: number, z: number) => number,
  ): void {
    const R = wall.radius;
    const chunkCount = Math.max(12, Math.round((2 * Math.PI * R) / CHUNK_LEN));
    const dA = (2 * Math.PI) / chunkCount;
    const segMatrices: THREE.Matrix4[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const a = wall.gateAngle + (i + 0.5) * dA;
      if (open(a)) continue;
      segMatrices.push(this.segMatrix(a, R, dA * R * 1.08, 1.5, groundY));
    }
    this.instanceKit(assets, "wall_straight", segMatrices);
    this.stats.segments = segMatrices.length;

    const towerMatrices: THREE.Matrix4[] = [];
    for (const t of wall.towers) {
      const m = new THREE.Matrix4().makeRotationY(-t.angle);
      const s = 1.15;
      m.multiply(new THREE.Matrix4().makeScale(s, 1.25, s));
      m.setPosition(t.x, groundY(t.x, t.z), t.z);
      towerMatrices.push(m);
    }
    this.instanceKit(assets, "tower_A", towerMatrices);

    const gateMatrices = [this.segMatrix(wall.gateAngle, R, GATE_HALF_ARC * 2.1, 1.6, groundY)];
    for (const a of crossings) gateMatrices.push(this.segMatrix(a, R, CROSS_HALF_ARC * 2.2, 1.2, groundY));
    this.instanceKit(assets, "wall_gate", gateMatrices);
  }

  // --- palisade: timber posts with sharpened tops ------------------------------

  private buildPalisade(
    wall: CastlePlan["wall"],
    crossings: number[],
    open: (a: number) => boolean,
    groundY: (x: number, z: number) => number,
  ): void {
    const R = wall.radius;
    const timber = this.ownMat({ color: 0x8a6a44, roughness: 0.95, flatShading: true });
    const post = this.ownGeo(
      bare([
        new THREE.CylinderGeometry(0.11, 0.14, 1.7, 5).translate(0, 0.85, 0),
        new THREE.CylinderGeometry(0.001, 0.11, 0.3, 5).translate(0, 1.85, 0),
      ]),
    );
    const n = Math.max(24, Math.round((2 * Math.PI * R) / 0.4));
    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < n; i++) {
      const a = wall.gateAngle + (i / n) * Math.PI * 2;
      if (open(a)) continue;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const m = new THREE.Matrix4().makeRotationY(-a);
      m.setPosition(x, groundY(x, z), z);
      mats.push(m);
    }
    this.instanceOwn(post, timber, mats);
    this.stats.segments = mats.length;

    // watch platforms at the tower angles
    const platform = this.ownGeo(
      bare([
        new THREE.BoxGeometry(1.15, 0.16, 1.15).translate(0, 1.95, 0),
        new THREE.CylinderGeometry(0.13, 0.16, 2.0, 5).translate(0.42, 1.0, 0.42),
        new THREE.CylinderGeometry(0.13, 0.16, 2.0, 5).translate(-0.42, 1.0, 0.42),
        new THREE.CylinderGeometry(0.13, 0.16, 2.0, 5).translate(0.42, 1.0, -0.42),
        new THREE.CylinderGeometry(0.13, 0.16, 2.0, 5).translate(-0.42, 1.0, -0.42),
      ]),
    );
    const tMats = wall.towers.map((t) => {
      const m = new THREE.Matrix4().makeRotationY(-t.angle);
      m.setPosition(t.x, groundY(t.x, t.z), t.z);
      return m;
    });
    this.instanceOwn(platform, timber, tMats);

    // gate: two heavy posts + lintel at the gate angle and each crossing
    const gate = this.ownGeo(
      bare([
        new THREE.CylinderGeometry(0.18, 0.22, 2.3, 6).translate(-GATE_HALF_ARC, 1.15, 0),
        new THREE.CylinderGeometry(0.18, 0.22, 2.3, 6).translate(GATE_HALF_ARC, 1.15, 0),
        new THREE.BoxGeometry(GATE_HALF_ARC * 2 + 0.5, 0.24, 0.3).translate(0, 2.35, 0),
      ]),
    );
    this.instanceOwn(gate, timber, this.portalMatrices(wall.gateAngle, crossings, R, groundY));
  }

  // --- hedge: rounded green segments -------------------------------------------

  private buildHedge(
    wall: CastlePlan["wall"],
    crossings: number[],
    open: (a: number) => boolean,
    groundY: (x: number, z: number) => number,
  ): void {
    const R = wall.radius;
    const leaf = this.ownMat({ color: 0x4e7a3c, roughness: 1, flatShading: true });
    const leafLight = this.ownMat({ color: 0x5f8f47, roughness: 1, flatShading: true });
    const bush = this.ownGeo(bare([new THREE.IcosahedronGeometry(0.8, 0).scale(1.15, 0.95, 0.75).translate(0, 0.72, 0)]));
    const chunkCount = Math.max(12, Math.round((2 * Math.PI * R) / (CHUNK_LEN * 0.82)));
    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const a = wall.gateAngle + ((i + 0.5) / chunkCount) * Math.PI * 2;
      if (open(a)) continue;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const m = new THREE.Matrix4().makeRotationY(-(a + Math.PI / 2));
      m.setPosition(x, groundY(x, z), z);
      mats.push(m);
    }
    this.instanceOwn(bush, leaf, mats);
    this.stats.segments = mats.length;

    const towerBush = this.ownGeo(bare([new THREE.IcosahedronGeometry(1.0, 0).scale(1.05, 1.5, 1.05).translate(0, 1.15, 0)]));
    const tMats = wall.towers.map((t) => {
      const m = new THREE.Matrix4().makeRotationY(-t.angle);
      m.setPosition(t.x, groundY(t.x, t.z), t.z);
      return m;
    });
    this.instanceOwn(towerBush, leafLight, tMats);

    // topiary arch over the gate + crossings
    const arch = this.ownGeo(
      bare([
        new THREE.IcosahedronGeometry(0.55, 0).scale(0.9, 2.2, 0.9).translate(-GATE_HALF_ARC, 1.0, 0),
        new THREE.IcosahedronGeometry(0.55, 0).scale(0.9, 2.2, 0.9).translate(GATE_HALF_ARC, 1.0, 0),
        new THREE.BoxGeometry(GATE_HALF_ARC * 2 + 0.6, 0.55, 0.7).translate(0, 2.5, 0),
      ]),
    );
    this.instanceOwn(arch, leafLight, this.portalMatrices(wall.gateAngle, crossings, R, groundY));
  }

  // --- obsidian: dark glassy slabs with a glowing seam ---------------------------

  private buildObsidian(
    wall: CastlePlan["wall"],
    crossings: number[],
    open: (a: number) => boolean,
    groundY: (x: number, z: number) => number,
  ): void {
    const R = wall.radius;
    const glass = this.ownMat({ color: 0x1d1a24, roughness: 0.3, metalness: 0.15, flatShading: true });
    const seam = this.ownMat({ color: 0x120f18, emissive: 0x8a5cff, emissiveIntensity: 1.4, flatShading: true });
    const chunkCount = Math.max(12, Math.round((2 * Math.PI * R) / CHUNK_LEN));
    const slab = this.ownGeo(bare([new THREE.BoxGeometry(CHUNK_LEN * 1.08, 1.85, 0.55).translate(0, 0.925, 0)]));
    const seamStrip = this.ownGeo(bare([new THREE.BoxGeometry(CHUNK_LEN * 1.08, 0.06, 0.58).translate(0, 1.05, 0)]));
    const mats: THREE.Matrix4[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const a = wall.gateAngle + ((i + 0.5) / chunkCount) * Math.PI * 2;
      if (open(a)) continue;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const m = new THREE.Matrix4().makeRotationY(-(a + Math.PI / 2));
      m.setPosition(x, groundY(x, z), z);
      mats.push(m);
    }
    this.instanceOwn(slab, glass, mats);
    this.instanceOwn(seamStrip, seam, mats.map((m) => m.clone()));
    this.stats.segments = mats.length;

    const towerGeo = this.ownGeo(bare([new THREE.CylinderGeometry(0.5, 0.68, 2.7, 6).translate(0, 1.35, 0)]));
    const towerBand = this.ownGeo(bare([new THREE.CylinderGeometry(0.56, 0.56, 0.09, 6).translate(0, 2.1, 0)]));
    const tMats = wall.towers.map((t) => {
      const m = new THREE.Matrix4().makeRotationY(-t.angle);
      m.setPosition(t.x, groundY(t.x, t.z), t.z);
      return m;
    });
    this.instanceOwn(towerGeo, glass, tMats);
    this.instanceOwn(towerBand, seam, tMats.map((m) => m.clone()));

    // portal: two pillars + a lintel with a glowing underside edge
    const portal = this.ownGeo(
      bare([
        new THREE.BoxGeometry(0.55, 2.6, 0.6).translate(-GATE_HALF_ARC, 1.3, 0),
        new THREE.BoxGeometry(0.55, 2.6, 0.6).translate(GATE_HALF_ARC, 1.3, 0),
        new THREE.BoxGeometry(GATE_HALF_ARC * 2 + 0.7, 0.4, 0.62).translate(0, 2.75, 0),
      ]),
    );
    const portalSeam = this.ownGeo(bare([new THREE.BoxGeometry(GATE_HALF_ARC * 2 + 0.72, 0.06, 0.64).translate(0, 2.53, 0)]));
    const pMats = this.portalMatrices(wall.gateAngle, crossings, R, groundY);
    this.instanceOwn(portal, glass, pMats);
    this.instanceOwn(portalSeam, seam, pMats.map((m) => m.clone()));
  }

  // --- shared helpers -------------------------------------------------------------

  private portalMatrices(
    gateAngle: number,
    crossings: number[],
    R: number,
    groundY: (x: number, z: number) => number,
  ): THREE.Matrix4[] {
    return [gateAngle, ...crossings].map((a) => {
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const m = new THREE.Matrix4().makeRotationY(-(a + Math.PI / 2));
      m.setPosition(x, groundY(x, z), z);
      return m;
    });
  }

  /** A wall piece centered at angle `a` on radius R, long axis along the tangent. */
  private segMatrix(
    a: number,
    R: number,
    len: number,
    sy: number,
    groundY: (x: number, z: number) => number,
  ): THREE.Matrix4 {
    const x = Math.cos(a) * R;
    const z = Math.sin(a) * R;
    const m = new THREE.Matrix4().makeRotationY(-(a + Math.PI / 2));
    m.multiply(new THREE.Matrix4().makeScale(len, sy, 0.85));
    m.setPosition(x, groundY(x, z), z);
    return m;
  }

  private ownMat(opts: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(opts);
    this.ownMats.push(m);
    return m;
  }

  private ownGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
    this.ownGeoms.push(g);
    return g;
  }

  private instanceOwn(geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[]): void {
    if (matrices.length === 0) return;
    const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.meshes.push(mesh);
  }

  private instanceKit(assets: Assets, key: string, matrices: THREE.Matrix4[]): void {
    if (matrices.length === 0) return;
    const model = assets.statics.get(key);
    if (!model) {
      console.warn(`[castle3d] wall piece missing: ${key}`);
      return;
    }
    // bakeStatic normalizes the long footprint axis to 1; our scale assumes x
    const alongX = model.size.x >= model.size.z;
    for (const part of model.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      matrices.forEach((m, i) => {
        if (!alongX) {
          const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
          mesh.setMatrixAt(i, m.clone().multiply(rot));
        } else {
          mesh.setMatrixAt(i, m);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  private clear(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
    }
    for (const g of this.ownGeoms) g.dispose();
    for (const m of this.ownMats) m.dispose();
    this.meshes = [];
    this.ownGeoms = [];
    this.ownMats = [];
    this.stats = { towers: 0, segments: 0, gate: false, gaps: 0, style: this.stats.style };
  }

  dispose(): void {
    this.clear();
  }
}
