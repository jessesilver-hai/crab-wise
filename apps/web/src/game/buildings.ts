import Phaser from "phaser";
import type { DistrictArchetype } from "@agent-empires/protocol";
import { P, SHEET, WALL_RUBBLE, W } from "./atlas.js";
import type { SizeBucket } from "./map.js";

/**
 * Buildings are composed from Yar modular parts: a wall-corner cell as the
 * body, a roof cell stacked above, plus kind-specific dressing. Footprint
 * grows with the file's LOC bucket (hut < house < large workshop). Every
 * part records a role so themes can recolor roofs without touching walls.
 */

export type PartRole = "wall" | "roof" | "deco" | "fx";

export type ComposedBuilding = {
  root: Phaser.GameObjects.Container;
  parts: { obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite; role: PartRole }[];
  /** Interactive hit rect in container-local coords. */
  hit: Phaser.Geom.Rectangle;
};

type PartSpec = { frame: string; dx: number; dy: number; role: PartRole; sheet?: string };

const HOUSE_WALLS = [P.wallPlaster, P.wallYellow, P.wallHinges, P.wallPlank];
const HOUSE_ROOFS = [P.roofGableA, P.roofGableB, P.roofGableC];

function pickN<T>(arr: T[], n: number): T {
  return arr[((n % arr.length) + arr.length) % arr.length]!;
}

/**
 * Recipe per building kind + size bucket. dx/dy offsets are relative to the
 * plot tile's ground point; wall cells hold content in the lower 48px of
 * their 64px cell, roofs stack ~30px above.
 */
/** Structure typologies keep their silhouette even at hut size. */
const TYPOLOGY_KINDS = new Set(["watchtower", "stela", "silo", "reliquary", "gatehouse", "megastructure"]);

function recipe(kind: string, arch: DistrictArchetype, bucket: SizeBucket, h: number): PartSpec[] {
  if (bucket === 0 && kind !== "towncenter" && !TYPOLOGY_KINDS.has(kind)) {
    // hut: a single low cell with a small awning cap
    return [
      { frame: pickN([P.wallDark, P.wallDoorA, P.wallDoorB, P.wallWindow], h), dx: 0, dy: 16, role: "wall" },
      { frame: P.roofSmall, dx: 0, dy: -28, role: "roof" },
    ];
  }
  const large = bucket === 2;
  switch (kind) {
    case "watchtower": {
      // tests stand guard: a stacked stone tower, unmistakable at any size
      const parts: PartSpec[] = [{ frame: P.keepBlock, dx: 0, dy: 16, role: "wall" }];
      if (bucket >= 1) parts.push({ frame: P.keepBlock, dx: 0, dy: -30, role: "wall" });
      parts.push({ frame: P.pyramid, dx: 0, dy: bucket >= 1 ? -76 : -30, role: "roof" });
      if (large) parts.push({ frame: P.pillarTall, dx: -26, dy: 24, role: "deco" });
      return parts;
    }
    case "stela": {
      // docs are monuments: slab, pillar, and for the great ones a spire
      const parts: PartSpec[] = [
        { frame: P.stoneSlab, dx: 0, dy: 16, role: "wall" },
        { frame: large ? P.spire : P.pillarTall, dx: 0, dy: large ? -20 : -14, role: "roof" },
      ];
      if (bucket >= 1) parts.push({ frame: P.pillarSmall, dx: 22, dy: 20, role: "deco" });
      return parts;
    }
    case "silo": {
      // configs feed the realm: a granary tower under a pyramid cap
      const parts: PartSpec[] = [
        { frame: P.keepDoor, dx: 0, dy: 16, role: "wall" },
        { frame: P.pyramid, dx: 0, dy: -30, role: "roof" },
      ];
      if (bucket >= 1) parts.push({ frame: P.awning, dx: -20, dy: 8, role: "deco" });
      return parts;
    }
    case "reliquary": {
      // assets rest in low vaults, not homes
      return [
        { frame: P.stonePlatform, dx: 0, dy: 16, role: "wall" },
        { frame: P.stoneSlab, dx: 0, dy: -6, role: "roof" },
        { frame: P.awning, dx: 14, dy: 2, role: "deco" },
      ];
    }
    case "gatehouse": {
      // entry points are gates: an arch flanked by pillars
      const parts: PartSpec[] = [
        { frame: P.keepArch, dx: 0, dy: 16, role: "wall" },
        { frame: P.roofSmall, dx: 0, dy: -40, role: "roof" },
        { frame: P.pillarSmall, dx: -28, dy: 24, role: "deco" },
      ];
      if (bucket >= 1) parts.push({ frame: P.pillarSmall, dx: 28, dy: 24, role: "deco" });
      return parts;
    }
    case "megastructure": {
      // giant files dwarf the streets: joined keeps under a spire
      return [
        { frame: P.keepBlock, dx: 32, dy: 32, role: "wall" },
        { frame: P.keepArch, dx: 0, dy: 16, role: "wall" },
        { frame: P.spire, dx: 32, dy: -16, role: "roof" },
        { frame: P.roofSlopeA, dx: 0, dy: -32, role: "roof" },
        { frame: P.chimneyOpen, dx: -16, dy: -28, role: "deco" },
      ];
    }
    case "towncenter": // sub-package hearts: a small stone keep
      return [
        { frame: P.keepArch, dx: 0, dy: 16, role: "wall" },
        { frame: P.pyramid, dx: 0, dy: -38, role: "roof" },
      ];
    case "barracks": {
      const parts: PartSpec[] = [
        { frame: P.keepBlock, dx: 0, dy: 16, role: "wall" },
        { frame: P.roofSmall, dx: 0, dy: -40, role: "roof" },
      ];
      if (large) parts.push({ frame: P.pillarSmall, dx: -30, dy: 30, role: "deco" });
      return parts;
    }
    case "market": {
      const parts: PartSpec[] = [
        { frame: P.floorWoodBig, dx: 0, dy: 16, role: "deco" },
        { frame: P.table, dx: -2, dy: 8, role: "deco" },
        { frame: P.roofGableC, dx: 0, dy: -26, role: "roof" },
      ];
      if (large) parts.push({ frame: P.stoolA, dx: 26, dy: 22, role: "deco" });
      return parts;
    }
    case "monastery":
      return [
        { frame: P.wallLattice, dx: 0, dy: 16, role: "wall" },
        { frame: P.spire, dx: 0, dy: -28, role: "roof" },
      ];
    case "mill": {
      const parts: PartSpec[] = [
        { frame: P.stonePlatform, dx: 0, dy: 16, role: "wall" },
        { frame: P.pyramid, dx: 0, dy: -26, role: "roof" },
        { frame: P.chimneyOpen, dx: 18, dy: -18, role: "deco" },
      ];
      return parts;
    }
    default: {
      // house / workshop: wall + roof picked by hash so streets vary
      const wall = pickN(HOUSE_WALLS, h);
      const roof = pickN(HOUSE_ROOFS, h >> 2);
      if (!large) {
        const parts: PartSpec[] = [
          { frame: wall, dx: 0, dy: 16, role: "wall" },
          { frame: roof, dx: 0, dy: -30, role: "roof" },
        ];
        if (arch === "forge" || h % 5 === 0) parts.push({ frame: P.chimney, dx: 15, dy: -27, role: "deco" });
        return parts;
      }
      // large workshop: two joined cells along the SE axis + long roofline
      const wall2 = pickN(HOUSE_WALLS, h >> 3);
      return [
        { frame: wall2, dx: 32, dy: 32, role: "wall" },
        { frame: wall, dx: 0, dy: 16, role: "wall" },
        { frame: pickN(HOUSE_ROOFS, h >> 5), dx: 32, dy: -14, role: "roof" },
        { frame: roof, dx: 0, dy: -30, role: "roof" },
        { frame: P.chimney, dx: -14, dy: -28, role: "deco" },
      ];
    }
  }
}

export function composeBuilding(
  scene: Phaser.Scene,
  kind: string,
  arch: DistrictArchetype,
  bucket: SizeBucket,
  hash: number,
): ComposedBuilding {
  const specs = recipe(kind, arch, bucket, hash >>> 0);
  const parts: ComposedBuilding["parts"] = [];
  const root = scene.add.container(0, 0);
  let top = 0;
  let left = -30;
  let right = 30;
  for (const s of specs) {
    const img = scene.add.image(s.dx, s.dy, s.sheet ?? SHEET.parts, s.frame).setOrigin(0.5, 1);
    root.add(img);
    parts.push({ obj: img, role: s.role });
    top = Math.min(top, s.dy - img.height);
    left = Math.min(left, s.dx - img.width / 2);
    right = Math.max(right, s.dx + img.width / 2);
  }
  // hearth smoke for the working kinds
  if (bucket > 0 && (kind === "mill" || (kind === "house" && arch === "forge"))) {
    const smoke = scene.add
      .sprite(14, top + 6, SHEET.smoke, 0)
      .setOrigin(0.5, 1)
      .setAlpha(0.75)
      .setScale(0.5);
    smoke.play({ key: "fx-smoke-puff", delay: (hash % 7) * 130 });
    root.add(smoke);
    parts.push({ obj: smoke, role: "fx" });
  }
  const hit = new Phaser.Geom.Rectangle(left, top, right - left, 22 - top);
  return { root, parts, hit };
}

/** Aggregated hamlet: a dense cluster of huts standing in for N files. */
export function composeHamlet(scene: Phaser.Scene, hash: number): ComposedBuilding {
  const root = scene.add.container(0, 0);
  const parts: ComposedBuilding["parts"] = [];
  const spots: [number, number][] = [
    [-16, 8],
    [16, 16],
    [0, 26],
  ];
  spots.forEach(([dx, dy], i) => {
    const wall = pickN([P.wallDark, P.wallDoorA, P.wallWindow], hash + i);
    const w = scene.add.image(dx, dy, SHEET.parts, wall).setOrigin(0.5, 1).setScale(0.5);
    const r = scene.add
      .image(dx, dy - 22, SHEET.parts, pickN(HOUSE_ROOFS, hash + i * 3))
      .setOrigin(0.5, 1)
      .setScale(0.5);
    root.add(w);
    root.add(r);
    parts.push({ obj: w, role: "wall" });
    parts.push({ obj: r, role: "roof" });
  });
  const hit = new Phaser.Geom.Rectangle(-34, -46, 68, 78);
  return { root, parts, hit };
}

/** Construction-site look shown before a brand-new building pops in. */
export function makeScaffold(scene: Phaser.Scene, hash: number): Phaser.GameObjects.Image {
  const frame = WALL_RUBBLE[hash % WALL_RUBBLE.length]!;
  return scene.add.image(0, 0, SHEET.walls, frame).setOrigin(0.5, 78 / 128);
}

/** The victory Wonder: a stacked monument with banners and a beacon fire. */
export function composeWonder(
  scene: Phaser.Scene,
  flagTex: string,
  accent: number,
): ComposedBuilding {
  const root = scene.add.container(0, 0);
  const parts: ComposedBuilding["parts"] = [];
  const add = (obj: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite, role: PartRole) => {
    root.add(obj);
    parts.push({ obj, role });
  };
  add(scene.add.image(0, 20, SHEET.parts, P.stairsA).setOrigin(0.5, 1), "wall");
  add(scene.add.image(0, -8, SHEET.parts, P.pillarTall).setOrigin(0.5, 1), "wall");
  add(scene.add.image(0, -50, SHEET.parts, P.spire).setOrigin(0.5, 1), "roof");
  const fire = scene.add.sprite(0, -168, SHEET.fire32, 0).setOrigin(0.5, 1);
  fire.play("fx-fire32-burn");
  add(fire, "fx");
  add(scene.add.image(-22, -120, flagTex).setOrigin(0.5, 1).setTint(accent), "deco");
  add(scene.add.image(22, -120, flagTex).setOrigin(0.5, 1).setTint(accent).setFlipX(true), "deco");
  const hit = new Phaser.Geom.Rectangle(-34, -196, 68, 220);
  return { root, parts, hit };
}

/** A ruined-arch gate piece used when a wall segment is destroyed. */
export const RUINED_GATE = W.archRuined;
