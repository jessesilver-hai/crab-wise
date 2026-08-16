import Phaser from "phaser";
import {
  buildingKindFor,
  type AgentStatus,
  type DistrictPatch,
  type GameEvent,
  type ThemePack,
  type WorldSpec,
} from "@agent-empires/protocol";
import type { Renderer } from "../match-view.js";
import {
  assignPlot,
  Hamlet,
  isoX,
  isoY,
  layoutHash,
  layoutMap,
  MapLayout,
  mulberry32,
  Quarter,
  quarterOf,
  Rect,
  SizeBucket,
  TILE_H,
  TILE_W,
} from "./map.js";
import {
  buildTerrain,
  fbm2,
  floraSpots,
  LIFT,
  paintTerrain,
  TerrainInfo,
  tintSplatTexture,
} from "./terrain.js";
import {
  fogTexture,
  hexColor,
  hookMarkerTexture,
  parchmentTexture,
  particleTextures,
  pruneGeneration,
  shade,
  silhouetteTexture,
  skyTexture,
  specSkyTexture,
  TEX_SCALE,
} from "./textures.js";
import { shortName, SpriteUnit, UnitAppearance } from "./sprites.js";
import {
  ActorKey,
  actorTexKey,
  queueAssets,
  RAIDER_ACTORS,
  registerAnims,
  registerCitizenAnims,
  registerFrames,
  SHEET,
  VILLAGERS,
} from "./atlas.js";
import { dressQuarter, Dressing, flagTexture } from "./districts.js";
import {
  ComposedBuilding,
  composeBuilding,
  composeHamlet,
  composeWonder,
  makeScaffold,
} from "./buildings.js";
import { Minimap, MiniDot } from "./minimap.js";
import { Archetype, ParticleKind, resolveArchetype } from "./archetypes.js";

const FOG_REVEAL_RADIUS = 2;
const CONSTRUCTION_MS = 1400;
const MAX_RAIDERS = 8;
const CARD_W = 264;
const ZOOM_LADDER = [0.35, 0.5, 0.75, 1, 1.5, 2] as const;

// Depth bands: everything lives directly on the scene, ordered by depth.
// World objects (buildings / units / flora) use their screen y.
const D_SKY = -200000;
const D_GROUND = -100000;
const D_TINT = D_GROUND + 200; // quarter tints / block bases (above all chunks)
const D_MARKER = -50000;
const D_FOG = 50000;
const D_LABEL = 60000;
const D_FX = 70000;
const D_PARTICLE = 80000;
const D_UI = 90000;

const DPR = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);

function hex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mix a color toward white so it works as a subtle multiply tint. */
import { visibleFloor } from "./palette";

function soften(color: number, keep = 0.35): number {
  const ch = (c: number) => Math.round(255 - (255 - c) * keep);
  return (ch((color >> 16) & 0xff) << 16) | (ch((color >> 8) & 0xff) << 8) | ch(color & 0xff);
}

/** The renderer handle: match-view's Renderer plus the in-world hooks. */
export type GameRendererHandle = Renderer & {
  setInspectHandler(cb: (path: string) => void): void;
  setSpeakHandler(cb: (agentId: string) => void): void;
  setOrderHandler(cb: (kind: "attend" | "hunt", target: string, agentId?: string) => void): void;
  /** Receives every Examine one-liner shown in-world (herald echo). */
  setExamineHandler(cb: (text: string) => void): void;
  /** Supplies Examine text; return undefined to fall back to built-in lines. */
  setExamineProvider(
    fn: (kind: "building" | "unit" | "raider" | "hook", id: string) => string | undefined,
  ): void;
  showXpDrop(agentId: string, skill: string, xp: number, color?: number): void;
  showLevelUp(agentId: string, skill: string, level: number): void;
  setSkillStats(agentId: string, stats: { total: number; top: [string, number][] }): void;
};

export function attachGameRenderer(mount: HTMLElement): GameRendererHandle {
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
    render: { antialias: false, pixelArt: true, roundPixels: true },
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
    setInspectHandler(cb) {
      scene.onInspect = cb;
    },
    setSpeakHandler(cb) {
      scene.onSpeak = cb;
    },
    setOrderHandler(cb) {
      scene.onOrder = cb;
    },
    setExamineHandler(cb) {
      scene.onExamine = cb;
    },
    setExamineProvider(fn) {
      scene.examineProvider = fn;
    },
    showXpDrop(agentId, skill, xp, color) {
      scene.showXpDrop(agentId, skill, xp, color);
    },
    showLevelUp(agentId, skill, level) {
      scene.showLevelUp(agentId, skill, level);
    },
    setSkillStats(agentId, stats) {
      scene.setSkillStats(agentId, stats);
    },
  };
}

// ---------------------------------------------------------------------------
// Scene records
// ---------------------------------------------------------------------------

const IDLE_STATUSES: ReadonlySet<AgentStatus> = new Set(["idle", "resting", "done"]);

type AgentRec = {
  unit: SpriteUnit;
  role: "orchestrator" | "worker";
  name: string;
  charge: string | null;
  status: AgentStatus;
  site: { x: number; y: number } | null;
  sitePath: string | null;
  nextMoveAt: number;
  /** Player-ordered move: suppress ambient wandering until this time. */
  holdUntil: number;
};

type BuildingRec = {
  root: Phaser.GameObjects.Container;
  composed: ComposedBuilding | null; // null while under first construction
  kind: string;
  bucket: SizeBucket;
  path: string;
  tx: number;
  ty: number;
  writes: number;
  linesAdded: number;
  linesRemoved: number;
  constructUntil: number; // 0 = fully built
  scaffold: Phaser.GameObjects.Image | null;
};

type RaiderRec = {
  unit: SpriteUnit;
  name: string;
  key: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  toB: boolean;
  nextAt: number;
  dying: boolean;
};

type FogRec = { img: Phaser.GameObjects.Image; cleared: boolean };

type PatchRec = {
  imgs: Phaser.GameObjects.GameObject[];
  tweens: Phaser.Tweens.Tween[];
  tiles: string[];
  texKeys: string[];
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
  angle?: number;
};

const PART_CFG: Record<ParticleKind | "rain", PartCfg> = {
  ash: { tex: "soft", add: false, scale: [0.35, 0.8], alpha: [0.2, 0.45], vx: [-8, 2], vy: [8, 20], sway: 8, flicker: false },
  embers: { tex: "soft", add: true, scale: [0.25, 0.6], alpha: [0.4, 0.85], vx: [-8, 8], vy: [-40, -14], sway: 10, flicker: true },
  mist: { tex: "mist", add: false, scale: [1.6, 3.6], alpha: [0.05, 0.1], vx: [5, 16], vy: [-2, 2], sway: 3, flicker: false },
  snow: { tex: "soft", add: false, scale: [0.25, 0.6], alpha: [0.35, 0.75], vx: [-6, 6], vy: [10, 28], sway: 14, flicker: false },
  spores: { tex: "soft", add: true, scale: [0.2, 0.5], alpha: [0.25, 0.55], vx: [-6, 6], vy: [-8, 6], sway: 12, flicker: true },
  dust: { tex: "streak", add: false, scale: [0.8, 1.8], alpha: [0.08, 0.22], vx: [50, 130], vy: [2, 12], sway: 4, flicker: false },
  rain: { tex: "streak", add: false, scale: [0.5, 1.0], alpha: [0.14, 0.32], vx: [-30, -14], vy: [230, 360], sway: 0, flicker: false, angle: 80 },
};

const KIND_NAMES: Record<string, string> = {
  house: "Dwelling",
  barracks: "Bastion",
  market: "Trade-Vault",
  monastery: "Sanctum",
  mill: "Engine-Granary",
  towncenter: "The Citadel",
};

const PROP_NAMES = [
  "Standing Stones",
  "Weathered Relics",
  "Old Wardens",
  "Forgotten Cairn",
  "Wind-Carved Remnant",
  "Silent Markers",
];
const PROP_LORE = [
  "Older than the first commit; nobody remembers who raised it.",
  "Locals swear it hums when the tests run green.",
  "A remnant of the world before the great refactor.",
  "Travelers leave offerings here before long migrations.",
  "Warm to the touch at night. No one knows why.",
  "Its inscriptions predate every README.",
];

type Selection =
  | { kind: "units"; ids: string[] }
  | { kind: "building"; path: string }
  | { kind: "hamlet"; dirPath: string }
  | { kind: "lore"; obj: Phaser.GameObjects.Image }
  | null;

type CardAction = { y: number; h: number; cb: () => void };

/** One row of the right-click context menu; cb === null means Cancel. */
type MenuEntry = { label: string; cb: (() => void) | null };

type CtxMenu = {
  root: Phaser.GameObjects.Container;
  hi: Phaser.GameObjects.Graphics;
  texts: Phaser.GameObjects.Text[];
  entries: MenuEntry[];
  x: number;
  y: number;
  w: number;
  h: number;
  rowTop: number;
  rowH: number;
  hiIdx: number;
};

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
  private fxTex!: { soft: string; mist: string; streak: string };
  private fogTexKey = "";
  private skyEventTimer: Phaser.Time.TimerEvent | null = null;

  private map: MapLayout | null = null;
  private terrain: TerrainInfo | null = null;
  private groundImgs: Phaser.GameObjects.RenderTexture[] = [];
  private miniColors: Uint32Array | null = null;
  private floraImgs: Phaser.GameObjects.Image[] = [];
  private blockTintImgs: Phaser.GameObjects.Image[] = [];
  private dressings: Dressing[] = [];
  private citadel = { x: 0, y: 0, tx: 0, ty: 0 };
  private agents = new Map<string, AgentRec>();
  private buildings = new Map<string, BuildingRec>();
  private hamletObjs: { rec: Hamlet; root: Phaser.GameObjects.Container }[] = [];
  private hamletByPath = new Map<string, Hamlet>();
  private raiders = new Map<string, RaiderRec>();
  private fogTiles = new Map<string, FogRec>();
  private props: { img: Phaser.GameObjects.Image; tx: number; ty: number; pulse: Phaser.Tweens.Tween | null }[] = [];
  private patchRecs = new Map<string, PatchRec>();
  private regionLabels: Phaser.GameObjects.Text[] = [];
  private particles: Particle[] = [];
  private skyImg: Phaser.GameObjects.Image | null = null;
  private wonder: ComposedBuilding | null = null;
  private minimap: Minimap | null = null;
  private tokenThrottle = new Map<string, number>();
  private fogDirty = true;
  private nextFogRefresh = 0;

  // interactivity
  private selected: Selection = null;
  onInspect: ((path: string) => void) | null = null;
  onSpeak: ((agentId: string) => void) | null = null;
  onOrder: ((kind: "attend" | "hunt", target: string, agentId?: string) => void) | null = null;
  onExamine: ((text: string) => void) | null = null;
  examineProvider:
    | ((kind: "building" | "unit" | "raider" | "hook", id: string) => string | undefined)
    | null = null;
  private hovered: Phaser.GameObjects.GameObject | null = null;
  private hoverMarker!: Phaser.GameObjects.Image;
  private selectMarker!: Phaser.GameObjects.Image;
  private ringTexKey = "";
  private nameplate!: Phaser.GameObjects.Container;
  private nameplateBg!: Phaser.GameObjects.Graphics;
  private nameplateText!: Phaser.GameObjects.Text;
  private card!: Phaser.GameObjects.Container;
  private cardBg!: Phaser.GameObjects.Graphics;
  private cardTitle!: Phaser.GameObjects.Text;
  private cardBody!: Phaser.GameObjects.Text;
  private cardActionTexts: Phaser.GameObjects.Text[] = [];
  private cardActions: CardAction[] = [];
  private cardRows: { y: number; h: number; id: string }[] = [];
  private cardPortraits: Phaser.GameObjects.Image[] = [];
  private cardH = 0;
  private cursorNow = "default";
  private lastClickAt = 0;
  private lastClickX = 0;
  private lastClickY = 0;
  // pointer gesture state
  private leftDown: { x: number; y: number } | null = null;
  private rightDown: { x: number; y: number } | null = null;
  private panning = false;
  private boxing = false;
  private mmDragging = false;
  private bandG!: Phaser.GameObjects.Graphics;

  // OSRS feel layer: hover action text, context menu, examine, xp drops
  private actionMain!: Phaser.GameObjects.Text;
  private actionSub!: Phaser.GameObjects.Text;
  private actionNow = "";
  private menu: CtxMenu | null = null;
  private suppressLeftUp = false;
  private examineToast: Phaser.GameObjects.Container | null = null;
  private xpNextAt = new Map<string, number>();
  private skillStats = new Map<string, { total: number; top: [string, number][] }>();

  constructor() {
    super("main");
  }

  enqueue(e: GameEvent, historical: boolean): void {
    if (this.ready) this.dispatch(e, historical);
    else this.pending.push([e, historical]);
  }

  preload(): void {
    queueAssets(this.load);
  }

  create(): void {
    registerFrames(this.textures);
    registerAnims(this.anims);
    registerCitizenAnims(this.anims);
    this.fxTex = particleTextures(this);
    parchmentTexture(this);
    this.accent = this.archetype.glow;
    this.ringTexKey = this.makeRingTexture();
    this.fogTexKey = fogTexture(this, this.archetype.fogColor, this.gen);

    this.hoverMarker = this.add
      .image(0, 0, this.ringTexKey)
      .setDepth(D_MARKER)
      .setAlpha(0.4)
      .setVisible(false);
    this.selectMarker = this.add
      .image(0, 0, this.ringTexKey)
      .setDepth(D_MARKER + 1)
      .setVisible(false);
    this.bandG = this.add.graphics().setScrollFactor(0).setDepth(D_UI + 2);

    this.buildNameplate();
    this.buildCard();
    this.buildActionText();
    this.setupInput();

    this.scale.on("resize", () => {
      this.sizeSky();
      this.positionCard();
    });

    // debug/smoke handle (read-only introspection from headless tests)
    (globalThis as Record<string, unknown>).__aeScene = this;

    this.ready = true;
    for (const [e, h] of this.pending) this.dispatch(e, h);
    this.pending = [];
  }

  /** Selection/hover ring: a flat ellipse outline sized to a tile footprint. */
  private makeRingTexture(): string {
    const key = "ui-ring";
    if (this.textures.exists(key)) return key;
    const w = 44;
    const h = 22;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2 - 2, h / 2 - 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2 - 2, h / 2 - 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    this.textures.addCanvas(key, canvas);
    return key;
  }

  // --- camera + input ---------------------------------------------------------

  private setupInput(): void {
    const cam = this.cameras.main;
    this.input.mouse?.disableContextMenu();
    let panLastX = 0;
    let panLastY = 0;

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      panLastX = p.x;
      panLastY = p.y;
      if (this.menu) {
        const m = this.menu;
        if (p.leftButtonDown()) {
          // clicks while the menu is open never reach the world beneath it
          this.suppressLeftUp = true;
          const inside = p.x >= m.x && p.x <= m.x + m.w && p.y >= m.y && p.y <= m.y + m.h;
          let entry: MenuEntry | undefined;
          if (inside && p.y - m.y >= m.rowTop) {
            entry = m.entries[Math.floor((p.y - m.y - m.rowTop) / m.rowH)];
          }
          this.closeMenu();
          entry?.cb?.();
          return;
        }
        this.closeMenu();
      }
      if (p.rightButtonDown()) {
        this.rightDown = { x: p.x, y: p.y };
        this.panning = false;
        return;
      }
      if (p.middleButtonDown()) {
        this.panning = true;
        return;
      }
      // left
      const mm = this.minimap?.hit(p.x, p.y);
      if (mm) {
        this.mmDragging = true;
        this.minimap!.jump(cam, mm.x, mm.y);
        return;
      }
      this.leftDown = { x: p.x, y: p.y };
      this.boxing = false;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      const dx = p.x - panLastX;
      const dy = p.y - panLastY;
      panLastX = p.x;
      panLastY = p.y;
      if (this.mmDragging) {
        const mm = this.minimap?.hit(p.x, p.y);
        if (mm) this.minimap!.jump(cam, mm.x, mm.y);
        return;
      }
      if (this.rightDown) {
        if (this.panning || Math.hypot(p.x - this.rightDown.x, p.y - this.rightDown.y) > 6) {
          this.panning = true;
          cam.scrollX -= dx / cam.zoom;
          cam.scrollY -= dy / cam.zoom;
        }
        return;
      }
      if (p.middleButtonDown()) {
        cam.scrollX -= dx / cam.zoom;
        cam.scrollY -= dy / cam.zoom;
        return;
      }
      if (this.leftDown) {
        if (this.boxing || Math.hypot(p.x - this.leftDown.x, p.y - this.leftDown.y) > 6) {
          this.boxing = true;
          this.drawBand(this.leftDown.x, this.leftDown.y, p.x, p.y);
        }
      }
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (this.mmDragging && p.leftButtonReleased()) {
        this.mmDragging = false;
        return;
      }
      if (p.rightButtonReleased()) {
        const wasPan = this.panning;
        this.rightDown = null;
        this.panning = false;
        if (!wasPan) this.openMenu(p);
        return;
      }
      if (!p.leftButtonReleased()) return;
      if (this.suppressLeftUp) {
        this.suppressLeftUp = false;
        this.leftDown = null;
        this.boxing = false;
        this.bandG.clear();
        return;
      }
      const down = this.leftDown;
      this.leftDown = null;
      if (this.boxing) {
        this.boxing = false;
        this.bandG.clear();
        if (down) this.finishBoxSelect(down.x, down.y, p.x, p.y);
        return;
      }
      this.handleLeftClick(p);
    });

    this.input.on(
      "gameobjectover",
      (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => this.setHovered(obj),
    );
    this.input.on(
      "gameobjectout",
      (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
        if (this.hovered === obj) this.setHovered(null);
      },
    );

    this.input.keyboard?.on("keydown-M", () => {
      this.minimap?.setShown(!this.minimap.shown);
    });

    this.game.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.events.once("destroy", () => {
      this.game.canvas?.removeEventListener("wheel", this.onWheel);
      delete (globalThis as Record<string, unknown>).__aeScene;
    });
  }

  /** Wheel zoom stepping the fixed ladder, anchored at the cursor. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const cam = this.cameras.main;
    let idx = 0;
    let bestD = Infinity;
    ZOOM_LADDER.forEach((z, i) => {
      const d = Math.abs(cam.zoom - z);
      if (d < bestD) {
        bestD = d;
        idx = i;
      }
    });
    idx = Phaser.Math.Clamp(idx + (e.deltaY < 0 ? 1 : -1), 0, ZOOM_LADDER.length - 1);
    const next = ZOOM_LADDER[idx]!;
    if (next === cam.zoom) return;
    const rect = this.game.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const wx = cam.scrollX + cam.width / 2 + (px - cam.width / 2) / cam.zoom;
    const wy = cam.scrollY + cam.height / 2 + (py - cam.height / 2) / cam.zoom;
    cam.setZoom(next);
    cam.scrollX = wx - cam.width / 2 - (px - cam.width / 2) / next;
    cam.scrollY = wy - cam.height / 2 - (py - cam.height / 2) / next;
  };

  private recenter(): void {
    this.cameras.main.pan(this.citadel.x, this.citadel.y, 600, "Sine.easeInOut");
  }

  private fitCamera(): void {
    const map = this.map;
    if (!map) return;
    const c = map.cityRect;
    const left = isoX(c.x, c.y + c.h - 1) - TILE_W;
    const right = isoX(c.x + c.w - 1, c.y) + TILE_W;
    const top = isoY(c.x, c.y) - LIFT - 3 * TILE_H;
    const bottom = isoY(c.x + c.w - 1, c.y + c.h - 1) + 2 * TILE_H;
    const vw = this.scale.width || 800;
    const vh = this.scale.height || 600;
    const zoom = Phaser.Math.Clamp(
      Math.min(vw / (right - left + 60), vh / (bottom - top + 80)),
      0.35,
      2,
    );
    const cam = this.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn((left + right) / 2, (top + bottom) / 2);
  }

  private setCursor(want: string): void {
    if (this.cursorNow !== want) {
      this.cursorNow = want;
      this.input.setDefaultCursor(want);
    }
  }

  // --- RTS verbs ---------------------------------------------------------------

  private drawBand(x0: number, y0: number, x1: number, y1: number): void {
    const g = this.bandG;
    g.clear();
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    g.fillStyle(this.accent, 0.08);
    g.fillRect(x, y, w, h);
    g.lineStyle(1, this.accent, 0.9);
    g.strokeRect(x, y, w, h);
  }

  private finishBoxSelect(x0: number, y0: number, x1: number, y1: number): void {
    const cam = this.cameras.main;
    const a = cam.getWorldPoint(Math.min(x0, x1), Math.min(y0, y1));
    const b = cam.getWorldPoint(Math.max(x0, x1), Math.max(y0, y1));
    const ids: string[] = [];
    for (const [id, rec] of this.agents) {
      const u = rec.unit;
      if (u.x >= a.x && u.x <= b.x && u.y >= a.y - 24 && u.y <= b.y + 8) ids.push(id);
    }
    if (ids.length > 0) this.selectUnits(ids);
    else this.clearSelection();
  }

  private selectUnits(ids: string[]): void {
    this.applySelectionRings(false);
    this.selected = { kind: "units", ids };
    this.applySelectionRings(true);
    this.selectMarker.setVisible(false);
    this.refreshCard();
  }

  private applySelectionRings(on: boolean): void {
    if (this.selected?.kind !== "units") return;
    for (const id of this.selected.ids) {
      const rec = this.agents.get(id);
      if (rec) rec.unit.setSelected(on);
    }
  }

  private firstSelectedAgent(): string | undefined {
    return this.selected?.kind === "units" ? this.selected.ids[0] : undefined;
  }

  private selectedAgentRecs(): AgentRec[] {
    if (this.selected?.kind !== "units") return [];
    return this.selected.ids
      .map((id) => this.agents.get(id))
      .filter((r): r is AgentRec => r !== undefined);
  }

  /** Post a hunt on a raider (context-menu "Slay"). */
  private orderHunt(key: string, agentId?: string): void {
    const rrec = this.raiders.get(key);
    const name = rrec?.name ?? key;
    this.onOrder?.("hunt", name, agentId);
    if (rrec) {
      this.convergeSelected(rrec.unit.x, rrec.unit.y + 14);
      this.waypointFlag(rrec.unit.x, rrec.unit.y + 8, 0xd05a48);
      this.float(`⚔ hunt: ${name.slice(0, 24)}`, rrec.unit.x, rrec.unit.y - 20, 0xd05a48);
    }
    console.info(`HUNT:${name}`);
  }

  /** Send a worker to a building (context-menu "Attend"). */
  private orderAttend(path: string, agentId?: string): void {
    if (path === "__towncenter__") return;
    this.onOrder?.("attend", path, agentId);
    const rec = this.buildings.get(path);
    if (rec) {
      const gx = isoX(rec.tx, rec.ty);
      const gy = this.groundYAt(rec.tx, rec.ty);
      this.convergeSelected(gx, gy + 18);
      this.waypointFlag(gx, gy + TILE_H / 4, this.accent);
      this.float("⚑ attend", gx, gy - 24, this.accent);
    }
    console.info(`ATTEND:${path}`);
  }

  /** Cosmetic move order for the current selection, world coords. */
  private walkHere(wx: number, wy: number): void {
    this.waypointFlag(wx, wy, this.accent);
    const recs = this.selectedAgentRecs();
    if (recs.length === 0) return;
    recs.forEach((rec, i) => {
      const ang = (i / recs.length) * Math.PI * 2;
      const rad = recs.length > 1 ? 14 + 6 * Math.sqrt(i) : 0;
      const tx = wx + Math.cos(ang) * rad;
      const ty = wy + Math.sin(ang) * rad * 0.5;
      const dist = Math.hypot(tx - rec.unit.x, ty - rec.unit.y);
      rec.unit.walkTo(tx, ty);
      rec.holdUntil = this.time.now + (dist / rec.unit.walkSpeed) * 1000 + 3200;
      rec.nextMoveAt = rec.holdUntil;
    });
  }

  // --- OSRS feel: action text + context menu + examine -----------------------

  /** Highest-priority interactive object under the pointer (issue-order order). */
  private pickTarget(p: Phaser.Input.Pointer): Phaser.GameObjects.GameObject | null {
    const hits = this.input.hitTestPointer(p).filter((o) => o.active);
    for (const k of ["unit", "raider", "building", "hamlet", "hook", "landmark", "prop"]) {
      const hit = hits.find((o) => o.getData("kind") === k);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Context-menu rows for a target. Row 0 is the default action (also shown
   * as the hover action text); the last row is always Cancel. (sx, sy) is the
   * screen point examine toasts anchor to; (wx, wy) the world point for walks.
   */
  private menuEntriesFor(
    target: Phaser.GameObjects.GameObject | null,
    wx: number,
    wy: number,
    sx: number,
    sy: number,
  ): MenuEntry[] {
    const entries: MenuEntry[] = [];
    const agentId = this.firstSelectedAgent();
    const kind = target?.getData("kind") as string | undefined;
    if (kind === "unit" && target) {
      const id = target.getData("id") as string;
      const rec = this.agents.get(id);
      const who = rec ? shortName(rec.name) : "the worker";
      const fallback = rec
        ? `${rec.name}. ${rec.role === "orchestrator" ? "Sovereign of the realm; gives the orders." : "A diligent worker of the realm."}`
        : "A worker of the realm.";
      entries.push({ label: `Talk-to ${who}`, cb: () => this.onSpeak?.(id) });
      entries.push({ label: "Examine", cb: () => this.examine("unit", id, fallback, sx, sy) });
    } else if (kind === "raider" && target) {
      const key = target.getData("key") as string;
      const name = ((target.getData("name") as string) ?? "the specter").slice(0, 26);
      entries.push({ label: `Slay ${name}`, cb: () => this.orderHunt(key, agentId) });
      entries.push({
        label: "Examine",
        cb: () =>
          this.examine("raider", name, "A failing test given form. Best slain quickly.", sx, sy),
      });
    } else if (kind === "building" && target) {
      const path = target.getData("path") as string;
      const rec = this.buildings.get(path);
      const citadel = path === "__towncenter__";
      if (!citadel) {
        const leaf = path.split("/").pop() ?? path;
        entries.push({
          label: `Attend house of ${leaf}`,
          cb: () => this.orderAttend(path, agentId),
        });
      }
      const lines = this.map?.weights.get(path) ?? Math.max(1, rec?.linesAdded ?? 1);
      const fallback = citadel
        ? "The Citadel. Seat of the sovereign and heart of the realm."
        : `A sturdy hall of the quarter. ${lines} lines strong.`;
      entries.push({
        label: citadel ? "Examine The Citadel" : "Examine",
        cb: () => this.examine("building", path, fallback, sx, sy),
      });
      if (rec) {
        const gx = isoX(rec.tx, rec.ty);
        const gy = this.groundYAt(rec.tx, rec.ty);
        entries.push({ label: "Walk here", cb: () => this.walkHere(gx, gy + 18) });
      }
    } else if (kind === "hook" && target) {
      const path = target.getData("path") as string;
      const label = ((target.getData("label") as string) ?? "the obelisk").slice(0, 30);
      const snippet = target.getData("snippet") as string | undefined;
      const fallback = snippet
        ? `An old obelisk etched: “${snippet}”`
        : "An old obelisk that poses a question.";
      entries.push({ label: `Read ${label}`, cb: () => this.onInspect?.(path) });
      entries.push({ label: "Examine", cb: () => this.examine("hook", path, fallback, sx, sy) });
    } else if (kind === "hamlet" && target) {
      const dir = (target.getData("dir") as string) || ".";
      const count = (target.getData("count") as number) ?? 0;
      const fallback = `${count} smaller works stand here, aggregated for scale.`;
      entries.push({
        label: `Examine ${dir}/ hamlet`,
        cb: () => this.examine(null, dir, fallback, sx, sy),
      });
      entries.push({ label: "Walk here", cb: () => this.walkHere(wx, wy) });
    } else if ((kind === "landmark" || kind === "prop") && target) {
      const name = ((target.getData("name") as string) ?? "Curiosity").slice(0, 30);
      const fallback = (target.getData("lore") as string) ?? "A curiosity of the realm.";
      entries.push({
        label: `Examine ${name}`,
        cb: () => this.examine(null, name, fallback, sx, sy),
      });
    } else {
      entries.push({ label: "Walk here", cb: () => this.walkHere(wx, wy) });
    }
    entries.push({ label: "Cancel", cb: null });
    return entries;
  }

  /** Right-click release (no pan): the OSRS "Choose Option" menu. */
  private openMenu(p: Phaser.Input.Pointer): void {
    this.closeMenu();
    if (!this.map || this.minimap?.hit(p.x, p.y)) return;
    const target = this.pickTarget(p);
    const w0 = this.cameras.main.getWorldPoint(p.x, p.y);
    const entries = this.menuEntriesFor(target, w0.x, w0.y, p.x, p.y);
    const rowH = 16;
    const headH = 18;
    const pad = 6;
    const root = this.add.container(0, 0).setScrollFactor(0).setDepth(D_UI + 6);
    const bg = this.add.graphics();
    const hi = this.add.graphics();
    root.add([bg, hi]);
    const head = this.add
      .text(pad + 2, 3, "Choose Option", {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "11px",
        color: "#c8a86b",
        fontStyle: "bold",
      })
      .setResolution(DPR);
    root.add(head);
    const rowTop = headH + pad / 2;
    const texts: Phaser.GameObjects.Text[] = [];
    let wMax = head.width;
    entries.forEach((e, i) => {
      const t = this.add
        .text(pad + 2, rowTop + i * rowH + 2, e.label, {
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: "11px",
          color: i === 0 && e.cb ? "#ffe9a8" : "#e4dcc4",
        })
        .setResolution(DPR);
      root.add(t);
      texts.push(t);
      wMax = Math.max(wMax, t.width);
    });
    const w = Math.max(120, Math.ceil(wMax) + pad * 2 + 6);
    const h = rowTop + entries.length * rowH + pad;
    const sw = this.scale.width || 800;
    const sh = this.scale.height || 600;
    const x = Phaser.Math.Clamp(Math.round(p.x - w / 2), 4, Math.max(4, sw - w - 4));
    const y = Phaser.Math.Clamp(Math.round(p.y - 6), 4, Math.max(4, sh - h - 4));
    root.setPosition(x, y);
    bg.fillStyle(0x171208, 0.96);
    bg.fillRect(0, 0, w, h);
    bg.fillStyle(0x2a1f0f, 1);
    bg.fillRect(1, 1, w - 2, headH - 2);
    bg.lineStyle(1, 0xc8a84b, 0.9);
    bg.strokeRect(0.5, 0.5, w - 1, h - 1);
    this.menu = { root, hi, texts, entries, x, y, w, h, rowTop, rowH, hiIdx: -1 };
  }

  private closeMenu(): void {
    this.menu?.root.destroy();
    this.menu = null;
  }

  /** Examine: parchment toast + optional herald echo via onExamine. */
  private examine(
    kind: "building" | "unit" | "raider" | "hook" | null,
    id: string,
    fallback: string,
    sx: number,
    sy: number,
  ): void {
    const text = (kind ? this.examineProvider?.(kind, id) : undefined) ?? fallback;
    this.showExamineToast(text, sx, sy);
    this.onExamine?.(text);
    console.info(`EXAMINE:${text}`);
  }

  private showExamineToast(text: string, sx: number, sy: number): void {
    this.examineToast?.destroy();
    const t = this.add
      .text(10, 8, text, {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "11px",
        color: "#3b2d17",
        wordWrap: { width: 220 },
        lineSpacing: 3,
      })
      .setResolution(DPR);
    const w = t.width + 20;
    const h = t.height + 16;
    const bg = this.add.graphics();
    bg.fillStyle(0xe8d9b0, 0.96);
    bg.fillRoundedRect(0, 0, w, h, 5);
    bg.lineStyle(1, 0x5a4527, 0.9);
    bg.strokeRoundedRect(0, 0, w, h, 5);
    const x = Phaser.Math.Clamp(sx + 10, 4, Math.max(4, (this.scale.width || 800) - w - 4));
    const y = Phaser.Math.Clamp(sy + 12, 4, Math.max(4, (this.scale.height || 600) - h - 4));
    const c = this.add.container(x, y, [bg, t]).setScrollFactor(0).setDepth(D_UI + 7).setAlpha(0);
    this.examineToast = c;
    this.tweens.add({ targets: c, alpha: 1, duration: 140 });
    this.tweens.add({
      targets: c,
      alpha: 0,
      delay: 2600,
      duration: 400,
      onComplete: () => {
        if (this.examineToast === c) this.examineToast = null;
        c.destroy();
      },
    });
  }

  /** OSRS-style yellow action text pinned to the canvas top-left. */
  private buildActionText(): void {
    this.actionMain = this.add
      .text(10, 8, "", {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "12px",
        color: "#ffe93b",
        fontStyle: "bold",
      })
      .setResolution(DPR)
      .setScrollFactor(0)
      .setDepth(D_UI + 3)
      .setShadow(1, 1, "#000000", 2, true, true)
      .setVisible(false);
    this.actionSub = this.add
      .text(10, 8, "", {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "12px",
        color: "#a89f8c",
      })
      .setResolution(DPR)
      .setScrollFactor(0)
      .setDepth(D_UI + 3)
      .setShadow(1, 1, "#000000", 2, true, true)
      .setVisible(false);
  }

  private updateActionText(pointer: Phaser.Input.Pointer): void {
    let main = "";
    let sub = "";
    const overCard =
      this.card.visible &&
      pointer.x >= this.card.x &&
      pointer.x <= this.card.x + CARD_W &&
      pointer.y >= this.card.y &&
      pointer.y <= this.card.y + this.cardH;
    const overMini = !!this.minimap?.hit(pointer.x, pointer.y);
    if (this.map && !this.menu && !overCard && !overMini) {
      const target = this.hovered && this.hovered.active ? this.hovered : null;
      const entries = this.menuEntriesFor(target, 0, 0, pointer.x, pointer.y);
      const first = entries[0];
      if (first?.cb) {
        main = first.label;
        const more = entries.length - 2; // minus the default row and Cancel
        if (more > 0) sub = ` / ${more} more option${more === 1 ? "" : "s"}`;
      }
    }
    const key = `${main}|${sub}`;
    if (key === this.actionNow) return;
    this.actionNow = key;
    if (!main) {
      this.actionMain.setVisible(false);
      this.actionSub.setVisible(false);
      return;
    }
    this.actionMain.setText(main).setVisible(true);
    this.actionSub.setText(sub).setVisible(sub.length > 0);
    this.actionSub.setX(10 + this.actionMain.width + 2);
  }

  // --- OSRS feel: xp drops, level-ups, skill stats ---------------------------

  private xpDiamondTex(): string {
    const key = "ui-xpdiamond";
    if (this.textures.exists(key)) return key;
    const c = document.createElement("canvas");
    c.width = 12;
    c.height = 12;
    const ctx = c.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(6, 0.8);
    ctx.lineTo(11.2, 6);
    ctx.lineTo(6, 11.2);
    ctx.lineTo(0.8, 6);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    this.textures.addCanvas(key, c);
    return key;
  }

  /** Floating "+40 Forgecraft" drop; multiple drops per agent queue up. */
  showXpDrop(agentId: string, skill: string, xp: number, color = 0x62c9e8): void {
    if (!this.ready || !this.agents.has(agentId)) return;
    const now = this.time.now;
    const start = Math.max(now, this.xpNextAt.get(agentId) ?? 0);
    this.xpNextAt.set(agentId, start + 300);
    const spawn = () => {
      const rec = this.agents.get(agentId);
      if (!rec) return;
      const icon = this.add.image(0, 0, this.xpDiamondTex()).setTint(color);
      const label = this.add
        .text(0, 0, `+${xp} ${skill}`, {
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: "12px",
          color: "#f8f4e6",
          fontStyle: "bold",
        })
        .setOrigin(0, 0.5)
        .setResolution(DPR)
        .setShadow(1, 1, "#000000", 2, true, true);
      const total = 15 + label.width;
      icon.setX(-total / 2 + 6);
      label.setX(icon.x + 9);
      const c = this.add.container(rec.unit.x, rec.unit.y - 36, [icon, label]).setDepth(D_FX + 4);
      this.tweens.add({ targets: c, y: c.y - 40, duration: 1200, ease: "Sine.easeOut" });
      this.tweens.add({
        targets: c,
        alpha: 0,
        delay: 550,
        duration: 650,
        onComplete: () => c.destroy(),
      });
    };
    if (start <= now) spawn();
    else this.time.delayedCall(start - now, spawn);
  }

  /** Firework burst + gold banner above the unit. */
  showLevelUp(agentId: string, skill: string, level: number): void {
    if (!this.ready) return;
    const rec = this.agents.get(agentId);
    if (!rec) return;
    const x = rec.unit.x;
    const y = rec.unit.y - 30;
    const tints = [0xffd75e, 0xfff2c8, this.accent, 0xffb347];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + Math.random() * 0.3;
      const d = 26 + Math.random() * 30;
      const img = this.add
        .image(x, y, this.fxTex.soft)
        .setTint(tints[i % tints.length]!)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(D_FX + 5)
        .setScale(0.4 + Math.random() * 0.5);
      this.tweens.add({
        targets: img,
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d * 0.7 + 8,
        alpha: 0,
        scale: 0.1,
        duration: 650 + Math.random() * 450,
        ease: "Cubic.easeOut",
        onComplete: () => img.destroy(),
      });
    }
    const banner = this.add
      .text(x, y - 14, `⚔ ${skill} Level ${level}!`, {
        fontFamily: "Cinzel, Georgia, serif",
        fontSize: "14px",
        color: "#ffd75e",
        fontStyle: "bold",
      })
      .setOrigin(0.5, 1)
      .setDepth(D_FX + 6)
      .setResolution(DPR)
      .setShadow(1, 1, "#000000", 3, true, true)
      .setScale(0.2);
    this.tweens.add({ targets: banner, scale: 1, duration: 260, ease: "Back.easeOut" });
    this.tweens.add({ targets: banner, y: y - 26, duration: 2000, ease: "Sine.easeOut" });
    this.tweens.add({
      targets: banner,
      alpha: 0,
      delay: 1550,
      duration: 450,
      onComplete: () => banner.destroy(),
    });
  }

  /** Store skill levels for the unit card's stat block. */
  setSkillStats(agentId: string, stats: { total: number; top: [string, number][] }): void {
    this.skillStats.set(agentId, stats);
    if (this.ready && this.selected?.kind === "units" && this.selected.ids.includes(agentId)) {
      this.refreshCard();
    }
  }

  private convergeSelected(x: number, y: number): void {
    const recs = this.selectedAgentRecs();
    recs.forEach((rec, i) => {
      const ang = (i / Math.max(1, recs.length)) * Math.PI * 2;
      const tx = x + Math.cos(ang) * 20;
      const ty = y + Math.sin(ang) * 10;
      const dist = Math.hypot(tx - rec.unit.x, ty - rec.unit.y);
      rec.unit.walkTo(tx, ty);
      rec.holdUntil = this.time.now + (dist / rec.unit.walkSpeed) * 1000 + 4000;
      rec.nextMoveAt = rec.holdUntil;
    });
  }

  /** Animated waypoint flag that plants, waves, and fades. */
  private waypointFlag(x: number, y: number, tint: number): void {
    const img = this.add
      .image(x, y, flagTexture(this))
      .setOrigin(0.5, 1)
      .setDepth(D_FX)
      .setTint(tint)
      .setScale(0.2);
    this.tweens.add({ targets: img, scaleX: 1, scaleY: 1, duration: 180, ease: "Back.easeOut" });
    this.tweens.add({
      targets: img,
      angle: { from: -4, to: 4 },
      duration: 240,
      yoyo: true,
      repeat: 3,
    });
    this.tweens.add({
      targets: img,
      alpha: 0,
      delay: 1400,
      duration: 420,
      onComplete: () => img.destroy(),
    });
  }

  private handleLeftClick(p: Phaser.Input.Pointer): void {
    // clicks landing on the info card go to its rows, never the world
    if (this.card.visible) {
      const lx = p.x - this.card.x;
      const ly = p.y - this.card.y;
      if (lx >= 0 && lx <= CARD_W && ly >= 0 && ly <= this.cardH) {
        for (const a of this.cardActions) {
          if (ly >= a.y && ly <= a.y + a.h) {
            a.cb();
            return;
          }
        }
        for (const r of this.cardRows) {
          if (ly >= r.y && ly <= r.y + r.h) {
            this.selectUnits([r.id]);
            return;
          }
        }
        return;
      }
    }
    const now = performance.now();
    const isDouble =
      now - this.lastClickAt < 350 && Math.hypot(p.x - this.lastClickX, p.y - this.lastClickY) < 24;
    this.lastClickAt = now;
    this.lastClickX = p.x;
    this.lastClickY = p.y;
    if (isDouble) {
      this.recenter();
      return;
    }
    const hits = this.input.hitTestPointer(p).filter((o) => o.active);
    const pri = ["unit", "raider", "building", "hamlet", "hook", "landmark", "prop"];
    let target: Phaser.GameObjects.GameObject | null = null;
    for (const k of pri) {
      target = hits.find((o) => o.getData("kind") === k) ?? null;
      if (target) break;
    }
    if (target) this.select(target);
    else this.clearSelection();
  }

  // --- hover: nameplates ---------------------------------------------------

  private buildNameplate(): void {
    this.nameplateBg = this.add.graphics();
    this.nameplateText = this.add
      .text(6, 3, "", {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "10px",
        color: "#efe6cd",
      })
      .setResolution(DPR);
    this.nameplate = this.add
      .container(0, 0, [this.nameplateBg, this.nameplateText])
      .setScrollFactor(0)
      .setDepth(D_UI + 1)
      .setVisible(false);
  }

  private setHovered(obj: Phaser.GameObjects.GameObject | null): void {
    if (this.hovered === obj) return;
    if (this.hovered && this.hovered.active) {
      const kind = this.hovered.getData("kind") as string | undefined;
      if (kind === "unit" || kind === "raider") {
        const rec =
          this.agents.get(this.hovered.getData("id") as string) ??
          this.raiders.get(this.hovered.getData("key") as string);
        if (rec) rec.unit.hovered = false;
      } else if (this.hovered instanceof Phaser.GameObjects.Image) {
        this.hovered.setScale(1);
      } else if (this.hovered instanceof Phaser.GameObjects.Container) {
        this.hovered.setScale(1);
      }
    }
    this.hovered = obj;
    if (!obj) {
      this.nameplate.setVisible(false);
      return;
    }
    const kind = obj.getData("kind") as string | undefined;
    let label = "";
    if (kind === "unit") {
      const rec = this.agents.get(obj.getData("id") as string);
      if (rec) {
        label = `${rec.name} · ${rec.status}`;
        rec.unit.hovered = true;
      }
    } else if (kind === "raider") {
      const rec = this.raiders.get(obj.getData("key") as string);
      if (rec) {
        label = `${rec.name} · right-click for options`;
        rec.unit.hovered = true;
      }
    } else if (kind === "building") {
      const rec = this.buildings.get(obj.getData("path") as string);
      if (rec) {
        label = rec.path === "__towncenter__" ? "The Citadel" : rec.path;
        if (obj instanceof Phaser.GameObjects.Container) obj.setScale(1.04);
      }
    } else if (kind === "hamlet") {
      label = `${obj.getData("dir") as string} · ⌂ ×${obj.getData("count") as number}`;
      if (obj instanceof Phaser.GameObjects.Container) obj.setScale(1.04);
    } else {
      label = (obj.getData("name") as string | undefined) ?? (obj.getData("label") as string) ?? "";
      if (obj instanceof Phaser.GameObjects.Image) obj.setScale(1.06);
    }
    if (label) {
      this.nameplateText.setText(label.length > 52 ? "…" + label.slice(-50) : label);
      const w = this.nameplateText.width + 12;
      const h = this.nameplateText.height + 6;
      this.nameplateBg.clear();
      this.nameplateBg.fillStyle(0x120e08, 0.9);
      this.nameplateBg.fillRoundedRect(0, 0, w, h, 4);
      this.nameplateBg.lineStyle(1, this.accent, 0.7);
      this.nameplateBg.strokeRoundedRect(0, 0, w, h, 4);
      this.nameplate.setVisible(true);
    } else {
      this.nameplate.setVisible(false);
    }
  }

  // --- selection + panel ---------------------------------------------------

  private select(obj: Phaser.GameObjects.GameObject): void {
    const kind = obj.getData("kind") as string | undefined;
    if (kind === "unit") {
      const id = obj.getData("id") as string;
      const rec = this.agents.get(id);
      if (!rec) return;
      // second click on the sole-selected unit opens its worksite
      if (
        this.selected?.kind === "units" &&
        this.selected.ids.length === 1 &&
        this.selected.ids[0] === id &&
        rec.sitePath
      ) {
        this.onInspect?.(rec.sitePath);
        return;
      }
      this.selectUnits([id]);
      return;
    }
    this.applySelectionRings(false);
    if (kind === "raider") {
      // left-clicking a raider just shows its card via lore selection
      const key = obj.getData("key") as string;
      const rec = this.raiders.get(key);
      if (!rec) return;
      this.selected = { kind: "lore", obj: obj as Phaser.GameObjects.Image };
      this.selectMarker.setPosition(rec.unit.x, rec.unit.y + 2).setVisible(true);
    } else if (kind === "building") {
      const path = obj.getData("path") as string;
      const rec = this.buildings.get(path);
      if (!rec) return;
      if (
        this.selected?.kind === "building" &&
        this.selected.path === path &&
        path !== "__towncenter__"
      ) {
        this.onInspect?.(path);
        return;
      }
      this.selected = { kind: "building", path };
      this.selectMarker
        .setPosition(isoX(rec.tx, rec.ty), this.groundYAt(rec.tx, rec.ty))
        .setVisible(true);
    } else if (kind === "hamlet") {
      this.selected = { kind: "hamlet", dirPath: obj.getData("dir") as string };
      this.selectMarker
        .setPosition(obj.getData("mx") as number, obj.getData("my") as number)
        .setVisible(true);
    } else if (kind === "prop" || kind === "landmark" || kind === "hook") {
      const img = obj as Phaser.GameObjects.Image;
      if (
        kind === "hook" &&
        this.selected?.kind === "lore" &&
        this.selected.obj === img &&
        this.onInspect
      ) {
        this.onInspect(img.getData("path") as string);
        return;
      }
      this.selected = { kind: "lore", obj: img };
      this.selectMarker
        .setPosition(img.getData("mx") as number, img.getData("my") as number)
        .setVisible(true);
    } else {
      return;
    }
    this.refreshCard();
  }

  private clearSelection(): void {
    this.applySelectionRings(false);
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
    this.cardActionTexts = [0, 1].map(() =>
      this.add
        .text(12, 0, "", {
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: "11px",
          color: "#e8d9b0",
          fontStyle: "bold",
        })
        .setResolution(DPR)
        .setVisible(false),
    );
    this.card = this.add
      .container(0, 0, [this.cardBg, this.cardTitle, this.cardBody, ...this.cardActionTexts])
      .setScrollFactor(0)
      .setDepth(D_UI)
      .setVisible(false);
  }

  /** Small portrait of a unit for the selection panel. */
  private addPortrait(rec: AgentRec, x: number, y: number): Phaser.GameObjects.Image {
    let img: Phaser.GameObjects.Image;
    if (rec.unit.appearance.kind === "citizen") {
      img = this.add.image(x + 14, y + 36, SHEET.citizens, rec.unit.appearance.def.frontIdle);
      img.setOrigin(0.5, 1);
    } else {
      // Bellanger cell: crop the head/torso area of the S-facing stance frame
      img = this.add.image(x + 14, y + 18, actorTexKey(rec.unit.appearance.actor), 6 * 8);
      img.setOrigin(0.5, 0.5).setScale(0.5).setCrop(96, 66, 64, 72);
    }
    this.card.add(img);
    this.cardPortraits.push(img);
    return img;
  }

  private refreshCard(): void {
    for (const p of this.cardPortraits) p.destroy();
    this.cardPortraits = [];
    this.cardRows = [];
    if (!this.selected) {
      this.card.setVisible(false);
      return;
    }
    let title = "";
    const lines: string[] = [];
    const actions: { label: string; cb: () => void }[] = [];
    let rowsBottom = 0;

    if (this.selected.kind === "units") {
      const recs = this.selectedAgentRecs();
      if (recs.length === 0) return this.clearSelection();
      if (recs.length === 1) {
        const rec = recs[0]!;
        const id = this.selected.ids[0]!;
        title = rec.name;
        lines.push(rec.role === "orchestrator" ? "sovereign · orchestrator" : "worker");
        lines.push(`status: ${rec.status}`);
        if (rec.sitePath) lines.push(`at: ${truncPath(rec.sitePath)}`);
        if (rec.charge)
          lines.push(`charge: ${rec.charge.length > 120 ? rec.charge.slice(0, 120) + "…" : rec.charge}`);
        const st = this.skillStats.get(id);
        if (st) {
          lines.push(`⚜ Total level ${st.total}`);
          for (const [sk, lv] of st.top.slice(0, 3)) lines.push(`   ${sk} · ${lv}`);
        }
        if (rec.sitePath && this.onInspect) lines.push("⌕ click again to open its worksite");
        lines.push("↷ right-click for options");
        if (this.onSpeak) {
          actions.push({ label: `🗨 Speak with ${shortName(rec.name)}`, cb: () => this.onSpeak?.(id) });
        }
        this.addPortrait(rec, CARD_W - 44, 8);
      } else {
        title = `${recs.length} units selected`;
        rowsBottom = 30;
        this.selected.ids.slice(0, 6).forEach((id, i) => {
          const rec = this.agents.get(id);
          if (!rec) return;
          const rowY = 30 + i * 40;
          this.addPortrait(rec, 12, rowY - 4);
          const t = this.add
            .text(46, rowY + 4, `${shortName(rec.name)} · ${rec.status}`, {
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: "11px",
              color: "#d8d2c0",
            })
            .setResolution(DPR);
          this.card.add(t);
          this.cardPortraits.push(t as unknown as Phaser.GameObjects.Image);
          this.cardRows.push({ y: rowY - 4, h: 40, id });
          rowsBottom = rowY + 36;
        });
        if (this.selected.ids.length > 6) lines.push(`…and ${this.selected.ids.length - 6} more`);
      }
    } else if (this.selected.kind === "building") {
      const rec = this.buildings.get(this.selected.path);
      if (!rec) return this.clearSelection();
      const name =
        rec.path === "__towncenter__" ? "The Citadel" : rec.path.split("/").pop() ?? rec.path;
      title = name;
      lines.push(KIND_NAMES[rec.kind] ?? rec.kind);
      if (rec.path !== "__towncenter__") lines.push(truncPath(rec.path));
      const w = this.map?.weights.get(rec.path);
      if (w && w > 1) lines.push(`${w} lines of stone`);
      lines.push(`reinforced ×${rec.writes}`);
      lines.push(`+${rec.linesAdded} / −${rec.linesRemoved} lines`);
      if (rec.path !== "__towncenter__" && this.onInspect)
        lines.push("⌕ click again to inspect the code");
    } else if (this.selected.kind === "hamlet") {
      const dirPath = this.selected.dirPath;
      const hm = this.map?.hamlets.find((x) => x.dirPath === dirPath);
      if (!hm) return this.clearSelection();
      title = `${hm.dirPath || "."}/ hamlet`;
      lines.push(`⌂ ×${hm.count} smaller works stand here`);
      lines.push("each hut is a real file, aggregated for scale");
    } else {
      const obj = this.selected.obj;
      if (!obj.active) return this.clearSelection();
      const kind = obj.getData("kind") as string;
      if (kind === "hook") {
        const path = obj.getData("path") as string;
        title = (obj.getData("label") as string) ?? "Quest Hook";
        lines.push(`“${obj.getData("snippet") as string}”`);
        lines.push(truncPath(path));
        if (this.onInspect) {
          actions.push({ label: "⌕ view the source", cb: () => this.onInspect?.(path) });
        }
      } else if (kind === "raider") {
        title = (obj.getData("name") as string) ?? "Specter";
        lines.push("a failing test given form");
        lines.push("↷ right-click · Slay to post the hunt");
      } else {
        title = (obj.getData("name") as string) ?? "Curiosity";
        lines.push(kind === "landmark" ? "landmark" : "curiosity");
        lines.push((obj.getData("lore") as string) ?? "");
      }
    }

    this.cardTitle.setText(title);
    this.cardTitle.setColor(hex(this.accent));
    this.cardBody.setText(lines.join("\n"));
    this.cardBody.setY(Math.max(this.cardTitle.y + this.cardTitle.height + 6, rowsBottom));
    let bottom = this.cardBody.y + this.cardBody.height;
    this.cardActions = [];
    this.cardActionTexts.forEach((t, i) => {
      const a = actions[i];
      if (!a) {
        t.setVisible(false);
        return;
      }
      t.setText(a.label);
      t.setColor(hex(this.accent));
      t.setY(bottom + 8);
      t.setVisible(true);
      this.cardActions.push({ y: t.y - 3, h: t.height + 6, cb: a.cb });
      bottom = t.y + t.height;
    });
    const h = bottom + 12;
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

  // --- sky + ambient particles ------------------------------------------------

  private sizeSky(): void {
    this.skyImg?.setDisplaySize(this.scale.width, this.scale.height * 0.55);
  }

  private redrawSky(): void {
    const key = this.spec
      ? specSkyTexture(this, this.spec.sky, this.gen)
      : skyTexture(this, this.archetype.horizonColor, this.gen);
    if (this.skyImg) this.skyImg.setTexture(key);
    else {
      this.skyImg = this.add.image(0, 0, key).setOrigin(0, 0).setScrollFactor(0).setDepth(D_SKY);
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

  // --- world construction ------------------------------------------------------

  private groundYAt(tx: number, ty: number): number {
    return this.terrain ? this.terrain.groundY(tx, ty) : isoY(tx, ty);
  }

  private buildWorld(event: Extract<GameEvent, { type: "match_started" }>): void {
    this.mapSeed = event.mapSeed;
    const map = layoutMap(event.repoTree, event.mapSeed);
    this.map = map;
    const hash = layoutHash(map);
    const terrain = buildTerrain(map, event.mapSeed);
    this.terrain = terrain;

    const painted = paintTerrain(this, map, terrain, event.mapSeed, D_GROUND);
    this.groundImgs = painted.images;
    this.miniColors = painted.miniColors;
    this.cameras.main.setBackgroundColor(this.archetype.skyColor);
    this.redrawSky();
    this.initParticles();

    // deep-directory blocks share a subtle base tint (visual grouping)
    map.blocks.forEach((b, i) => {
      const tint = 0x9a8258 + ((hashStr(b.path) & 0x1f) << 8);
      const splat = tintSplatTexture(this, `blk-${i}`, terrain, b.rect, tint, 0.14);
      this.blockTintImgs.push(
        this.add.image(splat.x, splat.y, splat.key).setOrigin(0, 0).setDepth(D_TINT),
      );
    });

    // quarter walls + furniture
    const dressRng = mulberry32((event.mapSeed ^ 0x5eed) >>> 0);
    for (const q of map.quarters) {
      this.dressings.push(dressQuarter(this, map, terrain, q, this.accent, dressRng));
    }

    // wilderness flora
    for (const f of floraSpots(map, terrain, event.mapSeed)) {
      const img = this.add.image(f.x, f.y, SHEET.terrain, f.frame).setOrigin(0.5, 1);
      img.setDepth(img.y);
      this.floraImgs.push(img);
    }

    // quarter labels (depth 1-2)
    for (const q of map.quarters) {
      if (q.depth > 2 || q.rect.w * q.rect.h < 9) continue;
      const cx = q.rect.x + q.rect.w / 2;
      const cy = q.rect.y;
      const label = this.add
        .text(isoX(cx, cy), this.groundYAt(cx, cy) - 26, q.label, {
          fontFamily: "Cinzel, Georgia, serif",
          fontSize: q.depth === 1 ? "13px" : "11px",
          color: hex(this.theme ? this.accent : 0xc98f4a),
        })
        .setOrigin(0.5)
        .setAlpha(q.depth === 1 ? 0.8 : 0.55)
        .setDepth(D_LABEL)
        .setResolution(DPR);
      label.setLetterSpacing(2);
      this.regionLabels.push(label);
    }

    // The Citadel: the walled castle at the root plaza
    const tc = map.townCenter;
    this.citadel = { x: isoX(tc.tx, tc.ty), y: this.groundYAt(tc.tx, tc.ty), tx: tc.tx, ty: tc.ty };
    this.placeCitadel();

    // EVERY file stands as a building from the first frame (fog hides it)
    for (const [path, cell] of map.plots) {
      this.placeBuilding(path, buildingKindFor(path), cell.tx, cell.ty, true, false);
    }
    for (const hm of map.hamlets) {
      this.placeHamlet(hm);
      for (const p of hm.paths) this.hamletByPath.set(p, hm);
    }

    // fog of war blankets the city + a small skirt; wilderness stays visible
    const c = map.cityRect;
    for (let ty = c.y - 2; ty < c.y + c.h + 2; ty++) {
      for (let tx = c.x - 2; tx < c.x + c.w + 2; tx++) {
        if (tx < 0 || ty < 0 || tx >= map.side || ty >= map.side) continue;
        // A veil, not a void: the whole treemap city reads dimly from minute
        // one and exploration brightens it, AoE-style.
        const fog = this.add
          .image(isoX(tx, ty), this.groundYAt(tx, ty), this.fogTexKey)
          .setScale(TEX_SCALE)
          .setAlpha(0.55)
          .setDepth(D_FOG);
        this.fogTiles.set(`${tx},${ty}`, { img: fog, cleared: false });
      }
    }
    this.reveal(tc.tx, tc.ty, 4, true);

    // minimap: terrain underlay + treemap silhouette
    this.minimap?.destroy();
    this.minimap = new Minimap(this, map.side, painted.miniColors, D_UI + 4);
    this.minimap.setStructure(map.quarters);
    this.fogDirty = true;

    this.fitCamera();
    console.info(
      `[world] layout-hash=${hash} side=${map.side} quarters=${map.quarters.length} ` +
        `blocks=${map.blocks.length} buildings=${map.plots.size} hamlets=${map.hamlets.length}`,
    );
  }

  private placeCitadel(): void {
    const { tx, ty } = this.citadel;
    const img = this.add
      .image(this.citadel.x, this.citadel.y + TILE_H, SHEET.castle)
      .setOrigin(0.5, 0.94);
    img.setDepth(img.y);
    img.setInteractive(
      new Phaser.Geom.Rectangle(30, 30, 310, 290),
      Phaser.Geom.Rectangle.Contains,
    );
    img.setData("kind", "building");
    img.setData("path", "__towncenter__");
    const cont = this.add.container(this.citadel.x, this.citadel.y + TILE_H);
    cont.setVisible(false);
    const rec: BuildingRec = {
      root: cont,
      composed: null,
      kind: "towncenter",
      bucket: 2,
      path: "__towncenter__",
      tx,
      ty,
      writes: 0,
      linesAdded: 0,
      linesRemoved: 0,
      constructUntil: 0,
      scaffold: null,
    };
    this.buildings.set("__towncenter__", rec);
  }

  private archetypeAt(path: string): Quarter["archetype"] {
    if (!this.map) return "quarter";
    return quarterOf(this.map, path)?.archetype ?? "quarter";
  }

  private placeBuilding(
    path: string,
    kind: string,
    tx: number,
    ty: number,
    instant: boolean,
    isNew: boolean,
  ): BuildingRec {
    const existing = this.buildings.get(path);
    if (existing) {
      if (!instant) this.flashUpgrade(existing);
      return existing;
    }
    const bucket: SizeBucket = this.map?.buckets.get(path) ?? 1;
    const gx = isoX(tx, ty);
    const gy = this.groundYAt(tx, ty) + TILE_H / 4;
    const composed = composeBuilding(this, kind, this.archetypeAt(path), bucket, hashStr(path));
    composed.root.setPosition(gx, gy);
    composed.root.setDepth(gy);
    composed.root.setInteractive(composed.hit, Phaser.Geom.Rectangle.Contains);
    composed.root.setData("kind", "building");
    composed.root.setData("path", path);
    this.applyRoofTint(composed, kind);
    const rec: BuildingRec = {
      root: composed.root,
      composed,
      kind,
      bucket,
      path,
      tx,
      ty,
      writes: 0,
      linesAdded: 0,
      linesRemoved: 0,
      constructUntil: 0,
      scaffold: null,
    };
    this.buildings.set(path, rec);
    if (!instant && isNew) {
      // genuinely new file: scaffold first, pop on completion
      composed.root.setVisible(false);
      const scaffold = makeScaffold(this, hashStr(path));
      scaffold.setPosition(gx, gy).setDepth(gy).setAlpha(0.9);
      this.tweens.add({ targets: scaffold, alpha: 0.55, duration: 260, yoyo: true, repeat: -1 });
      rec.scaffold = scaffold;
      rec.constructUntil = this.time.now + CONSTRUCTION_MS;
    }
    return rec;
  }

  private finishConstruction(rec: BuildingRec): void {
    rec.constructUntil = 0;
    rec.scaffold?.destroy();
    rec.scaffold = null;
    rec.root.setVisible(true);
    rec.root.setScale(1.18);
    this.tweens.add({ targets: rec.root, scale: 1, duration: 320, ease: "Back.easeOut" });
  }

  /** Existing building reinforced: brief scaffold shimmer + white flash. */
  private flashUpgrade(rec: BuildingRec): void {
    if (!rec.composed) return;
    const gx = rec.root.x;
    const gy = rec.root.y;
    const rubble = makeScaffold(this, rec.writes + hashStr(rec.path));
    rubble.setPosition(gx, gy + 2).setDepth(gy + 1).setAlpha(0.8);
    this.tweens.add({
      targets: rubble,
      alpha: 0,
      delay: 420,
      duration: 260,
      onComplete: () => rubble.destroy(),
    });
    for (const part of rec.composed.parts) {
      if (part.role === "fx") continue;
      const obj = part.obj;
      // clearTint() later restores MULTIPLY mode, so FILL is safe to set here
      obj.setTint(0xfff2c8).setTintMode(Phaser.TintModes.FILL);
      this.time.delayedCall(140, () => {
        if (!obj.active) return;
        obj.clearTint();
      });
    }
    this.time.delayedCall(160, () => this.applyRoofTint(rec.composed!, rec.kind));
    rec.root.setScale(1.1);
    this.tweens.add({ targets: rec.root, scale: 1, duration: 260, ease: "Back.easeOut" });
  }

  private placeHamlet(hm: Hamlet): void {
    const gx = isoX(hm.tx, hm.ty);
    const gy = this.groundYAt(hm.tx, hm.ty) + TILE_H / 4;
    const composed = composeHamlet(this, hashStr(hm.dirPath));
    composed.root.setPosition(gx, gy);
    composed.root.setDepth(gy);
    composed.root.setInteractive(composed.hit, Phaser.Geom.Rectangle.Contains);
    composed.root.setData("kind", "hamlet");
    composed.root.setData("dir", hm.dirPath);
    composed.root.setData("count", hm.count);
    composed.root.setData("mx", gx);
    composed.root.setData("my", gy);
    const badge = this.add
      .text(0, -52, `⌂ ×${hm.count}`, {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "10px",
        color: "#efe6cd",
        backgroundColor: "rgba(18,14,8,0.7)",
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5, 1)
      .setResolution(DPR);
    composed.root.add(badge);
    this.hamletObjs.push({ rec: hm, root: composed.root });
  }

  /** Roof recolor from WorldSpec architecture / theme accent. */
  private applyRoofTint(composed: ComposedBuilding, kind: string): void {
    let roofColor: number | undefined;
    const arch = this.spec?.architecture as
      | Record<string, { roofColor?: string } | undefined>
      | undefined;
    const specRoof = arch?.[kind]?.roofColor;
    if (specRoof) roofColor = hexColor(specRoof);
    else if (this.theme) roofColor = soften(this.accent, 0.3);
    for (const part of composed.parts) {
      if (part.role !== "roof") continue;
      if (roofColor === undefined) part.obj.clearTint();
      else part.obj.setTint(roofColor);
    }
  }

  private ping(x: number, y: number): void {
    const s = this.add.image(x, y, this.ringTexKey).setDepth(D_FX).setTint(this.accent);
    this.tweens.add({
      targets: s,
      alpha: 0,
      scale: 1.6,
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

  // --- fog -----------------------------------------------------------------

  private reveal(tx: number, ty: number, radius: number, historical: boolean): void {
    for (let dy = -radius - 2; dy <= radius + 2; dy++) {
      for (let dx = -radius - 2; dx <= radius + 2; dx++) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist > radius + 2) continue;
        const key = `${tx + dx},${ty + dy}`;
        const rec = this.fogTiles.get(key);
        if (!rec) continue;
        if (dist <= radius) {
          this.fogTiles.delete(key);
          if (historical) rec.img.destroy();
          else {
            this.tweens.add({
              targets: rec.img,
              alpha: 0,
              duration: 350,
              onComplete: () => rec.img.destroy(),
            });
          }
        } else if (!rec.cleared && rec.img.alpha > 0.4) {
          // explored fringe: a lighter veil, soft edge into the dark
          rec.cleared = true;
          const target = 0.34;
          if (historical) rec.img.setAlpha(target);
          else this.tweens.add({ targets: rec.img, alpha: target, duration: 350 });
        }
      }
    }
    this.fogDirty = true;
  }

  private fogAlphaAt = (tx: number, ty: number): number => {
    const rec = this.fogTiles.get(`${tx},${ty}`);
    return rec ? rec.img.alpha : 0;
  };

  // --- positions -------------------------------------------------------------

  private posForPath(path: string): { x: number; y: number; tx: number; ty: number } {
    const map = this.map!;
    let cell = map.plots.get(path);
    if (!cell) {
      const hm = this.hamletByPath.get(path);
      if (hm) cell = { tx: hm.tx, ty: hm.ty };
    }
    if (!cell) {
      const q = map.quarters.find((r) => r.path === path);
      if (q) {
        cell = {
          tx: Math.floor(q.rect.x + q.rect.w / 2),
          ty: Math.floor(q.rect.y + q.rect.h / 2),
        };
      } else if (path === "." || path === "") {
        cell = map.townCenter;
      } else {
        cell = assignPlot(map, path);
      }
    }
    return { x: isoX(cell.tx, cell.ty), y: this.groundYAt(cell.tx, cell.ty), tx: cell.tx, ty: cell.ty };
  }

  /** Nearest free land tile to (tx,ty), claimed in map.used; null if crowded. */
  private claimTileNear(tx: number, ty: number): { tx: number; ty: number } | null {
    const map = this.map;
    if (!map) return null;
    for (let radius = 0; radius <= 6; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = tx + dx;
          const y = ty + dy;
          if (x < 1 || y < 1 || x >= map.side - 1 || y >= map.side - 1) continue;
          const key = `${x},${y}`;
          if (map.used.has(key) || map.roads.has(key)) continue;
          if (this.terrain?.isWater(x, y)) continue;
          map.used.add(key);
          return { tx: x, ty: y };
        }
      }
    }
    return null;
  }

  /** Apply WorldSpec unit tint + gait to a figure (clears both when absent). */
  private styleUnit(unit: SpriteUnit, kind: "villager" | "hero" | "raider"): void {
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
    if (this.selected?.kind === "units" && this.selected.ids.includes(agentId)) this.refreshCard();
  }

  // --- event handling ----------------------------------------------------------

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
        const jitter = () => (Math.random() - 0.5) * 60;
        const isKing = e.role === "orchestrator";
        const appearance: UnitAppearance = isKing
          ? { kind: "actor", actor: "magician" }
          : { kind: "citizen", def: VILLAGERS[hashStr(e.name) % VILLAGERS.length]! };
        const unit = new SpriteUnit(
          this,
          appearance,
          e.name,
          this.citadel.x + jitter(),
          this.citadel.y + TILE_H + 26 + jitter() / 2,
          isKing ? "#f0c96a" : "#d8e4ec",
          this.ringTexKey,
        );
        const hitH = isKing ? 96 : 46;
        unit.root.setInteractive(
          new Phaser.Geom.Rectangle(-20, -hitH, 40, hitH + 12),
          Phaser.Geom.Rectangle.Contains,
        );
        unit.root.setData("kind", "unit");
        unit.root.setData("id", e.agentId);
        this.styleUnit(unit, isKing ? "hero" : "villager");
        this.agents.set(e.agentId, {
          unit,
          role: e.role,
          name: e.name,
          charge: e.charge ?? null,
          status: "idle",
          site: null,
          sitePath: null,
          nextMoveAt: this.time.now + 1000 + Math.random() * 3000,
          holdUntil: 0,
        });
        if (!historical && e.charge) unit.say(e.charge);
        break;
      }
      case "agent_status": {
        const rec = this.agents.get(e.agentId);
        if (!rec) break;
        rec.status = e.status;
        rec.unit.setStatusGlyph(e.status);
        rec.unit.setLabor(e.status === "building");
        if (e.detail && !historical) rec.unit.showDetail(e.detail);
        if (IDLE_STATUSES.has(e.status)) rec.nextMoveAt = this.time.now + 600 + Math.random() * 1200;
        else if (rec.site)
          rec.unit.walkTo(rec.site.x + (Math.random() - 0.5) * 30, rec.site.y + 18, historical);
        if (this.selected?.kind === "units" && this.selected.ids.includes(e.agentId))
          this.refreshCard();
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
        const isNew = !this.map.plots.has(e.path) && !this.buildings.has(e.path);
        const pos = this.posForPath(e.path);
        this.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS, historical);
        const rec = this.placeBuilding(e.path, e.buildingKind, pos.tx, pos.ty, historical, isNew);
        rec.writes++;
        rec.linesAdded += e.linesAdded;
        rec.linesRemoved += e.linesRemoved;
        if (!historical) this.float(`+${e.linesAdded}`, pos.x, pos.y, 0x9ecf7a);
        this.setSite(e.agentId, e.path, historical);
        if (this.selected?.kind === "building" && this.selected.path === e.path) this.refreshCard();
        break;
      }
      case "command_run": {
        const rec = this.agents.get(e.agentId);
        if (rec && !historical) {
          rec.unit.showDetail(`⚙ ${e.command.length > 40 ? e.command.slice(0, 40) + "…" : e.command}`);
          if (e.kind === "test") rec.unit.setStatusGlyph("fighting");
        }
        break;
      }
      case "command_result": {
        if (e.kind !== "test") break;
        this.reconcileRaiders(e.failures ?? [], historical);
        if ((e.testsFailed ?? 0) === 0 && !historical) {
          this.float("⚑ tests green!", this.citadel.x, this.citadel.y - 60, 0x9ecf7a);
        }
        break;
      }
      case "message": {
        if (!historical) this.agents.get(e.fromId)?.unit.say(e.text);
        break;
      }
      case "scroll": {
        if (!historical) this.scrollFanfare(e.authorId);
        break;
      }
      case "dialogue": {
        // handled by the match view's dialogue panel; nothing in-world
        break;
      }
      case "theme_patch": {
        this.applyDistrictPatch(e.patch, historical);
        break;
      }
      case "compaction": {
        const rec = this.agents.get(e.agentId);
        if (rec) {
          rec.site = null;
          rec.sitePath = null;
          rec.unit.walkTo(this.citadel.x + 30, this.citadel.y + TILE_H + 30, historical);
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
          rec.unit.setStatusGlyph("done");
          rec.unit.setLabor(false);
          rec.site = null;
          rec.sitePath = null;
          rec.unit.walkTo(
            this.citadel.x + (Math.random() - 0.5) * 70,
            this.citadel.y + TILE_H + 34,
            historical,
          );
          rec.unit.dimmed = true;
          if (this.selected?.kind === "units" && this.selected.ids.includes(e.agentId))
            this.refreshCard();
        }
        break;
      }
      case "match_ended": {
        if (e.result === "victory") this.raiseWonder(historical);
        else this.stageDefeat();
        break;
      }
      default:
        break; // decree / session_status / context / log render in the sidebar
    }
  }

  // --- scroll fanfare ----------------------------------------------------------

  private scrollFanfare(authorId: string): void {
    const rec = this.agents.get(authorId);
    const x0 = rec ? rec.unit.x : this.citadel.x;
    const y0 = (rec ? rec.unit.y : this.citadel.y) - 26;
    const img = this.add.image(x0, y0, "fx-scroll").setDepth(D_FX).setScale(0.2).setAlpha(0.95);
    this.tweens.add({ targets: img, scale: TEX_SCALE * 1.8, duration: 240, ease: "Back.easeOut" });
    const cam = this.cameras.main;
    const tx = cam.scrollX + cam.width / 2 + (cam.width * 0.42) / cam.zoom;
    const ty = cam.scrollY + cam.height / 2 - (cam.height * 0.4) / cam.zoom;
    const cx = (x0 + tx) / 2;
    const cy = Math.min(y0, ty) - 120 / cam.zoom;
    const fx = { t: 0 };
    this.tweens.add({
      targets: fx,
      t: 1,
      delay: 300,
      duration: 1000,
      ease: "Sine.easeIn",
      onUpdate: () => {
        const t = fx.t;
        const mt = 1 - t;
        img.setPosition(
          mt * mt * x0 + 2 * mt * t * cx + t * t * tx,
          mt * mt * y0 + 2 * mt * t * cy + t * t * ty,
        );
        img.setAngle(t * 50);
        if (t > 0.7) img.setAlpha(0.95 * (1 - (t - 0.7) / 0.3));
      },
      onComplete: () => img.destroy(),
    });
  }

  // --- district patches ----------------------------------------------------

  private disposePatch(rec: PatchRec): void {
    for (const t of rec.tweens) t.destroy();
    for (const img of rec.imgs) {
      if (this.selected?.kind === "lore" && this.selected.obj === img) this.clearSelection();
      if (this.hovered === img) this.setHovered(null);
      img.destroy();
    }
    for (const key of rec.tiles) this.map?.used.delete(key);
    for (const key of rec.texKeys) {
      if (this.textures.exists(key)) this.textures.remove(key);
    }
  }

  /**
   * Additive, idempotent district reskin: ground tint clipped to the
   * quarter's treemap rect, a floated title, clickable landmarks, quest-hook
   * obelisks inside the quarter, and bounded local props. A second patch for
   * the same district replaces everything the first added.
   */
  private applyDistrictPatch(patch: DistrictPatch, historical: boolean): void {
    const map = this.map;
    const terrain = this.terrain;
    if (!map || !terrain) return;

    const prev = this.patchRecs.get(patch.district);
    if (prev) {
      this.disposePatch(prev);
      this.patchRecs.delete(patch.district);
    }
    const rec: PatchRec = { imgs: [], tweens: [], tiles: [], texKeys: [] };
    const hkey = `dp${hashStr(patch.district).toString(36)}`;
    const quarter = map.quarters.find((q) => q.path === patch.district);
    const rect: Rect = quarter?.rect ?? map.cityRect;
    const accent = hexColor(patch.accent ?? "") ?? this.accent;
    const rng = mulberry32(hashStr(patch.district) ^ this.mapSeed);

    const tint = hexColor(patch.groundTint);
    if (tint !== undefined) {
      const t = tintSplatTexture(this, `${hkey}-tint`, terrain, rect, tint, 0.3);
      rec.texKeys.push(t.key);
      const img = this.add.image(t.x, t.y, t.key).setOrigin(0, 0).setDepth(D_TINT + 1);
      if (historical) img.setAlpha(0.9);
      else {
        img.setAlpha(0);
        rec.tweens.push(this.tweens.add({ targets: img, alpha: 0.9, duration: 1400 }));
      }
      rec.imgs.push(img);
    }

    const cxT = rect.x + rect.w / 2;
    const cyT = rect.y + rect.h / 2;

    if (!historical) {
      const title = this.add
        .text(isoX(cxT, cyT), this.groundYAt(cxT, cyT) - 26, `${patch.name} — ${patch.epithet}`, {
          fontFamily: "Cinzel, Georgia, serif",
          fontSize: "16px",
          color: hex(accent),
          stroke: "#120e08",
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(D_LABEL + 1)
        .setAlpha(0)
        .setResolution(DPR);
      title.setLetterSpacing(2);
      this.tweens.add({ targets: title, alpha: 0.95, y: title.y - 8, duration: 900, ease: "Sine.easeOut" });
      this.tweens.add({
        targets: title,
        alpha: 0,
        delay: 3600,
        duration: 900,
        onComplete: () => title.destroy(),
      });
    }

    (patch.landmarks ?? []).forEach((lm, i) => {
      const key = silhouetteTexture(this, `${hkey}-lm${i}`, lm.silhouette, lm.glow);
      rec.texKeys.push(key);
      const cell = this.claimTileNear(
        Math.floor(cxT) + (i === 0 ? -1 : 2),
        Math.floor(cyT) + (i === 0 ? 1 : -1),
      );
      if (!cell) return;
      rec.tiles.push(`${cell.tx},${cell.ty}`);
      const gx = isoX(cell.tx, cell.ty);
      const gy = this.groundYAt(cell.tx, cell.ty);
      const img = this.add.image(gx, gy + TILE_H / 4, key).setOrigin(0.5, 1).setScale(TEX_SCALE);
      img.setDepth(img.y);
      img.setInteractive(
        new Phaser.Geom.Rectangle(-10, -10, img.width + 20, img.height + 20),
        Phaser.Geom.Rectangle.Contains,
      );
      img.setData("kind", "landmark");
      img.setData("name", lm.name);
      img.setData("lore", lm.lore);
      img.setData("mx", gx);
      img.setData("my", gy);
      if (lm.glow) {
        rec.tweens.push(
          this.tweens.add({
            targets: img,
            alpha: 0.7,
            duration: (lm.glow.pulseSec * 1000) / 2,
            yoyo: true,
            repeat: -1,
            ease: "Sine.easeInOut",
          }),
        );
      }
      if (!historical) {
        img.setScale(TEX_SCALE * 0.2);
        rec.tweens.push(
          this.tweens.add({ targets: img, scale: TEX_SCALE, duration: 500, ease: "Back.easeOut" }),
        );
      }
      rec.imgs.push(img);
    });

    if (patch.questHooks && patch.questHooks.length > 0) {
      const hookTex = hookMarkerTexture(this, `${hkey}-hook`, accent);
      rec.texKeys.push(hookTex);
      for (const hook of patch.questHooks) {
        const pos = this.posForPath(hook.path);
        const cell = this.claimTileNear(pos.tx, pos.ty) ?? { tx: pos.tx, ty: pos.ty };
        rec.tiles.push(`${cell.tx},${cell.ty}`);
        const gx = isoX(cell.tx, cell.ty);
        const gy = this.groundYAt(cell.tx, cell.ty);
        const img = this.add.image(gx, gy + TILE_H / 4, hookTex).setOrigin(0.5, 1).setScale(TEX_SCALE);
        img.setDepth(img.y);
        img.setInteractive(
          new Phaser.Geom.Rectangle(-12, -12, img.width + 24, img.height + 24),
          Phaser.Geom.Rectangle.Contains,
        );
        img.setData("kind", "hook");
        img.setData("label", hook.label);
        img.setData("snippet", hook.snippet);
        img.setData("path", hook.path);
        img.setData("mx", gx);
        img.setData("my", gy);
        rec.tweens.push(
          this.tweens.add({
            targets: img,
            alpha: 0.72,
            duration: 1600,
            yoyo: true,
            repeat: -1,
            ease: "Sine.easeInOut",
          }),
        );
        rec.imgs.push(img);
        this.reveal(cell.tx, cell.ty, 1, historical);
      }
    }

    // district-local extra props (bounded scatter inside the quarter)
    if (patch.props && patch.props.length > 0) {
      let placed = 0;
      patch.props.forEach((wp, i) => {
        const key = silhouetteTexture(this, `${hkey}-p${i}`, wp.silhouette, wp.glow);
        rec.texKeys.push(key);
        for (let ty = rect.y; ty < rect.y + rect.h && placed < 10; ty++) {
          for (let tx = rect.x; tx < rect.x + rect.w && placed < 10; tx++) {
            const tileKey = `${tx},${ty}`;
            if (map.used.has(tileKey) || map.roads.has(tileKey)) continue;
            if (this.terrain?.isWater(tx, ty)) continue;
            const mask = fbm2(tx * 0.3 + i * 11, ty * 0.3, this.mapSeed ^ 0x3d);
            if (rng() < wp.density * 0.22 * (mask > 0.45 ? 1.5 : 0.4)) {
              map.used.add(tileKey);
              rec.tiles.push(tileKey);
              const gx = isoX(tx, ty);
              const gy = this.groundYAt(tx, ty);
              const img = this.add
                .image(gx, gy + TILE_H / 4, key)
                .setOrigin(0.5, 1)
                .setScale(TEX_SCALE);
              img.setDepth(img.y);
              img.setInteractive(
                new Phaser.Geom.Rectangle(-10, -10, img.width + 20, img.height + 20),
                Phaser.Geom.Rectangle.Contains,
              );
              img.setData("kind", "prop");
              img.setData("name", `${patch.name} Curiosity`);
              img.setData("lore", `Placed by the Worldsmith when ${patch.name} resolved into itself.`);
              img.setData("mx", gx);
              img.setData("my", gy);
              if (wp.glow) {
                rec.tweens.push(
                  this.tweens.add({
                    targets: img,
                    alpha: 0.62,
                    duration: (wp.glow.pulseSec * 1000) / 2,
                    yoyo: true,
                    repeat: -1,
                    ease: "Sine.easeInOut",
                  }),
                );
              }
              rec.imgs.push(img);
              placed++;
            }
          }
        }
      });
    }

    this.patchRecs.set(patch.district, rec);
  }

  // --- raiders -------------------------------------------------------------

  private makeRaider(key: string, name: string, x: number, y: number): SpriteUnit {
    const actor: ActorKey = RAIDER_ACTORS[hashStr(key) % RAIDER_ACTORS.length]!;
    const displayName = this.theme?.enemyName ? this.theme.enemyName.slice(0, 14) : name.slice(0, 14);
    const unit = new SpriteUnit(
      this,
      { kind: "actor", actor },
      displayName,
      x,
      y,
      "#c0483c",
      this.ringTexKey,
    );
    unit.walkSpeed = 46;
    unit.root.setInteractive(
      new Phaser.Geom.Rectangle(-24, -92, 48, 104),
      Phaser.Geom.Rectangle.Contains,
    );
    unit.root.setData("kind", "raider");
    unit.root.setData("key", key);
    unit.root.setData("name", name);
    this.styleUnit(unit, "raider");
    return unit;
  }

  private reconcileRaiders(failures: { name: string; path?: string }[], historical: boolean): void {
    const nextKeys = new Set(failures.map((f) => `${f.path ?? "?"}::${f.name}`));
    for (const [key, rec] of this.raiders) {
      if (!nextKeys.has(key) && !rec.dying) {
        rec.dying = true;
        if (!historical) {
          this.float("✕ bounty cleared", rec.unit.x, rec.unit.y - 40, 0xd4a843);
          rec.unit.die(() => {
            rec.unit.destroy();
            this.raiders.delete(key);
          });
        } else {
          rec.unit.destroy();
          this.raiders.delete(key);
        }
      }
    }
    for (const f of failures) {
      if (this.raiders.size >= MAX_RAIDERS) break;
      const key = `${f.path ?? "?"}::${f.name}`;
      if (this.raiders.has(key)) continue;
      // the raider besieges the quarter holding the failing test's file
      let anchor: { x: number; y: number; tx: number; ty: number };
      const quarter = f.path && this.map ? quarterOf(this.map, f.path) : null;
      if (quarter) {
        const g = quarter.gate;
        anchor = { x: isoX(g.tx, g.ty), y: this.groundYAt(g.tx, g.ty), tx: g.tx, ty: g.ty };
      } else if (f.path) {
        anchor = this.posForPath(f.path);
      } else {
        anchor = { x: this.citadel.x, y: this.citadel.y, tx: this.citadel.tx, ty: this.citadel.ty };
      }
      this.reveal(anchor.tx, anchor.ty, 1, historical);
      const unit = this.makeRaider(
        key,
        f.name,
        anchor.x + (Math.random() - 0.5) * 60,
        anchor.y + 24 + (Math.random() - 0.5) * 20,
      );
      this.raiders.set(key, {
        unit,
        name: f.name,
        key,
        ax: anchor.x - 44,
        ay: anchor.y + 30,
        bx: anchor.x + 44,
        by: anchor.y + 14,
        toB: hashStr(key) % 2 === 0,
        nextAt: 0,
        dying: false,
      });
      if (!historical) this.float("⚔", anchor.x, anchor.y, 0xc0483c);
    }
  }

  // --- theme -----------------------------------------------------------------

  /** A ThemePack arrived: re-tint the living world in place (AoE civ style). */
  private reskin(theme: ThemePack): void {
    this.theme = theme;
    const oldGen = this.gen;
    this.gen++;
    this.archetype = resolveArchetype(theme.biome.archetype, this.mapSeed);
    this.spec = theme.worldSpec ?? null;
    const themeAccent = hexColor(theme.biome.accentColor);
    this.accent = visibleFloor(themeAccent ?? this.archetype.glow, 0x40);

    this.cameras.main.setBackgroundColor(
      this.spec
        ? visibleFloor(shade(hexColor(this.spec.sky.top) ?? this.archetype.skyColor, 0.35), 0x14)
        : this.archetype.skyColor,
    );
    this.redrawSky();
    this.initParticles();
    this.resetSkyEvents();

    // terrain palette → subtle multiply tint on the painted ground chunks
    let groundTint: number | undefined;
    if (this.spec) {
      const base = this.spec.terrain.base
        .map((c) => hexColor(c))
        .filter((c): c is number => c !== undefined);
      const mid = base[Math.floor(base.length / 2)];
      if (mid !== undefined) groundTint = soften(mid, 0.45);
    } else {
      const grass = theme.biome.grassColors
        .map((c) => hexColor(c))
        .filter((c): c is number => c !== undefined);
      const mid = grass[Math.floor(grass.length / 2)];
      if (mid !== undefined) groundTint = soften(mid, 0.35);
    }
    for (const img of this.groundImgs) {
      if (groundTint === undefined) img.clearTint();
      else img.setTint(groundTint);
    }
    for (const img of this.floraImgs) {
      if (groundTint === undefined) img.clearTint();
      else img.setTint(soften(groundTint, 0.6));
    }

    // fog color follows the theme (floored: unexplored land must stay readable)
    const fogColor = visibleFloor(hexColor(theme.biome.fogColor) ?? this.archetype.fogColor, 0x26);
    this.fogTexKey = fogTexture(this, fogColor, this.gen);
    for (const [, rec] of this.fogTiles) {
      if (rec.img.active) rec.img.setTexture(this.fogTexKey);
    }

    // roofs + banners take the faction color
    for (const [, rec] of this.buildings) {
      if (rec.composed) this.applyRoofTint(rec.composed, rec.kind);
    }
    for (const d of this.dressings) {
      for (const b of d.banners) if (b.active) b.setTint(this.accent);
    }
    for (const label of this.regionLabels) label.setColor(hex(this.accent));

    for (const [, rec] of this.agents) {
      this.styleUnit(rec.unit, rec.role === "orchestrator" ? "hero" : "villager");
    }
    for (const [, rec] of this.raiders) this.styleUnit(rec.unit, "raider");

    this.placeSpecProps();
    if (this.miniColors && this.map) {
      this.minimap?.rebake(this.miniColors, groundTint);
      this.minimap?.setStructure(this.map.quarters);
    }
    this.refreshCard();
    this.time.delayedCall(5000, () => pruneGeneration(this, oldGen));
  }

  /** WorldSpec curiosities scattered in the wilderness (never in the city). */
  private placeSpecProps(): void {
    const map = this.map;
    const terrain = this.terrain;
    for (const p of this.props) {
      p.pulse?.destroy();
      p.img.destroy();
      if (map) map.used.delete(`${p.tx},${p.ty}`);
    }
    this.props = [];
    const specProps = this.spec?.props;
    if (!map || !terrain || !specProps || specProps.length === 0) return;
    const rng = mulberry32((this.mapSeed ^ 0x51ed2701) >>> 0);
    let placed = 0;
    for (let ty = 1; ty < map.side - 1 && placed < 80; ty++) {
      for (let tx = 1; tx < map.side - 1 && placed < 80; tx++) {
        if (terrain.inCity(tx, ty)) continue;
        const key = `${tx},${ty}`;
        if (map.used.has(key) || terrain.isWater(tx, ty)) continue;
        const mask = fbm2(tx * 0.24, ty * 0.24, this.mapSeed ^ 0x6b);
        const cluster = mask > 0.55 ? 1.7 : mask > 0.4 ? 0.9 : 0.35;
        for (let i = 0; i < specProps.length; i++) {
          const sp = specProps[i]!;
          const edge = Math.min(tx, ty, map.side - 1 - tx, map.side - 1 - ty);
          const ok =
            sp.placement === "scatter" ||
            (sp.placement === "edges" && edge < 3) ||
            (sp.placement === "ridges" && (tx + ty) % 5 === 0) ||
            sp.placement === "districts"; // city is off-limits; treat as scatter
          if (!ok) continue;
          if (rng() < sp.density * 0.16 * cluster) {
            const texKey = silhouetteTexture(this, `g${this.gen}-sp${i}`, sp.silhouette, sp.glow);
            map.used.add(key);
            const jx = tx + (rng() - 0.5) * 0.5;
            const jy = ty + (rng() - 0.5) * 0.5;
            const gx = isoX(jx, jy);
            const gy = terrain.groundY(jx, jy);
            const img = this.add
              .image(gx, gy + TILE_H / 4, texKey)
              .setOrigin(0.5, 1)
              .setScale(TEX_SCALE);
            img.setDepth(img.y);
            const pick = hashStr(key);
            img.setInteractive(
              new Phaser.Geom.Rectangle(-10, -10, img.width + 20, img.height + 20),
              Phaser.Geom.Rectangle.Contains,
            );
            img.setData("kind", "prop");
            img.setData("name", PROP_NAMES[pick % PROP_NAMES.length]!);
            img.setData("lore", PROP_LORE[(pick >>> 3) % PROP_LORE.length]!);
            img.setData("mx", gx);
            img.setData("my", gy);
            let pulse: Phaser.Tweens.Tween | null = null;
            if (sp.glow) {
              pulse = this.tweens.add({
                targets: img,
                alpha: 0.62,
                duration: (sp.glow.pulseSec * 1000) / 2,
                yoyo: true,
                repeat: -1,
                ease: "Sine.easeInOut",
              });
            }
            this.props.push({ img, tx, ty, pulse });
            placed++;
            break;
          }
        }
      }
    }
  }

  // --- endgame -----------------------------------------------------------------

  private raiseWonder(historical: boolean): void {
    const cell = this.claimTileNear(this.citadel.tx + 3, this.citadel.ty + 3) ?? {
      tx: this.citadel.tx + 3,
      ty: this.citadel.ty + 3,
    };
    const gx = isoX(cell.tx, cell.ty);
    const gy = this.groundYAt(cell.tx, cell.ty) + TILE_H / 4;
    const wonder = composeWonder(this, flagTexture(this), this.accent);
    wonder.root.setPosition(gx, gy);
    wonder.root.setDepth(gy);
    this.wonder = wonder;
    this.reveal(cell.tx, cell.ty, 4, historical);
    for (const [, rec] of this.raiders) rec.unit.destroy();
    this.raiders.clear();
    if (!historical) {
      this.cameras.main.pan(gx, gy - 80, 900, "Sine.easeInOut");
      this.time.addEvent({
        delay: 120,
        repeat: 25,
        callback: () => {
          if (!wonder.root.active) return;
          this.float(
            "✦",
            gx + (Math.random() - 0.5) * 160,
            gy - Math.random() * 150,
            this.accent,
          );
        },
      });
    }
  }

  private stageDefeat(): void {
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const x = this.citadel.x + Math.cos(angle) * 110;
      const y = this.citadel.y + TILE_H + 24 + Math.sin(angle) * 55;
      const key = `victory-lap-${i}`;
      const unit = this.makeRaider(key, "the end", x, y);
      this.raiders.set(key, {
        unit,
        name: "the end",
        key,
        ax: this.citadel.x + Math.cos(angle + 0.5) * 110,
        ay: this.citadel.y + TILE_H + 24 + Math.sin(angle + 0.5) * 55,
        bx: this.citadel.x + Math.cos(angle - 0.5) * 110,
        by: this.citadel.y + TILE_H + 24 + Math.sin(angle - 0.5) * 55,
        toB: i % 2 === 0,
        nextAt: 0,
        dying: false,
      });
    }
  }

  // --- frame tick ----------------------------------------------------------------

  override update(_time: number, delta: number): void {
    if (!this.ready) return;
    const dt = Math.min(100, delta);
    const now = this.time.now;

    // agents: bubbles + ambient life
    for (const rec of this.agents.values()) {
      rec.unit.tick(dt, now);
      if (rec.unit.isWalking || now < rec.nextMoveAt || now < rec.holdUntil) continue;
      if (IDLE_STATUSES.has(rec.status) || !rec.site) {
        const a = Math.random() * Math.PI * 2;
        const d = 30 + Math.random() * 90;
        rec.unit.walkTo(
          this.citadel.x + Math.cos(a) * d,
          this.citadel.y + TILE_H + 26 + Math.sin(a) * d * 0.5,
        );
        rec.nextMoveAt = now + 2600 + Math.random() * 4200;
      } else {
        rec.unit.walkTo(
          rec.site.x + (Math.random() - 0.5) * 36,
          rec.site.y + 18 + (Math.random() - 0.5) * 14,
        );
        rec.nextMoveAt = now + 1800 + Math.random() * 2600;
      }
    }

    // raiders pace menacingly at their besieged quarter's gate
    for (const rec of this.raiders.values()) {
      rec.unit.tick(dt, now);
      if (rec.dying || rec.unit.isWalking || now < rec.nextAt) continue;
      rec.toB = !rec.toB;
      const tx = rec.toB ? rec.bx : rec.ax;
      const ty = rec.toB ? rec.by : rec.ay;
      rec.unit.walkTo(tx, ty);
      rec.nextAt = now + 600 + Math.random() * 900;
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
    this.selectMarker.setTint(this.accent);
    if (this.hovered && this.hovered.active) {
      const kind = this.hovered.getData("kind") as string | undefined;
      if (kind === "unit" || kind === "raider") {
        const obj = this.hovered as Phaser.GameObjects.Container;
        this.hoverMarker.setPosition(obj.x, obj.y + 2).setVisible(true);
      } else if (kind === "building") {
        const rec = this.buildings.get(this.hovered.getData("path") as string);
        if (rec) {
          this.hoverMarker
            .setPosition(isoX(rec.tx, rec.ty), this.groundYAt(rec.tx, rec.ty))
            .setVisible(true);
        }
      } else {
        this.hoverMarker
          .setPosition(this.hovered.getData("mx") as number, this.hovered.getData("my") as number)
          .setVisible(true);
      }
    } else {
      this.hoverMarker.setVisible(false);
      if (this.hovered) this.setHovered(null);
    }

    // nameplate + cursor
    const pointer = this.input.activePointer;
    if (this.nameplate.visible) {
      const nx = Math.min(pointer.x + 14, w - this.nameplateText.width - 26);
      const ny = Math.max(4, pointer.y - this.nameplateText.height - 16);
      this.nameplate.setPosition(nx, ny);
    }

    // context menu: row hover highlight
    if (this.menu) {
      const m = this.menu;
      const lx = pointer.x - m.x;
      const ly = pointer.y - m.y;
      let idx = -1;
      if (lx >= 0 && lx <= m.w && ly >= m.rowTop && ly <= m.h) {
        idx = Math.floor((ly - m.rowTop) / m.rowH);
        if (idx >= m.entries.length) idx = -1;
      }
      if (idx !== m.hiIdx) {
        m.hiIdx = idx;
        m.hi.clear();
        if (idx >= 0) {
          m.hi.fillStyle(0xc8a84b, 0.22);
          m.hi.fillRect(2, m.rowTop + idx * m.rowH, m.w - 4, m.rowH);
        }
      }
    }

    // OSRS hover action text
    this.updateActionText(pointer);
    let overAction = false;
    if (this.card.visible) {
      const lx = pointer.x - this.card.x;
      const ly = pointer.y - this.card.y;
      if (lx >= 0 && lx <= CARD_W && ly >= 0 && ly <= this.cardH) {
        for (const a of this.cardActions) {
          if (ly >= a.y && ly <= a.y + a.h) {
            overAction = true;
            break;
          }
        }
      }
    }
    this.setCursor(this.hovered || overAction ? "pointer" : "default");

    // minimap: dots every frame, fog mask at ~1 Hz when dirty
    if (this.minimap && this.minimap.shown) {
      const dots: MiniDot[] = [];
      for (const [, rec] of this.buildings) {
        if (rec.path === "__towncenter__") continue;
        dots.push({ x: rec.root.x, y: rec.root.y, color: 0xcfc6ae });
      }
      dots.push({ x: this.citadel.x, y: this.citadel.y, color: 0xf0e6c8, big: true });
      for (const [, rec] of this.agents) {
        dots.push({ x: rec.unit.x, y: rec.unit.y, color: 0xf0c94a, big: rec.role === "orchestrator" });
      }
      for (const [, rec] of this.raiders) {
        dots.push({ x: rec.unit.x, y: rec.unit.y, color: 0xe0483c, big: true });
      }
      this.minimap.update(dots, this.cameras.main);
      if (this.fogDirty && now >= this.nextFogRefresh) {
        this.fogDirty = false;
        this.nextFogRefresh = now + 900;
        this.minimap.refreshFog(this.fogAlphaAt);
      }
    }
  }
}

function truncPath(path: string): string {
  return path.length > 42 ? "…" + path.slice(-40) : path;
}
