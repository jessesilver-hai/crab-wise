/**
 * World archetypes: six divergent world-forms in the same ancient-future
 * register. An archetype decides terrain palette + tile patterning, the prop
 * set scattered on unused tiles, the ambient weather particles, and the
 * skyline tint. A ThemePack may name one; otherwise it is derived
 * deterministically from the map seed so every repo still gets a world-form.
 */

export type ArchetypeId =
  | "ash-steppe"
  | "harbor-citadel"
  | "oracle-forge"
  | "glacier-vault"
  | "verdant-ruin"
  | "dune-monolith";

export const ARCHETYPE_IDS: readonly ArchetypeId[] = [
  "ash-steppe",
  "harbor-citadel",
  "oracle-forge",
  "glacier-vault",
  "verdant-ruin",
  "dune-monolith",
] as const;

export type ParticleKind = "ash" | "mist" | "embers" | "snow" | "spores" | "dust";

export type TilePattern = "cinder" | "wave" | "crack" | "shard" | "moss" | "ripple";

export type Archetype = {
  id: ArchetypeId;
  /** Ground-tile base colors (theme grassColors override these). */
  groundColors: number[];
  /** Per-tile detailing drawn over the base color. */
  pattern: TilePattern;
  fogColor: number;
  /** Camera clear color — the void beyond the steppe. */
  skyColor: number;
  /** Horizon gradient tint fixed to the top of the viewport. */
  horizonColor: number;
  /** Glow accent used for seams, sigils, and highlights. */
  glow: number;
  /** Chance per unused tile of hosting a prop. */
  propDensity: number;
  particle: { kind: ParticleKind; color: number; count: number };
};

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  "ash-steppe": {
    id: "ash-steppe",
    groundColors: [0x6a6152, 0x726858, 0x615847, 0x79705f],
    pattern: "cinder",
    fogColor: 0x060504,
    skyColor: 0x0d0a06,
    horizonColor: 0x2a2118,
    glow: 0xe3b264,
    propDensity: 0.055,
    particle: { kind: "ash", color: 0xa99f8d, count: 36 },
  },
  "harbor-citadel": {
    id: "harbor-citadel",
    groundColors: [0x4e5a5e, 0x556468, 0x475257, 0x5d6d70],
    pattern: "wave",
    fogColor: 0x04080a,
    skyColor: 0x071016,
    horizonColor: 0x14303a,
    glow: 0x7fd4c9,
    propDensity: 0.05,
    particle: { kind: "mist", color: 0xbcd8d8, count: 16 },
  },
  "oracle-forge": {
    id: "oracle-forge",
    groundColors: [0x3f3a3a, 0x484140, 0x363231, 0x514846],
    pattern: "crack",
    fogColor: 0x070403,
    skyColor: 0x120806,
    horizonColor: 0x3a160a,
    glow: 0xff8a4d,
    propDensity: 0.05,
    particle: { kind: "embers", color: 0xff9a4d, count: 44 },
  },
  "glacier-vault": {
    id: "glacier-vault",
    groundColors: [0x8d9aa4, 0x97a6b0, 0x839099, 0xa2b1ba],
    pattern: "shard",
    fogColor: 0x0a1016,
    skyColor: 0x0a1218,
    horizonColor: 0x24404e,
    glow: 0x9fd8ff,
    propDensity: 0.06,
    particle: { kind: "snow", color: 0xeaf4fa, count: 56 },
  },
  "verdant-ruin": {
    id: "verdant-ruin",
    groundColors: [0x55604a, 0x5d6a51, 0x4c5642, 0x66735a],
    pattern: "moss",
    fogColor: 0x050804,
    skyColor: 0x0a120a,
    horizonColor: 0x1d3320,
    glow: 0xa8d878,
    propDensity: 0.09,
    particle: { kind: "spores", color: 0xb9d98a, count: 40 },
  },
  "dune-monolith": {
    id: "dune-monolith",
    groundColors: [0x9a8a68, 0xa39371, 0x8f7f5e, 0xac9c7a],
    pattern: "ripple",
    fogColor: 0x0a0805,
    skyColor: 0x14100a,
    horizonColor: 0x443318,
    glow: 0xe8c878,
    propDensity: 0.05,
    particle: { kind: "dust", color: 0xd8c49a, count: 28 },
  },
};

export function resolveArchetype(id: string | undefined, mapSeed: number): Archetype {
  if (id && id in ARCHETYPES) return ARCHETYPES[id as ArchetypeId];
  const idx = Math.abs(Math.floor(mapSeed)) % ARCHETYPE_IDS.length;
  return ARCHETYPES[ARCHETYPE_IDS[idx]!];
}
