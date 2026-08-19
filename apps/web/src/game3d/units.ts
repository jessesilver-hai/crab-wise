// Skeletal units: KayKit character clones with per-unit AnimationMixer,
// 0.2s crossfades, billboard name tags / speech bubbles / status glyphs.
import * as THREE from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AgentStatus } from "@agent-empires/protocol";
import type { CharModel } from "./assets.js";
import { makeBillboard, type Billboard } from "./billboards.js";
import type { PickInfo } from "./constructions.js";

const CROSSFADE = 0.2;

const STATUS_GLYPHS: Partial<Record<AgentStatus, string>> = {
  thinking: "💭",
  moving: "➜",
  scouting: "🔎",
  building: "⚒",
  fighting: "⚔",
  resting: "☾",
  done: "✓",
};

export type UnitKind = "villager" | "hero" | "raider";

export class Unit3D {
  readonly group = new THREE.Group();
  readonly kind: UnitKind;
  readonly pickMesh: THREE.Mesh;
  walkSpeed = 1.5; // tiles/sec
  dimmed = false;
  /** Terrain sampler: units stand on the landform (renderer injects it). */
  groundY: (x: number, z: number) => number = () => 0;
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = "";
  private mats: (THREE.MeshStandardMaterial | THREE.MeshLambertMaterial)[] = [];
  private baseColors: THREE.Color[] = [];
  private target: { x: number; z: number } | null = null;
  private yawGoal = 0;
  private labor = false;
  private dying = false;
  private nameTag: Billboard;
  private bubble: Billboard | null = null;
  private bubbleUntil = 0;
  private caption: Billboard | null = null;
  private captionUntil = 0;
  private glyph: Billboard | null = null;
  private glyphChar: string | null = null;
  private ring: THREE.Mesh;
  private headY: number;
  private idleClip: string;
  private walkClip: string;
  private runClip: string;

  constructor(
    char: CharModel,
    pick: PickInfo,
    name: string,
    nameColor: string,
    kind: UnitKind,
    targetHeight: number,
  ) {
    this.kind = kind;
    this.model = SkeletonUtils.clone(char.scene);
    const s = targetHeight / char.height;
    this.model.scale.setScalar(s);
    this.model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const src = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const clones = src.map((m) => (m as THREE.MeshStandardMaterial).clone());
      mesh.material = clones.length === 1 ? clones[0]! : clones;
      for (const m of clones) {
        this.mats.push(m as THREE.MeshStandardMaterial);
        this.baseColors.push((m as THREE.MeshStandardMaterial).color.clone());
      }
    });
    this.group.add(this.model);
    this.headY = targetHeight + 0.12;

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const [clipName, clip] of char.clips) {
      this.actions.set(clipName, this.mixer.clipAction(clip));
    }
    const has = (n: string) => this.actions.has(n);
    this.idleClip = kind === "raider" && has("Idle_Combat") ? "Idle_Combat" : "Idle";
    this.walkClip = kind === "raider" && has("Walking_D_Skeletons") ? "Walking_D_Skeletons" : "Walking_A";
    this.runClip = has("Running_A") ? "Running_A" : this.walkClip;
    this.play(this.idleClip);

    // invisible pick cylinder (renders nothing, raycasts fine)
    this.pickMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, targetHeight + 0.3).translate(0, (targetHeight + 0.3) / 2, 0),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true }),
    );
    this.pickMesh.userData.pick = pick;
    this.group.add(this.pickMesh);

    this.nameTag = makeBillboard(name, { sizePx: 20, color: nameColor, worldH: 0.26 });
    this.nameTag.sprite.position.y = this.headY;
    this.group.add(this.nameTag.sprite);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.4, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.ring.position.y = 0.04;
    this.ring.visible = false;
    this.group.add(this.ring);
  }

  get x(): number {
    return this.group.position.x;
  }
  get y(): number {
    return this.group.position.y;
  }
  get z(): number {
    return this.group.position.z;
  }
  get isWalking(): boolean {
    return this.target !== null;
  }
  get headHeight(): number {
    return this.headY;
  }

  setPosition(x: number, z: number): void {
    this.group.position.set(x, this.groundY(x, z), z);
  }

  setRing(on: boolean, color?: number): void {
    this.ring.visible = on;
    if (color !== undefined) (this.ring.material as THREE.MeshBasicMaterial).color.set(color);
  }

  play(name: string, opts: { once?: boolean; then?: string } = {}): void {
    const action = this.actions.get(name);
    if (!action) return;
    if (this.currentName === name && !opts.once) return;
    action.reset();
    if (opts.once) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      if (opts.then) {
        const onDone = (e: { action: THREE.AnimationAction }) => {
          if (e.action === action) {
            this.mixer.removeEventListener("finished", onDone as never);
            if (!this.dying) this.play(opts.then!);
          }
        };
        this.mixer.addEventListener("finished", onDone as never);
      }
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    if (this.current && this.current !== action) this.current.crossFadeTo(action, CROSSFADE, false);
    action.play();
    this.current = action;
    this.currentName = name;
  }

  walkTo(x: number, z: number, instant = false): void {
    if (this.dying) return;
    if (instant) {
      this.setPosition(x, z);
      this.target = null;
      this.play(this.labor ? "Interact" : this.idleClip);
      return;
    }
    this.target = { x, z };
    const dist = Math.hypot(x - this.x, z - this.z);
    this.yawGoal = Math.atan2(x - this.x, z - this.z);
    this.play(dist > 5 ? this.runClip : this.walkClip);
  }

  setLabor(on: boolean): void {
    this.labor = on;
    if (!this.isWalking && !this.dying) this.play(on ? "Interact" : this.idleClip);
  }

  cheer(): void {
    this.target = null;
    this.play(this.actions.has("Cheer") ? "Cheer" : "Taunt");
  }

  flourish(): void {
    if (!this.isWalking && this.actions.has("Spellcast_Long")) {
      this.play("Spellcast_Long", { once: true, then: this.labor ? "Interact" : this.idleClip });
    }
  }

  hit(): void {
    this.play("Hit_A", { once: true, then: this.idleClip });
  }

  spawnFromGround(): void {
    if (this.actions.has("Spawn_Ground_Skeletons")) {
      this.play("Spawn_Ground_Skeletons", { once: true, then: this.idleClip });
    }
  }

  die(cb: () => void): void {
    this.dying = true;
    this.target = null;
    const finish = () => {
      let t = 0;
      const fade = (dt: number) => {
        t += dt;
        const a = Math.max(0, 1 - t / 0.6);
        for (const m of this.mats) {
          m.transparent = true;
          m.opacity = a;
        }
        if (t >= 0.6) {
          this.fader = null;
          cb();
        }
      };
      this.fader = fade;
    };
    if (this.actions.has("Death_C_Skeletons")) {
      const action = this.actions.get("Death_C_Skeletons")!;
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      if (this.current && this.current !== action) this.current.crossFadeTo(action, CROSSFADE, false);
      action.play();
      this.current = action;
      const onDone = (e: { action: THREE.AnimationAction }) => {
        if (e.action === action) {
          this.mixer.removeEventListener("finished", onDone as never);
          finish();
        }
      };
      this.mixer.addEventListener("finished", onDone as never);
    } else {
      finish();
    }
  }
  private fader: ((dt: number) => void) | null = null;

  say(text: string): void {
    this.bubble?.dispose();
    const short = text.length > 130 ? text.slice(0, 130) + "…" : text;
    this.bubble = makeBillboard(short, {
      font: "Georgia, serif",
      sizePx: 22,
      color: "#2a2013",
      bg: "#efe6cd",
      border: "#5a4527",
      maxWidthPx: 380,
      worldH: 0.32,
    });
    // taller bubbles for wrapped text
    const lines = Math.max(1, Math.round(this.bubble.h / 0.32));
    this.bubble.sprite.scale.multiplyScalar(1);
    this.bubble.sprite.position.y = this.headY + 0.34;
    this.bubble.sprite.renderOrder = 60 + lines;
    this.group.add(this.bubble.sprite);
    this.bubbleUntil = performance.now() + 4200;
  }

  showDetail(text: string): void {
    this.caption?.dispose();
    const short = text.length > 44 ? text.slice(0, 44) + "…" : text;
    this.caption = makeBillboard(short, { sizePx: 17, color: "#c9c0aa", worldH: 0.2 });
    this.caption.sprite.position.y = this.headY - 0.06;
    this.group.add(this.caption.sprite);
    this.captionUntil = performance.now() + 2600;
  }

  setStatusGlyph(status: AgentStatus): void {
    const char = STATUS_GLYPHS[status] ?? null;
    if (char === this.glyphChar) return;
    this.glyphChar = char;
    this.glyph?.dispose();
    this.glyph = null;
    if (!char) return;
    this.glyph = makeBillboard(char, { sizePx: 24, worldH: 0.26 });
    this.glyph.sprite.position.set(0.32, this.headY + 0.02, 0);
    this.group.add(this.glyph.sprite);
  }

  applyTint(color: number | undefined): void {
    this.mats.forEach((m, i) => {
      const base = this.baseColors[i]!;
      if (color === undefined) m.color.copy(base);
      else m.color.copy(base).multiply(new THREE.Color(color));
    });
  }

  tick(dt: number, now: number, animate: boolean): void {
    if (this.target) {
      const dx = this.target.x - this.x;
      const dz = this.target.z - this.z;
      const dist = Math.hypot(dx, dz);
      const step = this.walkSpeed * dt;
      if (dist <= step) {
        this.setPosition(this.target.x, this.target.z);
        this.target = null;
        if (!this.dying) this.play(this.labor ? "Interact" : this.idleClip);
      } else {
        this.setPosition(this.x + (dx / dist) * step, this.z + (dz / dist) * step);
        this.yawGoal = Math.atan2(dx, dz);
      }
    }
    // face travel direction smoothly
    let d = this.yawGoal - this.model.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.model.rotation.y += d * Math.min(1, dt * 10);
    if (animate || this.dying) this.mixer.update(dt);
    if (this.fader) this.fader(dt);
    if (this.bubble && now > this.bubbleUntil) {
      this.bubble.dispose();
      this.bubble = null;
    }
    if (this.caption && now > this.captionUntil) {
      this.caption.dispose();
      this.caption = null;
    }
    const opacity = this.dimmed ? 0.55 : 1;
    if (!this.dying && this.mats[0] && this.mats[0].opacity !== opacity) {
      for (const m of this.mats) {
        m.transparent = this.dimmed;
        m.opacity = opacity;
      }
    }
  }

  destroy(): void {
    this.nameTag.dispose();
    this.bubble?.dispose();
    this.caption?.dispose();
    this.glyph?.dispose();
    this.mixer.stopAllAction();
    this.group.removeFromParent();
    for (const m of this.mats) m.dispose();
  }
}
