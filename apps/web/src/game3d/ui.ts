// DOM overlays inside the game mount: OSRS-style hover action text, the
// "Choose Option" context menu, examine parchment toasts, and the minimap.
// All styling is inline so the 3D renderer ships without stylesheet edits.
import type { MapLayout } from "../game/map.js";
import { cssHex } from "./util.js";

export type MenuEntry = { label: string; cb: (() => void) | null };

export type MiniDot = { tx: number; ty: number; color: string; big?: boolean };

const MONO = "IBM Plex Mono, monospace";
const MINI_PX = 176;

export class Overlay {
  private root: HTMLDivElement;
  private actionMain: HTMLSpanElement;
  private actionSub: HTMLSpanElement;
  private menuEl: HTMLDivElement | null = null;
  private menuEntries: MenuEntry[] = [];
  private toast: HTMLDivElement | null = null;
  private toastTimer: number | null = null;
  private mini: HTMLCanvasElement;
  private miniBase: HTMLCanvasElement;
  private miniShown = true;
  private side = 1;
  private onJump: (tx: number, ty: number) => void;

  constructor(mount: HTMLElement, onJump: (tx: number, ty: number) => void) {
    this.onJump = onJump;
    if (getComputedStyle(mount).position === "static") mount.style.position = "relative";
    this.root = document.createElement("div");
    this.root.dataset.ae3d = "overlay";
    this.root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5;";
    mount.appendChild(this.root);

    const action = document.createElement("div");
    action.dataset.ae3d = "action";
    action.style.cssText = `position:absolute;top:8px;left:10px;font:bold 12px ${MONO};color:#ffe93b;` +
      "text-shadow:1px 1px 2px #000;white-space:nowrap;";
    this.actionMain = document.createElement("span");
    this.actionSub = document.createElement("span");
    this.actionSub.style.cssText = "color:#a89f8c;font-weight:normal;";
    action.append(this.actionMain, this.actionSub);
    this.root.appendChild(action);

    this.mini = document.createElement("canvas");
    this.mini.dataset.ae3d = "minimap";
    this.mini.width = MINI_PX;
    this.mini.height = MINI_PX;
    this.mini.style.cssText =
      `position:absolute;right:10px;bottom:10px;width:${MINI_PX}px;height:${MINI_PX}px;` +
      "border:1px solid #8a744a;border-radius:4px;background:#0b0906;pointer-events:auto;cursor:crosshair;";
    this.mini.addEventListener("pointerdown", (e) => {
      const r = this.mini.getBoundingClientRect();
      const tx = ((e.clientX - r.left) / r.width) * this.side;
      const ty = ((e.clientY - r.top) / r.height) * this.side;
      this.onJump(tx, ty);
      e.stopPropagation();
    });
    this.root.appendChild(this.mini);
    this.miniBase = document.createElement("canvas");
    this.miniBase.width = MINI_PX;
    this.miniBase.height = MINI_PX;
  }

  setAction(main: string, sub: string): void {
    if (this.actionMain.textContent !== main) this.actionMain.textContent = main;
    const s = sub ? ` ${sub}` : "";
    if (this.actionSub.textContent !== s) this.actionSub.textContent = s;
  }

  get menuOpen(): boolean {
    return this.menuEl !== null;
  }

  openMenu(entries: MenuEntry[], x: number, y: number): void {
    this.closeMenu();
    this.menuEntries = entries;
    const el = document.createElement("div");
    el.dataset.ae3d = "menu";
    el.style.cssText =
      `position:absolute;min-width:130px;background:#171208;border:1px solid #c8a84b;` +
      `font:11px ${MONO};color:#e4dcc4;pointer-events:auto;z-index:20;padding-bottom:4px;`;
    const head = document.createElement("div");
    head.textContent = "Choose Option";
    head.style.cssText = "background:#2a1f0f;color:#c8a86b;font-weight:bold;padding:3px 8px;";
    el.appendChild(head);
    entries.forEach((entry, i) => {
      const row = document.createElement("div");
      row.dataset.ae3dRow = String(i);
      row.textContent = entry.label;
      row.style.cssText =
        `padding:2px 8px;cursor:pointer;white-space:nowrap;color:${i === 0 && entry.cb ? "#ffe9a8" : "#e4dcc4"};`;
      row.addEventListener("pointerenter", () => (row.style.background = "rgba(200,168,75,0.22)"));
      row.addEventListener("pointerleave", () => (row.style.background = "transparent"));
      row.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.closeMenu();
        entry.cb?.();
      });
      el.appendChild(row);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.root.appendChild(el);
    const rw = this.root.clientWidth || 800;
    const rh = this.root.clientHeight || 600;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(4, Math.min(rw - w - 4, Math.round(x - w / 2)))}px`;
    el.style.top = `${Math.max(4, Math.min(rh - h - 4, Math.round(y - 6)))}px`;
    this.menuEl = el;
  }

  closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
    this.menuEntries = [];
  }

  currentMenuEntries(): MenuEntry[] {
    return this.menuEntries;
  }

  showExamine(text: string, x: number, y: number): void {
    this.toast?.remove();
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    const el = document.createElement("div");
    el.dataset.ae3d = "examine";
    el.textContent = text;
    el.style.cssText =
      `position:absolute;max-width:230px;background:#e8d9b0;color:#3b2d17;border:1px solid #5a4527;` +
      `border-radius:5px;padding:8px 10px;font:11px ${MONO};line-height:1.5;opacity:0;transition:opacity .15s;z-index:15;`;
    this.root.appendChild(el);
    const rw = this.root.clientWidth || 800;
    const rh = this.root.clientHeight || 600;
    el.style.left = `${Math.max(4, Math.min(rw - el.offsetWidth - 4, x + 10))}px`;
    el.style.top = `${Math.max(4, Math.min(rh - el.offsetHeight - 4, y + 12))}px`;
    requestAnimationFrame(() => (el.style.opacity = "1"));
    this.toast = el;
    this.toastTimer = window.setTimeout(() => {
      el.style.opacity = "0";
      this.toastTimer = window.setTimeout(() => el.remove(), 400);
    }, 2600);
  }

  /** Ephemeral gold title banner (district patch names, level-ups echo). */
  showTitle(text: string, accent: number): void {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      `position:absolute;top:16%;left:50%;transform:translateX(-50%);font:16px Cinzel, Georgia, serif;` +
      `letter-spacing:2px;color:${cssHex(accent)};text-shadow:1px 1px 3px #000;opacity:0;transition:opacity .8s;z-index:12;`;
    this.root.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = "0.95"));
    window.setTimeout(() => {
      el.style.opacity = "0";
      window.setTimeout(() => el.remove(), 900);
    }, 3600);
  }

  // --- minimap ---------------------------------------------------------------

  toggleMinimap(): void {
    this.miniShown = !this.miniShown;
    this.mini.style.display = this.miniShown ? "block" : "none";
  }

  get minimapShown(): boolean {
    return this.miniShown;
  }

  /** Bake the static layout underlay once per world/theme change. */
  bakeMinimap(map: MapLayout, tileColors: Int32Array): void {
    this.side = map.side;
    const ctx = this.miniBase.getContext("2d")!;
    const px = MINI_PX / map.side;
    ctx.clearRect(0, 0, MINI_PX, MINI_PX);
    for (let ty = 0; ty < map.side; ty++) {
      for (let tx = 0; tx < map.side; tx++) {
        ctx.fillStyle = cssHex(tileColors[ty * map.side + tx]!);
        ctx.fillRect(tx * px, ty * px, px + 0.5, px + 0.5);
      }
    }
    ctx.strokeStyle = "rgba(240,230,200,0.35)";
    ctx.lineWidth = 1;
    for (const q of map.quarters) {
      if (q.depth > 2) continue;
      ctx.strokeRect(q.rect.x * px, q.rect.y * px, q.rect.w * px, q.rect.h * px);
    }
  }

  paintMinimap(
    dots: MiniDot[],
    camPoly: { x: number; y: number }[] | null,
    fogAlphaAt: (tx: number, ty: number) => number,
  ): void {
    if (!this.miniShown) return;
    const ctx = this.mini.getContext("2d")!;
    const px = MINI_PX / this.side;
    ctx.clearRect(0, 0, MINI_PX, MINI_PX);
    ctx.drawImage(this.miniBase, 0, 0);
    // fog
    for (let ty = 0; ty < this.side; ty++) {
      for (let tx = 0; tx < this.side; tx++) {
        const a = fogAlphaAt(tx, ty);
        if (a > 0.02) {
          ctx.fillStyle = `rgba(4,3,2,${Math.min(0.85, a * 1.25)})`;
          ctx.fillRect(tx * px, ty * px, px + 0.5, px + 0.5);
        }
      }
    }
    for (const d of dots) {
      ctx.fillStyle = d.color;
      const r = d.big ? 2.6 : 1.5;
      ctx.beginPath();
      ctx.arc(d.tx * px, d.ty * px, r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (camPoly && camPoly.length === 4) {
      ctx.strokeStyle = "rgba(255,240,200,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      camPoly.forEach((p, i) => {
        const sx = p.x * px;
        const sy = p.y * px;
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }

  destroy(): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.root.remove();
  }
}
