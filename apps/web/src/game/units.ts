import Phaser from "phaser";
import { TEX_SCALE } from "./textures.js";

const WALK_SPEED = 150; // world px/s
const BUBBLE_MS = 6500;

const DPR = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);

export class Unit {
  readonly root: Phaser.GameObjects.Container;
  readonly sprite: Phaser.GameObjects.Image;
  private label: Phaser.GameObjects.Text;
  private bubble: Phaser.GameObjects.Container | null = null;
  private bubbleExpiry = 0;
  private walkTween: Phaser.Tweens.Tween | null = null;
  private bobPhase = Math.random() * Math.PI * 2;
  dimmed = false;

  constructor(
    private scene: Phaser.Scene,
    textureKey: string,
    name: string,
    x: number,
    y: number,
    labelColor: string,
  ) {
    this.sprite = scene.add.image(0, 0, textureKey).setOrigin(0.5, 1).setScale(TEX_SCALE);
    this.label = scene.add
      .text(0, 4, shortName(name), {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "11px",
        color: labelColor,
      })
      .setOrigin(0.5, 0)
      .setResolution(DPR);
    this.root = scene.add.container(x, y, [this.sprite, this.label]);
    this.root.setDepth(y);
  }

  get isWalking(): boolean {
    return this.walkTween !== null && this.walkTween.isPlaying();
  }

  walkTo(x: number, y: number, instant = false): void {
    this.walkTween?.stop();
    this.walkTween = null;
    const dx = x - this.root.x;
    if (Math.abs(dx) > 1) this.sprite.setFlipX(dx < 0);
    const dist = Math.hypot(dx, y - this.root.y);
    if (instant || dist < 2) {
      this.root.setPosition(x, y);
      return;
    }
    this.walkTween = this.scene.tweens.add({
      targets: this.root,
      x,
      y,
      duration: (dist / WALK_SPEED) * 1000,
      ease: "Sine.easeInOut",
      onComplete: () => {
        this.walkTween = null;
      },
    });
  }

  setTexture(key: string): void {
    this.sprite.setTexture(key);
    this.sprite.setScale(TEX_SCALE);
  }

  say(text: string): void {
    this.bubble?.destroy();
    const label = this.scene.add
      .text(0, 0, text.length > 130 ? text.slice(0, 130) + "…" : text, {
        fontFamily: "Georgia, serif",
        fontSize: "12px",
        color: "#2a2013",
        wordWrap: { width: 190 },
      })
      .setResolution(DPR);
    const pad = 7;
    const w = label.width;
    const h = label.height;
    const bg = this.scene.add.graphics();
    bg.fillStyle(0xe8d9b0);
    bg.lineStyle(2, 0x5a4527);
    bg.fillRoundedRect(-w / 2 - pad, -h - pad * 2, w + pad * 2, h + pad * 2, 6);
    bg.strokeRoundedRect(-w / 2 - pad, -h - pad * 2, w + pad * 2, h + pad * 2, 6);
    bg.fillTriangle(-5, -2, 5, -2, 0, 6);
    label.setOrigin(0.5, 1);
    label.setY(-pad);
    const bubble = this.scene.add.container(0, -34, [bg, label]);
    this.root.add(bubble);
    this.bubble = bubble;
    this.bubbleExpiry = this.scene.time.now + BUBBLE_MS;
  }

  /** Per-frame bob / fade housekeeping; also keeps depth = screen y. */
  tick(dtMs: number, now: number): void {
    const moving = this.isWalking;
    this.bobPhase += dtMs / (moving ? 90 : 400);
    this.sprite.setY(Math.sin(this.bobPhase) * (moving ? 2.2 : 0.8));
    this.root.setAlpha(this.dimmed ? 0.55 : 1);
    this.root.setDepth(this.root.y);

    if (this.bubble) {
      const remaining = this.bubbleExpiry - now;
      if (remaining <= 0) {
        this.bubble.destroy();
        this.bubble = null;
      } else if (remaining < 800) {
        this.bubble.setAlpha(remaining / 800);
      }
    }
  }

  destroy(): void {
    this.walkTween?.stop();
    this.walkTween = null;
    this.root.destroy();
  }

  get x(): number {
    return this.root.x;
  }
  get y(): number {
    return this.root.y;
  }
}

/** "Ashka the Unsleeping" → "Ashka"; "The Hierophant" → "Hierophant". */
export function shortName(name: string): string {
  const words = name.split(" ");
  const first = words[0]!;
  return /^(the|a|an|of)$/i.test(first) && words[1] ? words[1] : first;
}
