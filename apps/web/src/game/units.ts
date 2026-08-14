import Phaser from "phaser";
import type { AgentStatus } from "@agent-empires/protocol";
import { shadowTexture, TEX_SCALE } from "./textures.js";

const WALK_SPEED = 150; // world px/s
const BUBBLE_MS = 6500;
const CAPTION_MS = 2400;

const DPR = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);

/** Status → small glyph floated at the unit's shoulder ("…" pulses). */
const STATUS_GLYPHS: Partial<Record<AgentStatus, string>> = {
  thinking: "…",
  building: "⚒",
  scouting: "🔎",
  fighting: "⚔",
};

export class Unit {
  readonly root: Phaser.GameObjects.Container;
  readonly sprite: Phaser.GameObjects.Image;
  private shadow: Phaser.GameObjects.Image;
  private label: Phaser.GameObjects.Text;
  private bubble: Phaser.GameObjects.Container | null = null;
  private bubbleExpiry = 0;
  private glyph: Phaser.GameObjects.Text | null = null;
  private glyphTween: Phaser.Tweens.Tween | null = null;
  private glyphKey: string | null = null;
  private caption: Phaser.GameObjects.Text | null = null;
  private captionTween: Phaser.Tweens.Tween | null = null;
  private walkTween: Phaser.Tweens.Tween | null = null;
  private bobPhase = Math.random() * Math.PI * 2;
  dimmed = false;
  hovered = false;
  /** WorldSpec gaitBounce → walk-bob amplitude multiplier (1 = default). */
  gaitScale = 1;

  constructor(
    private scene: Phaser.Scene,
    textureKey: string,
    name: string,
    x: number,
    y: number,
    labelColor: string,
  ) {
    this.shadow = scene.add.image(0, 1, shadowTexture(scene)).setScale(TEX_SCALE * 1.1);
    this.sprite = scene.add.image(0, 0, textureKey).setOrigin(0.5, 1).setScale(TEX_SCALE);
    this.label = scene.add
      .text(0, 4, shortName(name), {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "11px",
        color: labelColor,
      })
      .setOrigin(0.5, 0)
      .setResolution(DPR);
    this.root = scene.add.container(x, y, [this.shadow, this.sprite, this.label]);
    this.root.setDepth(y);
  }

  get isWalking(): boolean {
    return this.walkTween !== null && this.walkTween.isPlaying();
  }

  /** Top of the sprite in container-local y (for bubbles/glyphs/captions). */
  private headY(): number {
    return -this.sprite.displayHeight - 4;
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

  /** WorldSpec unit tint (multiplies the sprite); undefined clears it. */
  applyTint(color?: number): void {
    if (color === undefined) this.sprite.clearTint();
    else this.sprite.setTint(color);
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

  /**
   * Status indicator over the unit: "…" pulses while thinking, tool glyphs for
   * building/scouting/fighting. One at a time; cleared for idle-ish statuses.
   */
  setStatusGlyph(status: AgentStatus): void {
    const glyph = STATUS_GLYPHS[status] ?? null;
    if (glyph === this.glyphKey) return;
    this.glyphTween?.destroy();
    this.glyphTween = null;
    this.glyph?.destroy();
    this.glyph = null;
    this.glyphKey = glyph;
    if (!glyph) return;
    const t = this.scene.add
      .text(11, this.headY() - 4, glyph, {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: glyph === "…" ? "14px" : "11px",
        color: "#f0e6c8",
        backgroundColor: "rgba(18,14,8,0.75)",
        padding: { x: 4, y: 1 },
      })
      .setOrigin(0.5, 1)
      .setResolution(DPR);
    this.root.add(t);
    this.glyph = t;
    this.glyphTween = this.scene.tweens.add({
      targets: t,
      alpha: glyph === "…" ? 0.3 : 0.65,
      duration: glyph === "…" ? 500 : 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /** Tiny fading progress caption ("reads src/parser.js"); never stacks. */
  showDetail(text: string): void {
    this.captionTween?.destroy();
    this.captionTween = null;
    this.caption?.destroy();
    const short = text.length > 44 ? text.slice(0, 44) + "…" : text;
    const t = this.scene.add
      .text(0, this.headY() - 8, short, {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "9px",
        color: "#d8d2c0",
        backgroundColor: "rgba(18,14,8,0.6)",
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5, 1)
      .setResolution(DPR);
    this.root.add(t);
    this.caption = t;
    this.captionTween = this.scene.tweens.add({
      targets: t,
      y: t.y - 14,
      alpha: 0,
      delay: CAPTION_MS,
      duration: 800,
      ease: "Sine.easeIn",
      onComplete: () => {
        if (this.caption === t) {
          this.caption = null;
          this.captionTween = null;
        }
        t.destroy();
      },
    });
  }

  /** Per-frame bob / fade housekeeping; also keeps depth = screen y. */
  tick(dtMs: number, now: number): void {
    const moving = this.isWalking;
    this.bobPhase += dtMs / (moving ? 90 : 400);
    const bob = Math.sin(this.bobPhase) * (moving ? 2.2 : 0.8) * this.gaitScale;
    this.sprite.setY(bob);
    // shadow stays grounded and squashes slightly as the body lifts
    this.shadow.setScale(TEX_SCALE * 1.1 * (1 - Math.max(0, -bob) * 0.03), TEX_SCALE * 1.1);
    this.root.setAlpha(this.dimmed ? 0.55 : 1);
    this.root.setScale(this.hovered ? 1.06 : 1);
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
    this.glyphTween?.destroy();
    this.captionTween?.destroy();
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
