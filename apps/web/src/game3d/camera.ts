// Orbit rig for the castle: 3/4 perspective view framing the whole plan,
// left-drag orbit (azimuth + pitch, clamped 15°–70°), wheel zoom, right-drag
// or WASD pan, and focus tweens for double-clicked constructions. Typing in
// the command bar must never move the camera — isTypingTarget guards keys.
import * as THREE from "three";

const DEG = Math.PI / 180;
const PITCH_MIN = 15 * DEG;
const PITCH_MAX = 70 * DEG;
const R_MIN = 6;
const R_MAX = 120;

/** True when the key press belongs to a text field (command bar, inputs). */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const t = (e.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

export class OrbitRig {
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
  readonly target = new THREE.Vector3();
  azimuth = -Math.PI / 4;
  pitch = 38 * DEG;
  radius = 60;
  private tGoal = new THREE.Vector3();
  private azGoal = this.azimuth;
  private pitchGoal = this.pitch;
  private rGoal = this.radius;
  private panBound = 40;
  private keys = new Set<string>();
  private detach: (() => void)[] = [];

  attachKeys(): void {
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return; // chat focus must never pan the castle
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

  /** Auto-fit: frame a plan of the given world radius in the default view. */
  fit(planRadius: number): void {
    this.panBound = planRadius + 12;
    this.target.set(0, 0.5, 0);
    this.tGoal.copy(this.target);
    this.azimuth = this.azGoal = -Math.PI / 4;
    this.pitch = this.pitchGoal = 38 * DEG;
    // A ground circle foreshortens vertically by sin(pitch); framing to the
    // raw radius leaves the castle small in a letterboxed sky. 0.82 fills
    // the frame while keeping the wall and a rim of grounds in view.
    const need = ((planRadius + 2) / Math.tan((this.camera.fov * DEG) / 2)) * 0.82;
    this.radius = this.rGoal = Math.min(R_MAX, Math.max(R_MIN, need));
    this.apply(this.camera.aspect || 1);
  }

  orbitBy(dxPx: number, dyPx: number): void {
    this.azGoal -= dxPx * 0.0075;
    this.pitchGoal = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitchGoal + dyPx * 0.005));
  }

  zoomBy(deltaY: number): void {
    const f = deltaY > 0 ? 1.16 : 1 / 1.16;
    this.rGoal = Math.min(R_MAX, Math.max(R_MIN, this.rGoal * f));
  }

  panPx(dx: number, dy: number, w: number, h: number): void {
    const worldPerPx = (2 * this.radius * Math.tan((this.camera.fov * DEG) / 2)) / Math.max(1, h);
    // camera right on the ground plane, and camera-forward projected to ground
    const rx = -Math.sin(this.azimuth);
    const rz = Math.cos(this.azimuth);
    const fx = -Math.cos(this.azimuth);
    const fz = -Math.sin(this.azimuth);
    void w;
    this.tGoal.x += (-dx * rx + dy * fx * 1.4) * worldPerPx;
    this.tGoal.z += (-dx * rz + dy * fz * 1.4) * worldPerPx;
    const b = this.panBound;
    this.tGoal.x = Math.min(b, Math.max(-b, this.tGoal.x));
    this.tGoal.z = Math.min(b, Math.max(-b, this.tGoal.z));
  }

  /** Smooth focus tween onto a world point (double-click a construction). */
  focusOn(x: number, y: number, z: number, radius = 14): void {
    this.tGoal.set(x, y, z);
    this.rGoal = Math.min(R_MAX, Math.max(R_MIN, radius));
  }

  update(dt: number, w: number, h: number): void {
    const kx =
      (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) -
      (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);
    const ky =
      (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0) -
      (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0);
    if (kx !== 0 || ky !== 0) this.panPx(-kx * 540 * dt, -ky * 540 * dt, w, h);
    const k = Math.min(1, dt * 9);
    this.target.lerp(this.tGoal, k);
    this.azimuth += (this.azGoal - this.azimuth) * k;
    this.pitch += (this.pitchGoal - this.pitch) * k;
    this.radius += (this.rGoal - this.radius) * Math.min(1, dt * 7);
    this.apply(w / Math.max(1, h));
  }

  private apply(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.position.set(
      this.target.x + this.radius * Math.cos(this.pitch) * Math.cos(this.azimuth),
      this.target.y + this.radius * Math.sin(this.pitch),
      this.target.z + this.radius * Math.cos(this.pitch) * Math.sin(this.azimuth),
    );
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  worldToScreen(p: THREE.Vector3, w: number, h: number): { x: number; y: number } {
    const v = p.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }
}
