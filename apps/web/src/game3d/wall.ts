// The curtain wall: instanced wall segments between the plan's towers, a
// tower piece at each tower socket, a real gate arch at the gate angle, and
// smaller arches wherever a connector polyline crosses WALL_RADIUS so rails
// and roads pass through instead of clipping the stone.
import * as THREE from "three";
import type { CastlePlan, Connector } from "../game/castle.js";
import type { Assets } from "./assets.js";

const CHUNK_LEN = 1.35;
const GATE_HALF_ARC = 1.6; // world units of wall left open at the main gate
const CROSS_HALF_ARC = 1.0; // world units left open at a connector crossing

export type WallStats = { towers: number; segments: number; gate: boolean; gaps: number };

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

export class CurtainWall {
  readonly group = new THREE.Group();
  stats: WallStats = { towers: 0, segments: 0, gate: false, gaps: 0 };
  private meshes: THREE.InstancedMesh[] = [];

  build(
    assets: Assets,
    wall: CastlePlan["wall"],
    connectors: Connector[],
    groundY: (x: number, z: number) => number,
  ): void {
    this.clear();
    const R = wall.radius;
    const crossings = wallCrossings(connectors, R).filter(
      (a) => Math.abs(angDiff(a, wall.gateAngle)) > (GATE_HALF_ARC + CROSS_HALF_ARC) / R,
    );
    const openings: { a: number; half: number }[] = [
      { a: wall.gateAngle, half: GATE_HALF_ARC / R },
      ...crossings.map((a) => ({ a, half: CROSS_HALF_ARC / R })),
    ];

    // --- wall segments (skip chunks inside an opening) ---
    const chunkCount = Math.max(12, Math.round((2 * Math.PI * R) / CHUNK_LEN));
    const dA = (2 * Math.PI) / chunkCount;
    const segMatrices: THREE.Matrix4[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const a = wall.gateAngle + (i + 0.5) * dA;
      if (openings.some((o) => Math.abs(angDiff(a, o.a)) < o.half)) continue;
      segMatrices.push(this.segMatrix(a, R, dA * R * 1.08, 1.5, groundY));
    }
    this.instance(assets, "wall_straight", segMatrices);
    this.stats.segments = segMatrices.length;

    // --- towers ---
    const towerMatrices: THREE.Matrix4[] = [];
    for (const t of wall.towers) {
      const m = new THREE.Matrix4().makeRotationY(-t.angle);
      const s = 1.15;
      m.multiply(new THREE.Matrix4().makeScale(s, 1.25, s));
      m.setPosition(t.x, groundY(t.x, t.z), t.z);
      towerMatrices.push(m);
    }
    this.instance(assets, "tower_A", towerMatrices);
    this.stats.towers = towerMatrices.length;

    // --- gate arch + crossing arches ---
    const gateMatrices = [this.segMatrix(wall.gateAngle, R, GATE_HALF_ARC * 2.1, 1.6, groundY)];
    for (const a of crossings) gateMatrices.push(this.segMatrix(a, R, CROSS_HALF_ARC * 2.2, 1.2, groundY));
    this.instance(assets, "wall_gate", gateMatrices);
    this.stats.gate = true;
    this.stats.gaps = crossings.length;
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

  private instance(assets: Assets, key: string, matrices: THREE.Matrix4[]): void {
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
      m.dispose();
    }
    this.meshes = [];
    this.stats = { towers: 0, segments: 0, gate: false, gaps: 0 };
  }

  dispose(): void {
    this.clear();
  }
}
