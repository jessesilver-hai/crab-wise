// Castle Era 3D renderer. The world is a castle: components from the frozen
// ComponentGraph/CastlePlan law stand as kit-built constructions on their
// sockets, connectors run as roads and carted rails, and the live loop
// (file_write / component_facts / castle_repr → CastleState) animates every
// visible consequence — scaffold theater, tint lerps, prop refits, form
// swaps and razings. The renderer NEVER re-derives layout: it renders
// plan + changes.
import * as THREE from "three";
import type { AgentStatus, GameEvent } from "@agent-empires/protocol";
import type { Renderer } from "../match-view.js";
import { asLedger, type CastlePlan, type Traits } from "../game/castle.js";
import type { Component } from "../game/components.js";
import { CastleState, type CastleChange } from "../game/castlestate.js";
import { Assets } from "./assets.js";
import { OrbitRig } from "./camera.js";
import { ConnectorWorks } from "./connectors.js";
import { Constructions, missingPieces, type PickInfo } from "./constructions.js";
import { CastleGround, GROUNDS_RADIUS } from "./ground.js";
import { Inspector, defaultWhy } from "./inspector.js";
import { CurtainWall } from "./wall.js";
import { Fx } from "./fx.js";
import { Unit3D } from "./units.js";
import { makeBillboard, type Billboard } from "./billboards.js";

const RING_RISE_MS = 350;
const IDLE_STATUSES: ReadonlySet<AgentStatus> = new Set(["idle", "resting", "done"]);

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

export function attachGameRenderer(mount: HTMLElement): GameRendererHandle {
  const game = new CastleGame(mount);
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

type AgentRec = {
  unit: Unit3D;
  role: "orchestrator" | "worker";
  name: string;
  status: AgentStatus;
  siteComp: string | null;
};

class CastleGame {
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
  private cam = new OrbitRig();
  private assets = new Assets();
  private ground = new CastleGround();
  private constructions: Constructions;
  private wall = new CurtainWall();
  private connectors = new ConnectorWorks();
  private inspector: Inspector;
  private fx = new Fx();
  private raycaster = new THREE.Raycaster();
  private hemi: THREE.HemisphereLight;
  private ambient: THREE.AmbientLight;
  private sun: THREE.DirectionalLight;

  private st = new CastleState();
  private founded = false;
  private foundStartedAt = 0;
  private foundMsValue = -1;
  private wallSig = "";
  private connSig = "";
  private pathToComp = new Map<string, string>();
  private compCache = new Map<string, Component>();
  private builders = new Map<string, string>(); // componentId → agentId hammering it

  private agents = new Map<string, AgentRec>();
  private workerCount = 0;
  private unitPickables: THREE.Object3D[] = [];

  private ready = false;
  private destroyed = false;
  private pending: [GameEvent, boolean][] = [];
  private raf = 0;
  private clock = new THREE.Clock();
  private detachers: (() => void)[] = [];
  private xpTimers = new Set<number>();
  private xpNextAt = new Map<string, number>();
  private skillStats = new Map<string, { total: number; top: [string, number][] }>();
  private tokenThrottle = new Map<string, number>();

  // pointer state
  private lastPointer = { x: 0, y: 0 };
  private leftDown: { x: number; y: number } | null = null;
  private rightDown = false;
  private dragged = false;
  private nextHoverAt = 0;
  private hover: { id: string; bb: Billboard } | null = null;

  // perf
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private fpsNow = 60;
  private lowSeconds = 0;
  private degraded = false;
  private particlesOff = false;
  private sparkNextAt = 0;

  constructor(mount: HTMLElement) {
    this.mount = mount;
    this.constructions = new Constructions(this.assets);
    this.constructions.groundY = this.ground.heightAt;
    this.connectors.groundY = this.ground.heightAt;
    this.constructions.onPuff = (x, y, z, kind) => this.puff(x, y, z, kind);

    // Software rasterizers (SwiftShader/llvmpipe) burn CPU per pixel; probe
    // for them first so we can skip MSAA and render at half resolution (the
    // CSS canvas stays full size, so picking coordinates are unaffected).
    const { softwareGL, glName } = detectSoftwareGL();
    this.renderer = new THREE.WebGLRenderer({ antialias: !softwareGL });
    this.renderer.setPixelRatio(softwareGL ? 0.5 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 600);
    this.renderer.shadowMap.enabled = !softwareGL;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (softwareGL) {
      this.degraded = true;
      console.info(`[perf3d] software GL detected (${glName}); starting degraded`);
    }
    this.renderer.domElement.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;display:block;";
    if (getComputedStyle(mount).position === "static") mount.style.position = "relative";
    mount.appendChild(this.renderer.domElement);

    // bright readable daylight — the castle never broods
    this.scene.background = new THREE.Color(0xbfdcee);
    this.scene.fog = new THREE.Fog(0xc9e0ee, 70, 170);
    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x8fa46a, 0.95);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.32);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.7);
    this.sun.position.set(26, 40, 14);
    this.sun.castShadow = !softwareGL;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    const sc = this.sun.shadow.camera;
    sc.left = -(GROUNDS_RADIUS + 6);
    sc.right = GROUNDS_RADIUS + 6;
    sc.top = GROUNDS_RADIUS + 6;
    sc.bottom = -(GROUNDS_RADIUS + 6);
    sc.near = 1;
    sc.far = 160;
    sc.updateProjectionMatrix();
    this.scene.add(this.hemi, this.ambient, this.sun, this.sun.target);
    this.scene.add(
      this.ground.group,
      this.constructions.group,
      this.wall.group,
      this.connectors.group,
      this.fx.group,
    );

    this.inspector = new Inspector(mount);
    this.inspector.onInspect = (path) => this.onInspect?.(path);
    this.cam.attachKeys();
    this.cam.fit(GROUNDS_RADIUS * 0.66); // pre-founding: closer in, less empty field
    this.attachPointer();

    const ro = new ResizeObserver(() => {
      this.renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 600);
    });
    ro.observe(mount);
    this.detachers.push(() => ro.disconnect());

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

  enqueue(e: GameEvent, historical: boolean): void {
    if (this.ready) this.dispatch(e, historical);
    else this.pending.push([e, historical]);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const t of this.xpTimers) window.clearTimeout(t);
    for (const d of this.detachers) d();
    this.cam.dispose();
    this.hover?.bb.dispose();
    this.hover = null;
    for (const rec of this.agents.values()) rec.unit.destroy();
    this.agents.clear();
    this.fx.dispose();
    this.inspector.destroy();
    this.constructions.dispose();
    this.wall.dispose();
    this.connectors.dispose();
    this.ground.dispose();
    this.assets.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    delete (globalThis as Record<string, unknown>).__ae3d;
  }

  // --- debug/smoke handle ------------------------------------------------------

  private debugHandle(): Record<string, unknown> {
    return {
      worldReady: () => this.founded,
      foundMs: () => this.foundMsValue,
      plan: () => this.st.plan,
      hash: () => this.st.plan?.hash ?? "",
      rootId: () => this.st.graph?.rootId ?? "",
      componentCount: () => this.st.graph?.components.length ?? 0,
      ids: () => this.constructions.ids(),
      socketWorld: (id: string) => this.constructions.worldPos(id),
      stateOf: (id: string) => this.constructions.stateOf(id),
      formOf: (id: string) => this.constructions.formOf(id),
      labelOf: (id: string) => this.constructions.labelOf(id),
      tintOf: (id: string) => this.constructions.tintOf(id),
      scaffoldCount: () => this.constructions.scaffoldCount(),
      towers: () => this.wall.stats.towers,
      gatePresent: () => this.wall.stats.gate,
      wallGaps: () => this.wall.stats.gaps,
      wallSegments: () => this.wall.stats.segments,
      cartPositions: () => this.connectors.cartPositions(),
      cartCount: () => this.connectors.cartCount,
      railCount: () => this.connectors.railCount,
      roadCount: () => this.connectors.roadCount,
      drawCalls: () => this.renderer.info.render.calls,
      fps: () => this.fpsNow,
      degraded: () => this.degraded,
      meshCount: () => {
        let n = 0;
        this.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) n++;
        });
        return n;
      },
      azimuth: () => this.cam.azimuth,
      pitch: () => this.cam.pitch,
      inspectorOpen: () => this.inspector.openLabel,
      inspectorText: () => this.inspector.bodyText,
      missingPieces: () => missingPieces(),
      agents: () => this.agents,
      groundHeightAt: (x: number, z: number) => this.ground.heightAt(x, z),
      projectWorld: (x: number, y: number, z: number) => {
        const w = this.mount.clientWidth || 800;
        const h = this.mount.clientHeight || 600;
        return this.cam.worldToScreen(new THREE.Vector3(x, y, z), w, h);
      },
    };
  }

  // --- examine channel -----------------------------------------------------------

  private examine(text: string): void {
    this.onExamine?.(text);
    console.log(`EXAMINE: ${text}`);
  }

  private labelOf(id: string): string {
    return this.constructions.labelOf(id) ?? this.compCache.get(id)?.label ?? id;
  }

  // --- events ----------------------------------------------------------------------

  private dispatch(e: GameEvent, historical: boolean): void {
    switch (e.type) {
      case "match_started": {
        if (this.founded) break;
        this.foundStartedAt = performance.now();
        // A returning castle's ledger rides the founding event: prior claims
        // never move, new components claim fresh sockets around them.
        const plan = this.st.found(
          e.repoTree,
          e.mapSeed,
          e.depEdges ?? [],
          e.probeHits ?? [],
          asLedger(e.castleLedger),
        );
        this.buildCastle(plan, historical);
        break;
      }
      case "component_facts": {
        if (!this.founded) break;
        const { plan, changes } = this.st.applyFacts(e.path, e.hits);
        this.applyChanges(plan, changes, historical, e.path);
        break;
      }
      case "castle_repr": {
        if (!this.founded) break;
        const { plan, changes } = this.st.applyRepr(e.componentId, e.form, e.cited, e.genome);
        this.applyChanges(plan, changes, historical, e.cited);
        break;
      }
      case "castle_style": {
        if (!this.founded) break;
        const { plan, changes } = this.st.applyStyle(e.style);
        this.applyChanges(plan, changes, historical, "the design decree");
        break;
      }
      case "file_write": {
        if (!this.founded) break;
        const { plan, changes } = this.st.applyWrite(e.path, e.created, e.linesAdded, e.linesRemoved);
        this.applyChanges(plan, changes, historical, e.path, e.agentId);
        this.walkAgentToPath(e.agentId, e.path, historical);
        const compId = this.pathToComp.get(e.path);
        if (compId && !historical) {
          const top = this.constructions.topOf(compId);
          if (top) this.fx.float(`+${e.linesAdded}`, top.x, top.z, top.y + 0.3, 0x8fc86a);
        }
        break;
      }
      case "agent_spawned": {
        this.spawnAgent(e.agentId, e.role, e.name, e.charge ?? null, historical);
        break;
      }
      case "agent_status": {
        const rec = this.agents.get(e.agentId);
        if (!rec) break;
        rec.status = e.status;
        rec.unit.setStatusGlyph(e.status);
        rec.unit.setLabor(e.status === "building");
        if (e.detail && !historical) rec.unit.showDetail(e.detail);
        break;
      }
      case "agent_moved":
      case "file_read":
      case "list_dir": {
        this.walkAgentToPath(e.agentId, e.path, historical);
        if (e.type === "file_read" && !historical) {
          const id = this.pathToComp.get(e.path);
          const top = id ? this.constructions.topOf(id) : null;
          if (top) this.fx.float("✦", top.x, top.z, top.y + 0.2, 0xe3c264, 18);
        }
        break;
      }
      case "search": {
        const first = e.paths[0];
        if (first) this.walkAgentToPath(e.agentId, first, historical);
        break;
      }
      case "command_run": {
        const rec = this.agents.get(e.agentId);
        if (rec && !historical) {
          rec.unit.showDetail(`⚙ ${e.command.length > 40 ? e.command.slice(0, 40) + "…" : e.command}`);
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
      case "compaction": {
        const rec = this.agents.get(e.agentId);
        if (rec) {
          rec.siteComp = null;
          rec.unit.walkTo(1.2, 2.4, historical);
        }
        break;
      }
      case "tokens": {
        if (historical) break;
        const n = (this.tokenThrottle.get(e.agentId) ?? 0) + 1;
        this.tokenThrottle.set(e.agentId, n);
        const rec = this.agents.get(e.agentId);
        if (rec && n % 3 === 0 && !this.particlesOff) {
          this.fx.float(
            `+${e.inputTokens + e.outputTokens}🪙`,
            rec.unit.x,
            rec.unit.z,
            rec.unit.y + rec.unit.headHeight,
            0xf0c96a,
            18,
          );
        }
        break;
      }
      case "agent_done": {
        const rec = this.agents.get(e.agentId);
        if (rec) {
          rec.status = "done";
          rec.unit.setStatusGlyph("done");
          rec.unit.setLabor(false);
          rec.siteComp = null;
          rec.unit.walkTo((Math.random() - 0.5) * 3, 2.2 + Math.random(), historical);
          rec.unit.dimmed = true;
        }
        break;
      }
      case "match_ended": {
        if (e.result === "victory" && !historical && !this.particlesOff) {
          this.fx.confetti(0, 0);
          for (const rec of this.agents.values()) rec.unit.cheer();
        }
        break;
      }
      default:
        break; // decree / session_status / theme_* / log / context render elsewhere
    }
  }

  // --- castle building -----------------------------------------------------------

  private refreshMaps(): void {
    const graph = this.st.graph;
    if (!graph) return;
    this.pathToComp.clear();
    for (const c of graph.components) {
      this.compCache.set(c.id, c);
      for (const p of c.paths) this.pathToComp.set(p, c.id);
    }
  }

  private buildCastle(plan: CastlePlan, historical: boolean): void {
    this.refreshMaps();
    this.ground.build(plan.seed, this.assets);
    for (const s of plan.sockets) {
      this.constructions.add(s, this.labelOf(s.componentId), {
        theater: false,
        instant: historical,
        riseDelay: historical ? 0 : 200 + s.ring * RING_RISE_MS,
      });
    }
    this.rebuildWorks(plan);
    const maxR = plan.sockets.reduce((m, s) => Math.max(m, Math.hypot(s.x, s.z)), plan.wall.radius);
    this.cam.fit(Math.max(14, maxR + 4));
    this.founded = true;
    this.foundMsValue = Math.round(performance.now() - this.foundStartedAt);
    console.info(
      `[castle] founded hash=${plan.hash} components=${this.st.graph?.components.length ?? 0} ` +
        `sockets=${plan.sockets.length} connectors=${plan.connectors.length} towers=${plan.wall.towers.length}`,
    );
    if (!historical) {
      this.examine(
        `the castle is founded — ${this.st.graph?.components.length ?? 0} components, hash ${plan.hash}`,
      );
    }
  }

  /** Rebuild wall/connector works when the plan's signature moved. */
  private rebuildWorks(plan: CastlePlan): void {
    const wallSig = `${plan.wall.gateAngle.toFixed(3)}|${plan.wall.towers.length}|${plan.connectors
      .map((c) => `${c.from}>${c.to}:${c.kind}:${c.points.length}`)
      .join(",")}`;
    if (wallSig !== this.wallSig) {
      this.wallSig = wallSig;
      this.wall.build(this.assets, plan.wall, plan.connectors, this.ground.heightAt);
    }
    const connSig = plan.connectors
      .map((c) => `${c.from}>${c.to}:${c.kind}:${c.weight}:${c.points.length}`)
      .join(",");
    if (connSig !== this.connSig) {
      this.connSig = connSig;
      this.connectors.build(this.assets, plan.connectors);
    }
  }

  private applyChanges(
    plan: CastlePlan,
    changes: CastleChange[],
    historical: boolean,
    source: string,
    byAgent?: string,
  ): void {
    // labels for removed components come from the pre-refresh cache
    const oldLabels = new Map<string, string>();
    for (const ch of changes) {
      if ("componentId" in ch) oldLabels.set(ch.componentId, this.labelOf(ch.componentId));
    }
    this.refreshMaps();
    const socketOf = new Map(plan.sockets.map((s) => [s.componentId, s]));
    for (const ch of changes) {
      if (ch.kind === "style") {
        // full design-language shift: the genome engine restyles the realm
        if (!historical) this.examine(`the castle takes the style «${ch.name}» — ${ch.cited}`);
        continue;
      }
      const label = this.labelOf(ch.componentId) ?? oldLabels.get(ch.componentId) ?? ch.componentId;
      switch (ch.kind) {
        case "added": {
          const socket = socketOf.get(ch.componentId);
          if (!socket) break;
          if (this.constructions.has(ch.componentId)) this.constructions.remove(ch.componentId);
          this.constructions.add(socket, label, { theater: !historical, instant: historical });
          if (!historical) {
            this.examine(`scaffolding rises for the ${socket.form} of ${label} (${source})`);
            this.assignBuilder(ch.componentId, byAgent, historical);
          }
          break;
        }
        case "removed": {
          const socket = socketOf.get(ch.componentId) ?? this.constructions.socketOf(ch.componentId);
          if (!socket) break;
          const stood = this.constructions.raze(ch.componentId, socket, !historical);
          this.releaseBuilder(ch.componentId);
          if (!historical && stood) {
            this.examine(`the ${oldLabels.get(ch.componentId) ?? label} is razed to rubble (${source})`);
          }
          break;
        }
        case "traits": {
          const socket = socketOf.get(ch.componentId);
          if (!socket) break;
          const wasScaffold = this.constructions.stateOf(ch.componentId) === "scaffold";
          const res = this.constructions.applyTraits(ch.componentId, socket, !historical);
          if (wasScaffold) this.releaseBuilder(ch.componentId);
          if (historical) break;
          if (wasScaffold) {
            this.examine(`the ${socket.form} of ${label} stands complete (${source})`);
          }
          if (res.tint) {
            const hex = socket.traits.tint ?? socket.traits.banner ?? "its kind's own colors";
            this.examine(`the ${socket.form} of ${label} repainted to ${hex} (${source})`);
          }
          if (res.size) this.examine(`the ${socket.form} of ${label} grows to size ${socket.traits.size} (${source})`);
          if (res.counts) this.examine(`the ${socket.form} of ${label} refits ${countsNote(ch.before, ch.after)} (${source})`);
          break;
        }
        case "form": {
          const socket = socketOf.get(ch.componentId);
          if (!socket) break;
          const wasScaffold = this.constructions.stateOf(ch.componentId) === "scaffold";
          this.constructions.swapForm(ch.componentId, socket, !historical);
          if (wasScaffold) this.releaseBuilder(ch.componentId);
          if (!historical) {
            this.examine(
              `${label} is reformed as a ${socket.form}${ch.cited ? ` — ${ch.cited}` : ""}`,
            );
          }
          break;
        }
        case "genome": {
          // the design vector changed: rebuild this construction in place
          const socket = socketOf.get(ch.componentId);
          if (!socket) break;
          this.constructions.swapForm(ch.componentId, socket, !historical);
          if (!historical) {
            this.examine(`${label} is redressed${ch.cited ? ` — ${ch.cited}` : ""}`);
          }
          break;
        }
      }
    }
    this.rebuildWorks(plan);
  }

  // --- construction theater builders ---------------------------------------------

  private assignBuilder(componentId: string, preferred: string | undefined, historical: boolean): void {
    const pos = this.constructions.worldPos(componentId);
    if (!pos) return;
    let pick: string | null = preferred && this.agents.has(preferred) ? preferred : null;
    if (!pick) {
      let best = Infinity;
      for (const [id, rec] of this.agents) {
        if (rec.role !== "worker" || !IDLE_STATUSES.has(rec.status)) continue;
        const d = Math.hypot(rec.unit.x - pos.x, rec.unit.z - pos.z);
        if (d < best) {
          best = d;
          pick = id;
        }
      }
    }
    if (!pick) return;
    const rec = this.agents.get(pick);
    if (!rec) return;
    this.builders.set(componentId, pick);
    rec.siteComp = componentId;
    rec.unit.walkTo(pos.x + (Math.random() - 0.5), pos.z + 1.1, historical);
    rec.unit.setLabor(true);
  }

  private releaseBuilder(componentId: string): void {
    const agentId = this.builders.get(componentId);
    this.builders.delete(componentId);
    const rec = agentId ? this.agents.get(agentId) : null;
    if (rec && rec.status !== "building") rec.unit.setLabor(false);
  }

  // --- agents ---------------------------------------------------------------------

  private spawnAgent(
    agentId: string,
    role: "orchestrator" | "worker",
    name: string,
    charge: string | null,
    historical: boolean,
  ): void {
    if (this.agents.has(agentId)) return;
    const isKing = role === "orchestrator";
    const charKey = isKing ? "Mage" : this.workerCount++ % 2 === 0 ? "Rogue" : "Barbarian";
    const char = this.assets.chars.get(charKey) ?? this.assets.chars.get("Rogue");
    if (!char) return;
    const unit = new Unit3D(
      char,
      { kind: "unit", id: agentId } satisfies PickInfo,
      name,
      isKing ? "#f0c96a" : "#e8f0f8",
      isKing ? "hero" : "villager",
      isKing ? 0.78 : 0.66,
    );
    unit.groundY = this.ground.heightAt;
    // the court gathers at the foot of the motte; the king keeps the top
    const jitter = () => (Math.random() - 0.5) * 2.4;
    if (isKing) unit.setPosition(0.6, 1.4);
    else unit.setPosition(jitter(), 4.6 + jitter());
    this.scene.add(unit.group);
    this.unitPickables.push(unit.pickMesh);
    this.agents.set(agentId, { unit, role, name, status: "idle", siteComp: null });
    if (!historical && charge) unit.say(charge);
  }

  private walkAgentToPath(agentId: string, path: string, historical: boolean): void {
    const rec = this.agents.get(agentId);
    if (!rec) return;
    const compId = this.pathToComp.get(path) ?? this.componentForTopDir(path);
    if (!compId) return;
    const pos = this.constructions.worldPos(compId);
    if (!pos) return;
    rec.siteComp = compId;
    if (rec.role === "orchestrator") return; // the king holds court at the keep
    rec.unit.walkTo(pos.x + (Math.random() - 0.5) * 1.2, pos.z + 1.2 + (Math.random() - 0.5) * 0.5, historical);
  }

  private componentForTopDir(path: string): string | null {
    const top = path.split("/")[0] ?? "";
    for (const id of this.compCache.keys()) {
      if (id.startsWith(`${top}:`)) return id;
    }
    return null;
  }

  // --- OSRS feel: xp + levels (same surface the match view expects) ---------------

  showXpDrop(agentId: string, skill: string, xp: number, color = 0x62c9e8): void {
    if (!this.agents.has(agentId) || this.particlesOff) return;
    const now = performance.now();
    const start = Math.max(now, this.xpNextAt.get(agentId) ?? 0);
    this.xpNextAt.set(agentId, start + 300);
    const spawn = () => {
      const rec = this.agents.get(agentId);
      if (!rec || this.destroyed) return;
      this.fx.float(`◆ +${xp} ${skill}`, rec.unit.x, rec.unit.z, rec.unit.y + rec.unit.headHeight + 0.3, color, 20);
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
    if (!rec || this.particlesOff) return;
    this.fx.burst(rec.unit.x, rec.unit.y + rec.unit.headHeight + 0.3, rec.unit.z, [0xffd75e, 0xfff2c8, 0xffb347]);
    this.fx.banner(`⚔ ${skill} Level ${level}!`, rec.unit.x, rec.unit.z, rec.unit.y + rec.unit.headHeight + 0.6);
  }

  setSkillStats(agentId: string, stats: { total: number; top: [string, number][] }): void {
    this.skillStats.set(agentId, stats);
  }

  // --- pointer / picking ------------------------------------------------------------

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
    on(
      "wheel",
      (e) => {
        e.preventDefault();
        this.cam.zoomBy(e.deltaY);
      },
      { passive: false },
    );
    on("pointerdown", (e) => {
      const p = this.toLocal(e);
      this.lastPointer = p;
      this.dragged = false;
      if (e.button === 0) this.leftDown = p;
      else if (e.button === 2 || e.button === 1) this.rightDown = true;
    });
    on("pointermove", (e) => {
      const p = this.toLocal(e);
      const dx = p.x - this.lastPointer.x;
      const dy = p.y - this.lastPointer.y;
      this.lastPointer = p;
      const w = this.mount.clientWidth || 800;
      const h = this.mount.clientHeight || 600;
      if (this.rightDown) {
        this.dragged = true;
        this.cam.panPx(dx, dy, w, h);
        return;
      }
      if (this.leftDown) {
        if (this.dragged || Math.hypot(p.x - this.leftDown.x, p.y - this.leftDown.y) > 6) {
          this.dragged = true;
          this.cam.orbitBy(dx, dy);
        }
        return;
      }
      // hover (throttled): name sprite over the hovered construction
      const now = performance.now();
      if (now >= this.nextHoverAt) {
        this.nextHoverAt = now + 140;
        this.updateHover(p.x, p.y);
      }
    });
    on("pointerup", (e) => {
      const p = this.toLocal(e);
      if (e.button === 2 || e.button === 1) {
        this.rightDown = false;
        return;
      }
      if (e.button !== 0) return;
      const wasDrag = this.dragged;
      this.leftDown = null;
      this.dragged = false;
      if (!wasDrag) this.handleClick(p.x, p.y);
    });
    on("pointerleave", () => {
      this.leftDown = null;
      this.rightDown = false;
      this.clearHover();
    });
    on("dblclick", (e) => {
      const p = this.toLocal(e);
      const pick = this.pickAt(p.x, p.y);
      if (pick?.kind === "construction") {
        const top = this.constructions.topOf(pick.componentId);
        if (top) this.cam.focusOn(top.x, top.y / 2, top.z, Math.max(10, top.y * 4));
      }
    });
  }

  private toLocal(e: MouseEvent): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pickAt(px: number, py: number): PickInfo | null {
    const w = this.mount.clientWidth || 800;
    const h = this.mount.clientHeight || 600;
    this.raycaster.setFromCamera(
      new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1),
      this.cam.camera,
    );
    const hits = this.raycaster.intersectObjects(
      [...this.unitPickables, ...this.constructions.pickables],
      false,
    );
    for (const hit of hits) {
      const pick = hit.object.userData.pick as PickInfo | undefined;
      if (pick) return pick;
    }
    return null;
  }

  private handleClick(px: number, py: number): void {
    const pick = this.pickAt(px, py);
    if (!pick) {
      this.inspector.close();
      return;
    }
    if (pick.kind === "unit") {
      this.onSpeak?.(pick.id);
      const provided = this.examineProvider?.("unit", pick.id);
      if (provided) this.examine(provided);
      return;
    }
    if (pick.kind === "construction") this.openInspector(pick.componentId);
  }

  private openInspector(componentId: string): void {
    const comp = this.compCache.get(componentId);
    const socket =
      this.st.plan?.sockets.find((s) => s.componentId === componentId) ??
      this.constructions.socketOf(componentId);
    if (!comp || !socket) return;
    const form = this.constructions.formOf(componentId) ?? socket.form;
    const why = socket.cited ?? defaultWhy(form, comp, socket.traits);
    this.inspector.open(comp, socket, form, why);
    this.examine(`${comp.label} — ${why}`);
  }

  private updateHover(px: number, py: number): void {
    const pick = this.pickAt(px, py);
    const id = pick?.kind === "construction" ? pick.componentId : null;
    if (id === (this.hover?.id ?? null)) return;
    this.clearHover();
    if (!id) {
      this.mount.style.cursor = "";
      return;
    }
    const top = this.constructions.topOf(id);
    if (!top) return;
    const bb = makeBillboard(this.labelOf(id), {
      sizePx: 22,
      color: "#fff6da",
      bg: "rgba(30,22,8,0.72)",
      border: "#c8a84b",
      pad: 6,
      worldH: 0.42,
    });
    bb.sprite.position.set(top.x, top.y + 0.5, top.z);
    this.scene.add(bb.sprite);
    this.hover = { id, bb };
    this.mount.style.cursor = "pointer";
  }

  private clearHover(): void {
    this.hover?.bb.dispose();
    this.hover = null;
  }

  // --- fx -----------------------------------------------------------------------------

  private puff(x: number, y: number, z: number, kind: "dust" | "spark" | "shimmer"): void {
    if (this.particlesOff) return;
    if (kind === "dust") this.fx.burst(x, y, z, [0xcfc4ae, 0xb8ad96, 0xe6dcc6], 22, 1.4);
    else if (kind === "spark") this.fx.burst(x, y, z, [0xffd75e, 0xfff2c8], 10, 1.1);
    else this.fx.burst(x, y, z, [0xffe9a8, 0xfff6d8, 0xffd75e], 30, 1.8); // golden shimmer
  }

  // --- main loop ------------------------------------------------------------------------

  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.clock.getDelta());
    const now = performance.now();
    const w = this.mount.clientWidth || 800;
    const h = this.mount.clientHeight || 600;

    this.cam.update(dt, w, h);
    this.constructions.tick(now, dt);
    this.connectors.tick(dt);
    for (const rec of this.agents.values()) rec.unit.tick(dt, now, this.fpsNow >= 18);
    this.fx.tick(dt);

    // construction theater: 6s scaffolds swap to the real construction
    for (const id of this.constructions.dueScaffolds(now)) {
      const label = this.labelOf(id);
      const form = this.constructions.socketOf(id)?.form ?? "construction";
      this.constructions.completeScaffold(id);
      this.releaseBuilder(id);
      this.examine(`the ${form} of ${label} stands complete`);
    }
    // hammer sparks over active scaffolds
    if (!this.particlesOff && now >= this.sparkNextAt) {
      this.sparkNextAt = now + 650;
      for (const p of this.constructions.scaffoldPositions().slice(0, 3)) {
        this.puff(p.x, p.y + 0.9, p.z, "spark");
      }
    }

    this.renderer.render(this.scene, this.cam.camera);

    // fps window + degrade ladder: shadows first, then particles
    this.fpsFrames++;
    if (now - this.fpsWindowStart >= 1000) {
      this.fpsNow = (this.fpsFrames * 1000) / (now - this.fpsWindowStart);
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
      if (this.fpsNow < 30) {
        this.lowSeconds++;
        if (this.lowSeconds >= 2 && this.renderer.shadowMap.enabled) {
          this.renderer.shadowMap.enabled = false;
          this.sun.castShadow = false;
          this.degraded = true;
          console.info("[perf3d] fps<30 — shadows off");
        } else if (this.lowSeconds >= 4 && !this.particlesOff) {
          this.particlesOff = true;
          console.info("[perf3d] fps<30 — particles off");
        }
      } else {
        this.lowSeconds = 0;
      }
    }
  };
}

function countsNote(before: Traits, after: Traits): string {
  const parts: string[] = [];
  if (before.gates !== after.gates) parts.push(`gates ${before.gates}→${after.gates}`);
  if (before.shafts !== after.shafts) parts.push(`shafts ${before.shafts}→${after.shafts}`);
  if (before.banners !== after.banners) parts.push(`banners ${before.banners}→${after.banners}`);
  if (before.storeys !== after.storeys) parts.push(`storeys ${before.storeys}→${after.storeys}`);
  return parts.join(", ") || "its works";
}

function detectSoftwareGL(): { softwareGL: boolean; glName: string } {
  try {
    const probe = document.createElement("canvas");
    const gl = (probe.getContext("webgl2") ?? probe.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { softwareGL: true, glName: "none" };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const glName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { softwareGL: /swiftshader|llvmpipe|software/i.test(glName), glName };
  } catch {
    return { softwareGL: false, glName: "unknown" };
  }
}
