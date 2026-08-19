// The inspector: a DOM panel inside the mount that turns a clicked
// construction back into its measured facts — label, kind, form, the "why"
// line (the representation loop's citation, or the default law), fact rows,
// palette chips, and the first file paths. Clicking a path hands off to the
// app's inspect flow.
import type { Component } from "../game/components.js";
import type { CastleForm, Socket, Traits } from "../game/castle.js";
import type { BuildingGenome, StyleGenome } from "../game/genome.js";

const MONO = "IBM Plex Mono, monospace";

/** The default-law "why" line per form — every mapping is a measured count. */
export function defaultWhy(form: CastleForm, c: Component, t: Traits): string {
  switch (form) {
    case "keep":
      return `the keep: the castle is built around its largest working part (${c.facts.lines} lines)`;
    case "manor":
      return `the web front is a manor: its measured palette paints roof and banners`;
    case "gatehouse":
      return `a server is a gatehouse: ${c.facts.routes} routes = ${t.gates} gates`;
    case "ore-mine":
      return `a database is an ore mine: ${c.facts.tables} tables = ${t.shafts} shafts`;
    case "enginehouse":
      return `a pipeline is an enginehouse: it drives the rails between the wards`;
    case "smithy":
      return `command tools are a smithy: each invocation hammered out by hand`;
    case "foundry":
      return `a shared library is a foundry: every ward draws from its castings`;
    case "training-yard":
      return `tests are a training yard: ${c.facts.testFiles} test files = ${t.banners} banners`;
    case "library-tower":
      return `docs are a library tower: ${c.facts.lines} lines stack ${t.storeys} storeys`;
    case "signal-tower":
      return `config is a signal tower: decrees posted for every ward to read`;
    case "reliquary":
      return `assets are a reliquary: ${c.facts.files} bound relics under guard`;
    case "well":
      return `a small utility: the well the other wards drink from`;
    case "chapel":
      return `a chapel: lore-heavy scrolls kept where the candles stay lit`;
  }
}

/** The genome's notable axes in plain words for the DESIGN section. */
export function describeGenome(g: BuildingGenome): string {
  const storey = `${g.storeys} storey${g.storeys === 1 ? "" : "s"}`;
  const mat = g.material.trim === "none" ? g.material.family : `${g.material.family} + ${g.material.trim}`;
  const dress = g.dressing.propSet === "none" ? "no dressing" : `${g.dressing.propSet} dressing`;
  return `${g.footprint}, ${storey}, ${g.roof.form} roof (${g.roof.pitch}), ${mat}, ${dress}`;
}

export class Inspector {
  private root: HTMLDivElement;
  private panel: HTMLDivElement | null = null;
  private openId: string | null = null;
  onInspect: ((path: string) => void) | null = null;

  constructor(mount: HTMLElement) {
    if (getComputedStyle(mount).position === "static") mount.style.position = "relative";
    this.root = document.createElement("div");
    this.root.dataset.ae3d = "overlay";
    this.root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:6;";
    mount.appendChild(this.root);
  }

  get openComponentId(): string | null {
    return this.openId;
  }

  get openLabel(): string | null {
    return this.panel?.querySelector<HTMLElement>('[data-ae3d="inspector-label"]')?.textContent ?? null;
  }

  get bodyText(): string {
    return this.panel?.textContent ?? "";
  }

  open(component: Component, socket: Socket, form: CastleForm, why: string, style: StyleGenome | null = null): void {
    this.close();
    const f = component.facts;
    const el = document.createElement("div");
    el.dataset.ae3d = "inspector";
    el.style.cssText =
      `position:absolute;top:10px;right:10px;width:264px;max-height:calc(100% - 20px);overflow:auto;` +
      `background:#f3ead2;color:#37290f;border:1px solid #8a6f3a;border-radius:6px;padding:10px 12px;` +
      `font:12px ${MONO};line-height:1.5;pointer-events:auto;box-shadow:0 3px 14px rgba(20,12,2,0.35);`;
    const chip = (hex: string) =>
      `<span data-ae3d="chip" title="${hex}" style="display:inline-block;width:14px;height:14px;border-radius:3px;` +
      `border:1px solid #6b5327;background:${hex};margin-right:4px;vertical-align:-2px;"></span>${hex}`;
    const row = (k: string, v: string) =>
      `<div style="display:flex;gap:6px;"><span style="color:#7a6236;min-width:64px;">${k}</span><span>${v}</span></div>`;
    const paths = component.paths.slice(0, 8);
    el.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:baseline;">` +
      `<strong data-ae3d="inspector-label" style="font-size:13px;">${esc(component.label)}</strong>` +
      `<button data-ae3d="inspector-close" style="border:none;background:none;cursor:pointer;font:inherit;color:#7a6236;">✕</button></div>` +
      `<div style="color:#7a6236;">${esc(component.kind)} · ${esc(form)}${socket.razed ? " · razed" : ""}</div>` +
      `<div data-ae3d="inspector-why" style="margin:7px 0;padding:6px 8px;background:#e7d9b4;border-radius:4px;font-style:italic;">“${esc(why)}”</div>` +
      `<div style="color:#7a6236;">design</div>` +
      (style
        ? `<div data-ae3d="inspector-style" style="font-style:italic;">«${esc(style.name)}» — ${esc(style.cited)}</div>`
        : "") +
      `<div data-ae3d="inspector-design" style="margin-bottom:5px;">${esc(describeGenome(socket.genome))}</div>` +
      row("files", String(f.files)) +
      row("lines", String(f.lines)) +
      (f.routes > 0 ? row("routes", String(f.routes)) : "") +
      (f.tables > 0 ? row("tables", String(f.tables)) : "") +
      (f.testFiles > 0 ? row("tests", String(f.testFiles)) : "") +
      (f.palette.length > 0
        ? `<div style="margin-top:4px;color:#7a6236;">palette</div><div data-ae3d="inspector-palette">${f.palette
            .slice(0, 6)
            .map(chip)
            .join("<br/>")}</div>`
        : "") +
      `<div style="margin-top:6px;color:#7a6236;">paths</div>` +
      paths
        .map(
          (p) =>
            `<div data-ae3d-path="${esc(p)}" style="cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#4c3a15;">${esc(p)}</div>`,
        )
        .join("") +
      (component.paths.length > paths.length
        ? `<div style="color:#7a6236;">… ${component.paths.length - paths.length} more</div>`
        : "");
    el.querySelector<HTMLButtonElement>('[data-ae3d="inspector-close"]')!.onclick = () => this.close();
    el.querySelectorAll<HTMLElement>("[data-ae3d-path]").forEach((n) => {
      n.onclick = () => this.onInspect?.(n.dataset.ae3dPath!);
    });
    this.root.appendChild(el);
    this.panel = el;
    this.openId = component.id;
  }

  close(): void {
    this.panel?.remove();
    this.panel = null;
    this.openId = null;
  }

  destroy(): void {
    this.close();
    this.root.remove();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
