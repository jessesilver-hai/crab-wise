import Phaser from "phaser";
import type { AgentStatus } from "@agent-empires/protocol";
import { shadowTexture, TEX_SCALE } from "./textures.js";
import {
  ACTOR_FEET_Y,
  ActorKey,
  actorTexKey,
  CitizenDef,
  citizenAnimId,
  Dir8,
  dir8FromDelta,
  SHEET,
} from "./atlas.js";

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

export type UnitAppearance =
  | { kind: "citizen"; def: CitizenDef }
  | { kind: "actor"; actor: ActorKey };

/**
 * An animated walker: SketchyLogic citizens (4-way: front/back frames plus
 * horizontal flip) or Bellanger actors (true 8-direction sheets). Owns its
 * shadow, selection ring, name label, speech bubble, status glyph, and
 * fading detail caption.
 */
export class SpriteUnit {
  readonly root: Phaser.GameObjects.Container;
  readonly sprite: Phaser.GameObjects.Sprite;
  appearance: UnitAppearance;
  private shadow: Phaser.GameObjects.Image;
  private ring: Phaser.GameObjects.Image;
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
  private facing: Dir8 = "se";
  private laborState = false;
  private dying = false;
  dimmed = false;
  hovered = false;
  /** WorldSpec gaitBounce → walk-bob amplitude multiplier (1 = default). */
  gaitScale = 1;
  walkSpeed = 90;

  constructor(
    private scene: Phaser.Scene,
    appearance: UnitAppearance,
    name: string,
    x: number,
    y: number,
    labelColor: string,
    ringTexture: string,
  ) {
    this.appearance = appearance;
    const big = appearance.kind === "actor";
    this.ring = scene.add
      .image(0, 1, ringTexture)
      .setScale(big ? 1.5 : 1)
      .setVisible(false);
    this.shadow = scene.add
      .image(0, 1, shadowTexture(scene))
      .setScale(TEX_SCALE * (big ? 2 : 1.1));
    this.sprite = scene.add.sprite(0, 0, this.baseTexture(), this.idleFrame());
    this.sprite.setOrigin(0.5, big ? ACTOR_FEET_Y : 1);
    this.label = scene.add
      .text(0, 4, shortName(name), {
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: "11px",
        color: labelColor,
      })
      .setOrigin(0.5, 0)
      .setResolution(DPR);
    this.root = scene.add.container(x, y, [this.ring, this.shadow, this.sprite, this.label]);
    this.root.setDepth(y);
    this.applyFacing(false);
  }

  private baseTexture(): string {
    return this.appearance.kind === "actor" ? actorTexKey(this.appearance.actor) : SHEET.citizens;
  }

  private idleFrame(): string | number {
    if (this.appearance.kind === "actor") return 0;
    return this.appearance.def.frontIdle;
  }

  get isWalking(): boolean {
    return this.walkTween !== null && this.walkTween.isPlaying();
  }

  get x(): number {
    return this.root.x;
  }
  get y(): number {
    return this.root.y;
  }

  /** Top of the sprite in container-local y (for bubbles/glyphs/captions). */
  private headY(): number {
    if (this.appearance.kind === "actor") return -this.sprite.displayHeight * ACTOR_FEET_Y + 66;
    return -this.sprite.displayHeight - 4;
  }

  setSelected(on: boolean): void {
    this.ring.setVisible(on);
  }

  setAppearance(appearance: UnitAppearance): void {
    this.appearance = appearance;
    const big = appearance.kind === "actor";
    this.sprite.setTexture(this.baseTexture(), this.idleFrame());
    this.sprite.setOrigin(0.5, big ? ACTOR_FEET_Y : 1);
    this.shadow.setScale(TEX_SCALE * (big ? 2 : 1.1));
    this.applyFacing(this.isWalking);
  }

  /** WorldSpec unit tint (multiplies the sprite); undefined clears it. */
  applyTint(color?: number): void {
    if (color === undefined) this.sprite.clearTint();
    else this.sprite.setTint(color);
  }

  private applyFacing(moving: boolean): void {
    if (this.dying) return;
    if (this.appearance.kind === "actor") {
      const key = `a-${this.appearance.actor}-${moving ? "walk" : this.laborState ? "cast" : "idle"}-${this.facing}`;
      if (this.sprite.anims.currentAnim?.key !== key) this.sprite.play(key);
      this.sprite.setFlipX(false);
      return;
    }
    // citizens: front rows natively face screen-left-down, back rows face
    // screen-right-up; flip to cover the other two quadrants
    const front = this.facing === "s" || this.facing === "se" || this.facing === "sw" || this.facing === "e";
    const flip = front ? this.facing === "se" || this.facing === "e" : this.facing === "nw" || this.facing === "w";
    this.sprite.setFlipX(flip);
    const id = citizenAnimId(this.appearance.def);
    if (moving || this.laborState) {
      const key = `cit-${id}-${front ? "front" : "back"}`;
      if (this.sprite.anims.currentAnim?.key !== key || !this.sprite.anims.isPlaying) {
        this.sprite.play(key);
      }
      this.sprite.anims.timeScale = this.laborState && !moving ? 0.45 : 1;
    } else {
      this.sprite.stop();
      this.sprite.setFrame(front ? this.appearance.def.frontIdle : this.appearance.def.backIdle);
    }
  }

  /** While true (status=building), play a slow in-place work loop. */
  setLabor(on: boolean): void {
    if (this.laborState === on) return;
    this.laborState = on;
    this.applyFacing(this.isWalking);
  }

  walkTo(x: number, y: number, instant = false): void {
    if (this.dying) return;
    this.walkTween?.stop();
    this.walkTween = null;
    const dx = x - this.root.x;
    const dy = y - this.root.y;
    const dist = Math.hypot(dx, dy);
    if (instant || dist < 2) {
      this.root.setPosition(x, y);
      this.applyFacing(false);
      return;
    }
    this.facing = dir8FromDelta(dx, dy);
    this.applyFacing(true);
    this.walkTween = this.scene.tweens.add({
      targets: this.root,
      x,
      y,
      duration: (dist / this.walkSpeed) * 1000,
      ease: "Linear",
      onComplete: () => {
        this.walkTween = null;
        this.applyFacing(false);
      },
    });
  }

  face(dx: number, dy: number): void {
    this.facing = dir8FromDelta(dx, dy);
    this.applyFacing(this.isWalking);
  }

  /** Actors only: play the death animation, then hand back control. */
  die(onDone: () => void): void {
    this.dying = true;
    this.walkTween?.stop();
    this.walkTween = null;
    if (this.appearance.kind === "actor") {
      const key = `a-${this.appearance.actor}-die-${this.facing}`;
      this.sprite.play(key);
      this.scene.tweens.add({ targets: this.root, alpha: 0, delay: 700, duration: 500 });
      this.scene.time.delayedCall(1250, onDone);
    } else {
      this.scene.tweens.add({ targets: this.root, alpha: 0, duration: 400, onComplete: onDone });
    }
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
    const bubble = this.scene.add.container(0, this.headY() - 2, [bg, label]);
    this.root.add(bubble);
    this.bubble = bubble;
    this.bubbleExpiry = this.scene.time.now + BUBBLE_MS;
  }

  /**
   * Status indicator over the unit: "…" pulses while thinking, tool glyphs
   * for building/scouting/fighting. One at a time; cleared for idle-ish.
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

  /** Per-frame housekeeping: bob (citizens laboring), bubbles, depth = y. */
  tick(_dtMs: number, now: number): void {
    const bobbing = this.laborState && this.appearance.kind === "citizen";
    if (bobbing) {
      this.bobPhase += _dtMs / 220;
      this.sprite.setY(Math.sin(this.bobPhase) * 1.6 * this.gaitScale);
    } else if (this.sprite.y !== 0) this.sprite.setY(0);
    this.root.setAlpha(this.dimmed ? 0.55 : 1);
    this.root.setScale(this.hovered ? 1.05 : 1);
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
}

/** "Ashka the Unsleeping" → "Ashka"; "The Hierophant" → "Hierophant". */
export function shortName(name: string): string {
  const words = name.split(" ");
  const first = words[0]!;
  return /^(the|a|an|of)$/i.test(first) && words[1] ? words[1] : first;
}
