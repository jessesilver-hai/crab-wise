import { Graphics, Renderer, Texture } from "pixi.js";
import type { PixelSprite, ThemePack } from "@agent-empires/protocol";
import { TILE_W, TILE_H } from "./map.js";

/**
 * Default world skin: ancient-future — a civilization so old its technology
 * reads as ritual. Ashen steppe, monolithic structures with dim glow seams,
 * robed figures, wraith-specters. All drawn procedurally into textures; a
 * repo's ThemePack overrides pieces with LLM-drawn pixel sprites.
 */
export type TextureSet = {
  grass: Texture[];
  fog: Texture;
  tree: Texture;
  buildings: Record<string, { built: Texture; scaffold: Texture }>;
  wonder: Texture;
  villager: Texture;
  king: Texture;
  raider: Texture;
  highlight: Texture;
};

const GLOW = 0xe3b264;

function diamond(g: Graphics, w: number, h: number, color: number): Graphics {
  g.moveTo(0, -h / 2).lineTo(w / 2, 0).lineTo(0, h / 2).lineTo(-w / 2, 0).closePath().fill(color);
  return g;
}

/** Isometric box: top diamond + two side faces. */
function isoBox(
  g: Graphics,
  w: number,
  depth: number,
  height: number,
  top: number,
  left: number,
  right: number,
): Graphics {
  const hw = w / 2;
  const hd = depth / 2;
  g.moveTo(-hw, -height).lineTo(0, hd - height).lineTo(0, hd).lineTo(-hw, 0).closePath().fill(left);
  g.moveTo(hw, -height).lineTo(0, hd - height).lineTo(0, hd).lineTo(hw, 0).closePath().fill(right);
  g.moveTo(0, -hd - height).lineTo(hw, -height).lineTo(0, hd - height).lineTo(-hw, -height).closePath().fill(top);
  return g;
}

/** Thin vertical glow seam on a structure face. */
function seam(g: Graphics, x: number, yTop: number, height: number, color = GLOW): void {
  g.rect(x - 0.8, yTop, 1.6, height).fill({ color, alpha: 0.9 });
}

export function buildTextures(renderer: Renderer): TextureSet {
  const gen = (g: Graphics) => {
    const tex = renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
    return tex;
  };

  // --- terrain: ashen steppe -----------------------------------------------
  const grass = makeGroundTextures(renderer, [0x6a6152, 0x726858, 0x615847, 0x79705f]);

  const fogG = new Graphics();
  diamond(fogG, TILE_W + 2, TILE_H + 2, 0x060504);
  const fog = gen(fogG);

  // "tree" = standing stone relic with a faint sigil glow
  const treeG = new Graphics();
  treeG.moveTo(-5, 0).lineTo(-3, -26).lineTo(3, -28).lineTo(5, 0).closePath().fill(0x4a453d);
  treeG.moveTo(-3, -26).lineTo(3, -28).lineTo(5, 0).lineTo(1, 0).closePath().fill(0x3a362f);
  treeG.circle(0, -18, 1.6).fill({ color: GLOW, alpha: 0.8 });
  treeG.ellipse(0, 1, 8, 3).fill({ color: 0x000000, alpha: 0.3 });
  const tree = gen(treeG);

  // --- structures: brutalist monoliths --------------------------------------
  const mk = (draw: (g: Graphics) => void): Texture => {
    const g = new Graphics();
    draw(g);
    return gen(g);
  };

  const scaffoldFor = (w: number, d: number, h: number): Texture =>
    mk((g) => {
      isoBox(g, w, d, h * 0.4, 0x5c554a, 0x4a4439, 0x3b362d);
      for (const [x] of [[-w / 2 + 2], [w / 2 - 2], [0]] as const) {
        g.rect(x - 1, -h, 2, h).fill(0x55503f);
      }
      g.rect(-w / 4, -h - 2, w / 2, 2).fill({ color: GLOW, alpha: 0.35 });
    });

  const buildings: TextureSet["buildings"] = {
    // dwelling: low adobe block, one glow door
    house: {
      built: mk((g) => {
        isoBox(g, 40, 24, 22, 0x8d8577, 0x6e675b, 0x585247);
        seam(g, 10, -18, 18);
        g.moveTo(0, -34).lineTo(20, -22).lineTo(0, -12).lineTo(-20, -22).closePath().fill(0x77705f);
      }),
      scaffold: scaffoldFor(40, 24, 24),
    },
    // bastion: angular fortress with antenna-spike
    barracks: {
      built: mk((g) => {
        isoBox(g, 48, 30, 28, 0x6f6f74, 0x55555c, 0x424248);
        g.moveTo(-24, -28).lineTo(-14, -40).lineTo(-4, -28).closePath().fill(0x62626a);
        g.rect(-0.8, -54, 1.6, 26).fill(0x50505a);
        g.circle(0, -55, 1.8).fill({ color: 0xb5564a, alpha: 0.95 });
        seam(g, -18, -22, 20, 0xb5564a);
      }),
      scaffold: scaffoldFor(48, 30, 28),
    },
    // trade-vault: low dome over a causeway gate
    market: {
      built: mk((g) => {
        isoBox(g, 46, 28, 14, 0x8d8577, 0x6e675b, 0x585247);
        g.circle(0, -20, 13).fill(0x77705f);
        g.circle(0, -20, 13).stroke({ color: 0x4a4439, width: 1.5 });
        g.rect(-6, -12, 12, 12).fill({ color: GLOW, alpha: 0.5 });
        seam(g, -16, -12, 10);
        seam(g, 16, -12, 10);
      }),
      scaffold: scaffoldFor(46, 28, 22),
    },
    // sanctum: tall thin obelisk, apex glow
    monastery: {
      built: mk((g) => {
        g.moveTo(-9, 0).lineTo(-5, -44).lineTo(0, -48).lineTo(5, -44).lineTo(9, 0).closePath().fill(0x7d7568);
        g.moveTo(0, -48).lineTo(5, -44).lineTo(9, 0).lineTo(0, 0).closePath().fill(0x655e51);
        g.circle(0, -50, 2.4).fill({ color: GLOW, alpha: 0.95 });
        seam(g, 0, -40, 34);
        g.ellipse(0, 1, 12, 4).fill({ color: 0x000000, alpha: 0.3 });
      }),
      scaffold: scaffoldFor(38, 24, 30),
    },
    // engine-granary: tiered silo with a slow ring
    mill: {
      built: mk((g) => {
        isoBox(g, 34, 22, 18, 0x837b6c, 0x685f50, 0x534b3e);
        isoBox(g, 24, 16, 10, 0x8d8577, 0x6e675b, 0x585247);
        g.translateTransform(0, -28);
        g.ellipse(0, 0, 15, 5).stroke({ color: GLOW, width: 1.4, alpha: 0.7 });
        g.translateTransform(0, 28);
      }),
      scaffold: scaffoldFor(34, 22, 24),
    },
    // the Citadel: stepped monolith, apex beacon
    towncenter: {
      built: mk((g) => {
        isoBox(g, 64, 40, 20, 0x7d7568, 0x615a4c, 0x4c463b);
        g.translateTransform(0, -20);
        isoBox(g, 46, 30, 16, 0x877f70, 0x6a6254, 0x544d40);
        g.translateTransform(0, -16);
        isoBox(g, 28, 18, 14, 0x91897a, 0x746c5c, 0x5c5547);
        g.translateTransform(0, 36);
        seam(g, -20, -34, 30);
        seam(g, 20, -34, 30);
        g.circle(0, -66, 3).fill(GLOW);
        g.circle(0, -66, 6).stroke({ color: GLOW, width: 1, alpha: 0.4 });
      }),
      scaffold: scaffoldFor(64, 40, 34),
    },
  };

  // the Beacon: a spire casting a light column
  const wonder = mk((g) => {
    g.rect(-2.5, -70, 5, 200).fill({ color: GLOW, alpha: 0.12 });
    g.moveTo(-14, 0).lineTo(-6, -58).lineTo(0, -64).lineTo(6, -58).lineTo(14, 0).closePath().fill(0x8d8577);
    g.moveTo(0, -64).lineTo(6, -58).lineTo(14, 0).lineTo(0, 0).closePath().fill(0x6e675b);
    seam(g, 0, -58, 52);
    g.circle(0, -68, 4).fill(GLOW);
    g.circle(0, -68, 9).stroke({ color: GLOW, width: 1.2, alpha: 0.5 });
    g.ellipse(0, 1, 18, 6).fill({ color: 0x000000, alpha: 0.3 });
  });

  // --- figures ----------------------------------------------------------------
  // robed worker
  const villager = mk((g) => {
    g.ellipse(0, 1, 8, 3.5).fill({ color: 0x000000, alpha: 0.35 });
    g.moveTo(-5, 0).lineTo(-4, -13).lineTo(4, -13).lineTo(5, 0).closePath().fill(0xa39a86);
    g.circle(0, -15, 4).fill(0x8d8577);
    g.moveTo(-4, -15).lineTo(0, -20).lineTo(4, -15).closePath().fill(0xa39a86); // hood
    g.rect(-1, -10, 2, 6).fill({ color: 0x4a4439 }); // sash
  });
  // hierophant: taller, halo ring
  const king = mk((g) => {
    g.ellipse(0, 1, 9, 4).fill({ color: 0x000000, alpha: 0.35 });
    g.moveTo(-6, 0).lineTo(-4, -17).lineTo(4, -17).lineTo(6, 0).closePath().fill(0x8a7a58);
    g.circle(0, -19, 4).fill(0x9a8f79);
    g.moveTo(-4, -19).lineTo(0, -25).lineTo(4, -19).closePath().fill(0x8a7a58);
    g.ellipse(0, -22, 8, 3).stroke({ color: GLOW, width: 1.3, alpha: 0.9 });
  });
  // specter: black wraith, pale eyes
  const raider = mk((g) => {
    g.ellipse(0, 1, 8, 3.5).fill({ color: 0x000000, alpha: 0.25 });
    g.moveTo(-5, 0).lineTo(-4, -14).lineTo(0, -18).lineTo(4, -14).lineTo(5, 0).closePath().fill({ color: 0x16141a, alpha: 0.95 });
    g.moveTo(-5, 0).lineTo(-2, -4).lineTo(1, 0).closePath().fill({ color: 0x16141a, alpha: 0.5 });
    g.circle(-1.6, -13, 1).fill(0xbfd4d8);
    g.circle(1.6, -13, 1).fill(0xbfd4d8);
  });

  const hlG = new Graphics();
  hlG.moveTo(0, -TILE_H / 2).lineTo(TILE_W / 2, 0).lineTo(0, TILE_H / 2).lineTo(-TILE_W / 2, 0).closePath()
    .stroke({ color: GLOW, width: 2 });
  const highlight = gen(hlG);

  return { grass, fog, tree, buildings, wonder, villager, king, raider, highlight };
}

function makeGroundTextures(renderer: Renderer, colors: number[]): Texture[] {
  return colors.map((c) => {
    const g = new Graphics();
    diamond(g, TILE_W, TILE_H, c);
    g.moveTo(0, -TILE_H / 2).lineTo(TILE_W / 2, 0).lineTo(0, TILE_H / 2).lineTo(-TILE_W / 2, 0).closePath()
      .stroke({ color: 0x2e2a22, width: 1, alpha: 0.5 });
    const tex = renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
    return tex;
  });
}

// ---------------------------------------------------------------------------
// Theme application: LLM pixel sprites → textures
// ---------------------------------------------------------------------------

export function pixelSpriteTexture(
  renderer: Renderer,
  sprite: PixelSprite,
  pixelSize: number,
): Texture {
  const g = new Graphics();
  const width = Math.max(...sprite.rows.map((r) => r.length));
  const height = sprite.rows.length;
  const ox = (-width * pixelSize) / 2;
  sprite.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === "." || ch === " ") continue;
      const hex = sprite.palette[ch];
      if (!hex) continue;
      g.rect(ox + x * pixelSize, (y - height) * pixelSize, pixelSize, pixelSize).fill(
        parseInt(hex.slice(1), 16),
      );
    }
  });
  // soft ground shadow so themed sprites sit in the world
  g.ellipse(0, 1, (width * pixelSize) / 3, 3.5).fill({ color: 0x000000, alpha: 0.3 });
  const tex = renderer.generateTexture({ target: g, resolution: 2 });
  g.destroy();
  return tex;
}

const UNIT_KEYS = new Set(["villager", "hero", "raider"]);
const BUILDING_KEYS = new Set(["house", "barracks", "market", "monastery", "mill", "towncenter"]);

/** Merge a ThemePack over the default set. Missing pieces keep defaults. */
export function applyTheme(renderer: Renderer, base: TextureSet, theme: ThemePack): TextureSet {
  const out: TextureSet = {
    ...base,
    buildings: { ...base.buildings },
  };

  const grassColors = theme.biome.grassColors
    .map((c) => parseInt(c.slice(1), 16))
    .filter((n) => !Number.isNaN(n));
  if (grassColors.length >= 2) out.grass = makeGroundTextures(renderer, grassColors);

  const fogColor = parseInt(theme.biome.fogColor.slice(1), 16);
  if (!Number.isNaN(fogColor)) {
    const g = new Graphics();
    diamond(g, TILE_W + 2, TILE_H + 2, fogColor);
    out.fog = renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
  }

  for (const sprite of theme.sprites) {
    if (UNIT_KEYS.has(sprite.key)) {
      const tex = pixelSpriteTexture(renderer, sprite, 2);
      if (sprite.key === "villager") out.villager = tex;
      if (sprite.key === "hero") out.king = tex;
      if (sprite.key === "raider") out.raider = tex;
    } else if (sprite.key === "tree") {
      out.tree = pixelSpriteTexture(renderer, sprite, 2);
    } else if (BUILDING_KEYS.has(sprite.key)) {
      out.buildings[sprite.key] = {
        built: pixelSpriteTexture(renderer, sprite, sprite.key === "towncenter" ? 3 : 2.5),
        scaffold: base.buildings[sprite.key]?.scaffold ?? base.buildings.house!.scaffold,
      };
    } else if (sprite.key === "wonder") {
      out.wonder = pixelSpriteTexture(renderer, sprite, 3);
    }
  }
  return out;
}
