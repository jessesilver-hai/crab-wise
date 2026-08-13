import { Graphics, Renderer, Texture } from "pixi.js";
import { TILE_W, TILE_H } from "./map.js";

/**
 * Procedural pixel-art-flavored textures. Everything is drawn once into
 * render textures, so the game uses sprites (cheap) rather than live Graphics.
 * Swappable later for hand-drawn or CC0 asset packs.
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

function diamond(g: Graphics, w: number, h: number, color: number): Graphics {
  g.moveTo(0, -h / 2).lineTo(w / 2, 0).lineTo(0, h / 2).lineTo(-w / 2, 0).closePath().fill(color);
  return g;
}

/** Isometric box: top diamond + two side faces, the core building block. */
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
  // left face
  g.moveTo(-hw, -height).lineTo(0, hd - height).lineTo(0, hd).lineTo(-hw, 0).closePath().fill(left);
  // right face
  g.moveTo(hw, -height).lineTo(0, hd - height).lineTo(0, hd).lineTo(hw, 0).closePath().fill(right);
  // top
  g.moveTo(0, -hd - height).lineTo(hw, -height).lineTo(0, hd - height).lineTo(-hw, -height).closePath().fill(top);
  return g;
}

export function buildTextures(renderer: Renderer): TextureSet {
  const gen = (g: Graphics) => {
    const tex = renderer.generateTexture({ target: g, resolution: 2 });
    g.destroy();
    return tex;
  };

  // --- terrain ---------------------------------------------------------
  const grass = [0x4f7a37, 0x557f3a, 0x4a7434, 0x5a8440].map((c) => {
    const g = new Graphics();
    diamond(g, TILE_W, TILE_H, c);
    g.moveTo(0, -TILE_H / 2).lineTo(TILE_W / 2, 0).lineTo(0, TILE_H / 2).lineTo(-TILE_W / 2, 0).closePath()
      .stroke({ color: 0x3c5f2a, width: 1, alpha: 0.6 });
    return gen(g);
  });

  const fogG = new Graphics();
  diamond(fogG, TILE_W + 2, TILE_H + 2, 0x0b0906);
  const fog = gen(fogG);

  const treeG = new Graphics();
  treeG.rect(-2, -10, 4, 10).fill(0x5b4226);
  treeG.circle(0, -16, 9).fill(0x2f5b26);
  treeG.circle(-5, -12, 6).fill(0x376a2c);
  treeG.circle(5, -12, 6).fill(0x2a5322);
  const tree = gen(treeG);

  // --- buildings ---------------------------------------------------------
  const mk = (draw: (g: Graphics) => void): Texture => {
    const g = new Graphics();
    draw(g);
    return gen(g);
  };

  const scaffoldFor = (w: number, d: number, h: number): Texture =>
    mk((g) => {
      isoBox(g, w, d, h * 0.45, 0xa08858, 0x86704a, 0x6d5a3c);
      // corner poles
      for (const [x, yBase] of [[-w / 2, 0], [w / 2, 0], [0, d / 2]] as const) {
        g.rect(x - 1.5, yBase - h, 3, h).fill(0x7a5c33);
      }
    });

  const buildings: TextureSet["buildings"] = {
    house: {
      built: mk((g) => {
        isoBox(g, 40, 24, 20, 0xc9b287, 0xa68e63, 0x8a7550);
        // roof
        g.moveTo(0, -44).lineTo(22, -22).lineTo(0, -8).lineTo(-22, -22).closePath().fill(0x9e4a32);
        g.moveTo(0, -44).lineTo(22, -22).lineTo(0, -14).closePath().fill(0x8a3f2b);
      }),
      scaffold: scaffoldFor(40, 24, 24),
    },
    barracks: {
      built: mk((g) => {
        isoBox(g, 48, 30, 26, 0x8d8d94, 0x6f6f78, 0x5a5a63);
        // crenellations
        for (let i = -2; i <= 2; i++) g.rect(i * 9 - 3, -34, 6, 8).fill(0x7c7c85);
        // banner
        g.rect(-1, -50, 2, 18).fill(0x4a3820);
        g.moveTo(1, -50).lineTo(14, -46).lineTo(1, -42).closePath().fill(0xc0483c);
      }),
      scaffold: scaffoldFor(48, 30, 28),
    },
    market: {
      built: mk((g) => {
        isoBox(g, 46, 28, 14, 0xc9b287, 0xa68e63, 0x8a7550);
        // striped awning
        g.moveTo(0, -40).lineTo(25, -18).lineTo(0, -2).lineTo(-25, -18).closePath().fill(0xb8862e);
        g.moveTo(0, -40).lineTo(25, -18).lineTo(0, -10).closePath().fill(0x8f6a24);
        g.circle(-8, -22, 3).fill(0xe8d9b0);
        g.circle(8, -18, 3).fill(0xe8d9b0);
      }),
      scaffold: scaffoldFor(46, 28, 22),
    },
    monastery: {
      built: mk((g) => {
        isoBox(g, 38, 24, 26, 0xd8cfc0, 0xb5aa97, 0x968b78);
        // dome + cross
        g.circle(0, -34, 10).fill(0x8a6f9e);
        g.rect(-1, -52, 2, 10).fill(0xd4a843);
        g.rect(-4, -49, 8, 2).fill(0xd4a843);
      }),
      scaffold: scaffoldFor(38, 24, 28),
    },
    mill: {
      built: mk((g) => {
        isoBox(g, 34, 22, 22, 0xb59a6a, 0x93794f, 0x79633f);
        // sails
        g.rect(-1, -46, 2, 16).fill(0x5b4226);
        for (const a of [0.5, 2.07, 3.64, 5.21]) {
          g.moveTo(0, -42)
            .lineTo(Math.cos(a) * 16, -42 + Math.sin(a) * 16)
            .lineTo(Math.cos(a + 0.35) * 12, -42 + Math.sin(a + 0.35) * 12)
            .closePath()
            .fill(0xe0d5b8);
        }
      }),
      scaffold: scaffoldFor(34, 22, 24),
    },
    towncenter: {
      built: mk((g) => {
        isoBox(g, 64, 40, 26, 0xc9b287, 0xa68e63, 0x8a7550);
        // grand tiered roof
        g.moveTo(0, -62).lineTo(34, -30).lineTo(0, -6).lineTo(-34, -30).closePath().fill(0x9e4a32);
        g.moveTo(0, -62).lineTo(34, -30).lineTo(0, -18).closePath().fill(0x8a3f2b);
        g.moveTo(0, -74).lineTo(16, -58).lineTo(0, -46).lineTo(-16, -58).closePath().fill(0xb85a3e);
        // gold finial
        g.circle(0, -76, 4).fill(0xd4a843);
      }),
      scaffold: scaffoldFor(64, 40, 30),
    },
  };

  const wonder = mk((g) => {
    // golden ziggurat
    isoBox(g, 84, 52, 18, 0xd8b866, 0xb99a4e, 0x97803f);
    g.translateTransform(0, -18);
    isoBox(g, 60, 38, 16, 0xe3c674, 0xc2a557, 0x9e8845);
    g.translateTransform(0, -16);
    isoBox(g, 36, 24, 14, 0xf0d488, 0xd4b869, 0xae9852);
    g.translateTransform(0, -14);
    g.circle(0, -14, 6).fill(0xfff2c0);
  });

  // --- units -------------------------------------------------------------
  const unit = (tunic: number, skin: number, hat?: number): Texture =>
    mk((g) => {
      g.ellipse(0, 1, 9, 4).fill({ color: 0x000000, alpha: 0.3 }); // shadow
      g.rect(-4, -14, 8, 10).fill(tunic); // body
      g.circle(0, -18, 5).fill(skin); // head
      if (hat !== undefined) {
        g.moveTo(-6, -21).lineTo(6, -21).lineTo(0, -30).closePath().fill(hat);
        g.circle(0, -29, 2).fill(0xf0c96a);
      }
    });

  const villager = unit(0x4c7e9e, 0xe8c39e);
  const king = unit(0x8a2be2 & 0xffffff, 0xe8c39e, 0xd4a843);
  const raider = mk((g) => {
    g.ellipse(0, 1, 9, 4).fill({ color: 0x000000, alpha: 0.3 });
    g.rect(-4, -14, 8, 10).fill(0x8a2020);
    g.circle(0, -18, 5).fill(0xb98a6a);
    g.rect(-9, -24, 2, 14).fill(0x666666); // spear
    g.moveTo(-9, -26).lineTo(-6, -22).lineTo(-11, -22).closePath().fill(0xaaaaaa);
  });

  const hlG = new Graphics();
  hlG.moveTo(0, -TILE_H / 2).lineTo(TILE_W / 2, 0).lineTo(0, TILE_H / 2).lineTo(-TILE_W / 2, 0).closePath()
    .stroke({ color: 0xf0c96a, width: 2 });
  const highlight = gen(hlG);

  return { grass, fog, tree, buildings, wonder, villager, king, raider, highlight };
}
