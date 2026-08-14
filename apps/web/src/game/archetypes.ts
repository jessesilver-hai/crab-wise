/**
 * World archetypes: six divergent world-forms in the same ancient-future
 * register. An archetype decides the fog/sky/glow palette and the ambient
 * weather particles. A ThemePack may name one; otherwise it is derived
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

export type Archetype = {
  id: ArchetypeId;
  fogColor: number;
  /** Camera clear color — the void beyond the steppe. */
  skyColor: number;
  /** Horizon gradient tint fixed to the top of the viewport. */
  horizonColor: number;
  /** Glow accent used for seams, sigils, and highlights. */
  glow: number;
  particle: { kind: ParticleKind; color: number; count: number };
};

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  "ash-steppe": {
    id: "ash-steppe",
    fogColor: 0x060504,
    skyColor: 0x0d0a06,
    horizonColor: 0x2a2118,
    glow: 0xe3b264,
    particle: { kind: "ash", color: 0xa99f8d, count: 36 },
  },
  "harbor-citadel": {
    id: "harbor-citadel",
    fogColor: 0x04080a,
    skyColor: 0x071016,
    horizonColor: 0x14303a,
    glow: 0x7fd4c9,
    particle: { kind: "mist", color: 0xbcd8d8, count: 16 },
  },
  "oracle-forge": {
    id: "oracle-forge",
    fogColor: 0x070403,
    skyColor: 0x120806,
    horizonColor: 0x3a160a,
    glow: 0xff8a4d,
    particle: { kind: "embers", color: 0xff9a4d, count: 44 },
  },
  "glacier-vault": {
    id: "glacier-vault",
    fogColor: 0x0a1016,
    skyColor: 0x0a1218,
    horizonColor: 0x24404e,
    glow: 0x9fd8ff,
    particle: { kind: "snow", color: 0xeaf4fa, count: 56 },
  },
  "verdant-ruin": {
    id: "verdant-ruin",
    fogColor: 0x050804,
    skyColor: 0x0a120a,
    horizonColor: 0x1d3320,
    glow: 0xa8d878,
    particle: { kind: "spores", color: 0xb9d98a, count: 40 },
  },
  "dune-monolith": {
    id: "dune-monolith",
    fogColor: 0x0a0805,
    skyColor: 0x14100a,
    horizonColor: 0x443318,
    glow: 0xe8c878,
    particle: { kind: "dust", color: 0xd8c49a, count: 28 },
  },
};

export function resolveArchetype(id: string | undefined, mapSeed: number): Archetype {
  if (id && id in ARCHETYPES) return ARCHETYPES[id as ArchetypeId];
  const idx = Math.abs(Math.floor(mapSeed)) % ARCHETYPE_IDS.length;
  return ARCHETYPES[ARCHETYPE_IDS[idx]!];
}
