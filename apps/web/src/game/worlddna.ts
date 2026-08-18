import { ARCHETYPE_IDS, type ArchetypeId } from "./archetypes.js";
import { mulberry32, pickComposition, RIVER_MIN_DEPTH, type CompositionKind } from "./map.js";
import type { Census, FileRole, LangFamily } from "./census.js";
import type { DistrictArchetype } from "@agent-empires/protocol";

/**
 * World DNA: the deterministic bridge from measured code facts (census) to
 * concrete render directives. The doctrine is legible isomorphism — every
 * divergence between two realms is either a census consequence or a
 * Worldsmith override that cites one. Pure function of (census, seed,
 * override); same repo → same world, different repos → unmistakably
 * different worlds.
 */

export type TimeOfDay = "dawn" | "noon" | "dusk" | "night";

/** Generic structure vocabulary; each engine maps kinds to its own models. */
export type StructureKind =
  | "dwelling"
  | "workshop"
  | "watchtower"
  | "stela"
  | "silo"
  | "reliquary"
  | "gatehouse"
  | "megastructure";

/** World population tier — sets map scale, camera envelope, expectations. */
export type ScaleTier = "hamlet" | "town" | "city" | "metropolis";

export type LandmarkKind = "colossus" | "harbor-beacon" | "great-library" | "garrison-keep" | "crown-spire";

export type WorldDNA = {
  form: ArchetypeId;
  /** The measured macro-form (mirrors the layout law, cited in lore). */
  composition: CompositionKind;
  /** File role → structure typology; the skyline is a histogram of the code. */
  structures: Record<FileRole, StructureKind>;
  scaleTier: ScaleTier;
  /** One census-derived monument that breaks the roofline. */
  landmark: { kind: LandmarkKind; subject: string; line: string };
  /** Ground colors (uint24). Curated per form — never mud-dark, never neon. */
  ground: {
    base: number; // city floor
    wild: number; // wilderness beyond the walls
    road: number;
    plaza: number;
    shore: number;
    water: number;
    /** Per-district floor tints by role (mixed over base). */
    district: Record<DistrictArchetype, number>;
  };
  vegetation: {
    /** 0..1 scatter density in the wilderness ring. */
    density: number;
    /** Foliage tint multiplier target (uint24). */
    tint: number;
    /** Share of trees rendered as cut stumps (industry/harvest mood). */
    cutShare: number;
  };
  rockDensity: number; // 0..1
  /** 0 none · 1 citadel ring · 2 + proving quarters · 3 all depth-1 walls. */
  fortification: 0 | 1 | 2 | 3;
  sun: {
    timeOfDay: TimeOfDay;
    /** Radians around the map (light direction). */
    azimuth: number;
    /** 0..1, low = raking dawn/dusk light. */
    elevation: number;
    color: number;
    ambient: number;
  };
  /** Instanced-mesh tint targets for the building kit. */
  buildingTint: { wall: number; roof: number; trim: number };
  /** Prop model keys scattered per district role (renderer maps to glbs). */
  props: Record<DistrictArchetype, readonly string[]>;
  /** Derived, citable facts — examine lore and Worldsmith grounding. */
  loreNotes: { subject: string; line: string }[];
};

/** Language temperament → ranked world-form affinity (maximal spread). */
const FORM_AFFINITY: Record<LangFamily, [ArchetypeId, ArchetypeId]> = {
  script: ["harbor-citadel", "verdant-ruin"],
  python: ["verdant-ruin", "oracle-forge"],
  systems: ["oracle-forge", "ash-steppe"],
  jvm: ["glacier-vault", "ash-steppe"],
  go: ["harbor-citadel", "glacier-vault"],
  web: ["dune-monolith", "harbor-citadel"],
  prose: ["dune-monolith", "glacier-vault"],
  data: ["ash-steppe", "dune-monolith"],
  shell: ["ash-steppe", "dune-monolith"],
  ruby: ["verdant-ruin", "dune-monolith"],
  other: ["verdant-ruin", "ash-steppe"],
};

type FormSkin = {
  ground: Omit<WorldDNA["ground"], "district">;
  districtMix: Partial<Record<DistrictArchetype, number>>;
  veg: { density: number; tint: number; cutShare: number };
  rock: number;
  sun: { timeOfDay: TimeOfDay; elevation: number; color: number; ambient: number };
  tint: WorldDNA["buildingTint"];
};

/**
 * Curated per-form skins. Bold hue separation on purpose: a glacier realm and
 * a dune realm should not share a palette. Floors sit in the 0x20..0x70
 * channel range so the night-lit renderer keeps them readable.
 */
const FORM_SKINS: Record<ArchetypeId, FormSkin> = {
  "ash-steppe": {
    ground: { base: 0x3a3532, wild: 0x2c2825, road: 0x54463a, plaza: 0x5c5044, shore: 0x4a4238, water: 0x1c2126 },
    districtMix: { proving: 0x59372e, scriptorium: 0x574f3c, granary: 0x4d4433, forge: 0x54382a, bazaar: 0x53443c, watchtower: 0x45403c, quarter: 0x433c34 },
    veg: { density: 0.35, tint: 0x8a7f5e, cutShare: 0.3 },
    rock: 0.75,
    sun: { timeOfDay: "night", elevation: 0.25, color: 0xc8b090, ambient: 0.42 },
    tint: { wall: 0x9a9088, roof: 0x6e5346, trim: 0xe3b264 },
  },
  "harbor-citadel": {
    ground: { base: 0x35443f, wild: 0x2a3a36, road: 0x4e5a52, plaza: 0x5a6a60, shore: 0x5e6a52, water: 0x143240 },
    districtMix: { proving: 0x4e4a3a, scriptorium: 0x4f5a50, granary: 0x445448, forge: 0x435048, bazaar: 0x50604e, watchtower: 0x3e4e4c, quarter: 0x3d4c44 },
    veg: { density: 0.6, tint: 0x5f8a6e, cutShare: 0.05 },
    rock: 0.35,
    sun: { timeOfDay: "dawn", elevation: 0.35, color: 0xa8d0c8, ambient: 0.5 },
    tint: { wall: 0xb8c0b4, roof: 0x2e5a5e, trim: 0x7fd4c9 },
  },
  "oracle-forge": {
    ground: { base: 0x40312a, wild: 0x322620, road: 0x5c4232, plaza: 0x684a34, shore: 0x503a2c, water: 0x351a12 },
    districtMix: { proving: 0x5c3026, scriptorium: 0x574434, granary: 0x4e3a2c, forge: 0x633822, bazaar: 0x58402e, watchtower: 0x4a362c, quarter: 0x4a3830 },
    veg: { density: 0.25, tint: 0x6e5a40, cutShare: 0.4 },
    rock: 0.65,
    sun: { timeOfDay: "dusk", elevation: 0.18, color: 0xff9a5a, ambient: 0.38 },
    tint: { wall: 0x8a7466, roof: 0x7a3a24, trim: 0xff8a4d },
  },
  "glacier-vault": {
    ground: { base: 0x46525e, wild: 0x59646e, road: 0x5e6e7c, plaza: 0x70808c, shore: 0x8294a0, water: 0x1e3a50 },
    districtMix: { proving: 0x5a5460, scriptorium: 0x5e6a78, granary: 0x525e6a, forge: 0x4e5a64, bazaar: 0x5a6a74, watchtower: 0x4c5a68, quarter: 0x4e5a66 },
    veg: { density: 0.3, tint: 0x7290a0, cutShare: 0.1 },
    rock: 0.55,
    sun: { timeOfDay: "noon", elevation: 0.55, color: 0xd8ecff, ambient: 0.55 },
    tint: { wall: 0xc4d0da, roof: 0x3a5a74, trim: 0x9fd8ff },
  },
  "verdant-ruin": {
    ground: { base: 0x34452e, wild: 0x2a3a26, road: 0x50543c, plaza: 0x5c6444, shore: 0x4e5a3c, water: 0x1a3028 },
    districtMix: { proving: 0x4e4430, scriptorium: 0x4e5640, granary: 0x445034, forge: 0x424c34, bazaar: 0x4e5c3a, watchtower: 0x3c4c36, quarter: 0x3e4c32 },
    veg: { density: 1.0, tint: 0x4e8a4a, cutShare: 0.0 },
    rock: 0.25,
    sun: { timeOfDay: "dawn", elevation: 0.4, color: 0xb8d890, ambient: 0.5 },
    tint: { wall: 0xa8a890, roof: 0x4a6a3a, trim: 0xa8d878 },
  },
  "dune-monolith": {
    ground: { base: 0x5a4c34, wild: 0x6a5a3e, road: 0x74643f, plaza: 0x82704a, shore: 0x8a7850, water: 0x1e4a4a },
    districtMix: { proving: 0x6a4a32, scriptorium: 0x746446, granary: 0x685838, forge: 0x64502e, bazaar: 0x726040, watchtower: 0x5c5038, quarter: 0x62523a },
    veg: { density: 0.15, tint: 0x7a7a4a, cutShare: 0.15 },
    rock: 0.5,
    sun: { timeOfDay: "dusk", elevation: 0.22, color: 0xf0c880, ambient: 0.46 },
    tint: { wall: 0xd0bc94, roof: 0x9a6a3a, trim: 0xe8c878 },
  },
};

const DISTRICT_ROLES: DistrictArchetype[] = ["quarter", "proving", "scriptorium", "granary", "watchtower", "forge", "bazaar"];

/** Prop vocabulary per district role — the KayKit props we actually ship. */
const ROLE_PROPS: Record<DistrictArchetype, readonly string[]> = {
  proving: ["target", "weaponrack", "banner_red", "tent"],
  scriptorium: ["book_set", "book_single", "torch_lit"],
  granary: ["sack", "barrel", "crate_A_small", "wheelbarrow"],
  watchtower: ["flag_blue", "torch_mounted"],
  forge: ["resource_lumber", "resource_stone", "torch_lit"],
  bazaar: ["crate_A_big", "banner_blue", "tent", "chest"],
  quarter: ["barrel", "wheelbarrow", "crate_open"],
};

const AZIMUTHS: Record<TimeOfDay, number> = { dawn: 0.8, noon: 1.6, dusk: 3.9, night: 4.7 };

/** Structural typology law: what a file IS decides what gets built on it. */
const STRUCTURE_BASE: Record<FileRole, StructureKind> = {
  source: "dwelling",
  test: "watchtower",
  docs: "stela",
  config: "silo",
  asset: "reliquary",
  entry: "gatehouse",
  giant: "megastructure",
};

/** Family flavor: forge realms raise workshops where others raise homes. */
const STRUCTURE_OVERRIDES: Partial<Record<ArchetypeId, Partial<Record<FileRole, StructureKind>>>> = {
  "oracle-forge": { source: "workshop" },
  "ash-steppe": { source: "workshop" },
};

export function scaleTierFor(fileCount: number): ScaleTier {
  if (fileCount <= 20) return "hamlet";
  if (fileCount <= 200) return "town";
  if (fileCount <= 1200) return "city";
  return "metropolis";
}

/** First measured claim wins: the monument cites the loudest census fact. */
export function deriveLandmark(census: Census): WorldDNA["landmark"] {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (census.giantShare > 0.25) {
    return {
      kind: "colossus",
      subject: "the giant files",
      line: `The Colossus honors the giants — ${pct(census.giantShare)} of all lines dwell in files of a thousand or more.`,
    };
  }
  if (census.monorepo) {
    return {
      kind: "harbor-beacon",
      subject: `${census.packageDirs} packages`,
      line: `The Harbor Beacon guides ${census.packageDirs} island-works home through one strait.`,
    };
  }
  if (census.docsRatio > 0.2) {
    return {
      kind: "great-library",
      subject: "the scriptures",
      line: `The Great Library rose where scripture is ${pct(census.docsRatio)} of the realm.`,
    };
  }
  if (census.testRatio >= 0.3) {
    return {
      kind: "garrison-keep",
      subject: "the trials",
      line: `The Garrison Keep drills trials that guard ${pct(census.testRatio)} of all lines.`,
    };
  }
  return {
    kind: "crown-spire",
    subject: "the crown",
    line: `The Crown Spire marks a young dominion — ${census.fileCount.toLocaleString()} works and rising.`,
  };
}

export function deriveWorldDNA(census: Census, seed: number, formOverride?: string): WorldDNA {
  const rng = mulberry32((seed ^ 0x5eed) >>> 0);
  const jitter = rng(); // consumed before any branch so choices stay aligned

  // --- form: language temperament, bent by extreme ratios ------------------
  const affinity = FORM_AFFINITY[census.dominant] ?? FORM_AFFINITY.other;
  let form: ArchetypeId = jitter < 0.72 ? affinity[0] : affinity[1];
  if (census.docsRatio > 0.5) form = "dune-monolith"; // a city of scripture
  if (census.giantShare > 0.5) form = "ash-steppe"; // megalith country
  if (formOverride && (ARCHETYPE_IDS as readonly string[]).includes(formOverride)) {
    form = formOverride as ArchetypeId; // the Worldsmith may re-see the land
  }
  const skin = FORM_SKINS[form];

  // --- vegetation: wilderness thins as the city grows -----------------------
  const wildness = 1 - Math.min(1, census.fileCount / 1400);
  const density = Math.min(1, Math.max(0.05, skin.veg.density * (0.55 + 0.65 * wildness)));

  // --- fortification: the test garrison builds the walls --------------------
  const fortification: WorldDNA["fortification"] =
    census.testRatio >= 0.3 ? 3 : census.testRatio >= 0.16 ? 2 : census.testRatio >= 0.06 ? 1 : 0;

  const district = {} as Record<DistrictArchetype, number>;
  for (const role of DISTRICT_ROLES) district[role] = skin.districtMix[role] ?? skin.ground.base;

  // --- composition, typology, scale, landmark --------------------------------
  const composition = pickComposition(census);
  const structures = { ...STRUCTURE_BASE, ...(STRUCTURE_OVERRIDES[form] ?? {}) };
  const scaleTier = scaleTierFor(census.fileCount);
  const landmark = deriveLandmark(census);

  // --- citable lore ----------------------------------------------------------
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const loreNotes: WorldDNA["loreNotes"] = [];
  const domShare = census.languages[0]?.share ?? 0;
  loreNotes.push({
    subject: "realm",
    line: `This land took the ${form.replace("-", " ")} form: ${census.dominant} holds ${pct(domShare)} of its ${census.totalLines.toLocaleString()} lines.`,
  });
  const compositionLine: Record<CompositionKind, string> = {
    "terrace-mount": `The realm rose as a terrace mount — its passages run ${census.maxDepth} levels deep, and altitude is depth.`,
    "archipelago": `The realm scattered into an archipelago — ${census.packageDirs} package isles in one sea.`,
    "ring-city": `The realm closed into a ring city — ${census.coreDir || "the core"} holds ${pct(census.coreShare)} of every line, and all roads circle it.`,
    "canyon-strata": `The realm cut a canyon — ${census.topLevelDirs} shallow strata along one Long Road.`,
  };
  loreNotes.push({ subject: "composition", line: compositionLine[composition] });
  loreNotes.push({ subject: "landmark", line: landmark.line });
  if (fortification >= 2) loreNotes.push({ subject: "walls", line: `The walls stand ${fortification === 3 ? "triple" : "double"}-ringed — trials guard ${pct(census.testRatio)} of all lines.` });
  else if (fortification === 0) loreNotes.push({ subject: "walls", line: `No garrison drills here — barely a trial guards these ${census.fileCount} structures.` });
  if (census.docsRatio > 0.2) loreNotes.push({ subject: "scriptorium", line: `Scripture is ${pct(census.docsRatio)} of the realm — the scriptoria burn many candles.` });
  if (census.giantShare > 0.25) loreNotes.push({ subject: "megaliths", line: `Megaliths: ${pct(census.giantShare)} of all lines dwell in giant files.` });
  if (census.monorepo) loreNotes.push({ subject: "archipelago", line: `An archipelago realm — ${census.packageDirs} island-works under one crown, bridges between them.` });
  if (census.maxDepth >= RIVER_MIN_DEPTH) loreNotes.push({ subject: "river", line: `A river runs from the deep quarters — nesting reaches ${census.maxDepth} levels down.` });

  return {
    form,
    composition,
    structures,
    scaleTier,
    landmark,
    ground: { ...skin.ground, district },
    vegetation: { density, tint: skin.veg.tint, cutShare: skin.veg.cutShare },
    rockDensity: skin.rock,
    fortification,
    sun: {
      timeOfDay: skin.sun.timeOfDay,
      azimuth: AZIMUTHS[skin.sun.timeOfDay] + (rng() - 0.5) * 0.6,
      elevation: skin.sun.elevation,
      color: skin.sun.color,
      ambient: skin.sun.ambient,
    },
    buildingTint: skin.tint,
    props: ROLE_PROPS,
    loreNotes,
  };
}
