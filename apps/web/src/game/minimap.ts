import Phaser from "phaser";
import { isoX, isoY, Rect, TILE_H, TILE_W } from "./map.js";

/**
 * Diamond minimap pinned to the bottom-right of the canvas: baked terrain
 * colors, a fog mask refreshed at ~1 Hz, live dots for buildings/units/
 * raiders, the camera viewport diamond, and click/drag-to-jump.
 */

export type MiniDot = { x: number; y: number; color: number; big?: boolean };

const PAD = 12;

export class Minimap {
  readonly width: number;
  readonly height: number;
  private container: Phaser.GameObjects.Container;
  private base: Phaser.GameObjects.Image;
  private structG: Phaser.GameObjects.Graphics;
  private fogG: Phaser.GameObjects.Graphics;
  private dotsG: Phaser.GameObjects.Graphics;
  private frameG: Phaser.GameObjects.Graphics;
  private side: number;
  private texKey: string;
  shown = true;

  constructor(
    private scene: Phaser.Scene,
    side: number,
    miniColors: Uint32Array,
    depth: number,
    width = 176,
  ) {
    this.side = side;
    this.width = width;
    this.height = width / 2;
    this.texKey = `minimap-base-${Date.now().toString(36)}`;
    this.base = scene.add.image(0, 0, this.bake(miniColors)).setOrigin(0, 0);
    this.base.setDisplaySize(this.width, this.height);
    this.structG = scene.add.graphics();
    this.fogG = scene.add.graphics();
    this.dotsG = scene.add.graphics();
    this.frameG = scene.add.graphics();
    this.frameG.lineStyle(1.5, 0x8a7a58, 0.9);
    this.frameG.strokeRect(-1, -1, this.width + 2, this.height + 2);
    this.container = scene.add
      .container(0, 0, [this.base, this.structG, this.fogG, this.dotsG, this.frameG])
      .setScrollFactor(0)
      .setDepth(depth);
    this.layout();
    scene.scale.on("resize", () => this.layout());
  }

  /** Re-bake the terrain underlay (theme tints change ground colors). */
  rebake(miniColors: Uint32Array, tint?: number): void {
    this.base.setTexture(this.bake(miniColors));
    this.base.setDisplaySize(this.width, this.height);
    if (tint !== undefined) this.base.setTint(tint);
    else this.base.clearTint();
  }

  private bake(miniColors: Uint32Array): string {
    const s = this.scene;
    if (s.textures.exists(this.texKey)) s.textures.remove(this.texKey);
    const side = this.side;
    const canvas = document.createElement("canvas");
    canvas.width = side * 2;
    canvas.height = side;
    const ctx = canvas.getContext("2d")!;
    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const c = miniColors[ty * side + tx]!;
        ctx.fillStyle = `#${c.toString(16).padStart(6, "0")}`;
        const mx = tx - ty + side - 1;
        const my = (tx + ty) / 2;
        ctx.fillRect(mx, my, 2, 1);
      }
    }
    s.textures.addCanvas(this.texKey, canvas);
    return this.texKey;
  }

  private layout(): void {
    this.container.setPosition(
      (this.scene.scale.width || 800) - this.width - PAD,
      (this.scene.scale.height || 600) - this.height - PAD,
    );
  }

  setShown(on: boolean): void {
    this.shown = on;
    this.container.setVisible(on);
  }

  /** World (scene) coords → minimap-local pixel coords. */
  private worldToMini(wx: number, wy: number): { x: number; y: number } {
    const halfW = (this.side * TILE_W) / 2;
    const fullH = this.side * TILE_H;
    return {
      x: ((wx + halfW) / (halfW * 2)) * this.width,
      y: (wy / fullH) * this.height,
    };
  }

  private miniToWorld(mx: number, my: number): { x: number; y: number } {
    const halfW = (this.side * TILE_W) / 2;
    const fullH = this.side * TILE_H;
    return {
      x: (mx / this.width) * halfW * 2 - halfW,
      y: (my / this.height) * fullH,
    };
  }

  /** Is this screen point inside the minimap? Returns local coords if so. */
  hit(px: number, py: number): { x: number; y: number } | null {
    if (!this.shown) return null;
    const lx = px - this.container.x;
    const ly = py - this.container.y;
    if (lx < 0 || ly < 0 || lx > this.width || ly > this.height) return null;
    return { x: lx, y: ly };
  }

  /** Center the camera on a minimap-local point. */
  jump(cam: Phaser.Cameras.Scene2D.Camera, lx: number, ly: number): void {
    const w = this.miniToWorld(lx, ly);
    cam.centerOn(w.x, w.y);
  }

  /** Treemap silhouette: quarter outlines drawn once over the underlay. */
  setStructure(quarters: { rect: Rect; depth: number }[]): void {
    const g = this.structG;
    g.clear();
    for (const q of quarters) {
      const alpha = q.depth === 1 ? 0.85 : q.depth === 2 ? 0.55 : 0.3;
      g.lineStyle(1, 0xe8dcb8, alpha);
      const { x, y, w, h } = q.rect;
      const pts = [
        this.worldToMini(isoX(x, y), isoY(x, y)),
        this.worldToMini(isoX(x + w - 1, y), isoY(x + w - 1, y)),
        this.worldToMini(isoX(x + w - 1, y + h - 1), isoY(x + w - 1, y + h - 1)),
        this.worldToMini(isoX(x, y + h - 1), isoY(x, y + h - 1)),
      ];
      g.beginPath();
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < 4; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      g.closePath();
      g.strokePath();
    }
  }

  /** Fog mask: dark squares over unexplored tiles (called ~1 Hz). */
  refreshFog(fogAlpha: (tx: number, ty: number) => number): void {
    if (!this.shown) return;
    const g = this.fogG;
    g.clear();
    const side = this.side;
    const sx = this.width / (side * 2);
    const sy = this.height / side;
    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const a = fogAlpha(tx, ty);
        if (a <= 0.05) continue;
        g.fillStyle(0x05060a, Math.min(0.85, a));
        const mx = (tx - ty + side - 1) * sx;
        const my = ((tx + ty) / 2) * sy;
        g.fillRect(mx, my, sx * 2 + 0.5, sy + 0.5);
      }
    }
  }

  /** Live overlay: entity dots + camera viewport (called every frame). */
  update(dots: MiniDot[], cam: Phaser.Cameras.Scene2D.Camera): void {
    if (!this.shown) return;
    const g = this.dotsG;
    g.clear();
    for (const d of dots) {
      const m = this.worldToMini(d.x, d.y);
      g.fillStyle(d.color, 1);
      const r = d.big ? 2.6 : 1.6;
      g.fillRect(m.x - r, m.y - r, r * 2, r * 2);
    }
    const v = cam.worldView;
    const a = this.worldToMini(v.x, v.y);
    const b = this.worldToMini(v.right, v.bottom);
    g.lineStyle(1, 0xf0e6c8, 0.9);
    g.strokeRect(a.x, a.y, Math.max(4, b.x - a.x), Math.max(3, b.y - a.y));
  }

  destroy(): void {
    this.container.destroy();
    if (this.scene.textures.exists(this.texKey)) this.scene.textures.remove(this.texKey);
  }
}
