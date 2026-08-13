// Run with: npx tsx scripts/worldspec-validate.mjs
// Asserts the WorldSpec zod schema accepts a maximal valid spec and rejects
// out-of-bounds LLM output (the whole point: bounded data, fixed engine).
import assert from "node:assert/strict";
import { WorldSpec, ThemePack } from "../packages/protocol/src/index.ts";

const prim = (over = {}) => ({
  shape: "obelisk",
  w: 12,
  h: 40,
  color: "#8a7c60",
  tilt: -12,
  ...over,
});

const building = {
  silhouette: [prim({ shape: "slab", h: 20 }), prim({ shape: "shard", h: 16, tilt: 8 })],
  roofColor: "#5a4527",
  wallColor: "#8d8577",
  emissive: "#e3b264",
};

const maximal = {
  version: 1,
  lore: {
    placeName: "The Causeway of Requests",
    epithet: "A harbor-citadel where request-caravans cross the black water.",
    loadingLines: [
      "The chroniclers unfurl the routing tables…",
      "Middleware wards are etched into the causeway stones…",
      "The test-seals are counted, one by one…",
      "Old handlers stir beneath the water line…",
      "The websocket beacons are lit against the fog…",
      "The record is read; the world may now stand…",
    ],
  },
  sky: { top: "#0a1218", horizon: "#24404e", hazeAlpha: 0.5 },
  terrain: {
    base: ["#3f4a4e", "#4e5a5e", "#556468", "#5d6d70", "#65787a", "#6d8284"],
    pattern: "plates",
    reliefIntensity: 1,
    waterline: { color: "#16323c", coverage: 0.35 },
  },
  props: Array.from({ length: 12 }, (_, i) => ({
    silhouette: [
      prim({ shape: "mast", w: 8, h: 60 }),
      prim({ shape: "ring", w: 14, h: 14 }),
      prim({ shape: "orb", w: 8, h: 8 }),
      prim({ shape: "frond", w: 20, h: 24, tilt: 30 }),
      prim({ shape: "coil", w: 10, h: 36 }),
      prim({ shape: "beam", w: 6, h: 72 }),
    ],
    density: 1,
    placement: (["ridges", "edges", "scatter", "districts"])[i % 4],
    glow: { color: "#7fd4c9", pulseSec: 2 + i },
  })),
  architecture: {
    house: building,
    barracks: building,
    market: building,
    monastery: building,
    mill: building,
    towncenter: {
      ...building,
      silhouette: [
        prim({ shape: "slab", w: 48, h: 24, tilt: 0 }),
        prim({ shape: "slab", w: 36, h: 20, tilt: 0 }),
        prim({ shape: "obelisk", w: 20, h: 48, tilt: 0 }),
        prim({ shape: "ring", w: 16, h: 16, tilt: 0 }),
        prim({ shape: "orb", w: 8, h: 8, tilt: 0 }),
      ],
    },
  },
  ambience: {
    particles: "rain",
    tint: "#bcd8d8",
    rate: 1,
    skyEvents: { kind: "birds", everySec: 20 },
  },
  units: {
    villagerTint: "#d8e4ec",
    heroTint: "#f0c96a",
    raiderTint: "#c0483c",
    gaitBounce: 1,
  },
};

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("WorldSpec schema validation");

// --- acceptance ------------------------------------------------------------
const max = WorldSpec.safeParse(maximal);
if (!max.success) console.error(max.error.issues.slice(0, 8));
ok("maximal valid spec parses", max.success);

const clone = (over) => JSON.parse(JSON.stringify({ ...maximal, ...over }));

// --- rejections ------------------------------------------------------------
const badRate = clone({});
badRate.ambience.rate = 2;
ok("rejects ambience.rate = 2", !WorldSpec.safeParse(badRate).success);

const manyProps = clone({});
manyProps.props = Array.from({ length: 40 }, () => maximal.props[0]);
ok("rejects 40 props", !WorldSpec.safeParse(manyProps).success);

const badHex = clone({});
badHex.sky.top = "#12ZZ34";
ok("rejects bad hex color", !WorldSpec.safeParse(badHex).success);

const manyLines = clone({});
manyLines.lore.loadingLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
ok("rejects 50 loadingLines", !WorldSpec.safeParse(manyLines).success);

const badTilt = clone({});
badTilt.props[0].silhouette[0].tilt = 90;
ok("rejects primitive tilt = 90", !WorldSpec.safeParse(badTilt).success);

// --- ThemePack integration ---------------------------------------------------
const theme = {
  factionName: "The Causeway Wardens",
  tagline: "They keep the black water routed.",
  kingName: "The Harbormaster",
  enemyName: "undertows",
  biome: {
    grassColors: ["#4e5a5e", "#556468"],
    fogColor: "#04080a",
    accentColor: "#7fd4c9",
    archetype: "harbor-citadel",
  },
  heraldOpeners: ["Hear the tide.", "The causeway speaks."],
  heraldClosers: ["So it is routed.", "The water keeps it."],
  personas: [
    { name: "Maren", title: "Pilot of Requests", quirk: "reads headers like tide charts" },
    { name: "Odd", title: "Keeper of Seals", quirk: "counts passing tests aloud" },
    { name: "Isla", title: "Wharf-Scribe", quirk: "annotates every mooring" },
  ],
  sprites: [],
};
ok("ThemePack without worldSpec still parses", ThemePack.safeParse(theme).success);
ok(
  "ThemePack with valid worldSpec parses",
  ThemePack.safeParse({ ...theme, worldSpec: maximal }).success,
);
ok(
  "ThemePack with invalid worldSpec fails (client strips it, relay 422s it)",
  !ThemePack.safeParse({ ...theme, worldSpec: badTilt }).success,
);

console.log(`\nAll ${passed} assertions passed.`);
