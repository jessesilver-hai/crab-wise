import { Application, Container, Sprite, Text } from "pixi.js";
import type { GameEvent } from "@agent-empires/protocol";
import type { Renderer } from "../match-view.js";
import { assignPlot, isoX, isoY, layoutMap, MapLayout, TILE_H } from "./map.js";
import { buildTextures, TextureSet } from "./textures.js";
import { Unit, Floater, makeFloater } from "./units.js";

const FOG_REVEAL_RADIUS = 2;
const CONSTRUCTION_MS = 1400;

export function attachGameRenderer(mount: HTMLElement): Renderer {
  const queue: [GameEvent, boolean][] = [];
  let impl: Game | null = null;
  let destroyed = false;

  Game.create(mount).then((game) => {
    if (destroyed) {
      game.destroy();
      return;
    }
    impl = game;
    for (const [e, h] of queue) game.handleEvent(e, h);
    queue.length = 0;
  });

  return {
    handleEvent(e, historical) {
      if (impl) impl.handleEvent(e, historical);
      else queue.push([e, historical]);
    },
    destroy() {
      destroyed = true;
      impl?.destroy();
    },
  };
}

type Building = { sprite: Sprite; kind: string; builtAt: number };

class Game {
  private world = new Container();
  private ground = new Container();
  private objects = new Container(); // buildings + units, y-sorted
  private fogLayer = new Container();
  private labels = new Container();
  private effects = new Container();

  private textures!: TextureSet;
  private map: MapLayout | null = null;
  private units = new Map<string, Unit>();
  private buildings = new Map<string, Building>();
  private raiders = new Map<string, Unit>();
  private fogTiles = new Map<string, Sprite>();
  private floaters: Floater[] = [];
  private constructing: { building: Building; done: number }[] = [];
  private tokenThrottle = new Map<string, number>();
  private lastNow = performance.now();

  private constructor(private app: Application, private mount: HTMLElement) {}

  static async create(mount: HTMLElement): Promise<Game> {
    const app = new Application();
    await app.init({ background: 0x0d0a06, resizeTo: mount, antialias: true, resolution: window.devicePixelRatio });
    mount.appendChild(app.canvas);
    const game = new Game(app, mount);
    game.textures = buildTextures(app.renderer);
    game.objects.sortableChildren = true;
    game.world.addChild(game.ground, game.objects, game.fogLayer, game.labels, game.effects);
    app.stage.addChild(game.world);
    game.setupCamera();
    app.ticker.add(() => game.tick());
    return game;
  }

  // --- camera --------------------------------------------------------------
  private setupCamera(): void {
    const canvas = this.app.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener("pointerup", () => (dragging = false));
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      this.world.x += e.clientX - lastX;
      this.world.y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const next = Math.min(2.5, Math.max(0.35, this.world.scale.x * factor));
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const wx = (px - this.world.x) / this.world.scale.x;
        const wy = (py - this.world.y) / this.world.scale.y;
        this.world.scale.set(next);
        this.world.x = px - wx * next;
        this.world.y = py - wy * next;
      },
      { passive: false },
    );
  }

  private fitCamera(): void {
    if (!this.map) return;
    const b = this.ground.getLocalBounds();
    const vw = this.mount.clientWidth || 800;
    const vh = this.mount.clientHeight || 600;
    const scale = Math.min(2, Math.min(vw / (b.width + 80), vh / (b.height + 80)));
    this.world.scale.set(scale);
    this.world.x = vw / 2 - (b.x + b.width / 2) * scale;
    this.world.y = vh / 2 - (b.y + b.height / 2) * scale;
  }

  // --- world construction ----------------------------------------------------
  private buildWorld(event: Extract<GameEvent, { type: "match_started" }>): void {
    const map = layoutMap(event.repoTree, event.mapSeed);
    this.map = map;

    for (let ty = 0; ty < map.side; ty++) {
      for (let tx = 0; tx < map.side; tx++) {
        const tile = new Sprite(map.rng() < 0.97 ? this.textures.grass[Math.floor(map.rng() * 4)]! : this.textures.grass[0]!);
        tile.anchor.set(0.5);
        tile.position.set(isoX(tx, ty), isoY(tx, ty));
        this.ground.addChild(tile);

        // trees on unused tiles
        if (!map.used.has(`${tx},${ty}`) && map.rng() < 0.055) {
          map.used.add(`${tx},${ty}`);
          const tree = new Sprite(this.textures.tree);
          tree.anchor.set(0.5, 1);
          tree.position.set(isoX(tx, ty), isoY(tx, ty) + TILE_H / 4);
          tree.zIndex = tree.y;
          this.objects.addChild(tree);
        }

        const fog = new Sprite(this.textures.fog);
        fog.anchor.set(0.5);
        fog.alpha = 0.88;
        fog.position.set(isoX(tx, ty), isoY(tx, ty));
        this.fogLayer.addChild(fog);
        this.fogTiles.set(`${tx},${ty}`, fog);
      }
    }

    // territory labels
    for (const region of map.regions) {
      if ((region.rect.w * region.rect.h) < 6) continue;
      const label = new Text({
        text: region.label,
        style: { fontFamily: "Pirata One, Georgia, serif", fontSize: 15, fill: 0xd4a843 },
      });
      label.alpha = 0.75;
      label.anchor.set(0.5);
      const cx = region.rect.x + region.rect.w / 2;
      const cy = region.rect.y;
      label.position.set(isoX(cx, cy), isoY(cx, cy) - 10);
      this.labels.addChild(label);
    }

    // Town Center stands from the start
    const tc = map.townCenter;
    this.placeBuilding("__towncenter__", "towncenter", tc.tx, tc.ty, true);
    this.reveal(tc.tx, tc.ty, 3);
    this.fitCamera();
  }

  private reveal(tx: number, ty: number, radius: number): void {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > radius + 1) continue;
        const key = `${tx + dx},${ty + dy}`;
        const fog = this.fogTiles.get(key);
        if (fog) {
          fog.destroy();
          this.fogTiles.delete(key);
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

  private placeBuilding(path: string, kind: string, tx: number, ty: number, instant: boolean): Building {
    const existing = this.buildings.get(path);
    const texSet = this.textures.buildings[kind] ?? this.textures.buildings.house!;
    if (existing) {
      if (!instant) {
        existing.sprite.texture = texSet.scaffold;
        this.constructing.push({ building: existing, done: performance.now() + CONSTRUCTION_MS });
      }
      return existing;
    }
    const sprite = new Sprite(instant ? texSet.built : texSet.scaffold);
    sprite.anchor.set(0.5, 1);
    sprite.position.set(isoX(tx, ty), isoY(tx, ty) + TILE_H / 4);
    sprite.zIndex = sprite.y;
    this.objects.addChild(sprite);
    const building: Building = { sprite, kind, builtAt: 0 };
    this.buildings.set(path, building);
    if (!instant) this.constructing.push({ building, done: performance.now() + CONSTRUCTION_MS });
    return building;
  }

  private ping(x: number, y: number): void {
    const s = new Sprite(this.textures.highlight);
    s.anchor.set(0.5);
    s.position.set(x, y);
    this.effects.addChild(s);
    const started = performance.now();
    const fade = () => {
      const t = (performance.now() - started) / 900;
      if (t >= 1 || s.destroyed) {
        if (!s.destroyed) s.destroy();
        return;
      }
      s.alpha = 1 - t;
      s.scale.set(1 + t * 0.5);
      requestAnimationFrame(fade);
    };
    fade();
  }

  private float(text: string, x: number, y: number, color: number): void {
    const f = makeFloater(text, x, y - 24, color, performance.now());
    this.effects.addChild(f.obj);
    this.floaters.push(f);
  }

  // --- event handling --------------------------------------------------------
  handleEvent(e: GameEvent, historical: boolean): void {
    if (e.type === "match_started") {
      this.buildWorld(e);
      return;
    }
    if (!this.map) return;

    switch (e.type) {
      case "agent_spawned": {
        const tc = this.map.townCenter;
        const jitter = () => (Math.random() - 0.5) * 50;
        const unit = new Unit(
          e.role === "orchestrator" ? this.textures.king : this.textures.villager,
          e.name,
          isoX(tc.tx, tc.ty) + jitter(),
          isoY(tc.tx, tc.ty) + 26 + jitter() / 2,
          e.role === "orchestrator" ? 0xf0c96a : 0xd8e4ec,
        );
        this.objects.addChild(unit.root);
        this.units.set(e.agentId, unit);
        if (!historical && e.charge) unit.say(e.charge);
        break;
      }
      case "agent_moved": {
        const unit = this.units.get(e.agentId);
        const pos = this.posForPath(e.path);
        unit?.walkTo(pos.x + (Math.random() - 0.5) * 24, pos.y + 18, historical);
        this.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS);
        break;
      }
      case "file_read": {
        const pos = this.posForPath(e.path);
        this.reveal(pos.tx, pos.ty, 1);
        if (!historical) this.ping(pos.x, pos.y);
        break;
      }
      case "list_dir": {
        const pos = this.posForPath(e.path);
        this.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS + 1);
        break;
      }
      case "search": {
        for (const path of e.paths.slice(0, 10)) {
          const pos = this.posForPath(path);
          this.reveal(pos.tx, pos.ty, 1);
          if (!historical) this.ping(pos.x, pos.y);
        }
        break;
      }
      case "file_write": {
        const pos = this.posForPath(e.path);
        this.reveal(pos.tx, pos.ty, FOG_REVEAL_RADIUS);
        this.placeBuilding(e.path, e.buildingKind, pos.tx, pos.ty, historical);
        if (!historical) this.float(`+${e.linesAdded}`, pos.x, pos.y, 0x9ecf7a);
        break;
      }
      case "command_result": {
        if (e.kind !== "test") break;
        this.reconcileRaiders(e.failures ?? [], historical);
        if ((e.testsFailed ?? 0) === 0 && !historical) {
          const tc = this.map.townCenter;
          this.float("⚑ tests green!", isoX(tc.tx, tc.ty), isoY(tc.tx, tc.ty) - 40, 0x9ecf7a);
        }
        break;
      }
      case "message": {
        if (!historical) this.units.get(e.fromId)?.say(e.text);
        break;
      }
      case "compaction": {
        const unit = this.units.get(e.agentId);
        const tc = this.map.townCenter;
        unit?.walkTo(isoX(tc.tx, tc.ty) + 30, isoY(tc.tx, tc.ty) + 30, historical);
        if (unit && !historical) this.float("🍖", unit.x, unit.y, 0xc98d5a);
        break;
      }
      case "tokens": {
        if (historical) break;
        const n = (this.tokenThrottle.get(e.agentId) ?? 0) + 1;
        this.tokenThrottle.set(e.agentId, n);
        const unit = this.units.get(e.agentId);
        if (unit && n % 3 === 0) {
          this.float(`+${e.inputTokens + e.outputTokens}🪙`, unit.x, unit.y, 0xf0c96a);
        }
        break;
      }
      case "agent_done": {
        const unit = this.units.get(e.agentId);
        if (unit) {
          const tc = this.map.townCenter;
          unit.walkTo(isoX(tc.tx, tc.ty) + (Math.random() - 0.5) * 70, isoY(tc.tx, tc.ty) + 34, historical);
          unit.dimmed = true;
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

  private reconcileRaiders(failures: { name: string; path?: string }[], historical: boolean): void {
    const map = this.map!;
    const nextKeys = new Set(failures.map((f) => `${f.path ?? "?"}::${f.name}`));
    for (const [key, raider] of this.raiders) {
      if (!nextKeys.has(key)) {
        if (!historical) this.float("✕", raider.x, raider.y - 10, 0xd4a843);
        raider.root.destroy();
        this.raiders.delete(key);
      }
    }
    for (const f of failures) {
      const key = `${f.path ?? "?"}::${f.name}`;
      if (this.raiders.has(key)) continue;
      const anchor = f.path ? this.posForPath(f.path) : (() => {
        const tc = map.townCenter;
        return { x: isoX(tc.tx, tc.ty), y: isoY(tc.tx, tc.ty), tx: tc.tx, ty: tc.ty };
      })();
      this.reveal(anchor.tx, anchor.ty, 1);
      const raider = new Unit(
        this.textures.raider,
        "raider",
        anchor.x + (Math.random() - 0.5) * 70,
        anchor.y + 20 + (Math.random() - 0.5) * 30,
        0xc0483c,
      );
      this.objects.addChild(raider.root);
      this.raiders.set(key, raider);
      if (!historical) this.float("⚔", anchor.x, anchor.y, 0xc0483c);
    }
  }

  private raiseWonder(historical: boolean): void {
    const map = this.map!;
    // The wonder rises beside the Town Center.
    const tc = map.townCenter;
    const wonder = new Sprite(this.textures.wonder);
    wonder.anchor.set(0.5, 1);
    wonder.position.set(isoX(tc.tx + 3, tc.ty + 3), isoY(tc.tx + 3, tc.ty + 3) + TILE_H / 4);
    wonder.zIndex = wonder.y;
    this.objects.addChild(wonder);
    this.reveal(tc.tx + 3, tc.ty + 3, 4);
    for (const [, raider] of this.raiders) raider.root.destroy();
    this.raiders.clear();
    if (!historical) {
      for (let i = 0; i < 26; i++) {
        setTimeout(() => {
          if (wonder.destroyed) return;
          this.float("✦", wonder.x + (Math.random() - 0.5) * 160, wonder.y - Math.random() * 120, 0xf0c96a);
        }, i * 120);
      }
    }
  }

  private stageDefeat(): void {
    const map = this.map!;
    const tc = map.townCenter;
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const raider = new Unit(
        this.textures.raider,
        "raider",
        isoX(tc.tx, tc.ty) + Math.cos(angle) * 80,
        isoY(tc.tx, tc.ty) + 24 + Math.sin(angle) * 40,
        0xc0483c,
      );
      this.objects.addChild(raider.root);
      this.raiders.set(`victory-lap-${i}`, raider);
    }
  }

  // --- frame tick --------------------------------------------------------------
  private tick(): void {
    const now = performance.now();
    const dt = Math.min(100, now - this.lastNow);
    this.lastNow = now;

    for (const unit of this.units.values()) unit.root.zIndex = unit.tick(dt, now);
    for (const raider of this.raiders.values()) {
      raider.root.zIndex = raider.tick(dt, now);
      if (Math.random() < 0.008) {
        raider.walkTo(raider.x + (Math.random() - 0.5) * 40, raider.y + (Math.random() - 0.5) * 20);
      }
    }

    const doneBuilding = this.constructing.filter((c) => c.done <= now);
    if (doneBuilding.length) {
      this.constructing = this.constructing.filter((c) => c.done > now);
      for (const { building } of doneBuilding) {
        const texSet = this.textures.buildings[building.kind] ?? this.textures.buildings.house!;
        building.sprite.texture = texSet.built;
        building.sprite.scale.set(1.15);
        const shrink = () => {
          if (building.sprite.destroyed) return;
          building.sprite.scale.set(Math.max(1, building.sprite.scale.x - 0.015));
          if (building.sprite.scale.x > 1) requestAnimationFrame(shrink);
        };
        shrink();
      }
    }

    this.floaters = this.floaters.filter((f) => {
      if (f.expiry <= now || f.obj.destroyed) {
        if (!f.obj.destroyed) f.obj.destroy();
        return false;
      }
      f.obj.y += (f.vy * dt) / 1000;
      f.obj.alpha = Math.min(1, (f.expiry - now) / 700);
      return true;
    });
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }
}
