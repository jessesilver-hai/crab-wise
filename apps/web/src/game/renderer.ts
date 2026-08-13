import Phaser from "phaser";
import type { AgentStatus, GameEvent, ThemePack, WorldSpec } from "@agent-empires/protocol";
import type { Renderer } from "../match-view.js";
import { assignPlot, isoX, isoY, layoutMap, MapLayout, mulberry32, TILE_H, TILE_W } from "./map.js";
import {
  applyTheme,
  applyWorldSpec,
  buildTextures,
  hexColor,
  particleTextures,
  pruneGeneration,
  shade,
  skyTexture,
  specSkyTexture,
  TextureSet,
  TEX_SCALE,
} from "./textures.js";
import { Unit } from "./units.js";
import { Archetype, ParticleKind, resolveArchetype } from "./archetypes.js";

const FOG_REVEAL_RADIUS = 2;
const CONSTRUCTION_MS = 1400;
const MAX_RAIDERS = 8;
const CARD_W = 264;

// Depth bands: everything lives directly on the scene, ordered by depth.
const D_SKY = -200000;
const D_GROUND = -100000;
const D_MARKER = -50000;
// objects (props / buildings / units) use their screen y (≈ -3k..+4k)
const D_FOG = 50000;
const D_LABEL = 60000;
const D_FX = 70000;
const D_PARTICLE = 80000;
const D_UI = 90000;

const DPR = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);

function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function attachGameRenderer(mount: HTMLElement): Renderer {
  const scene = new MainScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: mount,
    backgroundColor: "#0d0a06",
    banner: false,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: mount.clientWidth || 800,
      height: mount.clientHeight || 600,
    },
    render: { antialias: true },
    audio: { noAudio: true },
    scene,
  });
  return {
    handleEvent(e, historical) {
      scene.enqueue(e, historical);
    },
    destroy() {
      game.destroy(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Scene state records
// ---------------------------------------------------------------------------

const IDLE_STATUSES: ReadonlySet<AgentStatus> = new Set(["idle", "resting", "done"]);

type AgentRec = {
  unit: Unit;
  role: "orchestrator" | "worker";
  name: string;
  charge: string | null;
  status: AgentStatus;
  /** Where this agent's attention is: the building of the last file it touched. */
  site: { x: number; y: number } | null;
  sitePath: string | null;
  nextMoveAt: number;
};

type BuildingRec = {
  img: Phaser.GameObjects.Image;
  kind: string;
  path: string;
  tx: number;
  ty: number;
  writes: number;
  linesAdded: number;
  linesRemoved: number;
  constructUntil: number; // 0 = fully built
  pulse: Phaser.Tweens.Tween | null;
};

type RaiderRec = {
  unit: Unit;
  cx: number;
  cy: number;
  r: number;
  angle: number;
  speed: number; // rad/s prowl orbit
};

type PropRec = {
  img: Phaser.GameObjects.Image;
  variant: number;
  tx: number;
  ty: number;
  pulse: Phaser.Tweens.Tween | null;
};

type Particle = {
  img: Phaser.GameObjects.Image;
  vx: number;
  vy: number;
  sway: number;
  rate: number;
  phase: number;
  baseAlpha: number;
  flicker: boolean;
};

type PartCfg = {
  tex: "soft" | "mist" | "streak";
  add: boolean;
  scale: [number, number];
  alpha: [number, number];
  vx: [number, number];
  vy: [number, number];
  sway: number;
  flicker: boolean;
  /** Sprite rotation in degrees (rain streaks fall steeply). */
  angle?: number;
};

/** WorldSpec ambience adds "rain" on top of the archetype particle kinds. */
const PART_CFG: Record<ParticleKind | "rain", PartCfg> = {
  ash: { tex: "soft", add: false, scale: [0.35, 0.8], alpha: [0.2, 0.45], vx: [-8, 2], vy: [8, 20], sway: 8, flicker: false },
  embers: { tex: "soft", add: true, scale: [0.25, 0.6], alpha: [0.4, 0.85], vx: [-8, 8], vy: [-40, -14], sway: 10, flicker: true },
  mist: { tex: "mist", add: false, scale: [1.6, 3.6], alpha: [0.05, 0.1], vx: [5, 16], vy: [-2, 2], sway: 3, flicker: false },
  snow: { tex: "soft", add: false, scale: [0.25, 0.6], alpha: [0.35, 0.75], vx: [-6, 6], vy: [10, 28], sway: 14, flicker: false },
  spores: { tex: "soft", add: true, scale: [0.2, 0.5], alpha: [0.25, 0.55], vx: [-6, 6], vy: [-8, 6], sway: 12, flicker: true },
  dust: { tex: "streak", add: false, scale: [0.8, 1.8], alpha: [0.08, 0.22], vx: [50, 130], vy: [2, 12], sway: 4, flicker: false },
  rain: { tex: "streak", add: false, scale: [0.5, 1.0], alpha: [0.14, 0.32], vx: [-30, -14], vy: [230, 360], sway: 0, flicker: false, angle: 80 },
};

/** Which tiles a WorldSpec placement rule may claim. */
function propTileEligible(
  placement: "ridges" | "edges" | "scatter" | "districts",
  tx: number,
  ty: number,
  side: number,
  regionCenters: { x: number; y: number }[],
): boolean {
  switch (placement) {
    case "scatter":
      return true;
    case "edges":
      return tx < 2 || ty < 2 || tx >= side - 2 || ty >= side - 2;
    case "ridges":
      // strata lines running screen-horizontal across the diamond
      return (tx + ty) % 5 === 0;
    case "districts":
      return regionCenters.some((c) => Math.abs(c.x - tx) + Math.abs(c.y - ty) <= 2);
  }
}

/** Tiles with tx+ty ≥ returned threshold are water, ≈ coverage of the map. */
function waterThreshold(side: number, coverage: number): number {
  if (coverage <= 0.01) return 2 * side; // unreachable: no water
  const target = coverage * side * side;
  let acc = 0;
  for (let v = 2 * side - 2; v >= 0; v--) {
    acc += side - Math.abs(v - (side - 1));
    if (acc >= target) return v;
  }
  return 0;
}

const KIND_NAMES: Record<string, string> = {
  house: "Dwelling",
  barracks: "Bastion",
  market: "Trade-Vault",
  monastery: "Sanctum",
  mill: "Engine-Granary",
  towncenter: "The Citadel",
};

type Selection = { kind: "unit"; id: string } | { kind: "building"; path: string } | null;

// ---------------------------------------------------------------------------

class MainScene extends Phaser.Scene {
  private ready = false;
  private pending: [GameEvent, boolean][] = [];

  private gen = 0;
  private mapSeed = 1;
  private archetype: Archetype = resolveArchetype(undefined, 0);
  private theme: ThemePack | null = null;
  private spec: WorldSpec | null = null;
  private accent = 0xe3b264;
  private tex!: TextureSet;
  private fxTex!: { soft: string; mist: string; streak: string };
  private waterT = Number.POSITIVE_INFINITY;
  private skyEventTimer: Phaser.Time.TimerEvent | null = null;

  private map: MapLayout | null = null;
  private citadel = { x: 0, y: 0, tx: 0, ty: 0 };
  private agents = new Map<string, AgentRec>();
  private buildings = new Map<string, BuildingRec>();
  private raiders = new Map<string, RaiderRec>();
  private fogTiles = new Map<string, Phaser.GameObjects.Image>();
  private groundTiles: Phaser.GameObjects.Image[] = [];
  private props: PropRec[] = [];
  private regionLabels: Phaser.GameObjects.Text[] = [];
  private particles: Particle[] = [];
  private skyImg: Phaser.GameObjects.Image | null = null;
  private wonderImg: Phaser.GameObjects.Image | null = null;
  private tokenThrottle = new Map<string, number>();

  // interactivity
  private selected: Selection = null;
  private followId: string | null = null;
  private hovered: Phaser.GameObjects.GameObject | null = null;
  private hoverMarker!: Phaser.GameObjects.Image;
  private selectMarker!: Phaser.GameObjects.Image;
  private card!: Phaser.GameObjects.Container;
  private cardBg!: Phaser.GameObjects.Graphics;
  private cardTitle!: Phaser.GameObjects.Text;
  private cardBody!: Phaser.GameObjects.Text;
  private cardH = 0;
  private lastClickAt = 0;
  private lastClickX = 0;
  private lastClickY = 0;

  constructor() {
    super("main");
  }

  enqueue(e: GameEvent, historical: boolean): void {
    if (this.ready) this.dispatch(e, historical);
    else this.pending.push([e, historical]);
  }

  create(): void {
    this.tex = buildTextures(this, this.archetype, this.gen);
    this.fxTex = particleTextures(this);
    this.accent = this.archetype.glow;

    this.hoverMarker = this.add
      .image(0, 0, this.tex.highlight)
      .setScale(TEX_SCALE)
      .setDepth(D_MARKER)
      .setAlpha(0.5)
      .setVisible(false);
    this.selectMarker = this.add
      .image(0, 0, this.tex.highlight)
      .setScale(TEX_SCALE)
      .setDepth(D_MARKER + 1)
      .setVisible(false);

    this.buildCard();
    this.setupInput();

    this.scale.on("resize", () => {
      this.sizeSky();
      this.positionCard();
    });

    this.ready = true;
    for (const [e, h] of this.pending) this.dispatch(e, h);
    this.pending = [];
  }

  // --- camera + input --------------------------------------------------------

  private setupInput(): void {
    const cam = this.cameras.main;
    let dragLastX = 0;
    let dragLastY = 0;

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      dragLastX = p.x;
      dragLastY = p.y;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      const dx = p.x - dragLastX;
      const dy = p.y - dragLastY;
      dragLastX = p.x;
      dragLastY = p.y;
      if (p.getDistance() > 6) {
        this.stopFollowing();
        cam.scrollX -= dx / cam.zoom;
        cam.scrollY -= dy / cam.zoom;
      }
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (p.getDistance() > 8) return; // that was a pan, not a click
      const now = performance.now();
      const isDouble =
        now - this.lastClickAt < 350 &&
        Math.hypot(p.x - this.lastClickX, p.y - this.lastClickY) < 24;
      this.lastClickAt = now;
      this.lastClickX = p.x;
      this.lastClickY = p.y;
      if (isDouble) {
        this.recenter();
        return;
      }
      if (this.hovered) this.select(this.hovered);
      else this.clearSelection();
    });

    this.input.on(
      "gameobjectover",
      (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
        this.hovered = obj;
        this.input.setDefaultCursor("pointer");
      },
    );
    this.input.on(
      "gameobjectout",
      (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
        if (this.hovered === obj) {
          this.hovered = null;
          this.input.setDefaultCursor("default");
        }
      },
    );

    this.game.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.events.once("destroy", () => {
      this.game.canvas?.removeEventListener("wheel", this.onWheel);
    });
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const cam = this.cameras.main;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Phaser.Math.Clamp(cam.zoom * factor, 0.35, 2.5);
    if (this.followId) {
      cam.setZoom(next);
      return;
    }
    const rect = this.game.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // keep the world point under the cursor fixed through the zoom
    const wx = cam.scrollX + cam.width / 2 + (px - cam.width / 2) / cam.zoom;
    const wy = cam.scrollY + cam.height / 2 + (py - cam.height / 2) / cam.zoom;
    cam.setZoom(next);
    cam.scrollX = wx - cam.width / 2 - (px - cam.width / 2) / next;
    cam.scrollY = wy - cam.height / 2 - (py - cam.height / 2) / next;
  };

  private recenter(): void {
    this.stopFollowing();
    this.cameras.main.pan(this.citadel.x, this.citadel.y, 600, "Sine.easeInOut");
  }

  private stopFollowing(): void {
    if (this.followId !== null) {
      this.cameras.main.stopFollow();
      this.followId = null;
    }
  }

  private fitCamera(): void {
    if (!this.map) return;
    const side = this.map.side;
    const left = isoX(0, side - 1) - TILE_W / 2;
    const right = isoX(side - 1, 0) + TILE_W / 2;
    const top = isoY(0, 0) - TILE_H / 2;
    const bottom = isoY(side - 1, side - 1) + TILE_H / 2;
    const vw = this.scale.width || 800;
    const vh = this.scale.height || 600;
    const zoom = Phaser.Math.Clamp(
      Math.min(vw / (right - left + 80), vh / (bottom - top + 120)),
      0.35,
      2,
    );
    const cam = this.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn((left + right) / 2, (top + bottom) / 2);
  }

  // --- selection + info card ---------------------------------------------------

  private select(obj: Phaser.GameObjects.GameObject): void {
    const kind = obj.getData("kind") as string | undefined;
    if (kind === "unit") {
      const id = obj.getData("id") as string;
      const rec = this.agents.get(id);
      if (!rec) return;
      this.selected = { kind: "unit", id };
      this.followId = id;
      this.cameras.main.startFollow(rec.unit.root, false, 0.08, 0.08);
    } else if (kind === "building") {
      const path = obj.getData("path") as string;
      const rec = this.buildings.get(path);
      if (!rec) return;
      this.stopFollowing();
      this.selected = { kind: "building", path };
      this.selectMarker.setPosition(isoX(rec.tx, rec.ty), isoY(rec.tx, rec.ty)).setVisible(true);
    } else {
      return;
    }
    this.refreshCard();
  }

  private clearSelection(): void {
    this.stopFollowing();
    this.selected = null;
    this.selectMarker.setVisible(false);
    this.card.setVisible(false);
  }

  private buildCard(): void {
    this.cardBg = this.add.graphics();
    this.cardTitle = this.add
      .text(12, 10, "", {
        fontFamily: "Cinzel, Georgia, serif",
        fontSize: "13px",
        color: "#e8d9b0",
      })
      .setResolution(DPR);
    this.cardBody = this.add
      .text(12, 30, "", {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "11px",
        color: "#b8b0a0",
        wordWrap: { width: CARD_W - 24 },
        lineSpacing: 4,
      })
      .setResolution(DPR);
    this.card = this.add
      .container(0, 0, [this.cardBg, this.cardTitle, this.cardBody])
      .setScrollFactor(0)
      .setDepth(D_UI)
      .setVisible(false);
  }

  private refreshCard(): void {
    if (!this.selected) {
      this.card.setVisible(false);
      return;
    }
    let title = "";
    const lines: string[] = [];
    if (this.selected.kind === "unit") {
      const rec = this.agents.get(this.selected.id);
      if (!rec) return this.clearSelection();
      title = rec.name;
      lines.push(rec.role === "orchestrator" ? "sovereign · orchestrator" : "worker");
      lines.push(`status: ${rec.status}`);
      if (rec.sitePath) lines.push(`at: ${truncPath(rec.sitePath)}`);
      if (rec.charge) lines.push(`charge: ${rec.charge.length > 120 ? rec.charge.slice(0, 120) + "…" : rec.charge}`);
    } else {
      const rec = this.buildings.get(this.selected.path);
      if (!rec) return this.clearSelection();
      const name = rec.path === "__towncenter__" ? "The Citadel" : rec.path.split("/").pop() ?? rec.path;
      title = name;
      lines.push(KIND_NAMES[rec.kind] ?? rec.kind);
      if (rec.path !== "__towncenter__") lines.push(truncPath(rec.path));
      lines.push(`reinforced ×${rec.writes}`);
      lines.push(`+${rec.linesAdded} / −${rec.linesRemoved} lines`);
    }
    this.cardTitle.setText(title);
    this.cardTitle.setColor(hex(this.accent));
    this.cardBody.setText(lines.join("\n"));
    this.cardBody.setY(this.cardTitle.y + this.cardTitle.height + 6);
    const h = this.cardBody.y + this.cardBody.height + 12;
    this.cardH = h;
    this.cardBg.clear();
    this.cardBg.fillStyle(0x120e08, 0.92);
    this.cardBg.fillRoundedRect(0, 0, CARD_W, h, 8);
    this.cardBg.lineStyle(1.5, this.accent, 0.85);
    this.cardBg.strokeRoundedRect(0, 0, CARD_W, h, 8);
    this.card.setVisible(true);
    this.positionCard();
  }

  private positionCard(): void {
    this.card.setPosition(14, this.scale.height - this.cardH - 14);
  }

  // --- sky + ambient particles -------------------------------------------------

  private sizeSky(): void {
    this.skyImg?.setDisplaySize(this.scale.width, this.scale.height * 0.55);
  }

  private redrawSky(): void {
    const key = this.spec
      ? specSkyTexture(this, this.spec.sky, this.gen)
      : skyTexture(this, this.archetype.horizonColor, this.gen);
    if (this.skyImg) this.skyImg.setTexture(key);
    else {
      this.skyImg = this.add
        .image(0, 0, key)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(D_SKY);
    }
    this.skyImg.setAlpha(this.spec ? 0.7 : 0.55);
    this.sizeSky();
  }

  private initParticles(): void {
    for (const p of this.particles) p.img.destroy();
    this.particles = [];
    const amb = this.spec?.ambience;
    const eff: { kind: ParticleKind | "rain" | "none"; color: number; count: number } = amb
      ? {
          kind: amb.particles,
          color: hexColor(amb.tint) ?? 0xffffff,
          count: Math.round(amb.rate * 64),
        }
      : this.archetype.particle;
    if (eff.kind === "none" || eff.count <= 0) return;
    const cfg = PART_CFG[eff.kind];
    const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
    const w = this.scale.width || 800;
    const h = this.scale.height || 600;
    for (let i = 0; i < eff.count; i++) {
      const img = this.add
        .image(Math.random() * w, Math.random() * h, this.fxTex[cfg.tex])
        .setScrollFactor(0)
        .setDepth(D_PARTICLE)
        .setTint(eff.color)
        .setScale(rand(cfg.scale[0], cfg.scale[1]));
      if (cfg.add) img.setBlendMode(Phaser.BlendModes.ADD);
      if (cfg.angle !== undefined) img.setAngle(cfg.angle);
      const baseAlpha = rand(cfg.alpha[0], cfg.alpha[1]);
      img.setAlpha(baseAlpha);
      this.particles.push({
        img,
        vx: rand(cfg.vx[0], cfg.vx[1]),
        vy: rand(cfg.vy[0], cfg.vy[1]),
        sway: cfg.sway,
        rate: rand(0.6, 2.2),
        phase: Math.random() * Math.PI * 2,
        baseAlpha,
        flicker: cfg.flicker,
      });
    }
  }

  // --- WorldSpec sky events: rare screen-space happenings ----------------------

  private resetSkyEvents(): void {
    this.skyEventTimer?.remove();
    this.skyEventTimer = null;
    const se = this.spec?.ambience.skyEvents;
    if (!se) return;
    this.skyEventTimer = this.time.addEvent({
      delay: se.everySec * 1000,
      loop: true,
      callback: () => this.spawnSkyEvent(se.kind),
    });
    // one early showing so the feature is visible without a long wait
    this.time.delayedCall(6000, () => {
      if (this.skyEventTimer && this.spec?.ambience.skyEvents?.kind === se.kind) {
        this.spawnSkyEvent(se.kind);
      }
    });
  }

  private spawnSkyEvent(kind: "flare" | "drift" | "aurora" | "birds"): void {
    const w = this.scale.width || 800;
    const h = this.scale.height || 600;
    const tint = hexColor(this.spec?.ambience.tint ?? "") ?? this.accent;
    switch (kind) {
      case "flare": {
        // a bright streak arcing across the upper sky
        const y0 = h * (0.06 + Math.random() * 0.2);
        const img = this.add
          .image(-40, y0, this.fxTex.streak)
          .setScrollFactor(0)
          .setDepth(D_PARTICLE)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setTint(tint)
          .setScale(2.6, 1.4)
          .setAngle(12)
          .setAlpha(0.95);
        this.tweens.add({
          targets: img,
          x: w + 60,
          y: y0 + h * 0.14,
          alpha: 0,
          duration: 1500,
          ease: "Sine.easeIn",
          onComplete: () => img.destroy(),
        });
        break;
      }
      case "drift": {
        // a vast slow glow crossing behind the haze
        const img = this.add
          .image(-120, h * (0.08 + Math.random() * 0.22), this.fxTex.mist)
          .setScrollFactor(0)
          .setDepth(D_PARTICLE)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setTint(tint)
          .setScale(4.5)
          .setAlpha(0);
        this.tweens.add({ targets: img, x: w + 120, duration: 16000, ease: "Linear" });
        this.tweens.add({
          targets: img,
          alpha: 0.16,
          duration: 3500,
          yoyo: true,
          hold: 9000,
          onComplete: () => img.destroy(),
        });
        break;
      }
      case "aurora": {
        // shimmer bands pinned to the top of the viewport
        const imgs: Phaser.GameObjects.Image[] = [];
        for (let i = 0; i < 3; i++) {
          imgs.push(
            this.add
              .image(w * (0.2 + Math.random() * 0.6), 30 + i * 34, this.fxTex.mist)
              .setScrollFactor(0)
              .setDepth(D_PARTICLE)
              .setBlendMode(Phaser.BlendModes.ADD)
              .setTint(tint)
              .setScale(6 + Math.random() * 4, 0.9)
              .setAlpha(0),
          );
        }
        imgs.forEach((img, i) => {
          this.tweens.add({
            targets: img,
            alpha: 0.14 + Math.random() * 0.08,
            x: img.x + (Math.random() - 0.5) * 120,
            duration: 2600 + i * 500,
            yoyo: true,
            hold: 2400,
            ease: "Sine.easeInOut",
            onComplete: () => img.destroy(),
          });
        });
        break;
      }
      case "birds": {
        // a small v-flock crossing the upper third
        const goRight = Math.random() < 0.5;
        const y0 = h * (0.08 + Math.random() * 0.22);
        const dots: Phaser.GameObjects.Image[] = [];
        const n = 5 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          const k = i - Math.floor(n / 2);
          dots.push(
            this.add
              .image(k * 11 * (goRight ? -1 : 1), Math.abs(k) * 5, this.fxTex.soft)
              .setTint(0x14110c)
              .setScale(0.16)
              .setAlpha(0.85),
          );
        }
        const flock = this.add
          .container(goRight ? -60 : w + 60, y0, dots)
          .setScrollFactor(0)
          .setDepth(D_PARTICLE);
        this.tweens.add({
          targets: flock,
          x: goRight ? w + 60 : -60,
          y: y0 - h * 0.05,
          duration: 11000,
          ease: "Linear",
          onComplete: () => flock.destroy(),
        });
        break;
      }
    }
  }

  // --- world construction --------------------------------------------------------

  private buildWorld(event: Extract<GameEvent, { type: "match_started" }>): void {
    this.mapSeed = event.mapSeed;
    this.retexture();

    const map = layoutMap(event.repoTree, event.mapSeed);
    this.map = map;

    this.refreshWaterThreshold();
    for (let ty = 0; ty < map.side; ty++) {
      for (let tx = 0; tx < map.side; tx++) {
        this.groundTiles.push(
          this.add
            .image(isoX(tx, ty), isoY(tx, ty), this.groundKeyFor(tx, ty, map.rng))
            .setScale(TEX_SCALE)
            .setDepth(D_GROUND),
        );

        const fog = this.add
          .image(isoX(tx, ty), isoY(tx, ty), this.tex.fog)
          .setScale(TEX_SCALE)
          .setAlpha(0.88)
          .setDepth(D_FOG);
        this.fogTiles.set(`${tx},${ty}`, fog);
      }
    }

    // props (archetype relics or WorldSpec-composed silhouettes) on unused land
    this.placeProps();

    // territory labels
    for (const region of map.regions) {
      if (region.rect.w * region.rect.h < 6) continue;
      const cx = region.rect.x + region.rect.w / 2;
      const cy = region.rect.y;
      const label = this.add
        .text(isoX(cx, cy), isoY(cx, cy) - 10, region.label, {
          fontFamily: "Cinzel, Georgia, serif",
          fontSize: "13px",
          color: hex(this.theme ? this.accent : 0xc98f4a),
        })
        .setOrigin(0.5)
        .setAlpha(0.75)
        .setDepth(D_LABEL)
        .setResolution(DPR);
      label.setLetterSpacing(2);
      this.regionLabels.push(label);
    }

    // The Citadel stands from the start
    const tc = map.townCenter;
    this.citadel = { x: isoX(tc.tx, tc.ty), y: isoY(tc.tx, tc.ty), tx: tc.tx, ty: tc.ty };
    this.placeBuilding("__towncenter__", "towncenter", tc.tx, tc.ty, true);
    this.reveal(tc.tx, tc.ty, 3, true);
    this.fitCamera();
  }

  /** Rebuild every generated texture for the current archetype + theme + spec. */
  private retexture(): void {
    const oldGen = this.gen;
    this.gen++;
    this.archetype = resolveArchetype(this.theme?.biome.archetype, this.mapSeed);
    this.spec = this.theme?.worldSpec ?? null;
    let tex = buildTextures(this, this.archetype, this.gen);
    if (this.spec) tex = applyWorldSpec(this, tex, this.spec, this.gen);
    if (this.theme) tex = applyTheme(this, tex, this.theme, this.archetype, this.gen, this.spec ?? undefined);
    this.tex = tex;

    const themeAccent = this.theme ? parseInt(this.theme.biome.accentColor.slice(1), 16) : NaN;
    this.accent = Number.isNaN(themeAccent) ? this.archetype.glow : themeAccent;

    this.cameras.main.setBackgroundColor(
      this.spec ? shade(hexColor(this.spec.sky.top) ?? this.archetype.skyColor, 0.35) : this.archetype.skyColor,
    );
    this.redrawSky();
    this.initParticles();
    this.resetSkyEvents();
    this.refreshWaterThreshold();
    this.hoverMarker.setTexture(this.tex.highlight);
    this.selectMarker.setTexture(this.tex.highlight);
    this.wonderImg?.setTexture(this.tex.wonder);
    // In-flight effects (fog fades, pings) may still show old-gen textures for
    // a moment; prune once they are certainly gone.
    this.time.delayedCall(5000, () => pruneGeneration(this, oldGen));
  }

  // --- WorldSpec terrain + props ------------------------------------------------

  private refreshWaterThreshold(): void {
    const cov = this.spec?.terrain.waterline?.coverage ?? 0;
    this.waterT =
      this.map && this.tex.water && cov > 0
        ? waterThreshold(this.map.side, cov)
        : Number.POSITIVE_INFINITY;
  }

  private isWaterTile(tx: number, ty: number): boolean {
    return tx + ty >= this.waterT;
  }

  private groundKeyFor(tx: number, ty: number, rng: () => number): string {
    if (this.tex.water && this.isWaterTile(tx, ty)) return this.tex.water;
    return this.tex.ground[Math.floor(rng() * this.tex.ground.length)]!;
  }

  /** Re-texture every laid ground tile (including the waterline band). */
  private applyGroundTextures(): void {
    if (!this.map) return;
    const side = this.map.side;
    this.groundTiles.forEach((tile, i) => {
      if (!tile.active) return;
      tile.setTexture(this.groundKeyFor(i % side, Math.floor(i / side), Math.random));
    });
  }

  private clearProps(): void {
    for (const p of this.props) {
      p.pulse?.destroy();
      p.img.destroy();
      this.map?.used.delete(`${p.tx},${p.ty}`);
    }
    this.props = [];
  }

  /**
   * Scatter props over unused land tiles. WorldSpec props place by their own
   * density + placement rule; otherwise archetype props scatter uniformly.
   */
  private placeProps(): void {
    const map = this.map;
    if (!map) return;
    this.clearProps();
    const rng = mulberry32((this.mapSeed ^ 0x51ed2701) >>> 0);
    const specProps = this.tex.specProps;
    const centers = map.regions.map((r) => ({
      x: r.rect.x + r.rect.w / 2,
      y: r.rect.y + r.rect.h / 2,
    }));
    let placed = 0;
    for (let ty = 0; ty < map.side && placed < 240; ty++) {
      for (let tx = 0; tx < map.side && placed < 240; tx++) {
        const key = `${tx},${ty}`;
        if (map.used.has(key) || this.isWaterTile(tx, ty)) continue;
        if (specProps) {
          for (let i = 0; i < specProps.length; i++) {
            const sp = specProps[i]!;
            if (!propTileEligible(sp.placement, tx, ty, map.side, centers)) continue;
            // ridge/edge tile sets are far smaller than scatter, so weigh them up
            const weight = sp.placement === "scatter" ? 0.1 : sp.placement === "districts" ? 0.16 : 0.3;
            if (rng() < sp.density * weight) {
              map.used.add(key);
              this.spawnProp(tx, ty, sp.tex, i, sp.pulseSec);
              placed++;
              break;
            }
          }
        } else if (rng() < this.archetype.propDensity) {
          map.used.add(key);
          const variant = Math.floor(rng() * this.tex.props.length);
          this.spawnProp(tx, ty, this.tex.props[variant]!, variant, null);
          placed++;
        }
      }
    }
  }

  private spawnProp(tx: number, ty: number, texKey: string, variant: number, pulseSec: number | null): void {
    const img = this.add
      .image(isoX(tx, ty), isoY(tx, ty) + TILE_H / 4, texKey)
      .setOrigin(0.5, 1)
      .setScale(TEX_SCALE);
    img.setDepth(img.y);
    let pulse: Phaser.Tweens.Tween | null = null;
    if (pulseSec !== null) {
      pulse = this.tweens.add({
        targets: img,
        alpha: 0.62,
        duration: (pulseSec * 1000) / 2,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }
    this.props.push({ img, variant, tx, ty, pulse });
  }

  /** Apply WorldSpec unit tint + gait to a figure (clears both when absent). */
  private styleUnit(unit: Unit, kind: "villager" | "hero" | "raider"): void {
    const u = this.spec?.units;
    if (!u) {
      unit.applyTint(undefined);
      unit.gaitScale = 1;
      return;
    }
    const tint = kind === "villager" ? u.villagerTint : kind === "hero" ? u.heroTint : u.raiderTint;
    unit.applyTint(hexColor(tint));
    unit.gaitScale = 0.4 + u.gaitBounce * 1.4;
  }

  private reveal(tx: number, ty: number, radius: number, historical: boolean): void {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > radius + 1) continue;
        const key = `${tx + dx},${ty + dy}`;
        const fog = this.fogTiles.get(key);
        if (!fog) continue;
        this.fogTiles.delete(key);
        if (historical) fog.destroy();
        else {
          this.tweens.add({ targets: fog, alpha: 0, duration: 350, onComplete: () => fog.destroy() });
        }
      }
    }
  }

  private posForPath(path: string): { x: number; y: number; tx: number; ty: number } {
    const map = this.map!;
    let cell = map.plots.get(path);
    if (!cell) {
      const region = map.regions.find((r) => r.path === path);
      if (region) {
        cell = {
          tx: Math.floor(region.rect.x + region.rect.w / 2),
          ty: Math.floor(region.rect.y + region.rect.h / 2),
        };
      } else if (path === "." || path === "") {
        cell = map.townCenter;
      } else {
        cell = assignPlot(map, path);
      }
    }
    return { x: isoX(cell.tx, cell.ty), y: isoY(cell.tx, cell.ty), tx: cell.tx, ty: cell.ty };
  }

  private placeBuilding(path: string, kind: string, tx: number, ty: number, instant: boolean): BuildingRec {
    const existing = this.buildings.get(path);
    const texSet = this.tex.buildings[kind] ?? this.tex.buildings.house!;
    if (existing) {
      if (!instant) this.startConstruction(existing);
      return existing;
    }
    const img = this.add
      .image(isoX(tx, ty), isoY(tx, ty) + TILE_H / 4, instant ? texSet.built : texSet.scaffold)
      .setOrigin(0.5, 1)
      .setScale(TEX_SCALE);
    img.setDepth(img.y);
    img.setInteractive(new Phaser.Geom.Rectangle(36, 52, 128, 144), Phaser.Geom.Rectangle.Contains);
    img.setData("kind", "building");
    img.setData("path", path);
    const rec: BuildingRec = {
      img,
      kind,
      path,
      tx,
      ty,
      writes: 0,
      linesAdded: 0,
      linesRemoved: 0,
      constructUntil: 0,
      pulse: null,
    };
    this.buildings.set(path, rec);
    if (!instant) this.startConstruction(rec);
    return rec;
  }

  private startConstruction(rec: BuildingRec): void {
    const texSet = this.tex.buildings[rec.kind] ?? this.tex.buildings.house!;
    rec.img.setTexture(texSet.scaffold);
    rec.constructUntil = this.time.now + CONSTRUCTION_MS;
    if (!rec.pulse) {
      rec.pulse = this.tweens.add({
        targets: rec.img,
        alpha: 0.65,
        duration: 260,
        yoyo: true,
        repeat: -1,
      });
    }
  }

  private finishConstruction(rec: BuildingRec): void {
    rec.constructUntil = 0;
    rec.pulse?.stop();
    rec.pulse = null;
    rec.img.setAlpha(1);
    const texSet = this.tex.buildings[rec.kind] ?? this.tex.buildings.house!;
    rec.img.setTexture(texSet.built);
    rec.img.setScale(TEX_SCALE * 1.18);
    this.tweens.add({ targets: rec.img, scale: TEX_SCALE, duration: 320, ease: "Back.easeOut" });
  }

  private ping(x: number, y: number): void {
    const s = this.add.image(x, y, this.tex.highlight).setScale(TEX_SCALE).setDepth(D_FX);
    this.tweens.add({
      targets: s,
      alpha: 0,
      scale: TEX_SCALE * 1.5,
      duration: 900,
      onComplete: () => s.destroy(),
    });
  }

  private float(text: string, x: number, y: number, color: number): void {
    const t = this.add
      .text(x, y - 24, text, {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "13px",
        color: hex(color),
        fontStyle: "bold",
      })
      .setOrigin(0.5, 1)
      .setDepth(D_FX)
      .setResolution(DPR);
    this.tweens.add({ targets: t, y: y - 70, duration: 1600, ease: "Sine.easeOut" });
    this.tweens.add({ targets: t, alpha: 0, delay: 900, duration: 700, onComplete: () => t.destroy() });
  }

  /** Point an agent's attention at a path: walk its unit to that building. */
  private setSite(agentId: string, path: string, historical: boolean): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    const pos = this.posForPath(path);
    rec.site = { x: pos.x, y: pos.y };
    rec.sitePath = path;
    rec.unit.walkTo(
      pos.x + (Math.random() - 0.5) * 30,
      pos.y + 18 + (Math.random() - 0.5) * 10,
      historical,
    );
    rec.nextMoveAt = this.time.now + 2200 + Math.random() * 1500;
    if (this.selected?.kind === "unit" && this.selected.id === agentId) this.refreshCard();
  }

  // --- event handling --------------------------------------------------------

  private dispatch(e: GameEvent, historical: boolean): void {
    if (e.type === "match_started") {
      this.buildWorld(e);
      return;
    }
    if (e.type === "theme_ready") {
      this.reskin(e.theme);
      return;
    }
    if (!this.map) return;

    switch (e.type) {
      case "agent_spawned": {
        const jitter = () => (Math.random() - 0.5) * 50;
        const unit = new Unit(
          this,
          e.role === "orchestrator" ? this.tex.king : this.tex.villager,
          e.name,
          this.citadel.x + jitter(),
          this.citadel.y + 26 + jitter() / 2,
          e.role === "orchestrator" ? "#f0c96a" : "#d8e4ec",
        );
        unit.root.setInteractive(
          new Phaser.Geom.Rectangle(-14, -30, 28, 48),
          Phaser.Geom.Rectangle.Contains,
        );
        unit.root.setData("kind", "unit");
        unit.root.setData("id", e.agentId);
        this.styleUnit(unit, e.role === "orchestrator" ? "hero" : "villager");
        this.agents.set(e.agentId, {
          unit,
          role: e.role,
          name: e.name,
          charge: e.charge ?? null,
          status: "idle",
          site: null,
          sitePath: null,
          nextMoveAt: this.time.now + 1000 + Math.random() * 3000,
        });
        if (!historical && e.charge) unit.say(e.charge);
        break;
      }
      case "agent_status": {
        const rec = this.agents.get(e.agentId);
        if (!rec) break;
        rec.status = e.status;
        if (IDLE_STATUSES.has(e.status)) rec.nextMoveAt = this.time.now + 600 + Math.random() * 1200;
        else if (rec.site) rec.unit.walkTo(rec.site.x + (Math.random() - 0.5) * 30, rec.site.y + 18, historical);
        if (this.selected?.kind === "unit" && this.selected.id === e.agentId) this.refreshCard();
        break;
      }
      case "agent_moved": {
        const pos = this.posForPath(e.path);
        this.setSite(e.agentId, e.path, historical);
        this.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS, historical);
        break;
      }
      case "file_read": {
        const pos = this.posForPath(e.path);
        this.reveal(pos.tx, pos.ty, 1, historical);
        if (!historical) this.ping(pos.x, pos.y);
        this.setSite(e.agentId, e.path, historical);
        break;
      }
      case "list_dir": {
        const pos = this.posForPath(e.path);
        this.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS + 1, historical);
        this.setSite(e.agentId, e.path, historical);
        break;
      }
      case "search": {
        for (const path of e.paths.slice(0, 10)) {
          const pos = this.posForPath(path);
          this.reveal(pos.tx, pos.ty, 1, historical);
          if (!historical) this.ping(pos.x, pos.y);
        }
        const first = e.paths[0];
        if (first) this.setSite(e.agentId, first, historical);
        break;
      }
      case "file_write": {
        const pos = this.posForPath(e.path);
        this.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS, historical);
        const rec = this.placeBuilding(e.path, e.buildingKind, pos.tx, pos.ty, historical);
        rec.writes++;
        rec.linesAdded += e.linesAdded;
        rec.linesRemoved += e.linesRemoved;
        if (!historical) this.float(`+${e.linesAdded}`, pos.x, pos.y, 0x9ecf7a);
        this.setSite(e.agentId, e.path, historical);
        if (this.selected?.kind === "building" && this.selected.path === e.path) this.refreshCard();
        break;
      }
      case "command_result": {
        if (e.kind !== "test") break;
        this.reconcileRaiders(e.failures ?? [], historical);
        if ((e.testsFailed ?? 0) === 0 && !historical) {
          this.float("⚑ tests green!", this.citadel.x, this.citadel.y - 40, 0x9ecf7a);
        }
        break;
      }
      case "message": {
        if (!historical) this.agents.get(e.fromId)?.unit.say(e.text);
        break;
      }
      case "compaction": {
        const rec = this.agents.get(e.agentId);
        if (rec) {
          rec.site = null;
          rec.sitePath = null;
          rec.unit.walkTo(this.citadel.x + 30, this.citadel.y + 30, historical);
          if (!historical) this.float("🍖", rec.unit.x, rec.unit.y, 0xc98d5a);
        }
        break;
      }
      case "tokens": {
        if (historical) break;
        const n = (this.tokenThrottle.get(e.agentId) ?? 0) + 1;
        this.tokenThrottle.set(e.agentId, n);
        const rec = this.agents.get(e.agentId);
        if (rec && n % 3 === 0) {
          this.float(`+${e.inputTokens + e.outputTokens}🪙`, rec.unit.x, rec.unit.y, 0xf0c96a);
        }
        break;
      }
      case "agent_done": {
        const rec = this.agents.get(e.agentId);
        if (rec) {
          rec.status = "done";
          rec.site = null;
          rec.sitePath = null;
          rec.unit.walkTo(
            this.citadel.x + (Math.random() - 0.5) * 70,
            this.citadel.y + 34,
            historical,
          );
          rec.unit.dimmed = true;
          if (this.selected?.kind === "unit" && this.selected.id === e.agentId) this.refreshCard();
        }
        break;
      }
      case "match_ended": {
        if (e.result === "victory") this.raiseWonder(historical);
        else this.stageDefeat();
        break;
      }
    }
  }

  private makeRaider(x: number, y: number): Unit {
    const name = this.theme?.enemyName ? this.theme.enemyName.slice(0, 14) : "raider";
    const unit = new Unit(this, this.tex.raider, name, x, y, "#c0483c");
    this.styleUnit(unit, "raider");
    return unit;
  }

  private reconcileRaiders(failures: { name: string; path?: string }[], historical: boolean): void {
    const nextKeys = new Set(failures.map((f) => `${f.path ?? "?"}::${f.name}`));
    for (const [key, rec] of this.raiders) {
      if (!nextKeys.has(key)) {
        if (!historical) this.float("✕", rec.unit.x, rec.unit.y - 10, 0xd4a843);
        rec.unit.destroy();
        this.raiders.delete(key);
      }
    }
    for (const f of failures) {
      if (this.raiders.size >= MAX_RAIDERS) break;
      const key = `${f.path ?? "?"}::${f.name}`;
      if (this.raiders.has(key)) continue;
      const anchor = f.path
        ? this.posForPath(f.path)
        : { x: this.citadel.x, y: this.citadel.y, tx: this.citadel.tx, ty: this.citadel.ty };
      this.reveal(anchor.tx, anchor.ty, 1, historical);
      const unit = this.makeRaider(
        anchor.x + (Math.random() - 0.5) * 70,
        anchor.y + 20 + (Math.random() - 0.5) * 30,
      );
      this.raiders.set(key, {
        unit,
        cx: anchor.x,
        cy: anchor.y + 16,
        r: 16 + Math.random() * 16,
        angle: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 0.7,
      });
      if (!historical) this.float("⚔", anchor.x, anchor.y, 0xc0483c);
    }
  }

  /** A ThemePack arrived: re-skin the living world in place. */
  private reskin(theme: ThemePack): void {
    this.theme = theme;
    if (!this.map) return; // buildWorld will apply it
    this.retexture();

    this.applyGroundTextures();
    for (const [, fog] of this.fogTiles) {
      if (fog.active) fog.setTexture(this.tex.fog);
    }
    // WorldSpec props have their own densities/placements, so re-place rather
    // than retexture in place.
    this.placeProps();
    for (const [, rec] of this.buildings) {
      const texSet = this.tex.buildings[rec.kind] ?? this.tex.buildings.house!;
      if (rec.img.active) rec.img.setTexture(rec.constructUntil > 0 ? texSet.scaffold : texSet.built);
    }
    for (const [, rec] of this.agents) {
      rec.unit.setTexture(rec.role === "orchestrator" ? this.tex.king : this.tex.villager);
      this.styleUnit(rec.unit, rec.role === "orchestrator" ? "hero" : "villager");
    }
    for (const [, rec] of this.raiders) {
      rec.unit.setTexture(this.tex.raider);
      this.styleUnit(rec.unit, "raider");
    }
    for (const label of this.regionLabels) label.setColor(hex(this.accent));
    this.refreshCard();
  }

  private raiseWonder(historical: boolean): void {
    // The Beacon rises beside the Citadel.
    const tx = this.citadel.tx + 3;
    const ty = this.citadel.ty + 3;
    const wonder = this.add
      .image(isoX(tx, ty), isoY(tx, ty) + TILE_H / 4, this.tex.wonder)
      .setOrigin(0.5, 1)
      .setScale(TEX_SCALE);
    wonder.setDepth(wonder.y);
    this.wonderImg = wonder;
    this.reveal(tx, ty, 4, historical);
    for (const [, rec] of this.raiders) rec.unit.destroy();
    this.raiders.clear();
    if (!historical) {
      this.stopFollowing();
      this.cameras.main.pan(wonder.x, wonder.y - 40, 900, "Sine.easeInOut");
      this.time.addEvent({
        delay: 120,
        repeat: 25,
        callback: () => {
          if (!wonder.active) return;
          this.float(
            "✦",
            wonder.x + (Math.random() - 0.5) * 160,
            wonder.y - Math.random() * 120,
            this.accent,
          );
        },
      });
    }
  }

  private stageDefeat(): void {
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const unit = this.makeRaider(
        this.citadel.x + Math.cos(angle) * 80,
        this.citadel.y + 24 + Math.sin(angle) * 40,
      );
      this.raiders.set(`victory-lap-${i}`, {
        unit,
        cx: this.citadel.x,
        cy: this.citadel.y + 24,
        r: 80,
        angle,
        speed: 0.35,
      });
    }
  }

  // --- frame tick --------------------------------------------------------------

  override update(time: number, delta: number): void {
    if (!this.ready) return;
    const dt = Math.min(100, delta);
    const now = this.time.now;

    // agents: bob/bubbles + continuous life
    for (const rec of this.agents.values()) {
      rec.unit.tick(dt, now);
      if (rec.unit.isWalking || now < rec.nextMoveAt) continue;
      if (IDLE_STATUSES.has(rec.status) || !rec.site) {
        // idle-wander near the citadel
        const a = Math.random() * Math.PI * 2;
        const d = 30 + Math.random() * 80;
        rec.unit.walkTo(
          this.citadel.x + Math.cos(a) * d,
          this.citadel.y + 26 + Math.sin(a) * d * 0.5,
        );
        rec.nextMoveAt = now + 2600 + Math.random() * 4200;
      } else {
        // laboring: small moves around the worksite
        rec.unit.walkTo(
          rec.site.x + (Math.random() - 0.5) * 36,
          rec.site.y + 18 + (Math.random() - 0.5) * 14,
        );
        rec.nextMoveAt = now + 1800 + Math.random() * 2600;
      }
    }

    // raiders prowl in small orbits while their test fails
    for (const rec of this.raiders.values()) {
      rec.angle += (rec.speed * dt) / 1000;
      const nx = rec.cx + Math.cos(rec.angle) * rec.r;
      const ny = rec.cy + Math.sin(rec.angle) * rec.r * 0.5;
      rec.unit.sprite.setFlipX(nx < rec.unit.x);
      rec.unit.root.setPosition(nx, ny);
      rec.unit.tick(dt, now);
    }

    // construction completion
    for (const rec of this.buildings.values()) {
      if (rec.constructUntil > 0 && rec.constructUntil <= now) this.finishConstruction(rec);
    }

    // ambient weather
    const w = this.scale.width;
    const h = this.scale.height;
    const m = 48;
    for (const p of this.particles) {
      p.phase += (dt / 1000) * p.rate;
      p.img.x += ((p.vx + Math.sin(p.phase) * p.sway) * dt) / 1000;
      p.img.y += (p.vy * dt) / 1000;
      if (p.flicker) p.img.setAlpha(p.baseAlpha * (0.55 + 0.45 * Math.sin(p.phase * 5)));
      if (p.img.x > w + m) p.img.x = -m;
      if (p.img.x < -m) p.img.x = w + m;
      if (p.img.y > h + m) p.img.y = -m;
      if (p.img.y < -m) p.img.y = h + m;
    }

    // markers
    if (this.selected?.kind === "unit") {
      const rec = this.agents.get(this.selected.id);
      if (rec) this.selectMarker.setPosition(rec.unit.x, rec.unit.y + 2).setVisible(true);
    }
    if (this.hovered && (this.hovered as Phaser.GameObjects.GameObject).active) {
      const kind = this.hovered.getData("kind") as string | undefined;
      if (kind === "unit") {
        const obj = this.hovered as Phaser.GameObjects.Container;
        this.hoverMarker.setPosition(obj.x, obj.y + 2).setVisible(true);
      } else if (kind === "building") {
        const rec = this.buildings.get(this.hovered.getData("path") as string);
        if (rec) this.hoverMarker.setPosition(isoX(rec.tx, rec.ty), isoY(rec.tx, rec.ty)).setVisible(true);
      }
    } else {
      this.hoverMarker.setVisible(false);
      if (this.hovered) this.hovered = null;
    }
  }
}

function truncPath(path: string): string {
  return path.length > 42 ? "…" + path.slice(-40) : path;
}
