/**
 * Genome law — the design language of the castle, at combinatorial scale.
 *
 * A construction is no longer a fixed model: it is a BuildingGenome, a vector
 * of bounded axes (massing, roof, material, openings, ornament, dressing)
 * compiled to geometry by the engine. A castle additionally carries one
 * StyleGenome — the coordinated taste (material/roof/trim biases, grounds,
 * wall, nature, fog) that makes a bakery read warm-timbered and a compiler
 * read like an obsidian forge.
 *
 * The Law of Isomorphism is untouched:
 *   - measured slots stay measured: size/tier, tint, banner, gates, shafts,
 *     storeys band all come from Traits (code facts), and lawClamp() forces
 *     any genome back inside them;
 *   - every non-default genome arrives through the representation loop with
 *     a citation, validated field by field — an unlawful field silently
 *     falls back to the derived default, exactly like unlawful forms;
 *   - absent any choice, deriveGenome() is a pure function of
 *     (kind, traits, id, seed): the castle always stands, deterministically,
 *     and identical inputs hash identical.
 */
import type { ComponentKind } from "./components.js";
import type { Traits } from "./castle.js";

// ---------------------------------------------------------------------------
// Axes — every axis is a closed vocabulary or a bounded integer, so the
// Master Builder's choices are citable, validatable, and countable.
// ---------------------------------------------------------------------------

export const FOOTPRINTS = ["square", "rect", "ell", "tee", "cross", "round", "octagon", "tower"] as const;
export const TAPERS = ["none", "gentle", "stepped", "battered"] as const;
export const ROOF_FORMS = ["gable", "hip", "pyramid", "cone", "onion", "dome", "flat", "sawtooth", "skillion", "pagoda"] as const;
export const ROOF_PITCHES = ["low", "mid", "steep"] as const;
export const ROOF_OVERHANGS = ["none", "eave", "bracketed"] as const;
export const ROOF_CAPS = ["none", "finial", "spike", "orb", "weathervane", "chimney"] as const;
export const MATERIAL_FAMILIES = ["stone", "brick", "timber", "plaster", "obsidian", "sandstone", "copper", "marble", "basalt", "ice"] as const;
export const TRIMS = ["none", "quoins", "halftimber", "ribs", "glowseams", "ivy"] as const;
export const WINDOW_STYLES = ["none", "slit", "arch", "round", "lattice", "grand"] as const;
export const DOOR_STYLES = ["plank", "arch", "portcullis", "double", "rounded"] as const;
export const PROP_SETS = ["none", "bakery", "scholar", "forge", "harbor", "martial", "arcane", "mine", "garden", "trade"] as const;
export const NATURE_SETS = ["pine", "oak", "dead", "palm", "crystal", "mushroom"] as const;
export const WALL_STYLES = ["curtain", "palisade", "hedge", "obsidian"] as const;
export const GROUND_TONES = ["meadow", "scorch", "sand", "snow", "moor", "slate"] as const;
export const FOGS = ["none", "thin", "heavy"] as const;

export type Footprint = (typeof FOOTPRINTS)[number];
export type Taper = (typeof TAPERS)[number];
export type RoofForm = (typeof ROOF_FORMS)[number];
export type RoofPitch = (typeof ROOF_PITCHES)[number];
export type RoofOverhang = (typeof ROOF_OVERHANGS)[number];
export type RoofCap = (typeof ROOF_CAPS)[number];
export type MaterialFamily = (typeof MATERIAL_FAMILIES)[number];
export type Trim = (typeof TRIMS)[number];
export type WindowStyle = (typeof WINDOW_STYLES)[number];
export type DoorStyle = (typeof DOOR_STYLES)[number];
export type PropSet = (typeof PROP_SETS)[number];
export type NatureSet = (typeof NATURE_SETS)[number];
export type WallStyle = (typeof WALL_STYLES)[number];
export type GroundTone = (typeof GROUND_TONES)[number];
export type Fog = (typeof FOGS)[number];

export type BuildingGenome = {
  footprint: Footprint;
  /** Law-banded: clamped to traits.storeys ± 1, within 1..6. */
  storeys: number;
  bays: number; // 1..5
  taper: Taper;
  roof: { form: RoofForm; pitch: RoofPitch; overhang: RoofOverhang; cap: RoofCap };
  material: { family: MaterialFamily; trim: Trim };
  openings: { windows: WindowStyle; door: DoorStyle };
  ornament: {
    crenellated: boolean;
    buttresses: number; // 0..4
    /** Banner cloth always wears the measured secondary palette token. */
    banners: number; // 0..4
    glow: boolean;
    smoke: boolean;
  };
  dressing: { propSet: PropSet; density: number /* 0..3 */ };
};

export type StyleGenome = {
  /** The Master Builder's coinage, e.g. "Oracle-Forge Brutalism". */
  name: string;
  /** Ordered preferences the engine and deriveGenome lean toward. */
  materialBias: MaterialFamily[];
  roofBias: RoofForm[];
  trimBias: Trim[];
  natureSet: NatureSet;
  wallStyle: WallStyle;
  groundTone: GroundTone;
  fog: Fog;
  /** One measured line: why this castle wears this style. */
  cited: string;
};

/** Distinct lawful building permutations (the design-language head count). */
export function permutationCount(): number {
  const massing = FOOTPRINTS.length * 6 * 5 * TAPERS.length;
  const roof = ROOF_FORMS.length * ROOF_PITCHES.length * ROOF_OVERHANGS.length * ROOF_CAPS.length;
  const material = MATERIAL_FAMILIES.length * TRIMS.length;
  const openings = WINDOW_STYLES.length * DOOR_STYLES.length;
  const ornament = 2 * 5 * 5 * 2 * 2;
  const dressing = PROP_SETS.length * 4;
  return massing * roof * material * openings * ornament * dressing;
}

// ---------------------------------------------------------------------------
// Deterministic derivation — the default genome is a pure function of the
// measured component. No Grok, no randomness beyond the castle seed.
// ---------------------------------------------------------------------------

function fnv(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], roll: number): T {
  return arr[roll % arr.length]!;
}

/** Kind temperament: the lawful default leanings before any style bias. */
const KIND_LEAN: Record<
  ComponentKind,
  { foot: Footprint[]; roof: RoofForm[]; mat: MaterialFamily[]; props: PropSet }
> = {
  "app-web": { foot: ["rect", "ell", "tee"], roof: ["gable", "hip"], mat: ["timber", "plaster", "brick"], props: "trade" },
  "app-server": { foot: ["square", "rect"], roof: ["hip", "flat"], mat: ["stone", "brick"], props: "martial" },
  database: { foot: ["square", "octagon"], roof: ["flat", "skillion"], mat: ["stone", "basalt"], props: "mine" },
  pipeline: { foot: ["rect", "cross"], roof: ["sawtooth", "skillion"], mat: ["copper", "brick"], props: "forge" },
  cli: { foot: ["square", "tower"], roof: ["gable", "skillion"], mat: ["timber", "stone"], props: "forge" },
  library: { foot: ["square", "round"], roof: ["hip", "dome"], mat: ["stone", "marble"], props: "scholar" },
  tests: { foot: ["rect", "square"], roof: ["flat", "gable"], mat: ["timber", "stone"], props: "martial" },
  docs: { foot: ["round", "tower"], roof: ["cone", "onion"], mat: ["plaster", "marble"], props: "scholar" },
  config: { foot: ["tower", "square"], roof: ["pyramid", "cone"], mat: ["stone", "copper"], props: "arcane" },
  assets: { foot: ["round", "octagon"], roof: ["dome", "onion"], mat: ["marble", "sandstone"], props: "garden" },
};

/**
 * The lawful default: derived from measured traits, the castle seed, and —
 * when a style stands — the style's biases. Pure and total.
 */
export function deriveGenome(
  kind: ComponentKind,
  traits: Traits,
  componentId: string,
  seed: number,
  style?: StyleGenome | null,
): BuildingGenome {
  const lean = KIND_LEAN[kind];
  const r = fnv(`${seed}:${componentId}`);
  const r2 = fnv(`${componentId}:${seed}`);
  const mat = style?.materialBias?.length ? pick(style.materialBias, r) : pick(lean.mat, r);
  const roofForm = style?.roofBias?.length ? pick(style.roofBias, r2) : pick(lean.roof, r2);
  const trim = style?.trimBias?.length ? pick(style.trimBias, r) : traits.size >= 3 ? "quoins" : "none";
  const genome: BuildingGenome = {
    footprint: pick(lean.foot, r),
    storeys: traits.storeys,
    bays: Math.max(1, Math.min(5, traits.size + (r % 2))),
    taper: traits.size >= 4 ? "stepped" : "none",
    roof: {
      form: roofForm,
      pitch: pick(ROOF_PITCHES, r2 >> 3),
      overhang: traits.size >= 2 ? "eave" : "none",
      cap: kind === "config" ? "weathervane" : kind === "pipeline" ? "chimney" : pick(["none", "finial", "orb"] as const, r >> 5),
    },
    material: { family: mat, trim },
    openings: {
      windows: traits.size === 1 ? "slit" : pick(["arch", "lattice", "round"] as const, r >> 7),
      door: kind === "app-server" ? "portcullis" : pick(["plank", "arch", "double"] as const, r2 >> 5),
    },
    ornament: {
      crenellated: kind === "app-server" || kind === "tests",
      buttresses: traits.size >= 3 ? 2 : 0,
      banners: Math.min(4, Math.max(0, traits.banners - 1)),
      glow: false,
      smoke: kind === "pipeline",
    },
    dressing: { propSet: lean.props, density: Math.min(3, traits.size) },
  };
  return lawClamp(genome, traits);
}

// ---------------------------------------------------------------------------
// Validation — every field independently lawful or independently defaulted.
// ---------------------------------------------------------------------------

function member<T extends string>(vocab: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (vocab as readonly string[]).includes(v) ? (v as T) : fallback;
}

function bounded(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}

function flag(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Measured facts outrank taste: clamp the style axes the law owns. */
export function lawClamp(g: BuildingGenome, traits: Traits): BuildingGenome {
  const lo = Math.max(1, traits.storeys - 1);
  const hi = Math.min(6, traits.storeys + 1);
  g.storeys = Math.max(lo, Math.min(hi, g.storeys));
  g.ornament.banners = Math.min(4, Math.max(0, g.ornament.banners));
  g.ornament.buttresses = Math.min(4, Math.max(0, g.ornament.buttresses));
  g.dressing.density = Math.min(3, Math.max(0, g.dressing.density));
  g.bays = Math.min(5, Math.max(1, g.bays));
  return g;
}

/**
 * Validate a raw (Grok-authored or ledger-borne) building genome against the
 * lawful default for this component. Unknown fields never survive; unlawful
 * values fall back field-by-field; law-owned bands clamp last.
 */
export function validateBuildingGenome(
  raw: unknown,
  kind: ComponentKind,
  traits: Traits,
  componentId: string,
  seed: number,
  style?: StyleGenome | null,
): BuildingGenome {
  const d = deriveGenome(kind, traits, componentId, seed, style);
  if (typeof raw !== "object" || raw === null) return d;
  const g = raw as Record<string, unknown>;
  const roof = (typeof g.roof === "object" && g.roof !== null ? g.roof : {}) as Record<string, unknown>;
  const material = (typeof g.material === "object" && g.material !== null ? g.material : {}) as Record<string, unknown>;
  const openings = (typeof g.openings === "object" && g.openings !== null ? g.openings : {}) as Record<string, unknown>;
  const ornament = (typeof g.ornament === "object" && g.ornament !== null ? g.ornament : {}) as Record<string, unknown>;
  const dressing = (typeof g.dressing === "object" && g.dressing !== null ? g.dressing : {}) as Record<string, unknown>;
  const out: BuildingGenome = {
    footprint: member(FOOTPRINTS, g.footprint, d.footprint),
    storeys: bounded(g.storeys, 1, 6, d.storeys),
    bays: bounded(g.bays, 1, 5, d.bays),
    taper: member(TAPERS, g.taper, d.taper),
    roof: {
      form: member(ROOF_FORMS, roof.form, d.roof.form),
      pitch: member(ROOF_PITCHES, roof.pitch, d.roof.pitch),
      overhang: member(ROOF_OVERHANGS, roof.overhang, d.roof.overhang),
      cap: member(ROOF_CAPS, roof.cap, d.roof.cap),
    },
    material: {
      family: member(MATERIAL_FAMILIES, material.family, d.material.family),
      trim: member(TRIMS, material.trim, d.material.trim),
    },
    openings: {
      windows: member(WINDOW_STYLES, openings.windows, d.openings.windows),
      door: member(DOOR_STYLES, openings.door, d.openings.door),
    },
    ornament: {
      crenellated: flag(ornament.crenellated, d.ornament.crenellated),
      buttresses: bounded(ornament.buttresses, 0, 4, d.ornament.buttresses),
      banners: bounded(ornament.banners, 0, 4, d.ornament.banners),
      glow: flag(ornament.glow, d.ornament.glow),
      smoke: flag(ornament.smoke, d.ornament.smoke),
    },
    dressing: {
      propSet: member(PROP_SETS, dressing.propSet, d.dressing.propSet),
      density: bounded(dressing.density, 0, 3, d.dressing.density),
    },
  };
  return lawClamp(out, traits);
}

/** A style must be named and cited or it does not exist. Null = no style. */
export function validateStyleGenome(raw: unknown): StyleGenome | null {
  if (typeof raw !== "object" || raw === null) return null;
  const g = raw as Record<string, unknown>;
  const name = typeof g.name === "string" ? g.name.trim().slice(0, 48) : "";
  const cited = typeof g.cited === "string" ? g.cited.trim().slice(0, 240) : "";
  if (!name || !cited) return null;
  const list = <T extends string>(vocab: readonly T[], v: unknown): T[] =>
    Array.isArray(v)
      ? (v.filter((x) => typeof x === "string" && (vocab as readonly string[]).includes(x)) as T[]).slice(0, 3)
      : [];
  return {
    name,
    cited,
    materialBias: list(MATERIAL_FAMILIES, g.materialBias),
    roofBias: list(ROOF_FORMS, g.roofBias),
    trimBias: list(TRIMS, g.trimBias),
    natureSet: member(NATURE_SETS, g.natureSet, "pine"),
    wallStyle: member(WALL_STYLES, g.wallStyle, "curtain"),
    groundTone: member(GROUND_TONES, g.groundTone, "meadow"),
    fog: member(FOGS, g.fog, "none"),
  };
}

/** Stable one-line signature — folded into the castle hash. */
export function genomeSignature(g: BuildingGenome): string {
  return [
    g.footprint,
    g.storeys,
    g.bays,
    g.taper,
    g.roof.form,
    g.roof.pitch,
    g.roof.overhang,
    g.roof.cap,
    g.material.family,
    g.material.trim,
    g.openings.windows,
    g.openings.door,
    g.ornament.crenellated ? "cren" : "-",
    g.ornament.buttresses,
    g.ornament.banners,
    g.ornament.glow ? "glow" : "-",
    g.ornament.smoke ? "smoke" : "-",
    g.dressing.propSet,
    g.dressing.density,
  ].join("/");
}

export function styleSignature(s: StyleGenome | null | undefined): string {
  if (!s) return "unstyled";
  return [
    s.name,
    s.materialBias.join(","),
    s.roofBias.join(","),
    s.trimBias.join(","),
    s.natureSet,
    s.wallStyle,
    s.groundTone,
    s.fog,
  ].join("/");
}
