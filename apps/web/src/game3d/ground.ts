// Castle grounds: a circular grass disk (~radius 30) with subtle seeded
// height noise and a raised motte under the keep, an underlay plain running
// to the fog line, and a scatter ring of trees outside the outer ward.
// Everything static bakes into a handful of meshes.
import * as THREE from "three";
import { mulberry32 } from "../game/map.js";
import type { Assets } from "./assets.js";

export const GROUNDS_RADIUS = 30;
const MOTTE_H = 1.1;
const NOISE_AMP = 0.16;
const NOISE_CELL = 4.2;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class CastleGround {
  readonly group = new THREE.Group();
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private meshes: THREE.Object3D[] = [];
  private seed = 1;
  private noiseGrid = new Map<string, number>();

  /** Deterministic ground height; everything standing on the grounds asks this. */
  heightAt = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const motte = MOTTE_H * (1 - smoothstep(2.4, 5.4, r));
    // noise fades in past the inner ward and back out at the rim
    const fade = smoothstep(5.5, 9, r) * (1 - smoothstep(26, GROUNDS_RADIUS, r));
    return motte + this.noise2(x, z) * NOISE_AMP * fade;
  };

  private noiseCorner(ix: number, iz: number): number {
    const key = `${ix},${iz}`;
    let v = this.noiseGrid.get(key);
    if (v === undefined) {
      const rng = mulberry32((((ix * 73856093) ^ (iz * 19349663) ^ this.seed) >>> 0) || 1);
      v = rng() * 2 - 1;
      this.noiseGrid.set(key, v);
    }
    return v;
  }

  private noise2(x: number, z: number): number {
    const gx = x / NOISE_CELL;
    const gz = z / NOISE_CELL;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = this.noiseCorner(ix, iz);
    const b = this.noiseCorner(ix + 1, iz);
    const c = this.noiseCorner(ix, iz + 1);
    const d = this.noiseCorner(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }

  build(seed: number, assets: Assets): void {
    this.disposeMeshes();
    this.seed = seed >>> 0 || 1;
    this.noiseGrid.clear();

    // --- the grounds disk: rings × sectors grid with vertex-colored grass ---
    const rings = 34;
    const sectors = 72;
    const positions: number[] = [];
    const colors: number[] = [];
    const index: number[] = [];
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const grassA = new THREE.Color(0x7fae55);
    const grassB = new THREE.Color(0x94c266);
    const motteC = new THREE.Color(0xa8b07e);
    const col = new THREE.Color();
    for (let ri = 0; ri <= rings; ri++) {
      const r = (ri / rings) * GROUNDS_RADIUS;
      for (let si = 0; si < sectors; si++) {
        const a = (si / sectors) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const y = this.heightAt(x, z);
        positions.push(x, y, z);
        const n = (this.noise2(x * 1.7 + 40, z * 1.7 - 40) + 1) / 2;
        col.lerpColors(grassA, grassB, n * 0.85 + rng() * 0.15);
        if (r < 5.4) col.lerp(motteC, 1 - smoothstep(2.2, 5.4, r));
        colors.push(col.r, col.g, col.b);
      }
    }
    for (let ri = 0; ri < rings; ri++) {
      for (let si = 0; si < sectors; si++) {
        const a = ri * sectors + si;
        const b = ri * sectors + ((si + 1) % sectors);
        const c = (ri + 1) * sectors + si;
        const d = (ri + 1) * sectors + ((si + 1) % sectors);
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const disk = new THREE.Mesh(geo, mat);
    disk.receiveShadow = true;
    this.group.add(disk);
    this.geoms.push(geo);
    this.mats.push(mat);
    this.meshes.push(disk);

    // --- underlay plain to the fog line ---
    const plainGeo = new THREE.CircleGeometry(200, 48).rotateX(-Math.PI / 2);
    const plainMat = new THREE.MeshStandardMaterial({ color: 0x86ab5c, roughness: 1 });
    const plain = new THREE.Mesh(plainGeo, plainMat);
    plain.position.y = -0.03;
    plain.receiveShadow = true;
    this.group.add(plain);
    this.geoms.push(plainGeo);
    this.mats.push(plainMat);
    this.meshes.push(plain);

    // --- tree/rock scatter outside the outer ward ---
    const scatter: { key: string; count: number; sMin: number; sMax: number }[] = [
      { key: "tree_A", count: 10, sMin: 1.1, sMax: 1.7 },
      { key: "tree_B", count: 8, sMin: 1.0, sMax: 1.5 },
      { key: "rock_A", count: 5, sMin: 0.6, sMax: 1.0 },
    ];
    const m4 = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    for (const sc of scatter) {
      const model = assets.statics.get(sc.key);
      if (!model) continue;
      const spots: { x: number; z: number; s: number; rot: number }[] = [];
      for (let i = 0; i < sc.count; i++) {
        const a = rng() * Math.PI * 2;
        const r = 26 + rng() * 3.2;
        spots.push({
          x: Math.cos(a) * r,
          z: Math.sin(a) * r,
          s: sc.sMin + rng() * (sc.sMax - sc.sMin),
          rot: rng() * Math.PI * 2,
        });
      }
      for (const part of model.parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, spots.length);
        inst.castShadow = true;
        inst.receiveShadow = true;
        spots.forEach((p, i) => {
          m4.makeRotationY(p.rot);
          tmp.makeScale(p.s, p.s, p.s);
          m4.multiply(tmp);
          m4.setPosition(p.x, this.heightAt(p.x, p.z), p.z);
          inst.setMatrixAt(i, m4);
        });
        inst.instanceMatrix.needsUpdate = true;
        this.group.add(inst);
        this.meshes.push(inst);
      }
    }
  }

  private disposeMeshes(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
    }
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    this.meshes = [];
    this.geoms = [];
    this.mats = [];
  }

  dispose(): void {
    this.disposeMeshes();
    this.noiseGrid.clear();
  }
}
