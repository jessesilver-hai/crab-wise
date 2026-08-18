import type { ArchetypeId } from "./archetypes.js";
import type { CompositionKind } from "./map.js";

/**
 * Kit-per-world-form law: each form family layers its own CC0 accent models
 * (same author as the base kit, style-coherent) over the shared medieval
 * vocabulary, and compositions add their own terrain accents. Engine-pure
 * data — the 3D renderer loads these lazily per world; 2D approximates with
 * sprites. Paths are served from public/. Every piece is cited in
 * kits/LICENSES.md.
 */

export type KitPiece = {
  url: string;
  /** Uniform scale hint relative to one map tile (renderer may normalize). */
  scale?: number;
};

const K = "/assets/3d/kits";

/** Wilderness + district accent scatter per form family (beyond base props). */
export const FAMILY_ACCENTS: Record<ArchetypeId, KitPiece[]> = {
  "oracle-forge": [
    { url: `${K}/dungeon/pillar_decorated.gltf.glb` },
    { url: `${K}/dungeon/column.gltf.glb` },
    { url: `${K}/dungeon/rubble_large.gltf.glb` },
    { url: `${K}/dungeon/barrier_column.gltf.glb` },
  ],
  "verdant-ruin": [
    { url: `${K}/dungeon/column.gltf.glb` },
    { url: `${K}/dungeon/rubble_half.gltf.glb` },
    { url: `${K}/dungeon/wall_pillar.gltf.glb` },
  ],
  "dune-monolith": [
    { url: `${K}/dungeon/pillar.gltf.glb` },
    { url: `${K}/dungeon/pillar_decorated.gltf.glb` },
    { url: `${K}/dungeon/barrier_column.gltf.glb` },
  ],
  "ash-steppe": [
    { url: `${K}/halloween/bone_A.gltf` },
    { url: `${K}/halloween/bone_B.gltf` },
    { url: `${K}/halloween/grave_B.gltf` },
    { url: `${K}/halloween/gravemarker_A.gltf` },
    { url: `${K}/halloween/arch_gate.gltf` },
  ],
  "glacier-vault": [
    { url: `${K}/halloween/crypt.gltf` },
    { url: `${K}/halloween/coffin_decorated.gltf` },
    { url: `${K}/halloween/gravestone.gltf` },
    { url: `${K}/halloween/lantern_standing.gltf` },
  ],
  "harbor-citadel": [
    { url: `${K}/halloween/lantern_standing.gltf` },
    { url: `${K}/dungeon/chest_gold.glb` },
  ],
};

/** Composition-specific terrain accents (any family). */
export const COMPOSITION_ACCENTS: Record<CompositionKind, KitPiece[]> = {
  "terrace-mount": [
    { url: `${K}/hexagon/mountain_A_grass.gltf`, scale: 2.2 },
    { url: `${K}/hexagon/mountain_B_grass.gltf`, scale: 2.2 },
    { url: `${K}/hexagon/mountain_C_grass_trees.gltf`, scale: 2.2 },
  ],
  "archipelago": [],
  "ring-city": [],
  "canyon-strata": [
    { url: `${K}/dungeon/rubble_large.gltf.glb` },
    { url: `${K}/dungeon/stairs.gltf.glb` },
  ],
};

/** Harbor realms upgrade their crossings with real bridge spans. */
export const BRIDGE_MODELS: KitPiece[] = [
  { url: `${K}/hexagon/building_bridge_A.gltf` },
  { url: `${K}/hexagon/building_bridge_B.gltf` },
];
