// Classic RTS orthographic camera: fixed azimuth 45° / elevation 35°, wheel
// zoom, edge-scroll + middle/right-drag + WASD/arrow pan, smooth lerp.
import * as THREE from "three";
import type { Rect } from "../game/map.js";

const AZIMUTH = (45 * Math.PI) / 180;
const ELEVATION = (35 * Math.PI) / 180;
const MIN_VIEW_H = 6;
const MAX_VIEW_H = 160;
const CAM_DIST = 220;

export class RtsCamera {
  readonly camera: THREE.OrthographicCamera;
  /** World-space look-at point on the ground plane. */
  readonly target = new THREE.Vector3();
  private targetGoal = new THREE.Vector3();
  /** Vertical world units visible at zoom 1. */
  private viewH = 40;
  private viewHGoal = 40;
  private aspect = 1;
  private dir: THREE.Vector3;
  private keys = new Set<string>();
  private bounds: Rect | null = null;
  private detach: (() => void)[] = [];
  edgeScroll = true;
  /** Pointer position in mount px, updated by the renderer. */
  pointer = { x: -1, y: -1, inside: false, moved: false };

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 800);
    this.dir = new THREE.Vector3(
      Math.cos(ELEVATION) * Math.sin(AZIMUTH),
      Math.sin(ELEVATION),
      Math.cos(ELEVATION) * Math.cos(AZIMUTH),
    ).normalize();
    this.apply(1, 1);
  }

  attachKeys(): void {
    const down = (e: KeyboardEvent) => {
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        this.keys.add(e.code);
      }
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.code);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    this.detach.push(() => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    });
  }

  dispose(): void {
    for (const d of this.detach) d();
    this.detach = [];
  }

  setBounds(rect: Rect): void {
    this.bounds = rect;
  }

  /** Wheel zoom toward/away, clamped; smoothed in update(). */
  zoomBy(deltaY: number): void {
    const f = deltaY > 0 ? 1.18 : 1 / 1.18;
    this.viewHGoal = Math.min(MAX_VIEW_H, Math.max(MIN_VIEW_H, this.viewHGoal * f));
  }

  panPx(dx: number, dy: number, w: number, h: number): void {
    // screen px → world units on the ground plane
    const unitsPerPxY = this.viewH / Math.max(1, h);
    const unitsPerPxX = (this.viewH * this.aspect) / Math.max(1, w);
    // camera right on ground = (cos az, 0, -sin az); camera "up" on ground
    const rx = Math.cos(AZIMUTH);
    const rz = -Math.sin(AZIMUTH);
    const fScale = 1 / Math.max(0.15, Math.sin(ELEVATION));
    const fx = -Math.sin(AZIMUTH);
    const fz = -Math.cos(AZIMUTH);
    // drag-content semantics: +dx pointer drag moves the world right, so the
    // camera target moves -right; +dy moves the target +forward (up-screen).
    const mx = -dx * unitsPerPxX;
    const mz = dy * unitsPerPxY * fScale;
    this.targetGoal.x += rx * mx + fx * mz;
    this.targetGoal.z += rz * mx + fz * mz;
    this.clampGoal();
  }

  jumpTo(x: number, z: number): void {
    this.targetGoal.set(x, 0, z);
    this.clampGoal();
  }

  panTo(x: number, z: number): void {
    this.jumpTo(x, z);
  }

  private clampGoal(): void {
    const b = this.bounds;
    if (!b) return;
    this.targetGoal.x = Math.min(b.x + b.w + 4, Math.max(b.x - 4, this.targetGoal.x));
    this.targetGoal.z = Math.min(b.y + b.h + 4, Math.max(b.y - 4, this.targetGoal.z));
  }

  /** Fit the city rect in view and center on it. */
  frame(rect: Rect, aspect: number): void {
    const cx = rect.x + rect.w / 2;
    const cz = rect.y + rect.h / 2;
    this.target.set(cx, 0, cz);
    this.targetGoal.copy(this.target);
    // project the rect corners into camera space to find the needed extents
    const cam = new THREE.Matrix4().lookAt(this.dir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    const inv = cam.clone().invert();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [px, pz] of [
      [rect.x, rect.y],
      [rect.x + rect.w, rect.y],
      [rect.x, rect.y + rect.h],
      [rect.x + rect.w, rect.y + rect.h],
    ] as const) {
      const v = new THREE.Vector3(px - cx, 0, pz - cz).applyMatrix4(inv);
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
    const needH = Math.max(maxY - minY, (maxX - minX) / Math.max(0.1, aspect)) * 1.12;
    this.viewH = Math.min(MAX_VIEW_H, Math.max(MIN_VIEW_H, needH));
    this.viewHGoal = this.viewH;
    this.apply(aspect, 1);
  }

  private apply(aspect: number, _dt: number): void {
    this.aspect = aspect;
    const halfH = this.viewH / 2;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.position.copy(this.target).addScaledVector(this.dir, CAM_DIST);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  update(dt: number, w: number, h: number): void {
    // keyboard pan
    const kx = (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) -
      (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);
    const ky = (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0) -
      (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0);
    const speedPx = 620 * dt;
    if (kx !== 0 || ky !== 0) this.panPx(-kx * speedPx, -ky * speedPx, w, h);
    // edge scroll (only after a real pointer move, so headless runs stay put)
    if (this.edgeScroll && this.pointer.inside && this.pointer.moved) {
      const m = 14;
      let ex = 0;
      let ey = 0;
      if (this.pointer.x < m) ex = 1;
      else if (this.pointer.x > w - m) ex = -1;
      if (this.pointer.y < m) ey = 1;
      else if (this.pointer.y > h - m) ey = -1;
      if (ex !== 0 || ey !== 0) this.panPx(ex * speedPx, ey * speedPx, w, h);
    }
    // smooth lerp
    const k = Math.min(1, dt * 9);
    this.target.lerp(this.targetGoal, k);
    this.viewH += (this.viewHGoal - this.viewH) * Math.min(1, dt * 8);
    this.apply(w / Math.max(1, h), dt);
  }

  /** Mount-px → ground-plane world point (y = 0). */
  screenToGround(px: number, py: number, w: number, h: number): THREE.Vector3 {
    const ndc = new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1);
    const origin = new THREE.Vector3(ndc.x, ndc.y, -1).unproject(this.camera);
    const dir = new THREE.Vector3(0, 0, 1)
      .transformDirection(this.camera.matrixWorld)
      .negate();
    const t = -origin.y / dir.y;
    return origin.clone().addScaledVector(dir, t);
  }

  /** World point → mount px. */
  worldToScreen(p: THREE.Vector3, w: number, h: number): { x: number; y: number } {
    const v = p.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }
}
