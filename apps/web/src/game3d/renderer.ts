// Three.js low-poly 3D renderer for Agent Empires (KayKit CC0 assets).
// Drop-in replacement for the 2D factory: same attachGameRenderer signature,
// same event semantics, and — by construction — the same city layout: the
// world geometry comes from game/map.ts, the engine-pure treemap module the
// 2D renderer uses (layout hash logged identically on match_started).
import * as THREE from "three";
import {
  bountyValue,
  type AgentStatus,
  type DistrictArchetype,
  type DistrictPatch,
  type FileNode,
  type GameEvent,
  type ThemePack,
  type WorldSpec,
} from "@agent-empires/protocol";
import type { Renderer } from "../match-view.js";
import {
  assignPlot,
  layoutHash,
  layoutMap,
  mulberry32,
  quarterOf,
  type Hamlet,
  type MapLayout,
} from "../game/map.js";
import { visibleFloor } from "../game/palette.js";
import { resolveArchetype, type Archetype } from "../game/archetypes.js";
import { analyzeCensus, districtCensus, surveyLine, type Census } from "../game/census.js";
import { createShroud, type Shroud } from "../game/shroud.js";
import { deriveWorldDNA, type TimeOfDay, type WorldDNA } from "../game/worlddna.js";
import { Assets } from "./assets.js";
import { RtsCamera, isTypingTarget } from "./camera.js";
import { City, type BuildingRec3D, type PickInfo } from "./city.js";
import { Ground } from "./ground.js";
import { Unit3D } from "./units.js";
import { Overlay, type MenuEntry, type MiniDot } from "./ui.js";
import { Fx } from "./fx.js";
import { hashStr, hexColor, shortName, soften } from "./util.js";
import { makeBillboard } from "./billboards.js";

const FOG_REVEAL_RADIUS = 2;
const MAX_RAIDERS = 8;
/** The survey chronicle line speaks once the rise (~1.2s + props) settles. */
const SURVEY_SPEAK_MS = 1500;
const SURVEY_HINT = "⟡ The land lies unsurveyed — click a darkened quarter to chart it.";
const CONSTRUCTION_MS = 1400;
const IDLE_STATUSES: ReadonlySet<AgentStatus> = new Set(["idle", "resting", "done"]);

/** Worldsmith timeOfDay override → sun remap (curated, DNA-register). */
const TIME_OF_DAY: Record<TimeOfDay, { azimuth: number; elevation: number; color: number }> = {
  dawn: { azimuth: 0.8, elevation: 0.35, color: 0xf5c9a0 },
  noon: { azimuth: 1.6, elevation: 0.55, color: 0xfff2dc },
  dusk: { azimuth: 3.9, elevation: 0.18, color: 0xff9a5a },
  night: { azimuth: 4.7, elevation: 0.25, color: 0x9db8dc },
};
/** Worldsmith vegetation override → density multiplier over DNA. */
const VEGETATION_MULT: Record<string, number> = { barren: 0.15, sparse: 0.5, wooded: 1.0, lush: 1.6 };
/** Ambient never drops below this — the night world stays readable. */
const AMBIENT_FLOOR = 0.35;

/** The renderer handle: match-view's Renderer plus the in-world hooks. */
export type GameRendererHandle = Renderer & {
  setInspectHandler(cb: (path: string) => void): void;
  setSpeakHandler(cb: (agentId: string) => void): void;
  setOrderHandler(cb: (kind: "attend" | "hunt", target: string, agentId?: string) => void): void;
  setExamineHandler(cb: (text: string) => void): void;
  setExamineProvider(
    fn: (kind: "building" | "unit" | "raider" | "hook", id: string) => string | undefined,
  ): void;
  showXpDrop(agentId: string, skill: string, xp: number, color?: number): void;
  showLevelUp(agentId: string, skill: string, level: number): void;
  setSkillStats(agentId: string, stats: { total: number; top: [string, number][] }): void;
};

type AgentRec = {
  unit: Unit3D;
  role: "orchestrator" | "worker";
  name: string;
  charge: string | null;
  status: AgentStatus;
  site: { x: number; z: number } | null;
  sitePath: string | null;
  nextMoveAt: number;
  holdUntil: number;
};

type RaiderRec = {
  unit: Unit3D;
  name: string;
  key: string;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  toB: boolean;
  nextAt: number;
  dying: boolean;
};

type PatchRec = { objects: THREE.Object3D[]; disposers: (() => void)[]; tiles: string[] };

export function attachGameRenderer(mount: HTMLElement): GameRendererHandle {
  const game = new Game3D(mount);
  return {
    handleEvent(e, historical) {
      game.enqueue(e, historical);
    },
    destroy() {
      game.destroy();
    },
    setInspectHandler(cb) {
      game.onInspect = cb;
    },
    setSpeakHandler(cb) {
      game.onSpeak = cb;
    },
    setOrderHandler(cb) {
      game.onOrder = cb;
    },
    setExamineHandler(cb) {
      game.onExamine = cb;
    },
    setExamineProvider(fn) {
      game.examineProvider = fn;
    },
    showXpDrop(agentId, skill, xp, color) {
      game.showXpDrop(agentId, skill, xp, color);
    },
    showLevelUp(agentId, skill, level) {
      game.showLevelUp(agentId, skill, level);
    },
    setSkillStats(agentId, stats) {
      game.setSkillStats(agentId, stats);
    },
  };
}

class Game3D {
  // callbacks (mirrors the 2D scene's surface)
  onInspect: ((path: string) => void) | null = null;
  onSpeak: ((agentId: string) => void) | null = null;
  onOrder: ((kind: "attend" | "hunt", target: string, agentId?: string) => void) | null = null;
  onExamine: ((text: string) => void) | null = null;
  examineProvider:
    | ((kind: "building" | "unit" | "raider" | "hook", id: string) => string | undefined)
    | null = null;

  private mount: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new RtsCamera();
  private assets = new Assets();
  private ground = new Ground();
  private city: City;
  private fx = new Fx();
  private overlay: Overlay;
  private raycaster = new THREE.Raycaster();
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;

  private ready = false;
  private destroyed = false;
  private pending: [GameEvent, boolean][] = [];
  private raf = 0;
  private clock = new THREE.Clock();

  private map: MapLayout | null = null;
  private mapSeed = 1;
  private archetype: Archetype = resolveArchetype(undefined, 0);
  private census: Census | null = null;
  private dna: WorldDNA | null = null;
  private landLoreIdx = 0;
  private theme: ThemePack | null = null;
  private spec: WorldSpec | null = null;
  private accent = 0xe3b264;
  private citadel = { x: 0, z: 0, tx: 0, ty: 0 };
  private hamletByPath = new Map<string, Hamlet>();
  private agents = new Map<string, AgentRec>();
  private raiders = new Map<string, RaiderRec>();
  private workerCount = 0;
  private patchRecs = new Map<string, PatchRec>();
  private unitPickables: THREE.Object3D[] = [];
  private extraPickables: THREE.Object3D[] = [];
  private constructions: { path: string; until: number; scaffold: THREE.Object3D | null }[] = [];
  private flashes = new Map<string, { rec: BuildingRec3D; until: number }>();
  private tokenThrottle = new Map<string, number>();
  private xpNextAt = new Map<string, number>();
  private xpTimers = new Set<number>();
  private skillStats = new Map<string, { total: number; top: [string, number][] }>();
  private layoutHashValue = "";
  private shroud: Shroud | null = null;
  private repoTree: FileNode | null = null;
  private surveyTimers = new Set<number>();
  private hintShown = false;

  // pointer state
  private lastPointer = { x: 0, y: 0 };
  private hovered: PickInfo | null = null;
  private hoveredUnit: Unit3D | null = null;
  private rightDown: { x: number; y: number } | null = null;
  private middleDown = false;
  private leftDown: { x: number; y: number } | null = null;
  private panned = false;
  private longPress: number | null = null;
  private nextPickAt = 0;
  private nextMiniAt = 0;
  private actionNow = "";

  // perf
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private fpsNow = 60;
  private lowSeconds = 0;
  private degraded = false;
  private districtLabels: { sprite: THREE.Sprite; dispose: () => void }[] = [];

  private detachers: (() => void)[] = [];

  constructor(mount: HTMLElement) {
    this.mount = mount;
    this.city = new City(this.assets);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Software rasterizers (SwiftShader/llvmpipe) burn CPU and RAM per pixel;
    // degrade before allocating shadow maps rather than waiting for the FPS dip.
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const glName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    const softwareGL = /swiftshader|llvmpipe|software/i.test(glName);
    this.renderer.setPixelRatio(softwareGL ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 600);
    this.renderer.shadowMap.enabled = !softwareGL;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (softwareGL) {
      this.degraded = true;
      console.info(`[perf3d] software GL detected (${glName}); starting degraded`);
    }
    this.renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    if (getComputedStyle(mount).position === "static") mount.style.position = "relative";
    mount.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(this.archetype.skyColor);
    this.hemi = new THREE.HemisphereLight(0xcdd7e8, 0x54503e, 0.85);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.16);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 1.55);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.hemi, this.ambient, this.sun, this.sun.target);
    this.scene.add(this.ground.group, this.city.group, this.fx.group);

    this.overlay = new Overlay(mount, (tx, ty) => this.cam.jumpTo(tx, ty));
    this.cam.attachKeys();
    this.attachPointer();

    const ro = new ResizeObserver(() => {
      this.renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 600);
    });
    ro.observe(mount);
    this.detachers.push(() => ro.disconnect());

    const keyM = (e: KeyboardEvent) => {
      if (e.code === "KeyM" && !isTypingTarget(e)) this.overlay.toggleMinimap();
    };
    window.addEventListener("keydown", keyM);
    this.detachers.push(() => window.removeEventListener("keydown", keyM));

    // debug/smoke handle (read-only introspection from headless tests)
    (globalThis as Record<string, unknown>).__ae3d = this.debugHandle();

    void this.assets.loadCore().then(() => {
      if (this.destroyed) return;
      this.ready = true;
      this.assets.loadRest();
      for (const [e, h] of this.pending) this.dispatch(e, h);
      this.pending = [];
    });

    this.fpsWindowStart = performance.now();
    this.loop();
  }

  private debugHandle(): Record<string, unknown> {
    return {
      worldReady: () => this.map !== null,
      layoutHash: () => this.layoutHashValue,
      map: () => this.map,
      dna: () => this.dna,
      waterTilesRendered: () => this.ground.waterTileCount,
      bridgesRendered: () => this.ground.bridgeCount,
      decorStats: () => this.city.decorStats(),
      buildings: () => this.city.buildings,
      instanceCount: () => this.city.buildingInstanceCount(),
      drawCalls: () => this.renderer.info.render.calls,
      fps: () => this.fpsNow,
      degraded: () => this.degraded,
      fogAlphaAt: (tx: number, ty: number) => this.ground.fogAlphaAt(tx, ty),
      shroud: () => ({
        surveyed: this.shroud ? [...this.shroud.surveyed] : [],
        unsurveyed: this.shroud
          ? this.shroud.quarterPaths.filter((p) => !this.shroud!.isSurveyed(p)).length
          : 0,
      }),
      survey: (path: string) => this.surveyQuarter(path),
      hiddenPlotCount: () => this.city.hiddenCount(),
      plotScale: (path: string) => this.city.plotScale(path),
      risingCount: () => this.city.risingCount(),
      fogAnimating: () => this.ground.fogIsAnimating,
      agents: () => this.agents,
      raiders: () => this.raiders,
      menuEntries: () => this.overlay.currentMenuEntries().map((e) => e.label),
      fxActive: () => this.fx.activeCount,
      hookTiles: () =>
        this.extraPickables
          .map((o) => o.userData.pick as PickInfo | undefined)
          .filter((p): p is Extract<PickInfo, { kind: "hook" }> => p?.kind === "hook")
          .map((p) => ({ tx: p.tx, ty: p.ty, path: p.path })),
      projectTile: (tx: number, ty: number) => {
        const w = this.mount.clientWidth || 800;
        const h = this.mount.clientHeight || 600;
        return this.cam.worldToScreen(new THREE.Vector3(tx, 0, ty), w, h);
      },
      projectWorld: (x: number, y: number, z: number) => {
        const w = this.mount.clientWidth || 800;
        const h = this.mount.clientHeight || 600;
        return this.cam.worldToScreen(new THREE.Vector3(x, y, z), w, h);
      },
    };
  }

  enqueue(e: GameEvent, historical: boolean): void {
    if (this.ready) this.dispatch(e, historical);
    else this.pending.push([e, historical]);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const t of this.xpTimers) window.clearTimeout(t);
    for (const t of this.surveyTimers) window.clearTimeout(t);
    for (const d of this.detachers) d();
    this.cam.dispose();
    this.overlay.destroy();
    for (const rec of this.agents.values()) rec.unit.destroy();
    for (const rec of this.raiders.values()) rec.unit.destroy();
    this.fx.dispose();
    for (const l of this.districtLabels) l.dispose();
    this.city.dispose();
    this.ground.dispose();
    this.assets.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    delete (globalThis as Record<string, unknown>).__ae3d;
  }

  // --- input -----------------------------------------------------------------

  private attachPointer(): void {
    const el = this.renderer.domElement;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.detachers.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on("contextmenu", (e) => e.preventDefault());
    on("wheel", (e) => {
      e.preventDefault();
      this.cam.zoomBy(e.deltaY);
    }, { passive: false });
    on("pointerdown", (e) => {
      const p = this.toLocal(e);
      this.cam.pointer.inside = true;
      if (e.button === 2) {
        this.rightDown = p;
        this.panned = false;
      } else if (e.button === 1) {
        this.middleDown = true;
        e.preventDefault();
      } else if (e.button === 0) {
        this.leftDown = p;
        this.panned = false;
        if (e.pointerType === "touch") {
          this.longPress = window.setTimeout(() => this.openMenuAt(p.x, p.y), 550);
        }
      }
      this.lastPointer = p;
    });
    on("pointermove", (e) => {
      const p = this.toLocal(e);
      const dx = p.x - this.lastPointer.x;
      const dy = p.y - this.lastPointer.y;
      this.lastPointer = p;
      this.cam.pointer = { x: p.x, y: p.y, inside: true, moved: true };
      const w = this.mount.clientWidth || 800;
      const h = this.mount.clientHeight || 600;
      if (this.middleDown) {
        this.cam.panPx(dx, dy, w, h);
        return;
      }
      if (this.rightDown) {
        if (this.panned || Math.hypot(p.x - this.rightDown.x, p.y - this.rightDown.y) > 6) {
          this.panned = true;
          this.cam.panPx(dx, dy, w, h);
        }
        return;
      }
      if (this.leftDown && (this.panned || Math.hypot(p.x - this.leftDown.x, p.y - this.leftDown.y) > 8)) {
        this.panned = true;
        if (this.longPress !== null) {
          window.clearTimeout(this.longPress);
          this.longPress = null;
        }
        this.cam.panPx(dx, dy, w, h);
        this.mount.style.cursor = "grabbing";
      }
    });
    on("pointerup", (e) => {
      const p = this.toLocal(e);
      if (e.button === 1) {
        this.middleDown = false;
        return;
      }
      if (e.button === 2) {
        const wasPan = this.panned;
        this.rightDown = null;
        this.panned = false;
        if (!wasPan) this.openMenuAt(p.x, p.y);
        return;
      }
      if (e.button === 0) {
        if (this.longPress !== null) {
          window.clearTimeout(this.longPress);
          this.longPress = null;
        }
        const wasPan = this.panned;
        this.leftDown = null;
        this.panned = false;
        this.mount.style.cursor = "";
        if (!wasPan) this.handleLeftClick(p.x, p.y);
      }
    });
    on("pointerleave", () => {
      this.cam.pointer.inside = false;
    });
  }

  private toLocal(e: MouseEvent): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Raycast the scene at mount px; returns the best target by verb priority. */
  private pickAt(px: number, py: number): PickInfo | null {
    if (!this.map) return null;
    const w = this.mount.clientWidth || 800;
    const h = this.mount.clientHeight || 600;
    this.raycaster.setFromCamera(
      new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1),
      this.cam.camera,
    );
    const list = [...this.unitPickables, ...this.city.pickables, ...this.extraPickables];
    const hits = this.raycaster.intersectObjects(list, false);
    const found: PickInfo[] = [];
    for (const hit of hits) {
      const obj = hit.object;
      const direct = obj.userData.pick as PickInfo | undefined;
      if (direct) {
        if (this.pickVisible(direct)) found.push(direct);
        continue;
      }
      if ((obj as THREE.InstancedMesh).isInstancedMesh && hit.instanceId !== undefined) {
        const path = this.city.pathForInstance(obj as THREE.InstancedMesh, hit.instanceId);
        if (path && (!this.shroud || this.shroud.plotVisible(path))) {
          found.push({ kind: "building", path });
        }
      }
    }
    const pri = ["unit", "raider", "building", "hamlet", "hook", "landmark", "prop"] as const;
    for (const k of pri) {
      const f = found.find((p) => p.kind === k);
      if (f) return f;
    }
    return null;
  }

  private groundPointAt(px: number, py: number): THREE.Vector3 {
    const w = this.mount.clientWidth || 800;
    const h = this.mount.clientHeight || 600;
    return this.cam.screenToGround(px, py, w, h);
  }

  // --- OSRS verbs --------------------------------------------------------------

  /**
   * Context-menu rows for a target. Row 0 is the default action (also the
   * hover action text); the last row is always Cancel — same labels and
   * ordering as the 2D renderer.
   */
  private menuEntriesFor(target: PickInfo | null, wx: number, wz: number, sx: number, sy: number): MenuEntry[] {
    const entries: MenuEntry[] = [];
    if (target?.kind === "unit") {
      const id = target.id;
      const rec = this.agents.get(id);
      const who = rec ? shortName(rec.name) : "the worker";
      const fallback = rec
        ? `${rec.name}. ${rec.role === "orchestrator" ? "Sovereign of the realm; gives the orders." : "A diligent worker of the realm."}`
        : "A worker of the realm.";
      entries.push({ label: `Talk-to ${who}`, cb: () => this.onSpeak?.(id) });
      entries.push({ label: "Examine", cb: () => this.examine("unit", id, fallback, sx, sy) });
    } else if (target?.kind === "raider") {
      const key = target.key;
      const name = target.name.slice(0, 26);
      entries.push({ label: `Slay ${name}`, cb: () => this.orderHunt(key) });
      entries.push({
        label: "Examine",
        cb: () => this.examine("raider", name, "A failing test given form. Best slain quickly.", sx, sy),
      });
    } else if (target?.kind === "building") {
      const path = target.path;
      const rec = this.city.buildings.get(path);
      const citadel = path === "__towncenter__";
      if (!citadel) {
        const leaf = path.split("/").pop() ?? path;
        entries.push({ label: `Attend house of ${leaf}`, cb: () => this.orderAttend(path) });
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
        entries.push({ label: "Walk here", cb: () => this.walkHere(rec.tx, rec.ty + 0.6) });
      }
    } else if (target?.kind === "hook") {
      const fallback = target.snippet
        ? `An old obelisk etched: “${target.snippet}”`
        : "An old obelisk that poses a question.";
      const path = target.path;
      entries.push({ label: `Read ${target.label.slice(0, 30)}`, cb: () => this.onInspect?.(path) });
      entries.push({ label: "Examine", cb: () => this.examine("hook", path, fallback, sx, sy) });
    } else if (target?.kind === "hamlet") {
      const dir = target.dir || ".";
      const fallback = `${target.count} smaller works stand here, aggregated for scale.`;
      entries.push({ label: `Examine ${dir}/ hamlet`, cb: () => this.examine(null, dir, fallback, sx, sy) });
      entries.push({ label: "Walk here", cb: () => this.walkHere(wx, wz) });
    } else if (target?.kind === "landmark" || target?.kind === "prop") {
      const name = target.name.slice(0, 30);
      const fallback = target.lore || "A curiosity of the realm.";
      entries.push({ label: `Examine ${name}`, cb: () => this.examine(null, name, fallback, sx, sy) });
    } else {
      const surveyPath = this.surveyableQuarterAt(wx, wz);
      if (surveyPath) {
        entries.push({
          label: "⚑ Survey the quarter",
          cb: () => {
            this.surveyQuarter(surveyPath, sx, sy);
          },
        });
      }
      entries.push({ label: "Walk here", cb: () => this.walkHere(wx, wz) });
      entries.push({ label: "Examine the land", cb: () => this.examineLand(wx, wz, sx, sy) });
    }
    entries.push({ label: "Cancel", cb: null });
    return entries;
  }

  /**
   * Ground examine: cite the world's DNA. Prefers Worldsmith worldLore, else
   * derived loreNotes; water picks archipelago/river lines, land the rest.
   * Cycles through applicable lines on repeat examines.
   */
  private examineLand(wx: number, wz: number, sx: number, sy: number): void {
    const onWater = this.map?.water.has(`${Math.round(wx)},${Math.round(wz)}`) ?? false;
    const themeLore = this.theme?.world?.worldLore;
    const pool = (themeLore && themeLore.length > 0 ? themeLore : this.dna?.loreNotes) ?? [];
    const subjectRe = onWater ? /archipelago|river|water|sea|shore|coast/i : /realm|wall|fort|megalith|script/i;
    let lines = pool.filter((l) => subjectRe.test(l.subject));
    if (lines.length === 0) lines = pool;
    const fallback = onWater
      ? "Dark water. Even the coastline here was shaped by the code."
      : "The living ground of the realm.";
    const line = lines.length > 0 ? lines[this.landLoreIdx++ % lines.length]!.line : fallback;
    this.examine(null, "the land", line, sx, sy);
  }

  // --- the shroud: click-to-survey discovery -----------------------------------

  /** Shroud-hidden things must not be pickable (their names would leak). */
  private pickVisible(p: PickInfo): boolean {
    const sh = this.shroud;
    if (!sh) return true;
    switch (p.kind) {
      case "building":
        return p.path === "__towncenter__" || sh.plotVisible(p.path);
      case "hamlet":
        return sh.plotVisible(p.dir);
      case "hook":
        return sh.plotVisible(p.path);
      default:
        return true;
    }
  }

  /**
   * Outermost unsurveyed quarter under a ground point — exactly the one the
   * shroud law lets a visitor survey next (inner wards wait for their parent).
   */
  private surveyableQuarterAt(wx: number, wz: number): string | null {
    const map = this.map;
    const shroud = this.shroud;
    if (!map || !shroud) return null;
    const tx = Math.round(wx);
    const ty = Math.round(wz);
    const containing = map.quarters
      .filter((q) => tx >= q.rect.x && ty >= q.rect.y && tx < q.rect.x + q.rect.w && ty < q.rect.y + q.rect.h)
      .sort((a, b) => a.depth - b.depth);
    const first = containing.find((q) => !shroud.isSurveyed(q.path));
    return first && shroud.canSurvey(first.path) ? first.path : null;
  }

  /** Viewer-local and free (spectators too): click → survey → ceremony. */
  private surveyQuarter(path: string, sx?: number, sy?: number): boolean {
    if (!this.shroud?.survey(path)) return false;
    this.revealCeremony([path], false, sx, sy);
    return true;
  }

  /** Agent activity at a path uncovers its quarter chain for everyone. */
  private autoRevealAt(path: string, historical: boolean): void {
    if (!this.shroud) return;
    const chain = this.shroud.revealForPath(path);
    if (chain.length > 0) this.revealCeremony(chain, historical);
  }

  /**
   * The reveal ceremony: the veil lifts over each quarter's rect (inner wards
   * still unsurveyed get their deep veil back), the district's works rise
   * smallest-first, and once the rise settles the census speaks one
   * surveyLine per quarter through the examine sink. Historical replay snaps
   * silently — same convention as fog and fx everywhere else.
   */
  private revealCeremony(chain: string[], historical: boolean, sx?: number, sy?: number): void {
    const map = this.map;
    const shroud = this.shroud;
    if (!map || !shroud) return;
    for (const path of chain) {
      const q = map.quarters.find((qq) => qq.path === path);
      if (q) this.ground.liftQuarterRect(q.rect, historical);
    }
    for (const q of map.quarters) {
      if (shroud.isSurveyed(q.path)) continue;
      if (chain.some((p) => q.path.startsWith(p + "/"))) this.ground.veilQuarterRect(q.rect);
    }
    this.city.riseNewlyVisible(historical, performance.now());
    if (historical) return;
    chain.forEach((path, i) => {
      const q = map.quarters.find((qq) => qq.path === path);
      const census = this.repoTree ? districtCensus(this.repoTree, path) : null;
      if (!q || !census) return;
      const line = surveyLine(q.label, census);
      const t = window.setTimeout(() => {
        this.surveyTimers.delete(t);
        if (this.destroyed) return;
        if (i === 0 && sx !== undefined && sy !== undefined) this.overlay.showExamine(line, sx, sy);
        this.onExamine?.(line);
        console.info(`EXAMINE:${line}`);
      }, SURVEY_SPEAK_MS + i * 400);
      this.surveyTimers.add(t);
    });
  }

  private openMenuAt(px: number, py: number): void {
    if (!this.map) return;
    const target = this.pickAt(px, py);
    const g = this.groundPointAt(px, py);
    const entries = this.menuEntriesFor(target, g.x, g.z, px, py);
    this.overlay.openMenu(entries, px, py);
  }

  /** Left click: run the default (first) menu entry for the target. */
  private handleLeftClick(px: number, py: number): void {
    if (this.overlay.menuOpen) {
      this.overlay.closeMenu();
      return;
    }
    if (!this.map) return;
    const target = this.pickAt(px, py);
    const g = this.groundPointAt(px, py);
    const entries = this.menuEntriesFor(target, g.x, g.z, px, py);
    entries[0]?.cb?.();
  }

  private examine(
    kind: "building" | "unit" | "raider" | "hook" | null,
    id: string,
    fallback: string,
    sx: number,
    sy: number,
  ): void {
    const text = (kind ? this.examineProvider?.(kind, id) : undefined) ?? fallback;
    this.overlay.showExamine(text, sx, sy);
    this.onExamine?.(text);
    console.info(`EXAMINE:${text}`);
  }

  private orderHunt(key: string): void {
    const rrec = this.raiders.get(key);
    const name = rrec?.name ?? key;
    this.onOrder?.("hunt", name);
    if (rrec) this.fx.float(`⚔ hunt: ${name.slice(0, 24)}`, rrec.unit.x, rrec.unit.z, 1.2, 0xd05a48);
    console.info(`HUNT:${name}`);
  }

  private orderAttend(path: string): void {
    if (path === "__towncenter__") return;
    this.onOrder?.("attend", path);
    const rec = this.city.buildings.get(path);
    if (rec) this.fx.float("⚑ attend", rec.tx, rec.ty, 1.1, this.accent);
    console.info(`ATTEND:${path}`);
  }

  /** Cosmetic waypoint (no unit selection model in 3D — flag only). */
  private walkHere(wx: number, wz: number): void {
    this.fx.float("⚑", wx, wz, 0.4, this.accent, 26);
  }

  // --- OSRS feel: xp drops, level-ups ----------------------------------------

  showXpDrop(agentId: string, skill: string, xp: number, color = 0x62c9e8): void {
    if (!this.agents.has(agentId)) return;
    const now = performance.now();
    const start = Math.max(now, this.xpNextAt.get(agentId) ?? 0);
    this.xpNextAt.set(agentId, start + 300);
    const spawn = () => {
      const rec = this.agents.get(agentId);
      if (!rec || this.destroyed) return;
      this.fx.float(`◆ +${xp} ${skill}`, rec.unit.x, rec.unit.z, rec.unit.headHeight + 0.3, color, 20);
    };
    if (start <= now) spawn();
    else {
      const t = window.setTimeout(() => {
        this.xpTimers.delete(t);
        spawn();
      }, start - now);
      this.xpTimers.add(t);
    }
  }

  showLevelUp(agentId: string, skill: string, level: number): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    this.fx.burst(rec.unit.x, rec.unit.headHeight + 0.3, rec.unit.z, [0xffd75e, 0xfff2c8, this.accent, 0xffb347]);
    this.fx.banner(`⚔ ${skill} Level ${level}!`, rec.unit.x, rec.unit.z, rec.unit.headHeight + 0.6);
  }

  setSkillStats(agentId: string, stats: { total: number; top: [string, number][] }): void {
    this.skillStats.set(agentId, stats);
  }

  // --- world -------------------------------------------------------------------

  private archetypeAt = (path: string): DistrictArchetype => {
    if (!this.map) return "quarter";
    return quarterOf(this.map, path)?.archetype ?? "quarter";
  };

  private buildWorld(event: Extract<GameEvent, { type: "match_started" }>): void {
    this.mapSeed = event.mapSeed;
    this.repoTree = event.repoTree;
    this.archetype = resolveArchetype(this.theme?.biome.archetype, event.mapSeed);
    const map = layoutMap(event.repoTree, event.mapSeed, event.depEdges);
    this.map = map;
    const hash = layoutHash(map);
    this.layoutHashValue = hash;

    // terra incognita: quarters begin unsurveyed; the law hides their works
    const shroud = createShroud(map.quarters);
    this.shroud = shroud;
    this.city.setVisibilityLaw((p) => shroud.plotVisible(p));

    // world DNA: measured code facts → render directives (theme may override)
    this.census = analyzeCensus(event.repoTree);
    const dna = this.applyWorldOverrides(
      deriveWorldDNA(this.census, event.mapSeed, this.theme?.biome.archetype),
    );
    this.dna = dna;

    this.ground.build(map, event.mapSeed, dna);
    // deep veil before the city builds: instances bake their dimmed light
    for (const q of map.quarters) this.ground.veilQuarterRect(q.rect);
    this.ground.onFogTile = (tx, ty, alpha) => this.city.setTileLight(tx, ty, alpha);
    this.city.buildWorld(map, event.mapSeed, this.archetypeAt, this.ground.fogAlphaAt, dna, this.degraded);
    this.city.retintFlags(dna.buildingTint.trim);
    this.buildDistrictLabels(map);

    for (const hm of map.hamlets) for (const p of hm.paths) this.hamletByPath.set(p, hm);

    const tc = map.townCenter;
    this.citadel = { x: tc.tx, z: tc.ty, tx: tc.tx, ty: tc.ty };
    this.ground.reveal(tc.tx, tc.ty, 4, true);

    // sun from DNA, shadow frustum covering the whole city
    this.applySun(dna);
    const d = map.side * 0.72;
    const sc = this.sun.shadow.camera;
    sc.left = -d;
    sc.right = d;
    sc.top = d;
    sc.bottom = -d;
    sc.near = 1;
    sc.far = map.side * 3;
    sc.updateProjectionMatrix();

    const aspect = (this.mount.clientWidth || 800) / (this.mount.clientHeight || 600);
    this.cam.setBounds(map.cityRect);
    this.cam.frame(map.cityRect, aspect);

    this.overlay.bakeMinimap(map, this.ground.tileColors);
    if (this.theme) this.reskin(this.theme);

    console.info(
      `[world] layout-hash=${hash} side=${map.side} quarters=${map.quarters.length} ` +
        `blocks=${map.blocks.length} buildings=${map.plots.size} hamlets=${map.hamlets.length}`,
    );

    if (map.quarters.length > 0 && !this.hintShown) {
      this.hintShown = true;
      this.onExamine?.(SURVEY_HINT);
      console.info(`EXAMINE:${SURVEY_HINT}`);
    }
  }

  /** Directory names floated over their quarters: the map explains the repo. */
  private buildDistrictLabels(map: MapLayout): void {
    for (const l of this.districtLabels) {
      this.scene.remove(l.sprite);
      l.dispose();
    }
    this.districtLabels = [];
    const put = (
      text: string,
      x: number,
      z: number,
      o: { sizePx: number; color: string; worldH: number; y: number },
    ) => {
      const b = makeBillboard(text, {
        sizePx: o.sizePx,
        color: o.color,
        worldH: o.worldH,
        bold: true,
        bg: "rgba(10,8,5,0.45)",
        border: "none",
        pad: 7,
      });
      (b.sprite.material as THREE.SpriteMaterial).depthTest = false;
      b.sprite.renderOrder = 30;
      b.sprite.position.set(x, o.y, z);
      this.scene.add(b.sprite);
      this.districtLabels.push(b);
    };
    for (const q of map.quarters) {
      if (q.depth > 2) continue;
      const size = Math.min(q.rect.w, q.rect.h);
      if (q.depth === 2 && size < 7) continue;
      const name = q.path.split("/").pop() ?? q.path;
      const label = name.length > 20 ? `${name.slice(0, 19)}…` : name;
      put(label, q.rect.x + q.rect.w / 2, q.rect.y + q.rect.h / 2, {
        sizePx: 34,
        color: q.depth === 1 ? "#f0d9a0" : "#c9b98e",
        worldH: q.depth === 1 ? Math.min(2.4, Math.max(1.25, size * 0.1)) : 0.9,
        y: q.depth === 1 ? 3.4 : 2.1,
      });
    }
    put("⚜ THE CITADEL", map.townCenter.tx, map.townCenter.ty, {
      sizePx: 36,
      color: "#ffe9a8",
      worldH: 1.5,
      y: 4.6,
    });
  }

  private posForPath(path: string): { x: number; z: number; tx: number; ty: number } {
    const map = this.map!;
    let cell = map.plots.get(path);
    if (!cell) {
      const hm = this.hamletByPath.get(path);
      if (hm) cell = { tx: hm.tx, ty: hm.ty };
    }
    if (!cell) {
      const q = map.quarters.find((r) => r.path === path);
      if (q) {
        cell = { tx: Math.floor(q.rect.x + q.rect.w / 2), ty: Math.floor(q.rect.y + q.rect.h / 2) };
      } else if (path === "." || path === "") {
        cell = map.townCenter;
      } else {
        cell = assignPlot(map, path);
      }
    }
    return { x: cell.tx, z: cell.ty, tx: cell.tx, ty: cell.ty };
  }

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
          map.used.add(key);
          return { tx: x, ty: y };
        }
      }
    }
    return null;
  }

  private setSite(agentId: string, path: string, historical: boolean): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    const pos = this.posForPath(path);
    rec.site = { x: pos.x, z: pos.z };
    rec.sitePath = path;
    rec.unit.walkTo(pos.x + (Math.random() - 0.5) * 0.8, pos.z + 0.55 + (Math.random() - 0.5) * 0.3, historical);
    rec.nextMoveAt = performance.now() + 2200 + Math.random() * 1500;
  }

  private styleUnit(unit: Unit3D, kind: "villager" | "hero" | "raider"): void {
    const u = this.spec?.units;
    if (!u) {
      unit.applyTint(kind === "hero" ? 0xf0d9a0 : undefined);
      return;
    }
    const tint = kind === "villager" ? u.villagerTint : kind === "hero" ? u.heroTint : u.raiderTint;
    const tc = hexColor(tint);
    unit.applyTint(tc === undefined ? undefined : visibleFloor(tc, 0x55));
  }

  // --- events ------------------------------------------------------------------

  private dispatch(e: GameEvent, historical: boolean): void {
    if (e.type === "match_started") {
      this.buildWorld(e);
      return;
    }
    if (e.type === "theme_ready") {
      this.theme = e.theme;
      this.reskin(e.theme);
      return;
    }
    if (!this.map) return;

    switch (e.type) {
      case "agent_spawned": {
        const isKing = e.role === "orchestrator";
        const charKey = isKing ? "Mage" : this.workerCount++ % 2 === 0 ? "Rogue" : "Barbarian";
        const char = this.assets.chars.get(charKey) ?? this.assets.chars.get("Rogue");
        if (!char) break;
        const unit = new Unit3D(
          char,
          { kind: "unit", id: e.agentId },
          e.name,
          isKing ? "#f0c96a" : "#d8e4ec",
          isKing ? "hero" : "villager",
          isKing ? 0.74 : 0.62,
        );
        const jitter = () => (Math.random() - 0.5) * 2.2;
        unit.setPosition(this.citadel.x + jitter(), this.citadel.z + 1.6 + jitter() / 2);
        this.scene.add(unit.group);
        this.unitPickables.push(unit.pickMesh);
        this.styleUnit(unit, isKing ? "hero" : "villager");
        this.agents.set(e.agentId, {
          unit,
          role: e.role,
          name: e.name,
          charge: e.charge ?? null,
          status: "idle",
          site: null,
          sitePath: null,
          nextMoveAt: performance.now() + 1000 + Math.random() * 3000,
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
        if (IDLE_STATUSES.has(e.status)) rec.nextMoveAt = performance.now() + 600 + Math.random() * 1200;
        else if (rec.site) rec.unit.walkTo(rec.site.x + (Math.random() - 0.5) * 0.8, rec.site.z + 0.55, historical);
        break;
      }
      case "agent_moved": {
        this.autoRevealAt(e.path, historical);
        const pos = this.posForPath(e.path);
        this.setSite(e.agentId, e.path, historical);
        this.ground.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS, historical);
        break;
      }
      case "file_read": {
        this.autoRevealAt(e.path, historical);
        const pos = this.posForPath(e.path);
        this.ground.reveal(pos.tx, pos.ty, 1, historical);
        if (!historical) this.fx.float("✦", pos.x, pos.z, 0.6, this.accent, 18);
        this.setSite(e.agentId, e.path, historical);
        break;
      }
      case "list_dir": {
        this.autoRevealAt(e.path, historical);
        const pos = this.posForPath(e.path);
        this.ground.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS + 1, historical);
        this.setSite(e.agentId, e.path, historical);
        break;
      }
      case "search": {
        for (const path of e.paths.slice(0, 10)) {
          this.autoRevealAt(path, historical);
          const pos = this.posForPath(path);
          this.ground.reveal(pos.tx, pos.ty, 1, historical);
          if (!historical) this.fx.float("✦", pos.x, pos.z, 0.6, this.accent, 16);
        }
        const first = e.paths[0];
        if (first) this.setSite(e.agentId, first, historical);
        break;
      }
      case "file_write": {
        // reveal before raising: a building must never appear under the veil
        this.autoRevealAt(e.path, historical);
        const isNew = !this.map.plots.has(e.path) && !this.city.buildings.has(e.path);
        const pos = this.posForPath(e.path);
        this.ground.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS, historical);
        let rec = this.city.buildings.get(e.path);
        if (!rec) {
          rec = this.city.addBuilding(e.path, e.buildingKind, this.archetypeAt(e.path), pos.tx, pos.ty);
          if (isNew && !historical) this.startConstruction(e.path, pos.tx, pos.ty);
        } else if (!historical) {
          this.city.flashBuilding(rec);
          this.flashes.set(e.path, { rec, until: performance.now() + 160 });
        }
        rec.writes++;
        rec.linesAdded += e.linesAdded;
        rec.linesRemoved += e.linesRemoved;
        if (!historical) this.fx.float(`+${e.linesAdded}`, pos.x, pos.z, 1.0, 0x9ecf7a);
        this.setSite(e.agentId, e.path, historical);
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
          this.fx.float("⚑ tests green!", this.citadel.x, this.citadel.z, 2.6, 0x9ecf7a);
        }
        break;
      }
      case "message": {
        if (historical) break;
        const rec = this.agents.get(e.fromId);
        if (rec) {
          rec.unit.say(e.text);
          if (rec.role === "orchestrator") rec.unit.flourish();
        }
        break;
      }
      case "scroll": {
        if (!historical) {
          const rec = this.agents.get(e.authorId);
          const from = rec
            ? new THREE.Vector3(rec.unit.x, rec.unit.headHeight, rec.unit.z)
            : new THREE.Vector3(this.citadel.x, 1, this.citadel.z);
          this.fx.scrollArc(from, new THREE.Vector3(this.citadel.x, 2.2, this.citadel.z));
        }
        break;
      }
      case "dialogue":
        break; // handled by the match view's dialogue panel
      case "theme_patch": {
        this.applyDistrictPatch(e.patch, historical);
        break;
      }
      case "compaction": {
        const rec = this.agents.get(e.agentId);
        if (rec) {
          rec.site = null;
          rec.sitePath = null;
          rec.unit.walkTo(this.citadel.x + 1, this.citadel.z + 1.4, historical);
          if (!historical) this.fx.float("🍖", rec.unit.x, rec.unit.z, 0.9, 0xc98d5a);
        }
        break;
      }
      case "tokens": {
        if (historical) break;
        const n = (this.tokenThrottle.get(e.agentId) ?? 0) + 1;
        this.tokenThrottle.set(e.agentId, n);
        const rec = this.agents.get(e.agentId);
        if (rec && n % 3 === 0) {
          this.fx.float(`+${e.inputTokens + e.outputTokens}🪙`, rec.unit.x, rec.unit.z, rec.unit.headHeight, 0xf0c96a, 18);
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
          rec.unit.walkTo(this.citadel.x + (Math.random() - 0.5) * 2.4, this.citadel.z + 1.7, historical);
          rec.unit.dimmed = true;
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

  private startConstruction(path: string, tx: number, ty: number): void {
    let scaffold: THREE.Object3D | null = null;
    const model = this.assets.statics.get("scaffolding");
    if (model) {
      const g = new THREE.Group();
      for (const part of model.parts) {
        const m = new THREE.Mesh(part.geometry, part.material);
        m.castShadow = true;
        g.add(m);
      }
      g.position.set(tx, 0, ty);
      g.scale.setScalar(0.85);
      this.scene.add(g);
      scaffold = g;
    }
    this.constructions.push({ path, until: performance.now() + CONSTRUCTION_MS, scaffold });
  }

  // --- raiders -------------------------------------------------------------

  private makeRaider(key: string, name: string): Unit3D | null {
    const modelKey = bountyValue(name) >= 300 ? "Skeleton_Warrior" : "Skeleton_Minion";
    const char = this.assets.chars.get(modelKey) ?? this.assets.chars.get("Skeleton_Minion");
    if (!char) return null;
    const displayName = this.theme?.enemyName ? this.theme.enemyName.slice(0, 14) : name.slice(0, 14);
    const unit = new Unit3D(char, { kind: "raider", key, name }, displayName, "#c0483c", "raider", 0.66);
    unit.walkSpeed = 0.85;
    this.styleUnit(unit, "raider");
    return unit;
  }

  private reconcileRaiders(failures: { name: string; path?: string }[], historical: boolean): void {
    const nextKeys = new Set(failures.map((f) => `${f.path ?? "?"}::${f.name}`));
    for (const [key, rec] of this.raiders) {
      if (!nextKeys.has(key) && !rec.dying) {
        rec.dying = true;
        const drop = () => {
          rec.unit.destroy();
          const pi = this.unitPickables.indexOf(rec.unit.pickMesh);
          if (pi >= 0) this.unitPickables.splice(pi, 1);
          this.raiders.delete(key);
        };
        if (!historical) {
          this.fx.float("✕ bounty cleared", rec.unit.x, rec.unit.z, 1.4, 0xd4a843);
          rec.unit.die(drop);
        } else drop();
      }
    }
    for (const f of failures) {
      if (this.raiders.size >= MAX_RAIDERS) break;
      const key = `${f.path ?? "?"}::${f.name}`;
      if (this.raiders.has(key)) continue;
      let anchor: { x: number; z: number; tx: number; ty: number };
      const quarter = f.path && this.map ? quarterOf(this.map, f.path) : null;
      if (quarter) {
        const g = quarter.gate;
        anchor = { x: g.tx, z: g.ty, tx: g.tx, ty: g.ty };
      } else if (f.path) {
        anchor = this.posForPath(f.path);
      } else {
        anchor = { x: this.citadel.x, z: this.citadel.z, tx: this.citadel.tx, ty: this.citadel.ty };
      }
      this.ground.reveal(anchor.tx, anchor.ty, 1, historical);
      const unit = this.makeRaider(key, f.name);
      if (!unit) continue;
      unit.setPosition(anchor.x + (Math.random() - 0.5) * 1.6, anchor.z + 0.8 + (Math.random() - 0.5) * 0.6);
      this.scene.add(unit.group);
      this.unitPickables.push(unit.pickMesh);
      if (!historical) unit.spawnFromGround();
      this.raiders.set(key, {
        unit,
        name: f.name,
        key,
        ax: anchor.x - 1.3,
        az: anchor.z + 0.9,
        bx: anchor.x + 1.3,
        bz: anchor.z + 0.4,
        toB: hashStr(key) % 2 === 0,
        nextAt: 0,
        dying: false,
      });
      if (!historical) this.fx.float("⚔", anchor.x, anchor.z, 1.2, 0xc0483c);
    }
  }

  // --- world DNA ---------------------------------------------------------------

  /** Fold ThemePack.world overrides (timeOfDay/vegetation) into the DNA. */
  private applyWorldOverrides(dna: WorldDNA): WorldDNA {
    const world = this.theme?.world;
    if (!world) return dna;
    let sun = dna.sun;
    if (world.timeOfDay) {
      const t = TIME_OF_DAY[world.timeOfDay];
      sun = {
        timeOfDay: world.timeOfDay,
        azimuth: t.azimuth,
        elevation: t.elevation,
        color: t.color,
        ambient: Math.max(AMBIENT_FLOOR, dna.sun.ambient),
      };
    }
    let vegetation = dna.vegetation;
    if (world.vegetation) {
      const mult = VEGETATION_MULT[world.vegetation] ?? 1;
      vegetation = { ...vegetation, density: Math.min(1, Math.max(0, vegetation.density * mult)) };
    }
    return { ...dna, sun, vegetation };
  }

  /** Point the directional light per dna.sun; DNA colors are curated. */
  private applySun(dna: WorldDNA): void {
    const map = this.map;
    if (!map) return;
    const cx = map.side / 2;
    const el = (0.12 + Math.min(1, Math.max(0, dna.sun.elevation)) * 0.78) * (Math.PI / 2);
    const dist = map.side * 0.9;
    this.sun.position.set(
      cx + Math.cos(dna.sun.azimuth) * dist * Math.cos(el),
      Math.max(map.side * 0.2, dist * Math.sin(el)),
      cx + Math.sin(dna.sun.azimuth) * dist * Math.cos(el),
    );
    this.sun.target.position.set(cx, 0, cx);
    this.sun.color.set(dna.sun.color);
    this.sun.intensity = 1.1 + dna.sun.elevation * 0.8;
    this.ambient.intensity = Math.max(AMBIENT_FLOOR, dna.sun.ambient);
  }

  // --- theme -------------------------------------------------------------------

  /** ThemePack arrived: re-tint sky, lights, ground, banners, units in place. */
  private reskin(theme: ThemePack): void {
    this.theme = theme;
    this.archetype = resolveArchetype(theme.biome.archetype, this.mapSeed);
    this.spec = theme.worldSpec ?? null;

    // re-derive DNA under the theme's form override + world overrides, then
    // re-apply everything DNA-driven (ground colors, decor, tints, sun)
    if (this.census) {
      this.dna = this.applyWorldOverrides(
        deriveWorldDNA(this.census, this.mapSeed, theme.biome.archetype),
      );
    }
    if (this.map && this.dna) {
      this.ground.setDna(this.dna.ground);
      this.city.buildDecor(this.map, this.mapSeed, this.dna, this.degraded);
      this.city.retintBuildings(this.dna.buildingTint.roof);
      this.applySun(this.dna);
    }
    const themeAccent = hexColor(theme.biome.accentColor);
    this.accent = visibleFloor(themeAccent ?? this.archetype.glow, 0x50);

    // sky/background + hemisphere tints, all floored for visibility
    const skyTop = this.spec ? hexColor(this.spec.sky.top) : undefined;
    const bg = visibleFloor(skyTop ?? this.archetype.horizonColor, 0x20);
    this.scene.background = new THREE.Color(bg);
    this.hemi.color.set(visibleFloor(soften(bg, 0.55), 0x3a));
    const fogFloor = visibleFloor(hexColor(theme.biome.fogColor) ?? this.archetype.fogColor, 0x34);
    this.hemi.groundColor.set(soften(fogFloor, 0.5));

    // ground tint from spec terrain ramp or biome grass mid-color
    let groundTint: number | undefined;
    if (this.spec) {
      const base = this.spec.terrain.base.map((c) => hexColor(c)).filter((c): c is number => c !== undefined);
      groundTint = base[Math.floor(base.length / 2)];
    } else {
      const grass = theme.biome.grassColors.map((c) => hexColor(c)).filter((c): c is number => c !== undefined);
      groundTint = grass[Math.floor(grass.length / 2)];
    }
    if (this.map) {
      this.ground.setThemeTint(groundTint);
      const water = this.spec?.terrain.waterline?.color;
      const wc = hexColor(water ?? "");
      if (wc !== undefined) this.ground.setWaterColor(wc);
      this.overlay.bakeMinimap(this.map, this.ground.tileColors);
    }
    this.city.retintFlags(this.accent);
    for (const rec of this.agents.values()) {
      this.styleUnit(rec.unit, rec.role === "orchestrator" ? "hero" : "villager");
    }
    for (const rec of this.raiders.values()) this.styleUnit(rec.unit, "raider");
  }

  /** Additive, idempotent district reskin (parity with the 2D renderer). */
  private applyDistrictPatch(patch: DistrictPatch, historical: boolean): void {
    const map = this.map;
    if (!map) return;
    const prev = this.patchRecs.get(patch.district);
    if (prev) {
      for (const o of prev.objects) {
        o.removeFromParent();
        const pi = this.extraPickables.indexOf(o);
        if (pi >= 0) this.extraPickables.splice(pi, 1);
      }
      for (const d of prev.disposers) d();
      for (const t of prev.tiles) map.used.delete(t);
      this.patchRecs.delete(patch.district);
    }
    const rec: PatchRec = { objects: [], disposers: [], tiles: [] };
    const quarter = map.quarters.find((q) => q.path === patch.district);
    const rect = quarter?.rect ?? map.cityRect;
    const accent = visibleFloor(hexColor(patch.accent ?? "") ?? this.accent, 0x50);
    const rng = mulberry32(hashStr(patch.district) ^ this.mapSeed);

    this.ground.applyPatchTint(patch, hexColor(patch.groundTint));
    if (this.overlay && this.map) this.overlay.bakeMinimap(this.map, this.ground.tileColors);
    if (!historical) this.overlay.showTitle(`${patch.name} — ${patch.epithet}`, accent);

    const cxT = Math.floor(rect.x + rect.w / 2);
    const cyT = Math.floor(rect.y + rect.h / 2);

    // landmarks: procedural monoliths with emissive accents
    (patch.landmarks ?? []).forEach((lm, i) => {
      const cell = this.claimTileNear(cxT + (i === 0 ? -1 : 2), cyT + (i === 0 ? 1 : -1));
      if (!cell) return;
      rec.tiles.push(`${cell.tx},${cell.ty}`);
      const g = new THREE.Group();
      const baseColor = hexColor(lm.silhouette[0]?.color ?? "") ?? 0x6a6258;
      const mat = new THREE.MeshStandardMaterial({
        color: visibleFloor(baseColor, 0x30),
        emissive: new THREE.Color(hexColor(lm.glow?.color ?? "") ?? accent),
        emissiveIntensity: 0.35,
        roughness: 0.8,
      });
      rec.disposers.push(() => mat.dispose());
      const tiers = Math.min(3, lm.silhouette.length);
      let y = 0;
      for (let t = 0; t < tiers; t++) {
        const w = 0.55 - t * 0.14;
        const h = 0.5 + t * 0.35;
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat);
        m.position.y = y + h / 2;
        m.castShadow = true;
        m.userData.pick = { kind: "landmark", name: lm.name, lore: lm.lore, tx: cell.tx, ty: cell.ty } satisfies PickInfo;
        g.add(m);
        this.extraPickables.push(m);
        y += h;
      }
      g.position.set(cell.tx, 0, cell.ty);
      this.scene.add(g);
      rec.objects.push(g);
      this.ground.reveal(cell.tx, cell.ty, 1, historical);
    });

    // quest hooks: small emissive obelisks with a glow billboard
    for (const hook of patch.questHooks ?? []) {
      const pos = this.posForPath(hook.path);
      const cell = this.claimTileNear(pos.tx, pos.ty) ?? { tx: pos.tx, ty: pos.ty };
      rec.tiles.push(`${cell.tx},${cell.ty}`);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2c2618,
        emissive: new THREE.Color(accent),
        emissiveIntensity: 0.9,
        roughness: 0.5,
      });
      rec.disposers.push(() => mat.dispose());
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18).translate(0, 0.4, 0), mat);
      m.position.set(cell.tx, 0, cell.ty);
      m.castShadow = true;
      m.userData.pick = {
        kind: "hook",
        path: hook.path,
        label: hook.label,
        snippet: hook.snippet,
        tx: cell.tx,
        ty: cell.ty,
      } satisfies PickInfo;
      this.scene.add(m);
      this.extraPickables.push(m);
      rec.objects.push(m);
      const glow = makeBillboard("✦", { sizePx: 26, color: "#ffe9a8", worldH: 0.3 });
      glow.sprite.position.set(cell.tx, 0.95, cell.ty);
      this.scene.add(glow.sprite);
      rec.objects.push(glow.sprite);
      rec.disposers.push(() => glow.dispose());
      this.ground.reveal(cell.tx, cell.ty, 1, historical);
    }

    // bounded district-local props
    if (patch.props && patch.props.length > 0) {
      let placed = 0;
      const mat = new THREE.MeshStandardMaterial({ color: 0x7a7266, roughness: 0.9 });
      rec.disposers.push(() => mat.dispose());
      patch.props.forEach((wp, i) => {
        for (let ty = rect.y; ty < rect.y + rect.h && placed < 10; ty++) {
          for (let tx = rect.x; tx < rect.x + rect.w && placed < 10; tx++) {
            const tileKey = `${tx},${ty}`;
            if (map.used.has(tileKey) || map.roads.has(tileKey)) continue;
            if (rng() < wp.density * 0.1) {
              map.used.add(tileKey);
              rec.tiles.push(tileKey);
              const m = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.3, 0.24).translate(0, 0.15, 0), mat);
              m.position.set(tx, 0, ty);
              m.rotation.y = rng() * Math.PI;
              m.userData.pick = {
                kind: "prop",
                name: `${patch.name} Curiosity`,
                lore: `Placed by the Worldsmith when ${patch.name} resolved into itself.`,
                tx,
                ty,
              } satisfies PickInfo;
              this.scene.add(m);
              this.extraPickables.push(m);
              rec.objects.push(m);
              placed++;
            }
          }
        }
        void i;
      });
    }

    this.patchRecs.set(patch.district, rec);
  }

  // --- endgame -------------------------------------------------------------

  private raiseWonder(historical: boolean): void {
    const cell = this.claimTileNear(this.citadel.tx + 3, this.citadel.ty + 3) ?? {
      tx: this.citadel.tx + 3,
      ty: this.citadel.ty + 3,
    };
    this.ground.reveal(cell.tx, cell.ty, 4, historical);
    this.fx.raiseWonder(cell.tx, cell.ty, this.accent);
    for (const [key, rec] of this.raiders) {
      rec.unit.destroy();
      const pi = this.unitPickables.indexOf(rec.unit.pickMesh);
      if (pi >= 0) this.unitPickables.splice(pi, 1);
      this.raiders.delete(key);
    }
    for (const rec of this.agents.values()) rec.unit.cheer();
    if (!historical) {
      this.cam.panTo(cell.tx, cell.ty);
      this.fx.confetti(cell.tx, cell.ty);
    }
  }

  private stageDefeat(): void {
    this.sun.intensity *= 0.35;
    this.hemi.intensity *= 0.6;
    this.hemi.color.set(0x8a8a90);
    this.hemi.groundColor.set(0x3a3a40);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const unit = this.makeRaider(`victory-lap-${i}`, "the end");
      if (!unit) continue;
      const x = this.citadel.x + Math.cos(angle) * 3.4;
      const z = this.citadel.z + 1.2 + Math.sin(angle) * 2;
      unit.setPosition(x, z);
      this.scene.add(unit.group);
      this.unitPickables.push(unit.pickMesh);
      this.raiders.set(`victory-lap-${i}`, {
        unit,
        name: "the end",
        key: `victory-lap-${i}`,
        ax: this.citadel.x + Math.cos(angle + 0.5) * 3.4,
        az: this.citadel.z + 1.2 + Math.sin(angle + 0.5) * 2,
        bx: this.citadel.x + Math.cos(angle - 0.5) * 3.4,
        bz: this.citadel.z + 1.2 + Math.sin(angle - 0.5) * 2,
        toB: i % 2 === 0,
        nextAt: 0,
        dying: false,
      });
    }
  }

  // --- frame loop ----------------------------------------------------------

  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.clock.getDelta());
    const now = performance.now();
    const w = this.mount.clientWidth || 800;
    const h = this.mount.clientHeight || 600;

    this.cam.edgeScroll = !this.overlay.menuOpen;
    this.cam.update(dt, w, h);
    this.ground.tick(dt);
    this.city.tick(now);
    this.fx.tick(dt);

    // agents: ambient life (movement timing may use randomness; layout may not)
    for (const rec of this.agents.values()) {
      const p = this.cam.worldToScreen(new THREE.Vector3(rec.unit.x, 0.5, rec.unit.z), w, h);
      const onScreen = p.x > -w * 0.2 && p.x < w * 1.2 && p.y > -h * 0.2 && p.y < h * 1.2;
      rec.unit.tick(dt, now, onScreen);
      if (rec.unit.isWalking || now < rec.nextMoveAt || now < rec.holdUntil) continue;
      if (IDLE_STATUSES.has(rec.status) || !rec.site) {
        const a = Math.random() * Math.PI * 2;
        const d = 1 + Math.random() * 2.6;
        rec.unit.walkTo(this.citadel.x + Math.cos(a) * d, this.citadel.z + 1.4 + Math.sin(a) * d * 0.6);
        rec.nextMoveAt = now + 2600 + Math.random() * 4200;
      } else {
        rec.unit.walkTo(rec.site.x + (Math.random() - 0.5) * 1.1, rec.site.z + 0.55 + (Math.random() - 0.5) * 0.5);
        rec.nextMoveAt = now + 1800 + Math.random() * 2600;
      }
    }
    for (const rec of this.raiders.values()) {
      const p = this.cam.worldToScreen(new THREE.Vector3(rec.unit.x, 0.5, rec.unit.z), w, h);
      const onScreen = p.x > -w * 0.2 && p.x < w * 1.2 && p.y > -h * 0.2 && p.y < h * 1.2;
      rec.unit.tick(dt, now, onScreen);
      if (rec.dying || rec.unit.isWalking || now < rec.nextAt) continue;
      rec.toB = !rec.toB;
      rec.unit.walkTo(rec.toB ? rec.bx : rec.ax, rec.toB ? rec.bz : rec.az);
      rec.nextAt = now + 600 + Math.random() * 900;
    }

    // construction scaffolds
    for (let i = this.constructions.length - 1; i >= 0; i--) {
      const c = this.constructions[i]!;
      if (c.until <= now) {
        c.scaffold?.removeFromParent();
        this.constructions.splice(i, 1);
      }
    }
    // building flash restore
    for (const [path, f] of this.flashes) {
      if (f.until <= now) {
        this.city.unflashBuilding(f.rec);
        this.flashes.delete(path);
      }
    }

    // hover picking at ~30 Hz + OSRS action text
    if (now >= this.nextPickAt && this.map && !this.overlay.menuOpen) {
      this.nextPickAt = now + 33;
      const pick = this.pickAt(this.lastPointer.x, this.lastPointer.y);
      this.setHovered(pick);
      const g = this.groundPointAt(this.lastPointer.x, this.lastPointer.y);
      const entries = this.menuEntriesFor(pick, g.x, g.z, this.lastPointer.x, this.lastPointer.y);
      const first = entries[0];
      let main = "";
      let sub = "";
      if (first?.cb) {
        main = first.label;
        const more = entries.length - 2;
        if (more > 0) sub = `/ ${more} more option${more === 1 ? "" : "s"}`;
      }
      const key = `${main}|${sub}`;
      if (key !== this.actionNow) {
        this.actionNow = key;
        this.overlay.setAction(main, sub);
      }
      this.renderer.domElement.style.cursor = pick ? "pointer" : "default";
    }

    // minimap at ~8 Hz
    if (now >= this.nextMiniAt && this.map && this.overlay.minimapShown) {
      this.nextMiniAt = now + 125;
      const dots: MiniDot[] = [{ tx: this.citadel.tx, ty: this.citadel.ty, color: "#f0e6c8", big: true }];
      for (const rec of this.agents.values()) {
        dots.push({ tx: rec.unit.x, ty: rec.unit.z, color: "#f0c94a", big: rec.role === "orchestrator" });
      }
      for (const rec of this.raiders.values()) {
        dots.push({ tx: rec.unit.x, ty: rec.unit.z, color: "#e0483c", big: true });
      }
      const poly = [
        this.cam.screenToGround(0, 0, w, h),
        this.cam.screenToGround(w, 0, w, h),
        this.cam.screenToGround(w, h, w, h),
        this.cam.screenToGround(0, h, w, h),
      ].map((v) => ({ x: v.x, y: v.z }));
      this.overlay.paintMinimap(dots, poly, this.ground.fogAlphaAt);
    }

    // fps window + auto-degrade
    this.fpsFrames++;
    if (now - this.fpsWindowStart >= 1000) {
      this.fpsNow = (this.fpsFrames * 1000) / (now - this.fpsWindowStart);
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
      if (!this.degraded && this.map) {
        if (this.fpsNow < 45) this.lowSeconds++;
        else this.lowSeconds = 0;
        if (this.lowSeconds >= 5) this.degradePerf();
      }
    }

    this.renderer.render(this.scene, this.cam.camera);
  };

  private setHovered(pick: PickInfo | null): void {
    let unit: Unit3D | null = null;
    if (pick?.kind === "unit") unit = this.agents.get(pick.id)?.unit ?? null;
    else if (pick?.kind === "raider") unit = this.raiders.get(pick.key)?.unit ?? null;
    if (unit !== this.hoveredUnit) {
      this.hoveredUnit?.setRing(false);
      this.hoveredUnit = unit;
      this.hoveredUnit?.setRing(true, 0xffffff);
    }
    this.hovered = pick;
    void this.hovered;
  }

  /** Rolling FPS < 45 for 5s: shadows off + pixelRatio 1, never re-enabled. */
  private degradePerf(): void {
    this.degraded = true;
    this.renderer.shadowMap.enabled = false;
    this.sun.castShadow = false;
    this.renderer.setPixelRatio(1);
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
    console.info(`[perf3d] auto-degrade: shadows off, pixelRatio=1 (fps=${this.fpsNow.toFixed(1)})`);
  }
}
