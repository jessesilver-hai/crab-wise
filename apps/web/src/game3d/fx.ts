// Transient world effects: floating text, xp drops, level-up fireworks,
// victory confetti + wonder, scroll arcs. All are timing-only animation —
// world placement stays deterministic elsewhere.
import * as THREE from "three";
import { makeBillboard, type Billboard } from "./billboards.js";
import { cssHex } from "./util.js";

type FloatFx = { bb: Billboard; t: number; dur: number; rise: number; y0: number };
type BurstFx = {
  points: THREE.Points;
  vel: Float32Array;
  t: number;
  dur: number;
  gravity: number;
};
type ArcFx = { bb: Billboard; t: number; dur: number; from: THREE.Vector3; ctrl: THREE.Vector3; to: THREE.Vector3 };
type WonderFx = { group: THREE.Group; t: number };

export class Fx {
  readonly group = new THREE.Group();
  private floats: FloatFx[] = [];
  private bursts: BurstFx[] = [];
  private arcs: ArcFx[] = [];
  private wonder: WonderFx | null = null;

  float(text: string, x: number, z: number, y: number, color: number, sizePx = 22): void {
    const bb = makeBillboard(text, { sizePx, color: cssHex(color), bold: true, worldH: 0.3 });
    bb.sprite.position.set(x, y, z);
    this.group.add(bb.sprite);
    this.floats.push({ bb, t: 0, dur: 1.6, rise: 1.1, y0: y });
  }

  banner(text: string, x: number, z: number, y: number): void {
    const bb = makeBillboard(text, {
      font: "Cinzel, Georgia, serif",
      sizePx: 26,
      color: "#ffd75e",
      bold: true,
      worldH: 0.42,
    });
    bb.sprite.position.set(x, y, z);
    bb.sprite.scale.multiplyScalar(0.2);
    this.group.add(bb.sprite);
    const target = bb.sprite.scale.clone().multiplyScalar(5);
    const grow = { bb, t: 0, dur: 2.2, rise: 0.5, y0: y };
    // reuse the float pipeline; scale pops in tick via userData
    bb.sprite.userData.popTo = target;
    this.floats.push(grow);
  }

  /** Firework burst of additive points. */
  burst(x: number, y: number, z: number, colors: number[], count = 26, speed = 1.6): void {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const up = 0.6 + Math.random() * 1.4;
      vel[i * 3] = Math.cos(a) * speed * (0.5 + Math.random() * 0.7);
      vel[i * 3 + 1] = up * speed;
      vel[i * 3 + 2] = Math.sin(a) * speed * (0.5 + Math.random() * 0.7);
      c.set(colors[i % colors.length]!);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    this.bursts.push({ points, vel, t: 0, dur: 1.4, gravity: 2.6 });
  }

  confetti(x: number, z: number): void {
    for (let i = 0; i < 6; i++) {
      this.burst(
        x + (Math.random() - 0.5) * 6,
        1 + Math.random() * 2.5,
        z + (Math.random() - 0.5) * 6,
        [0xffd75e, 0xfff2c8, 0xe3b264, 0xffb347, 0x9ecf7a],
        40,
        2.4,
      );
    }
  }

  /** Scroll sprite arcing from an agent to the citadel. */
  scrollArc(from: THREE.Vector3, to: THREE.Vector3): void {
    const bb = makeBillboard("📜", { sizePx: 30, worldH: 0.5 });
    bb.sprite.position.copy(from);
    this.group.add(bb.sprite);
    const ctrl = from.clone().lerp(to, 0.5);
    ctrl.y += 3.2;
    this.arcs.push({ bb, t: 0, dur: 1.3, from: from.clone(), ctrl, to: to.clone() });
  }

  /** Golden wonder obelisk rising at the citadel on victory. */
  raiseWonder(x: number, z: number, accent: number): THREE.Group {
    const g = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({
      color: 0xd8b354,
      emissive: new THREE.Color(accent),
      emissiveIntensity: 0.55,
      metalness: 0.6,
      roughness: 0.35,
    });
    const tiers = [
      [1.6, 0.5],
      [1.1, 0.5],
      [0.7, 0.7],
      [0.34, 1.4],
    ] as const;
    let y = 0;
    for (const [w, h] of tiers) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), gold);
      m.position.y = y + h / 2;
      m.castShadow = true;
      g.add(m);
      y += h;
    }
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffe9a8, emissiveIntensity: 1.2 }),
    );
    orb.position.y = y + 0.3;
    g.add(orb);
    g.position.set(x, 0, z);
    g.scale.setScalar(0.01);
    this.group.add(g);
    this.wonder = { group: g, t: 0 };
    return g;
  }

  get activeCount(): number {
    return this.floats.length + this.bursts.length + this.arcs.length + (this.wonder ? 1 : 0);
  }

  tick(dt: number): void {
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]!;
      f.t += dt;
      const p = Math.min(1, f.t / f.dur);
      f.bb.sprite.position.y = f.y0 + f.rise * (1 - (1 - p) * (1 - p));
      const popTo = f.bb.sprite.userData.popTo as THREE.Vector3 | undefined;
      if (popTo) {
        const k = Math.min(1, f.t / 0.26);
        f.bb.sprite.scale.copy(popTo).multiplyScalar(0.2 + 0.8 * k);
      }
      (f.bb.sprite.material as THREE.SpriteMaterial).opacity = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
      if (p >= 1) {
        f.bb.dispose();
        this.floats.splice(i, 1);
      }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!;
      b.t += dt;
      const att = b.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let j = 0; j < att.count; j++) {
        b.vel[j * 3 + 1]! -= b.gravity * dt;
        att.setXYZ(
          j,
          att.getX(j) + b.vel[j * 3]! * dt,
          Math.max(0.05, att.getY(j) + b.vel[j * 3 + 1]! * dt),
          att.getZ(j) + b.vel[j * 3 + 2]! * dt,
        );
      }
      att.needsUpdate = true;
      const p = Math.min(1, b.t / b.dur);
      (b.points.material as THREE.PointsMaterial).opacity = 1 - p;
      if (p >= 1) {
        b.points.geometry.dispose();
        (b.points.material as THREE.Material).dispose();
        b.points.removeFromParent();
        this.bursts.splice(i, 1);
      }
    }
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i]!;
      a.t += dt;
      const p = Math.min(1, a.t / a.dur);
      const mt = 1 - p;
      a.bb.sprite.position.set(
        mt * mt * a.from.x + 2 * mt * p * a.ctrl.x + p * p * a.to.x,
        mt * mt * a.from.y + 2 * mt * p * a.ctrl.y + p * p * a.to.y,
        mt * mt * a.from.z + 2 * mt * p * a.ctrl.z + p * p * a.to.z,
      );
      if (p > 0.7) (a.bb.sprite.material as THREE.SpriteMaterial).opacity = 1 - (p - 0.7) / 0.3;
      if (p >= 1) {
        a.bb.dispose();
        this.arcs.splice(i, 1);
      }
    }
    if (this.wonder) {
      this.wonder.t += dt;
      const p = Math.min(1, this.wonder.t / 1.6);
      this.wonder.group.scale.setScalar(0.01 + (1 - Math.pow(1 - p, 3)) * 0.99);
      if (p >= 1) this.wonder = null;
    }
  }

  dispose(): void {
    for (const f of this.floats) f.bb.dispose();
    for (const b of this.bursts) {
      b.points.geometry.dispose();
      (b.points.material as THREE.Material).dispose();
    }
    for (const a of this.arcs) a.bb.dispose();
    this.floats = [];
    this.bursts = [];
    this.arcs = [];
  }
}
