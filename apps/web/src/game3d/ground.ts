// Castle grounds: a circular disk (~radius 30) with subtle seeded height
// noise and a raised motte under the keep, an underlay plain running to the
// fog line, and a nature scatter ring outside the outer ward. The StyleGenome
// restyles it: GROUND_TONES recolor disk/motte/plain, NATURE_SETS swap the
// scatter (kit trees, or procedural palms/crystals/mushrooms). Heights are
// tone-independent, so a restyle never moves a standing construction.
import * as THREE from "three";
import { mulberry32 } from "../game/map.js";
import type { GroundTone, NatureSet } from "../game/genome.js";
import type { Assets } from "./assets.js";
import { cssHex } from "./util.js";

export const GROUNDS_RADIUS = 30;
const MOTTE_H = 1.1;
const NOISE_AMP = 0.16;
const NOISE_CELL = 4.2;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

type TonePalette = { a: number; b: number; motte: number; plain: number };

const TONES: Record<GroundTone, TonePalette> = {
  meadow: { a: 0x7fae55, b: 0x94c266, motte: 0xa8b07e, plain: 0x86ab5c },
  scorch: { a: 0x4a3a34, b: 0x5f4038, motte: 0x6b5346, plain: 0x453833 },
  sand: { a: 0xd4b078, b: 0xe0c28c, motte: 0xcbb086, plain: 0xd0af74 },
  snow: { a: 0xe6edf3, b: 0xf3f7fa, motte: 0xd6e0e8, plain: 0xe2eaf1 },
  moor: { a: 0x5c6647, b: 0x6b7351, motte: 0x7a7d5e, plain: 0x596244 },
  slate: { a: 0x7d8388, b: 0x8d9298, motte: 0x9aa0a4, plain: 0x788085 },
};

type Spot = { x: number; z: number; s: number; rot: number };

export class CastleGround {
  readonly group = new THREE.Group();
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private meshes: THREE.Object3D[] = [];
  private seed = 1;
  private noiseGrid = new Map<string, number>();
  private toneName: GroundTone = "meadow";
  private natureName: NatureSet = "pine";
  private plainHex = "#000000";

  /** Deterministic ground height; everything standing on the grounds asks this. */
  heightAt = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const motte = MOTTE_H * (1 - smoothstep(2.4, 5.4, r));
    // noise fades in past the inner ward and back out at the rim
    const fade = smoothstep(5.5, 9, r) * (1 - smoothstep(26, GROUNDS_RADIUS, r));
    return motte + this.noise2(x, z) * NOISE_AMP * fade;
  };

  /** Machine-readable style state for the smoke battery. */
  styleInfo(): { tone: GroundTone; nature: NatureSet; hex: string } {
    return { tone: this.toneName, nature: this.natureName, hex: this.plainHex };
  }

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

  build(seed: number, assets: Assets, tone: GroundTone = "meadow", nature: NatureSet = "pine"): void {
    this.disposeMeshes();
    this.seed = seed >>> 0 || 1;
    this.noiseGrid.clear();
    this.toneName = tone;
    this.natureName = nature;
    const pal = TONES[tone];

    // --- the grounds disk: rings × sectors grid with vertex-colored terrain ---
    const rings = 34;
    const sectors = 72;
    const positions: number[] = [];
    const colors: number[] = [];
    const index: number[] = [];
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const grassA = new THREE.Color(pal.a);
    const grassB = new THREE.Color(pal.b);
    const motteC = new THREE.Color(pal.motte);
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
    const plainMat = new THREE.MeshStandardMaterial({ color: pal.plain, roughness: 1 });
    this.plainHex = cssHex(plainMat.color.getHex());
    const plain = new THREE.Mesh(plainGeo, plainMat);
    plain.position.y = -0.03;
    plain.receiveShadow = true;
    this.group.add(plain);
    this.geoms.push(plainGeo);
    this.mats.push(plainMat);
    this.meshes.push(plain);

    // --- nature scatter outside the outer ward (deterministic from seed) ---
    this.scatterNature(assets, nature, rng);
  }

  private spots(rng: () => number, count: number, sMin: number, sMax: number): Spot[] {
    const out: Spot[] = [];
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = 26 + rng() * 3.2;
      out.push({
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        s: sMin + rng() * (sMax - sMin),
        rot: rng() * Math.PI * 2,
      });
    }
    return out;
  }

  private instanceModel(assets: Assets, key: string, spots: Spot[]): void {
    const model = assets.statics.get(key);
    if (!model || spots.length === 0) return;
    const m4 = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
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

  /** Instance an owned procedural geometry+material over the spots. */
  private instanceGeo(geo: THREE.BufferGeometry, mat: THREE.Material, spots: Spot[]): void {
    if (spots.length === 0) {
      geo.dispose();
      (mat as THREE.Material).dispose();
      return;
    }
    const m4 = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
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
    this.geoms.push(geo);
    this.mats.push(mat);
    this.meshes.push(inst);
  }

  private scatterNature(assets: Assets, nature: NatureSet, rng: () => number): void {
    switch (nature) {
      case "pine": {
        this.instanceModel(assets, "tree_A", this.spots(rng, 10, 1.1, 1.7));
        this.instanceModel(assets, "tree_B", this.spots(rng, 8, 1.0, 1.5));
        this.instanceModel(assets, "rock_A", this.spots(rng, 5, 0.6, 1.0));
        break;
      }
      case "oak": {
        this.instanceModel(assets, "trees_B_medium", this.spots(rng, 8, 1.3, 1.9));
        this.instanceModel(assets, "tree_B", this.spots(rng, 6, 1.1, 1.6));
        this.instanceModel(assets, "rock_A", this.spots(rng, 4, 0.6, 1.0));
        break;
      }
      case "dead": {
        this.instanceModel(assets, "tree_cut", this.spots(rng, 8, 0.9, 1.3));
        this.instanceModel(assets, "rock_D", this.spots(rng, 5, 0.6, 1.1));
        // bare procedural trunks — no leafy kit piece reads "dead"
        const trunk = new THREE.CylinderGeometry(0.05, 0.11, 1.7, 5).translate(0, 0.85, 0);
        const armA = new THREE.CylinderGeometry(0.03, 0.05, 0.7, 4).translate(0, 0.35, 0).rotateZ(0.7).translate(0.05, 1.1, 0);
        const armB = new THREE.CylinderGeometry(0.025, 0.045, 0.6, 4).translate(0, 0.3, 0).rotateZ(-0.9).translate(-0.05, 1.3, 0);
        const bare = mergeBare([trunk, armA, armB]);
        this.instanceGeo(bare, new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 1, flatShading: true }), this.spots(rng, 9, 0.9, 1.5));
        break;
      }
      case "palm": {
        const spots = this.spots(rng, 10, 0.9, 1.5);
        const trunk = new THREE.CylinderGeometry(0.05, 0.09, 1.8, 5).translate(0, 0.9, 0).rotateZ(0.12);
        const fronds: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 6; i++) {
          fronds.push(
            new THREE.BoxGeometry(1.1, 0.03, 0.22)
              .translate(0.55, 0, 0)
              .rotateZ(-0.5)
              .rotateY((i / 6) * Math.PI * 2)
              .translate(0.2, 1.85, 0),
          );
        }
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 1, flatShading: true });
        const frondMat = new THREE.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 1, flatShading: true });
        this.instanceGeo(mergeBare([trunk]), trunkMat, spots);
        this.instanceGeo(mergeBare(fronds), frondMat, spots);
        break;
      }
      case "crystal": {
        const spike = new THREE.CylinderGeometry(0.001, 0.28, 1.6, 5).translate(0, 0.8, 0);
        const side = new THREE.CylinderGeometry(0.001, 0.18, 0.9, 5).translate(0, 0.45, 0).rotateZ(0.5).translate(0.3, 0, 0.1);
        const mat = new THREE.MeshStandardMaterial({
          color: 0x9fd8f0,
          emissive: 0x3a7ac8,
          emissiveIntensity: 0.8,
          roughness: 0.25,
          flatShading: true,
        });
        this.instanceGeo(mergeBare([spike, side]), mat, this.spots(rng, 12, 0.7, 1.5));
        break;
      }
      case "mushroom": {
        const spots = this.spots(rng, 11, 0.8, 1.6);
        const stem = new THREE.CylinderGeometry(0.09, 0.13, 0.55, 6).translate(0, 0.275, 0);
        const cap = new THREE.SphereGeometry(0.42, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.62, 1).translate(0, 0.5, 0);
        const stemMat = new THREE.MeshStandardMaterial({ color: 0xe4d6bc, roughness: 1, flatShading: true });
        const capMat = new THREE.MeshStandardMaterial({ color: 0xb04338, roughness: 0.9, flatShading: true });
        this.instanceGeo(mergeBare([stem]), stemMat, spots);
        this.instanceGeo(mergeBare([cap]), capMat, spots);
        break;
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

/** Merge to position+normal-only non-indexed geometry (uniform for merging). */
function mergeBare(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const bare = geoms.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (n !== g) g.dispose();
    if (n.getAttribute("uv")) n.deleteAttribute("uv");
    return n;
  });
  if (bare.length === 1) return bare[0]!;
  const positions: number[] = [];
  const normals: number[] = [];
  for (const g of bare) {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      if (n) normals.push(n.getX(i), n.getY(i), n.getZ(i));
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  if (normals.length === positions.length) out.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  else out.computeVertexNormals();
  return out;
}
