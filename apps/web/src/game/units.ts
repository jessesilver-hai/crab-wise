import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";

const WALK_SPEED = 150; // px/s
const BUBBLE_MS = 6500;

export class Unit {
  readonly root = new Container();
  private sprite: Sprite;
  private bubble: Container | null = null;
  private bubbleExpiry = 0;
  private targetX: number;
  private targetY: number;
  private bobPhase = Math.random() * Math.PI * 2;
  dimmed = false;

  constructor(texture: Texture, name: string, x: number, y: number, labelColor: number) {
    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5, 1);
    this.root.addChild(this.sprite);

    const label = new Text({
      text: shortName(name),
      style: { fontFamily: "IBM Plex Mono, monospace", fontSize: 11, fill: labelColor },
    });
    label.anchor.set(0.5, 0);
    label.y = 4;
    this.root.addChild(label);

    this.root.position.set(x, y);
    this.targetX = x;
    this.targetY = y;
  }

  walkTo(x: number, y: number, instant = false): void {
    this.targetX = x;
    this.targetY = y;
    if (instant) this.root.position.set(x, y);
  }

  setTexture(texture: Texture): void {
    this.sprite.texture = texture;
  }

  say(text: string): void {
    this.bubble?.destroy();
    const bubble = new Container();
    const label = new Text({
      text: text.length > 130 ? text.slice(0, 130) + "…" : text,
      style: {
        fontFamily: "Georgia, serif",
        fontSize: 12,
        fill: 0x2a2013,
        wordWrap: true,
        wordWrapWidth: 190,
      },
    });
    const pad = 7;
    const bg = new Graphics();
    bg.roundRect(-label.width / 2 - pad, -label.height - pad * 2, label.width + pad * 2, label.height + pad * 2, 6)
      .fill(0xe8d9b0)
      .stroke({ color: 0x5a4527, width: 2 });
    bg.moveTo(-5, -2).lineTo(5, -2).lineTo(0, 6).closePath().fill(0xe8d9b0);
    label.anchor.set(0.5, 1);
    label.y = -pad;
    bubble.addChild(bg, label);
    bubble.y = -34;
    this.root.addChild(bubble);
    this.bubble = bubble;
    this.bubbleExpiry = performance.now() + BUBBLE_MS;
  }

  /** Returns current zIndex hint (screen y) after moving. */
  tick(dtMs: number, now: number): number {
    const dx = this.targetX - this.root.x;
    const dy = this.targetY - this.root.y;
    const dist = Math.hypot(dx, dy);
    const moving = dist > 2;
    if (moving) {
      const step = Math.min(dist, (WALK_SPEED * dtMs) / 1000);
      this.root.x += (dx / dist) * step;
      this.root.y += (dy / dist) * step;
    }
    this.bobPhase += dtMs / (moving ? 90 : 400);
    this.sprite.y = Math.sin(this.bobPhase) * (moving ? 2.2 : 0.8);
    this.root.alpha = this.dimmed ? 0.55 : 1;

    if (this.bubble) {
      const remaining = this.bubbleExpiry - now;
      if (remaining <= 0) {
        this.bubble.destroy();
        this.bubble = null;
      } else if (remaining < 800) {
        this.bubble.alpha = remaining / 800;
      }
    }
    return this.root.y;
  }

  get x(): number {
    return this.root.x;
  }
  get y(): number {
    return this.root.y;
  }
}

/** "Ashka the Unsleeping" → "Ashka"; "The Hierophant" → "Hierophant". */
function shortName(name: string): string {
  const words = name.split(" ");
  const first = words[0]!;
  return /^(the|a|an|of)$/i.test(first) && words[1] ? words[1] : first;
}

export type Floater = { obj: Text; vy: number; expiry: number };

export function makeFloater(text: string, x: number, y: number, color: number, now: number): Floater {
  const obj = new Text({
    text,
    style: { fontFamily: "IBM Plex Mono, monospace", fontSize: 13, fill: color, fontWeight: "600" },
  });
  obj.anchor.set(0.5, 1);
  obj.position.set(x, y);
  return { obj, vy: -28, expiry: now + 1600 };
}
