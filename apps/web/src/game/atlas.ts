import Phaser from "phaser";

/**
 * Single source of truth for every sprite-sheet frame rect used by the
 * renderer. All pixel coordinates were measured off the shipped PNGs
 * (apps/web/public/assets/iso); remap here if the art ever changes.
 *
 * Sheets:
 * - terrain: Yar outside tileset, 64x64 cells; floor diamonds sit in the
 *   bottom half of their cell (y+32..y+64), props use tight rects.
 * - parts:   Yar modular building tileset, 64x64 cells (walls/roofs/furniture).
 * - walls:   extradave castle walls, 64x128 cells (one wall block per tile).
 * - citizens: SketchyLogic citizen strip; irregular columns, 5 row bands.
 *   Each character is 8 consecutive frames: 4 front-facing walk frames then
 *   4 back-facing walk frames.
 * - actors:  Clint Bellanger hero/creature sheets, 2048x2048, 256px cells,
 *   rows = 8 directions (W NW N NE E SE S SW), cols = frames
 *   [0..3 walk/stance, 4..5 cast/swing, 6 hit, 7 dead].
 */

export const ISO_BASE = "/assets/iso/";

export const SHEET = {
  terrain: "sh-terrain",
  parts: "sh-parts",
  walls: "sh-walls",
  castle: "sh-castle",
  citizens: "sh-citizens",
  fire32: "fx-fire32",
  fire64: "fx-fire64",
  smoke: "fx-smoke",
} as const;

export const ACTOR_URLS = {
  magician: "units/hero/magician.png",
  skeleton: "monsters/skeleton.png",
  zombie: "monsters/zombie.png",
  goblin: "monsters/goblin.png",
  ogre: "monsters/ogre.png",
  werewolf: "monsters/werewolf.png",
  elemental: "monsters/elemental.png",
} as const;
export type ActorKey = keyof typeof ACTOR_URLS;
export const RAIDER_ACTORS: ActorKey[] = ["skeleton", "zombie", "goblin", "werewolf", "elemental", "ogre"];

export function actorTexKey(actor: ActorKey): string {
  return `actor-${actor}`;
}

/** Bellanger sheet geometry. */
export const ACTOR_CELL = 256;
/** Feet baseline inside a 256px actor cell (measured across stance frames). */
export const ACTOR_FEET_Y = 184 / 256;
export const DIRS8 = ["w", "nw", "n", "ne", "e", "se", "s", "sw"] as const;
export type Dir8 = (typeof DIRS8)[number];

/** Screen-space velocity → 8-direction facing (y grows downward). */
export function dir8FromDelta(dx: number, dy: number): Dir8 {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = east
  const sector = Math.round(deg / 45); // -4..4
  switch (sector) {
    case 0: return "e";
    case 1: return "se";
    case 2: return "s";
    case 3: return "sw";
    case -1: return "ne";
    case -2: return "n";
    case -3: return "nw";
    default: return "w";
  }
}

// ---------------------------------------------------------------------------
// Terrain frames (Yar outside tileset). cell(col,row) = 64x64 cell rect.
// ---------------------------------------------------------------------------

type Rect4 = [number, number, number, number];
const cell = (c: number, r: number): Rect4 => [c * 64, r * 64, 64, 64];

/** Floor-diamond frames: diamond occupies y+33..y+63 → center at (32, 48). */
export const FLOOR_ORIGIN_Y = 48 / 64;

const TERRAIN_RECTS: Record<string, Rect4> = {
  // plain grass
  grass0: cell(0, 2), grass1: cell(1, 2), grass2: cell(2, 2), grass3: cell(3, 2),
  // decorated grass (flowers / leaf litter)
  grassd0: cell(0, 0), grassd1: cell(1, 0), grassd2: cell(2, 0), grassd3: cell(3, 0),
  grassd4: cell(4, 0), grassd5: cell(5, 0), grassd6: cell(6, 0),
  grassd7: cell(0, 1), grassd8: cell(1, 1), grassd9: cell(4, 1), grassd10: cell(5, 1),
  grassd11: cell(6, 1), grassd12: cell(7, 1),
  // dirt-heavy grass → road tiles
  dirt0: cell(2, 1), dirt1: cell(3, 1),
  // open water
  water0: cell(4, 8), water1: cell(5, 8), water2: cell(6, 9), water3: cell(7, 9),
  water4: cell(8, 9), water5: cell(9, 9),
  // shore transitions: name = which diamond edges hold land
  shoreNW0: cell(3, 8), shoreNW1: cell(3, 9),
  shoreNE0: cell(6, 8), shoreNE1: cell(8, 8), shoreNE2: cell(4, 9),
  shoreSW0: cell(0, 8), shoreSW1: cell(0, 9),
  shoreSE0: cell(1, 9), shoreSE1: cell(2, 9),
  shoreN0: cell(7, 8), shoreN1: cell(9, 8),
  shoreS0: cell(5, 9),
  shoreW0: cell(1, 8),
  shoreE0: cell(2, 8),
  waterIsle0: cell(0, 10), waterIsle1: cell(2, 10),
  // terrace cliff blocks (grass top diamond + rock face, full 64x64 cell)
  cliff0: cell(1, 7), cliff1: cell(2, 7), cliff2: cell(3, 7), cliff3: cell(4, 7),
  cliff4: cell(5, 7), cliff5: cell(6, 7), cliff6: cell(7, 7), cliff7: cell(8, 7), cliff8: cell(9, 7),
  // rocks
  rock0: cell(0, 5), rock1: cell(1, 5), rock2: cell(2, 5), rock3: cell(4, 5), rock4: cell(5, 5),
  rockS0: [408, 408, 42, 40], rockS1: [488, 412, 26, 26], rockS2: [532, 408, 34, 30],
  // trees + flora (tight rects, anchor = bottom center)
  pineBig: [1, 872, 63, 141], pineMed: [134, 903, 50, 108], pineSmall: [134, 786, 48, 97],
  pineTiny: [200, 810, 45, 73],
  oakBig: [462, 871, 174, 147],
  deadTall: [69, 878, 59, 135], deadThin: [204, 906, 39, 105], deadWide: [279, 906, 144, 115],
  bushBig: [69, 783, 58, 45], bushSmall: [27, 795, 35, 29],
  bushRound: [516, 786, 59, 42], bushRound2: [578, 778, 59, 50],
  log0: [264, 797, 40, 25], log1: [324, 805, 43, 24],
  plant0: [393, 790, 44, 24], plant1: [461, 792, 35, 26],
  tuft0: [6, 721, 51, 40], tuft1: [517, 726, 54, 43], tuftDead: [582, 719, 55, 41],
};

export const T = {
  grass: ["grass0", "grass1", "grass2", "grass3"],
  grassDecor: [
    "grassd0", "grassd1", "grassd2", "grassd3", "grassd4", "grassd5", "grassd6",
    "grassd7", "grassd8", "grassd9", "grassd10", "grassd11", "grassd12",
  ],
  dirt: ["dirt0", "dirt1"],
  water: ["water0", "water1", "water2", "water3", "water4", "water5"],
  waterIsles: ["waterIsle0", "waterIsle1"],
  /** keyed by land-neighbor mask bits: 1=NW, 2=NE, 4=SW, 8=SE */
  shore: {
    1: ["shoreNW0", "shoreNW1"],
    2: ["shoreNE0", "shoreNE1", "shoreNE2"],
    4: ["shoreSW0", "shoreSW1"],
    8: ["shoreSE0", "shoreSE1"],
    3: ["shoreN0", "shoreN1"],
    12: ["shoreS0"],
    5: ["shoreW0"],
    10: ["shoreE0"],
  } as Record<number, string[]>,
  cliff: ["cliff0", "cliff1", "cliff2", "cliff3", "cliff4", "cliff5", "cliff6", "cliff7", "cliff8"],
  rocks: ["rock0", "rock1", "rock2", "rock3", "rock4", "rockS0", "rockS1", "rockS2"],
  pines: ["pineBig", "pineMed", "pineSmall", "pineTiny"],
  oaks: ["oakBig"],
  deadTrees: ["deadTall", "deadThin", "deadWide"],
  bushes: ["bushBig", "bushSmall", "bushRound", "bushRound2"],
  ground: ["log0", "log1", "plant0", "plant1", "tuft0", "tuft1", "tuftDead"],
} as const;

// ---------------------------------------------------------------------------
// Building parts (Yar modular tileset). cell(col,row).
// ---------------------------------------------------------------------------

const PARTS_RECTS = {
  chimney: cell(0, 0), chimneyOpen: cell(1, 0),
  floorStone0: cell(2, 0), floorStone1: cell(3, 0), floorStone2: cell(4, 0),
  awning: [384, 16, 64, 32],
  stonePlatform: cell(0, 1), stoneSlab: cell(0, 2),
  roofGableA: cell(2, 1), roofGableB: cell(0, 6), roofGableC: cell(2, 6),
  roofSlopeA: cell(1, 1), roofSlopeB: cell(3, 1), roofSlopeC: cell(1, 6),
  roofSmall: cell(7, 1),
  spire: [576, 0, 64, 128], pyramid: [576, 128, 64, 64],
  wallPlaster: cell(1, 2), wallYellow: cell(4, 2), wallHinges: cell(5, 2),
  wallPlank: cell(6, 2), wallLattice: cell(7, 2),
  wallDark: cell(6, 6), wallDoorA: cell(7, 6), wallDoorB: cell(8, 6), wallWindow: cell(9, 6),
  keepBlock: cell(8, 2), keepDoor: cell(8, 3), keepArch: cell(8, 4),
  floorWood: cell(0, 5), floorPlankA: cell(4, 6), floorPlankB: cell(5, 6), floorWoodBig: cell(4, 4),
  table: cell(1, 5), stoolA: cell(2, 5), stoolB: cell(3, 5),
  stairsA: cell(4, 5), stairsB: cell(5, 5),
  pillarSmall: cell(6, 5), pillarTall: cell(7, 5),
  wellRing: cell(8, 5), well: cell(9, 5),
} satisfies Record<string, Rect4>;

export const P = Object.fromEntries(Object.keys(PARTS_RECTS).map((k) => [k, k])) as {
  [K in keyof typeof PARTS_RECTS]: string;
};

// ---------------------------------------------------------------------------
// Castle wall blocks (extradave, 64x128 cells, one block per map tile).
// ---------------------------------------------------------------------------

const wcell = (c: number, r: number): Rect4 => [c * 64, r * 128, 64, 128];

const WALL_RECTS = {
  segA: wcell(0, 0), segB: wcell(5, 0), segC: wcell(6, 0), segSlit: wcell(7, 0),
  segD: wcell(5, 1), segE: wcell(6, 2),
  arch: wcell(6, 1), archRuined: wcell(7, 1),
  towerA: wcell(3, 3), towerB: wcell(6, 4), towerC: wcell(7, 4),
  lowA: wcell(0, 6), lowB: wcell(1, 6), lowC: wcell(2, 6), lowD: wcell(4, 6),
  lowE: wcell(5, 6), lowF: wcell(6, 6), lowG: wcell(7, 6),
  brokeA: wcell(0, 5), brokeB: wcell(2, 5), brokeC: wcell(3, 5),
  rubbleA: wcell(1, 4), rubbleB: wcell(2, 4), rubbleC: wcell(3, 4),
} satisfies Record<string, Rect4>;

export const W = Object.fromEntries(Object.keys(WALL_RECTS).map((k) => [k, k])) as {
  [K in keyof typeof WALL_RECTS]: string;
};

export const WALL_SEGS = [W.segA, W.segB, W.segC, W.segSlit, W.segD, W.segE];
export const WALL_LOW = [W.lowA, W.lowB, W.lowC, W.lowD, W.lowE, W.lowF, W.lowG];
export const WALL_TOWERS = [W.towerA, W.towerB, W.towerC];
export const WALL_RUBBLE = [W.rubbleA, W.rubbleB, W.rubbleC];

// ---------------------------------------------------------------------------
// SketchyLogic citizens: 5 row bands of irregular columns. Characters are 8
// consecutive frames (4 front + 4 back); band 4 holds singles + the soldier.
// ---------------------------------------------------------------------------

type Band = { y0: number; y1: number; cols: [number, number][] };
const CITIZEN_BANDS: Band[] = [
  { y0: 10, y1: 47, cols: [[5, 16], [24, 41], [49, 60], [71, 86], [94, 104], [113, 128], [138, 148], [157, 173], [181, 192], [200, 217], [225, 236], [247, 262]] },
  { y0: 61, y1: 98, cols: [[6, 16], [25, 40], [50, 60], [69, 85], [93, 104], [112, 129], [137, 148], [158, 174], [182, 192], [200, 216], [226, 236], [245, 261]] },
  { y0: 112, y1: 149, cols: [[5, 16], [24, 41], [49, 60], [71, 86], [94, 104], [113, 128], [138, 148], [157, 173], [181, 192], [200, 217], [225, 236], [247, 262]] },
  { y0: 163, y1: 200, cols: [[5, 16], [25, 40], [49, 60], [69, 85], [93, 104], [114, 130], [137, 148], [156, 173], [182, 192], [200, 216], [226, 236], [245, 261]] },
  { y0: 207, y1: 251, cols: [[1, 18], [26, 38], [46, 60], [68, 83], [88, 106], [110, 127], [132, 151], [157, 172], [178, 194], [200, 216], [222, 240]] },
];

function citizenFrameName(i: number): string {
  return `c${i}`;
}

export type CitizenDef = {
  frontIdle: string;
  frontWalk: string[];
  backIdle: string;
  backWalk: string[];
};

function charDef(start: number): CitizenDef {
  const f = (i: number) => citizenFrameName(start + i);
  return {
    frontIdle: f(0),
    frontWalk: [f(0), f(1), f(2), f(3)],
    backIdle: f(4),
    backWalk: [f(4), f(5), f(6), f(7)],
  };
}

/** Six villager outfits (peasants, robed folk) — workers pick by name hash. */
export const VILLAGERS: CitizenDef[] = [0, 8, 16, 24, 32, 40].map(charDef);
/** Caped soldier: front frames 51..54, back frames 55..58. */
export const SOLDIER: CitizenDef = {
  frontIdle: citizenFrameName(51),
  frontWalk: [51, 52, 53, 54].map(citizenFrameName),
  backIdle: citizenFrameName(55),
  backWalk: [55, 56, 57, 58].map(citizenFrameName),
};
export const CITIZEN_SINGLES = {
  mage: citizenFrameName(48),
  noble: citizenFrameName(49),
  adventurer: citizenFrameName(50),
};

// ---------------------------------------------------------------------------
// Loading + registration
// ---------------------------------------------------------------------------

export function queueAssets(load: Phaser.Loader.LoaderPlugin): void {
  load.image(SHEET.terrain, ISO_BASE + "terrain/yar-iso-64x64-outside.png");
  load.image(SHEET.parts, ISO_BASE + "buildings/yar-iso-64x64-building-a.png");
  load.image(SHEET.walls, ISO_BASE + "buildings/extradave-castle-walls-64x128.png");
  load.image(SHEET.castle, ISO_BASE + "buildings/sketchylogic-castle.png");
  load.image(SHEET.citizens, ISO_BASE + "units/sketchylogic-citizens.png");
  load.spritesheet(SHEET.fire32, ISO_BASE + "effects/fire-32.png", { frameWidth: 32, frameHeight: 32 });
  load.spritesheet(SHEET.fire64, ISO_BASE + "effects/fire-64.png", { frameWidth: 64, frameHeight: 64 });
  load.spritesheet(SHEET.smoke, ISO_BASE + "effects/chimney-smoke.png", { frameWidth: 128, frameHeight: 64 });
  for (const [actor, url] of Object.entries(ACTOR_URLS)) {
    load.spritesheet(actorTexKey(actor as ActorKey), ISO_BASE + url, {
      frameWidth: ACTOR_CELL,
      frameHeight: ACTOR_CELL,
    });
  }
}

/** Add every named frame rect onto its parent texture. Idempotent. */
export function registerFrames(textures: Phaser.Textures.TextureManager): void {
  const addAll = (texKey: string, rects: Record<string, Rect4>) => {
    const tex = textures.get(texKey);
    for (const [name, [x, y, w, h]] of Object.entries(rects)) {
      if (!tex.has(name)) tex.add(name, 0, x, y, w, h);
    }
  };
  addAll(SHEET.terrain, TERRAIN_RECTS);
  addAll(SHEET.parts, PARTS_RECTS);
  addAll(SHEET.walls, WALL_RECTS);

  const cit = textures.get(SHEET.citizens);
  let i = 0;
  for (const band of CITIZEN_BANDS) {
    for (const [x0, x1] of band.cols) {
      const name = citizenFrameName(i++);
      if (!cit.has(name)) cit.add(name, 0, x0 - 1, band.y0 - 1, x1 - x0 + 3, band.y1 - band.y0 + 3);
    }
  }
}

/** Create walk/cast/die animations for the Bellanger actors + effects. */
export function registerAnims(anims: Phaser.Animations.AnimationManager): void {
  for (const actor of Object.keys(ACTOR_URLS) as ActorKey[]) {
    const tex = actorTexKey(actor);
    DIRS8.forEach((dir, row) => {
      const base = row * 8;
      const mk = (suffix: string, frames: number[], frameRate: number, repeat: number) => {
        const key = `a-${actor}-${suffix}-${dir}`;
        if (!anims.exists(key)) {
          anims.create({
            key,
            frames: frames.map((f) => ({ key: tex, frame: base + f })),
            frameRate,
            repeat,
          });
        }
      };
      mk("walk", [0, 1, 2, 3], 8, -1);
      mk("idle", [0, 1], 1.4, -1);
      mk("cast", [4, 5], 3, -1);
      mk("die", [6, 7], 3, 0);
    });
  }
  const fx = (key: string, tex: string, frames: number[], frameRate: number) => {
    if (!anims.exists(key)) {
      anims.create({
        key,
        frames: frames.map((f) => ({ key: tex, frame: f })),
        frameRate,
        repeat: -1,
      });
    }
  };
  fx("fx-fire32-burn", SHEET.fire32, [0, 1, 2, 3, 4, 5, 6, 7, 8], 12);
  fx("fx-fire64-burn", SHEET.fire64, [0, 1, 2, 3, 4, 5, 6, 7, 8], 12);
  fx("fx-smoke-puff", SHEET.smoke, [0, 1, 2, 3, 4], 5);
}

/** Citizen walk animations (front/back per character). */
export function registerCitizenAnims(anims: Phaser.Animations.AnimationManager): void {
  const defs: [string, CitizenDef][] = [
    ...VILLAGERS.map((d, i) => [`v${i}`, d] as [string, CitizenDef]),
    ["sold", SOLDIER],
  ];
  for (const [id, def] of defs) {
    const mk = (suffix: string, frames: string[]) => {
      const key = `cit-${id}-${suffix}`;
      if (!anims.exists(key)) {
        anims.create({
          key,
          frames: frames.map((f) => ({ key: SHEET.citizens, frame: f })),
          frameRate: 7,
          repeat: -1,
        });
      }
    };
    mk("front", def.frontWalk);
    mk("back", def.backWalk);
  }
}

export function citizenAnimId(def: CitizenDef): string {
  const idx = VILLAGERS.indexOf(def);
  return idx >= 0 ? `v${idx}` : "sold";
}
