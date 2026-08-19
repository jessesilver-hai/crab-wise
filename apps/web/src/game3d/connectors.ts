// Connector works: cobble roads and raised rails along the plan's polylines,
// with mine carts looping the rails — the visible heartbeat of the pipeline
// ↔ database isomorphism. Static geometry merges into a few meshes; only
// the carts move.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Connector } from "../game/castle.js";
import type { Assets } from "./assets.js";

const CART_SPEED = 2; // world units / second
const MAX_CARTS = 4;

type Polyline = {
  pts: { x: number; z: number }[];
  cum: number[]; // cumulative length at each point
  length: number;
};

function polyline(points: { x: number; z: number }[]): Polyline {
  const cum: number[] = [0];
  let L = 0;
  for (let i = 1; i < points.length; i++) {
    L += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
    cum.push(L);
  }
  return { pts: points, cum, length: L };
}

function pointAt(p: Polyline, s: number): { x: number; z: number; hx: number; hz: number } {
  const L = p.length;
  const t = Math.min(L, Math.max(0, s));
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i]! < t) i++;
  const a = p.pts[i - 1]!;
  const b = p.pts[i]!;
  const seg = p.cum[i]! - p.cum[i - 1]!;
  const f = seg > 1e-6 ? (t - p.cum[i - 1]!) / seg : 0;
  const hx = seg > 1e-6 ? (b.x - a.x) / seg : 1;
  const hz = seg > 1e-6 ? (b.z - a.z) / seg : 0;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, hx, hz };
}

type Cart = {
  group: THREE.Group;
  line: Polyline;
  s: number;
  dir: 1 | -1;
};

export class ConnectorWorks {
  readonly group = new THREE.Group();
  private meshes: THREE.Object3D[] = [];
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private carts: Cart[] = [];
  private cartMats: THREE.Material[] = [];
  groundY: (x: number, z: number) => number = () => 0;
  railCount = 0;
  roadCount = 0;

  build(assets: Assets, connectors: Connector[]): void {
    this.clear();
    const roadGeos: THREE.BufferGeometry[] = [];
    const railGeos: THREE.BufferGeometry[] = [];
    const tieMatrices: THREE.Matrix4[] = [];

    for (const c of connectors) {
      const line = polyline(c.points);
      if (line.length < 0.5) continue;
      if (c.kind === "road") {
        this.roadCount++;
        roadGeos.push(...this.ribbon(line, 0.85, 0.025));
      } else {
        this.railCount++;
        // rail bed + two steel strips + ties
        roadGeos.push(...this.ribbon(line, 0.7, 0.02));
        railGeos.push(...this.rail(line, -0.16));
        railGeos.push(...this.rail(line, 0.16));
        for (let s = 0.3; s < line.length; s += 0.55) {
          const p = pointAt(line, s);
          const m = new THREE.Matrix4().makeRotationY(-Math.atan2(p.hz, p.hx));
          m.setPosition(p.x, this.groundY(p.x, p.z) + 0.05, p.z);
          tieMatrices.push(m);
        }
        // carts: 1 + floor(weight/2), capped, spread along the line
        const n = Math.min(MAX_CARTS, 1 + Math.floor(c.weight / 2));
        for (let i = 0; i < n; i++) {
          const cart = this.makeCart(assets);
          cart.position.y = -100; // placed on first tick
          this.group.add(cart);
          this.carts.push({
            group: cart,
            line,
            s: (line.length * (i + 0.5)) / n,
            dir: i % 2 === 0 ? 1 : -1,
          });
        }
      }
    }

    if (roadGeos.length > 0) {
      const geo = mergeGeometries(roadGeos, false);
      for (const g of roadGeos) g.dispose();
      if (geo) {
        const mat = new THREE.MeshStandardMaterial({ color: 0xa89c85, roughness: 1 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        this.group.add(mesh);
        this.meshes.push(mesh);
        this.geoms.push(geo);
        this.mats.push(mat);
      }
    }
    if (railGeos.length > 0) {
      const geo = mergeGeometries(railGeos, false);
      for (const g of railGeos) g.dispose();
      if (geo) {
        const mat = new THREE.MeshStandardMaterial({ color: 0x5f5850, roughness: 0.6, metalness: 0.5 });
        const mesh = new THREE.Mesh(geo, mat);
        this.group.add(mesh);
        this.meshes.push(mesh);
        this.geoms.push(geo);
        this.mats.push(mat);
      }
    }
    if (tieMatrices.length > 0) {
      const tieGeo = new THREE.BoxGeometry(0.09, 0.05, 0.56);
      const tieMat = new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 1 });
      const inst = new THREE.InstancedMesh(tieGeo, tieMat, tieMatrices.length);
      tieMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.receiveShadow = true;
      this.group.add(inst);
      this.meshes.push(inst);
      this.geoms.push(tieGeo);
      this.mats.push(tieMat);
    }
  }

  /** Flat quad strip along the line, hugging the ground. */
  private ribbon(line: Polyline, width: number, lift: number): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];
    const step = 0.9;
    const half = width / 2;
    const positions: number[] = [];
    const index: number[] = [];
    let vi = 0;
    for (let s = 0; s <= line.length + 1e-6; s += step) {
      const p = pointAt(line, Math.min(s, line.length));
      const nx = -p.hz;
      const nz = p.hx;
      const y = (x: number, z: number) => this.groundY(x, z) + lift;
      positions.push(
        p.x + nx * half, y(p.x + nx * half, p.z + nz * half), p.z + nz * half,
        p.x - nx * half, y(p.x - nx * half, p.z - nz * half), p.z - nz * half,
      );
      if (vi >= 2) index.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
      vi += 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    out.push(geo);
    return out;
  }

  /** One steel strip offset sideways from the line's spine. */
  private rail(line: Polyline, offset: number): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];
    const step = 1.1;
    let prev: { x: number; z: number } | null = null;
    for (let s = 0; s <= line.length + 1e-6; s += step) {
      const p = pointAt(line, Math.min(s, line.length));
      const cur = { x: p.x - p.hz * offset, z: p.z + p.hx * offset };
      if (prev) {
        const dx = cur.x - prev.x;
        const dz = cur.z - prev.z;
        const len = Math.hypot(dx, dz);
        if (len > 1e-4) {
          const geo = new THREE.BoxGeometry(len + 0.03, 0.04, 0.045);
          const m = new THREE.Matrix4().makeRotationY(-Math.atan2(dz, dx));
          const mx = (prev.x + cur.x) / 2;
          const mz = (prev.z + cur.z) / 2;
          m.setPosition(mx, this.groundY(mx, mz) + 0.095, mz);
          geo.applyMatrix4(m);
          out.push(geo);
        }
      }
      prev = cur;
    }
    return out;
  }

  private makeCart(assets: Assets): THREE.Group {
    const g = new THREE.Group();
    const model = assets.statics.get("wheelbarrow");
    if (model) {
      for (const part of model.parts) {
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.castShadow = true;
        mesh.scale.setScalar(0.55);
        g.add(mesh);
      }
    } else {
      const geo = new THREE.BoxGeometry(0.4, 0.22, 0.28).translate(0, 0.16, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x6e5335, roughness: 0.9 });
      this.geoms.push(geo);
      this.cartMats.push(mat);
      g.add(new THREE.Mesh(geo, mat));
    }
    // ore load: a small stone lump so full carts read at a glance
    const oreGeo = new THREE.IcosahedronGeometry(0.09, 0);
    const oreMat = new THREE.MeshStandardMaterial({ color: 0x8f9aa8, roughness: 0.7 });
    const ore = new THREE.Mesh(oreGeo, oreMat);
    ore.position.y = 0.26;
    g.add(ore);
    this.geoms.push(oreGeo);
    this.cartMats.push(oreMat);
    return g;
  }

  cartPositions(): { x: number; z: number }[] {
    return this.carts.map((c) => ({ x: c.group.position.x, z: c.group.position.z }));
  }

  get cartCount(): number {
    return this.carts.length;
  }

  tick(dt: number): void {
    for (const c of this.carts) {
      c.s += CART_SPEED * dt * c.dir;
      if (c.s >= c.line.length) {
        c.s = c.line.length;
        c.dir = -1;
      } else if (c.s <= 0) {
        c.s = 0;
        c.dir = 1;
      }
      const p = pointAt(c.line, c.s);
      c.group.position.set(p.x, this.groundY(p.x, p.z) + 0.1, p.z);
      c.group.rotation.y = -Math.atan2(p.hz * c.dir, p.hx * c.dir);
    }
  }

  private clear(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
    }
    for (const c of this.carts) c.group.removeFromParent();
    for (const g of this.geoms) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const m of this.cartMats) m.dispose();
    this.meshes = [];
    this.geoms = [];
    this.mats = [];
    this.carts = [];
    this.cartMats = [];
  }

  dispose(): void {
    this.clear();
  }
}
