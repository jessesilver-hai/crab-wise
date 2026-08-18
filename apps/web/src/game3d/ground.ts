// Stepped terrain (vertex-colored treemap districts + roads + plaza + shore
// + map.heights plateaus with cliff skirts and road ramps), animated water
// (outer sea + map.water tiles), bridges, import-edge streets, and the
// fog-of-war veil draped over the landform. All placement colors derive from
// the map layout + mulberry32(seed) + the census-derived world DNA — no
// unseeded randomness.
import * as THREE from "three";
import type { DistrictArchetype, DistrictPatch } from "@agent-empires/protocol";
import { mulberry32, quarterOf, type MapLayout, type Rect } from "../game/map.js";
import { visibleFloor } from "../game/palette.js";
import type { WorldDNA } from "../game/worlddna.js";
import { ELEV } from "./terrain3d.js";
import { ARCH_TINT, mixColor, scaleColor, soften } from "./util.js";

const BASE_GRASS = 0x55703c;
const WILD_GRASS = 0x46603a;
const ROAD = 0x6b5a41;
const PLAZA = 0x8d8878;
const SAND = 0xb9a878;
const WATER = 0x2a4a5e;
const BRIDGE_PLANK = 0x8a6b46;
/** Water surface sits below the land plane; the bed dips beneath it. */
const WATER_Y = -0.06;
/** Cliff/skirt faces use the upper tile's palette darkened by this factor. */
const CLIFF_MUL = 0.75;
/** Streets are quieter than roads: a narrow pale strip, not a full tile. */
const STREET_W = 0.45;
/** Unsurveyed quarters sit under a veil notably deeper than exploration fog
 * (0.55 unexplored / 0.34 fringe); footsteps cannot clear it — only a survey. */
const SHROUD_ALPHA = 0.82;
const SHROUD_LIFTED = 0.34;

type GroundColors = WorldDNA["ground"];

const FALLBACK_COLORS: GroundColors = {
  base: BASE_GRASS,
  wild: WILD_GRASS,
  road: ROAD,
  plaza: PLAZA,
  shore: SAND,
  water: WATER,
  district: Object.fromEntries(
    Object.entries(ARCH_TINT).map(([k, v]) => [k, soften(v, 0.5)]),
  ) as Record<DistrictArchetype, number>,
};

export class Ground {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  private water: THREE.Mesh;
  private waterUniforms = { uTime: { value: 0 } };
  private side = 0;
  /** Per-tile final color (uint24), pre-theme. */
  private tileBase: Int32Array = new Int32Array(0);
  tileColors: Int32Array = new Int32Array(0);
  private map: MapLayout | null = null;
  private jitter: Float32Array = new Float32Array(0);
  private patchTints = new Map<string, number>(); // district path → tint
  private themeTint: number | undefined;
  private colors: GroundColors = FALLBACK_COLORS;

  // stepped-terrain vertex bookkeeping: each vertex averages ≤4 tile colors
  // (top faces) or takes one tile darkened (cliff skirts)
  private vertRef: Int32Array = new Int32Array(0);
  private vertMul: Float32Array = new Float32Array(0);
  private vertCount = 0;
  /** Per-tile corner heights (c00,c10,c11,c01) — streets + veil drape reuse. */
  private tileCornerY: Float32Array = new Float32Array(0);

  // import-edge streets (map.streets): narrow paved strips flush with terrain
  private streetMesh: THREE.Mesh | null = null;
  private streetMat: THREE.MeshLambertMaterial | null = null;
  /** Street tiles consumed from the layout (smoke introspection). */
  streetTileCount = 0;

  // inland water + bridges (map.water / map.bridges)
  private waterTiles: THREE.Mesh | null = null;
  private waterTilesMat: THREE.MeshLambertMaterial;
  private bridgeMesh: THREE.InstancedMesh | null = null;
  private bridgeMat: THREE.MeshLambertMaterial | null = null;
  /** Rendered counts, exposed for the smoke battery. */
  waterTileCount = 0;
  bridgeCount = 0;

  // fog veil
  private veil: THREE.Mesh | null = null;
  private veilRect = { x: 0, y: 0, w: 0, h: 0 };
  private fogCur: Float32Array = new Float32Array(0);
  private fogTarget: Float32Array = new Float32Array(0);
  private fogCleared: Uint8Array = new Uint8Array(0);
  /** Tiles under an unsurveyed quarter's deep veil (reveal() skips them). */
  private shrouded: Uint8Array = new Uint8Array(0);
  private fogAnimating = false;
  /** Called when a tile's veil target changes (city dims/lights buildings). */
  onFogTile: ((tx: number, ty: number, alpha: number) => void) | null = null;

  constructor() {
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    this.mesh.receiveShadow = true;
    this.mesh.userData.pick = { kind: "ground" };
    this.group.add(this.mesh);

    const waterMat = new THREE.MeshLambertMaterial({ color: WATER, transparent: true, opacity: 0.94 });
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterUniforms.uTime;
      shader.vertexShader =
        "uniform float uTime;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           transformed.y += sin(uTime * 1.3 + position.x * 0.55 + position.y * 0.4) * 0.05;`,
        );
    };
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 48, 48), waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -0.1;
    this.group.add(this.water);

    // inland water: geometry is baked in world coords (no mesh rotation), so
    // the wave uses position.x/z rather than the plane-local x/y above
    this.waterTilesMat = new THREE.MeshLambertMaterial({ color: WATER, transparent: true, opacity: 0.92 });
    this.waterTilesMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterUniforms.uTime;
      shader.vertexShader =
        "uniform float uTime;\n" +
        shader.vertexShader.replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           transformed.y += sin(uTime * 1.3 + position.x * 0.55 + position.z * 0.4) * 0.03;`,
        );
    };
  }

  build(map: MapLayout, seed: number, dna?: WorldDNA): void {
    if (dna) this.colors = dna.ground;
    this.map = map;
    this.side = map.side;
    const side = map.side;

    const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    this.jitter = new Float32Array(side * side);
    for (let i = 0; i < side * side; i++) this.jitter[i] = rand();
    this.tileBase = new Int32Array(side * side);
    this.tileColors = new Int32Array(side * side);
    this.buildTerrainMesh(map);
    this.computeTileBase();
    this.paint();

    this.water.geometry.dispose();
    this.water.geometry = new THREE.PlaneGeometry(side * 5, side * 5, 40, 40);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set((side - 1) / 2, -0.1, (side - 1) / 2);
    this.tintWaterMats(this.colors.water);

    this.buildWaterTiles(map);
    this.buildBridges(map);
    this.buildStreets(map);
    this.buildVeil(map);
  }

  /**
   * Water must read at any sun/veil state: self-lit toward its own hue so the
   * sea separates from the sky void and channels glint through dim light.
   */
  private tintWaterMats(color: number): void {
    for (const m of [this.water.material as THREE.MeshLambertMaterial, this.waterTilesMat]) {
      m.color.set(color);
      m.emissive.set(color);
      m.emissiveIntensity = 0.55;
    }
  }

  /** Re-derive all DNA-driven colors in place (form change via reskin). */
  setDna(colors: GroundColors): void {
    this.colors = colors;
    this.tintWaterMats(colors.water);
    this.streetMat?.color.set(this.streetColor());
    if (this.map) {
      this.computeTileBase();
      this.paint();
    }
  }

  /**
   * Build the stepped terrain: one quad per tile at its map.heights level
   * (per-tile vertices, so plateaus keep hard edges), cliff skirts wherever a
   * neighbor sits lower, road ramps across 1-level changes, and the classic
   * sunken water bed / sloped shoreline from the flat-era relief law.
   */
  private buildTerrainMesh(map: MapLayout): void {
    const side = map.side;
    const lvlOf = (tx: number, ty: number): number => {
      if (tx < 0 || ty < 0 || tx >= side || ty >= side) return 0;
      return map.heights.get(`${tx},${ty}`) ?? 0;
    };
    const isWater = (tx: number, ty: number): boolean => map.water.has(`${tx},${ty}`);
    const isPath = (tx: number, ty: number): boolean => {
      const k = `${tx},${ty}`;
      return map.roads.has(k) || map.streets.has(k);
    };
    // Road/street tiles ramp: a corner shared with a path neighbor exactly
    // one level lower drops to that neighbor's level (a climbable slope).
    const cornerLevel = (tx: number, ty: number, cx: number, cy: number): number => {
      let L = lvlOf(tx, ty);
      if (isPath(tx, ty) && !isWater(tx, ty)) {
        const nbs = [
          [tx + (cx ? 1 : -1), ty],
          [tx, ty + (cy ? 1 : -1)],
        ] as const;
        for (const [nx, ny] of nbs) {
          if (nx < 0 || ny < 0 || nx >= side || ny >= side) continue;
          if (isPath(nx, ny) && !isWater(nx, ny) && lvlOf(nx, ny) === L - 1) L = L - 1;
        }
      }
      return L;
    };
    const cornerY = (tx: number, ty: number, cx: number, cy: number): number => {
      // tiles sharing this corner (grid coord tx+cx, ty+cy)
      const gx = tx + cx;
      const gy = ty + cy;
      let wet = 0;
      let n = 0;
      for (const [ax, ay] of [[gx - 1, gy - 1], [gx, gy - 1], [gx - 1, gy], [gx, gy]] as const) {
        if (ax < 0 || ay < 0 || ax >= side || ay >= side) continue;
        n++;
        if (isWater(ax, ay)) wet++;
      }
      if (isWater(tx, ty)) return wet === n ? -0.42 : -0.16;
      const L = cornerLevel(tx, ty, cx, cy);
      if (L === 0 && wet > 0) return -0.16; // shoreline slopes into the sea
      return L * ELEV;
    };

    // corner order per tile: c00 (−x,−z), c10 (+x,−z), c11 (+x,+z), c01 (−x,+z)
    const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    this.tileCornerY = new Float32Array(side * side * 4);
    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const i = (ty * side + tx) * 4;
        CORNERS.forEach(([cx, cy], c) => {
          this.tileCornerY[i + c] = cornerY(tx, ty, cx, cy);
        });
      }
    }

    const pos: number[] = [];
    const idx: number[] = [];
    const ref: number[] = []; // 4 tile indices per vertex, -1 padded
    const mul: number[] = [];
    const pushVert = (x: number, y: number, z: number, tiles: number[], m: number): number => {
      const v = pos.length / 3;
      pos.push(x, y, z);
      for (let k = 0; k < 4; k++) ref.push(tiles[k] ?? -1);
      mul.push(m);
      return v;
    };

    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const ti = ty * side + tx;
        const ci = ti * 4;
        // top face: 4 verts, colors averaged over the ≤4 tiles at each corner
        const verts: number[] = [];
        CORNERS.forEach(([cx, cy], c) => {
          const gx = tx + cx;
          const gy = ty + cy;
          const tiles: number[] = [];
          for (const [ax, ay] of [[gx - 1, gy - 1], [gx, gy - 1], [gx - 1, gy], [gx, gy]] as const) {
            if (ax < 0 || ay < 0 || ax >= side || ay >= side) continue;
            tiles.push(ay * side + ax);
          }
          verts.push(pushVert(tx - 0.5 + cx, this.tileCornerY[ci + c]!, ty - 0.5 + cy, tiles, 1));
        });
        idx.push(verts[0]!, verts[2]!, verts[1]!, verts[0]!, verts[3]!, verts[2]!);

        // cliff skirts: emitted from the higher side toward each lower edge.
        // Corner indices per direction: [my A, my B, neighbor A, neighbor B]
        const EPS = 1e-4;
        const dirs = [
          { dx: 1, dz: 0, a: 1, b: 2, na: 0, nb: 3 }, // east face
          { dx: -1, dz: 0, a: 0, b: 3, na: 1, nb: 2 }, // west
          { dx: 0, dz: 1, a: 3, b: 2, na: 0, nb: 1 }, // south
          { dx: 0, dz: -1, a: 0, b: 1, na: 3, nb: 2 }, // north
        ] as const;
        for (const d of dirs) {
          const nx = tx + d.dx;
          const nz = ty + d.dz;
          if (nx < 0 || nz < 0 || nx >= side || nz >= side) continue;
          const ni = (nz * side + nx) * 4;
          const a = this.tileCornerY[ci + d.a]!;
          const b = this.tileCornerY[ci + d.b]!;
          const na = this.tileCornerY[ni + d.na]!;
          const nb = this.tileCornerY[ni + d.nb]!;
          if (a <= na + EPS && b <= nb + EPS) continue;
          const botA = Math.min(a, na);
          const botB = Math.min(b, nb);
          const ax = tx - 0.5 + CORNERS[d.a]![0];
          const az = ty - 0.5 + CORNERS[d.a]![1];
          const bx = tx - 0.5 + CORNERS[d.b]![0];
          const bz = ty - 0.5 + CORNERS[d.b]![1];
          const tiles = [ti];
          const tA = pushVert(ax, a, az, tiles, CLIFF_MUL);
          const tB = pushVert(bx, b, bz, tiles, CLIFF_MUL);
          const bB = pushVert(bx, botB, bz, tiles, CLIFF_MUL);
          const bA = pushVert(ax, botA, az, tiles, CLIFF_MUL);
          // winding faces outward (toward the lower neighbor)
          idx.push(tA, bB, bA, tA, tB, bB);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    geo.computeVertexNormals();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.mesh.position.set(0, 0, 0);
    this.vertRef = new Int32Array(ref);
    this.vertMul = new Float32Array(mul);
    this.vertCount = mul.length;
  }

  /** Top-face height of a tile's highest corner (veil drape anchor). */
  private tileTopY(tx: number, ty: number): number {
    const side = this.side;
    if (tx < 0 || ty < 0 || tx >= side || ty >= side) return 0;
    const i = (ty * side + tx) * 4;
    return Math.max(
      this.tileCornerY[i]!,
      this.tileCornerY[i + 1]!,
      this.tileCornerY[i + 2]!,
      this.tileCornerY[i + 3]!,
    );
  }

  /** One merged quad per map.water tile, sharing the animated wave uniform. */
  private buildWaterTiles(map: MapLayout): void {
    if (this.waterTiles) {
      this.waterTiles.geometry.dispose();
      this.waterTiles.removeFromParent();
      this.waterTiles = null;
    }
    this.waterTileCount = map.water.size;
    if (map.water.size === 0) return;
    const n = map.water.size;
    const pos = new Float32Array(n * 4 * 3);
    const nrm = new Float32Array(n * 4 * 3);
    const idx = new Uint32Array(n * 6);
    let q = 0;
    for (const key of map.water) {
      const [tx, ty] = key.split(",").map(Number) as [number, number];
      const v = q * 4;
      const corners = [
        [tx - 0.5, ty - 0.5],
        [tx + 0.5, ty - 0.5],
        [tx + 0.5, ty + 0.5],
        [tx - 0.5, ty + 0.5],
      ] as const;
      corners.forEach(([x, z], i) => {
        pos[(v + i) * 3] = x;
        pos[(v + i) * 3 + 1] = WATER_Y;
        pos[(v + i) * 3 + 2] = z;
        nrm[(v + i) * 3 + 1] = 1;
      });
      idx.set([v, v + 2, v + 1, v, v + 3, v + 2], q * 6);
      q++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.waterTilesMat.color.set(this.colors.water);
    this.waterTiles = new THREE.Mesh(geo, this.waterTilesMat);
    this.waterTiles.frustumCulled = false;
    this.group.add(this.waterTiles);
  }

  /** Raised plank per bridge tile — the road continues across the water. */
  private buildBridges(map: MapLayout): void {
    if (this.bridgeMesh) {
      this.bridgeMesh.geometry.dispose();
      this.bridgeMesh.removeFromParent();
      this.bridgeMesh.dispose();
      this.bridgeMesh = null;
    }
    this.bridgeCount = map.bridges.size;
    if (map.bridges.size === 0) return;
    if (!this.bridgeMat) this.bridgeMat = new THREE.MeshLambertMaterial({ color: BRIDGE_PLANK });
    const geo = new THREE.BoxGeometry(1.04, 0.1, 0.84);
    const mesh = new THREE.InstancedMesh(geo, this.bridgeMat, map.bridges.size);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const key of map.bridges) {
      const [tx, ty] = key.split(",").map(Number) as [number, number];
      const horiz =
        map.roads.has(`${tx - 1},${ty}`) ||
        map.roads.has(`${tx + 1},${ty}`) ||
        map.streets.has(`${tx - 1},${ty}`) ||
        map.streets.has(`${tx + 1},${ty}`);
      m.makeRotationY(horiz ? 0 : Math.PI / 2);
      m.setPosition(tx, 0.02, ty);
      mesh.setMatrixAt(i++, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    this.bridgeMesh = mesh;
    this.group.add(mesh);
  }

  /**
   * Streets: map.streets rendered as narrow pale paved strips (~0.45 tile
   * wide vs the roads' full tile), flush with the terrain — the measured
   * import graph made visible but quieter than the tree roads. Street tiles
   * that cross water are in map.bridges and get the plank treatment instead.
   */
  private buildStreets(map: MapLayout): void {
    if (this.streetMesh) {
      this.streetMesh.geometry.dispose();
      this.streetMesh.removeFromParent();
      this.streetMesh = null;
    }
    this.streetTileCount = map.streets.size;
    const dry = [...map.streets].filter((k) => !map.bridges.has(k)).sort();
    if (dry.length === 0) return;
    if (!this.streetMat) this.streetMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.streetMat.color.set(this.streetColor());
    const side = map.side;
    const pos: number[] = [];
    const idx: number[] = [];
    // bilinear corner-height sample so strips hug ramped tiles too
    const yAt = (tx: number, ty: number, u: number, v: number): number => {
      const i = (ty * side + tx) * 4;
      const c00 = this.tileCornerY[i]!;
      const c10 = this.tileCornerY[i + 1]!;
      const c11 = this.tileCornerY[i + 2]!;
      const c01 = this.tileCornerY[i + 3]!;
      return (c00 * (1 - u) + c10 * u) * (1 - v) + (c01 * (1 - u) + c11 * u) * v;
    };
    const half = STREET_W / 2;
    for (const key of dry) {
      const [tx, ty] = key.split(",").map(Number) as [number, number];
      const horiz = map.streets.has(`${tx - 1},${ty}`) || map.streets.has(`${tx + 1},${ty}`);
      // strip corners in tile-local (u,v) space, then to world
      const corners: [number, number][] = horiz
        ? [[0, 0.5 - half], [1, 0.5 - half], [1, 0.5 + half], [0, 0.5 + half]]
        : [[0.5 - half, 0], [0.5 + half, 0], [0.5 + half, 1], [0.5 - half, 1]];
      const v0 = pos.length / 3;
      for (const [u, v] of corners) {
        pos.push(tx - 0.5 + u, yAt(tx, ty, u, v) + 0.015, ty - 0.5 + v);
      }
      idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    geo.computeVertexNormals();
    this.streetMesh = new THREE.Mesh(geo, this.streetMat);
    this.streetMesh.frustumCulled = false;
    this.streetMesh.receiveShadow = true;
    this.group.add(this.streetMesh);
  }

  /** Pale paving derived from the DNA plaza tone — quieter than roads. */
  private streetColor(): number {
    return mixColor(this.colors.plaza, 0xffffff, 0.3);
  }

  /** Static per-tile color: district tint, road, plaza, water, shoreline. */
  private computeTileBase(): void {
    const map = this.map!;
    const side = this.side;
    const g = this.colors;
    const c = map.cityRect;
    const tc = map.townCenter;
    const quarterTint = new Map<string, number>();
    for (const q of map.quarters) quarterTint.set(q.path, g.district[q.archetype] ?? g.base);
    // ring-city dressing: the ring road around the raised core paves brighter
    let ring: Rect | null = null;
    if (map.composition === "ring-city") {
      const core = map.quarters.find(
        (q) => q.depth === 1 && (map.heights.get(`${q.rect.x + 1},${q.rect.y + 1}`) ?? 0) === 2,
      );
      if (core) ring = { x: core.rect.x - 1, y: core.rect.y - 1, w: core.rect.w + 2, h: core.rect.h + 2 };
    }
    const onRing = (tx: number, ty: number): boolean => {
      if (!ring) return false;
      if (tx < ring.x || ty < ring.y || tx >= ring.x + ring.w || ty >= ring.y + ring.h) return false;
      return tx === ring.x || ty === ring.y || tx === ring.x + ring.w - 1 || ty === ring.y + ring.h - 1;
    };
    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const i = ty * side + tx;
        const key = `${tx},${ty}`;
        const j = 0.94 + this.jitter[i]! * 0.12;
        if (map.water.has(key)) {
          // the bed under the animated surface (and the minimap silhouette)
          this.tileBase[i] = scaleColor(g.water, j);
          continue;
        }
        const inCity = tx >= c.x && ty >= c.y && tx < c.x + c.w && ty < c.y + c.h;
        let color = inCity ? g.base : g.wild;
        if (inCity) {
          // deepest quarter tint (DNA district color for its archetype)
          let best: { depth: number; tint: number } | null = null;
          for (const q of map.quarters) {
            if (tx >= q.rect.x && ty >= q.rect.y && tx < q.rect.x + q.rect.w && ty < q.rect.y + q.rect.h) {
              if (!best || q.depth > best.depth) best = { depth: q.depth, tint: quarterTint.get(q.path)! };
            }
          }
          if (best) color = mixColor(color, best.tint, 0.45);
          if (Math.abs(tx - tc.tx) <= 2 && Math.abs(ty - tc.ty) <= 2) color = mixColor(color, g.plaza, 0.75);
          if (map.roads.has(key)) {
            color = mixColor(color, g.road, 0.72);
            if (onRing(tx, ty)) color = scaleColor(color, 1.16);
          }
        }
        if (map.coast.has(key)) color = mixColor(color, g.shore, 0.55);
        const edge = Math.min(tx, ty, side - 1 - tx, side - 1 - ty);
        if (edge <= 1) color = mixColor(color, g.shore, edge === 0 ? 0.85 : 0.45);
        // deterministic jitter: ±6% luminance from the seeded stream
        this.tileBase[i] = scaleColor(color, j);
      }
    }
  }

  /** Re-apply theme tint + district patch tints and push vertex colors. */
  paint(): void {
    const map = this.map;
    if (!map) return;
    const side = this.side;
    const patchRects: { rect: { x: number; y: number; w: number; h: number }; tint: number }[] = [];
    for (const [district, tint] of this.patchTints) {
      const q = map.quarters.find((qq) => qq.path === district);
      patchRects.push({ rect: q?.rect ?? map.cityRect, tint });
    }
    for (let ty = 0; ty < side; ty++) {
      for (let tx = 0; tx < side; tx++) {
        const i = ty * side + tx;
        let color = this.tileBase[i]!;
        // water keeps its DNA color so archipelago/river silhouettes stay legible
        if (!map.water.has(`${tx},${ty}`)) {
          if (this.themeTint !== undefined) color = mixColor(color, this.themeTint, 0.35);
          for (const p of patchRects) {
            if (tx >= p.rect.x && ty >= p.rect.y && tx < p.rect.x + p.rect.w && ty < p.rect.y + p.rect.h) {
              color = mixColor(color, p.tint, 0.35);
            }
          }
        }
        this.tileColors[i] = color;
      }
    }
    // vertex color = average of the vertex's referenced tiles (soft district
    // borders on top faces) times its multiplier (cliff skirts darken)
    const att = this.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const col = new THREE.Color();
    for (let v = 0; v < this.vertCount; v++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const ti = this.vertRef[v * 4 + k]!;
        if (ti < 0) continue;
        const c = this.tileColors[ti]!;
        r += (c >> 16) & 0xff;
        g += (c >> 8) & 0xff;
        b += c & 0xff;
        n++;
      }
      const m = this.vertMul[v]!;
      col.setRGB((r / Math.max(1, n) / 255) * m, (g / Math.max(1, n) / 255) * m, (b / Math.max(1, n) / 255) * m);
      col.convertSRGBToLinear();
      att.setXYZ(v, col.r, col.g, col.b);
    }
    att.needsUpdate = true;
  }

  setThemeTint(tint: number | undefined): void {
    this.themeTint = tint === undefined ? undefined : soften(visibleFloor(tint, 0x60), 0.45);
    this.paint();
  }

  applyPatchTint(patch: DistrictPatch, tint: number | undefined): void {
    if (tint === undefined) this.patchTints.delete(patch.district);
    else this.patchTints.set(patch.district, visibleFloor(tint, 0x50));
    this.paint();
  }

  setWaterColor(color: number): void {
    this.tintWaterMats(visibleFloor(color, 0x2c));
  }

  // --- fog veil --------------------------------------------------------------

  private buildVeil(map: MapLayout): void {
    if (this.veil) {
      this.veil.geometry.dispose();
      (this.veil.material as THREE.Material).dispose();
      this.veil.removeFromParent();
    }
    const c = map.cityRect;
    const r = { x: c.x - 2, y: c.y - 2, w: c.w + 4, h: c.h + 4 };
    this.veilRect = r;
    this.fogCur = new Float32Array(r.w * r.h).fill(0.55);
    this.fogTarget = new Float32Array(r.w * r.h).fill(0.55);
    this.fogCleared = new Uint8Array(r.w * r.h);
    this.shrouded = new Uint8Array(r.w * r.h);
    // the sea is not unexplored code: bays and channels show through the veil
    // so the archipelago silhouette reads from the first frame
    for (let iz = 0; iz < r.h; iz++) {
      for (let ix = 0; ix < r.w; ix++) {
        if (!map.water.has(`${r.x + ix},${r.y + iz}`)) continue;
        const i = iz * r.w + ix;
        this.fogCur[i] = 0.12;
        this.fogTarget[i] = 0.12;
        this.fogCleared[i] = 1;
      }
    }
    const geo = new THREE.PlaneGeometry(r.w, r.h, r.w, r.h);
    geo.rotateX(-Math.PI / 2);
    // drape the veil over the landform: each grid vertex rides the highest
    // top face of its adjacent tiles, so plateaus stay veiled at altitude
    {
      const att = geo.getAttribute("position") as THREE.BufferAttribute;
      for (let iz = 0; iz <= r.h; iz++) {
        for (let ix = 0; ix <= r.w; ix++) {
          let y = 0;
          for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
            y = Math.max(y, this.tileTopY(r.x + ix + dx, r.y + iz + dz));
          }
          att.setY(iz * (r.w + 1) + ix, y);
        }
      }
    }
    const colors = new Float32Array((r.w + 1) * (r.h + 1) * 4);
    for (let i = 0; i < colors.length; i += 4) {
      colors[i] = 0.015;
      colors[i + 1] = 0.013;
      colors[i + 2] = 0.02;
      colors[i + 3] = 0.55;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.veil = new THREE.Mesh(geo, mat);
    this.veil.position.set(r.x + r.w / 2 - 0.5, 0.03, r.y + r.h / 2 - 0.5);
    this.veil.renderOrder = 5;
    this.group.add(this.veil);
    this.pushVeilAlphas();
  }

  get fogIsAnimating(): boolean {
    return this.fogAnimating;
  }

  fogAlphaAt = (tx: number, ty: number): number => {
    const r = this.veilRect;
    const ix = tx - r.x;
    const iz = ty - r.y;
    if (ix < 0 || iz < 0 || ix >= r.w || iz >= r.h) return 0;
    return this.fogCur[iz * r.w + ix]!;
  };

  /** Same semantics as the 2D renderer's reveal(): full clear + soft fringe. */
  reveal(tx: number, ty: number, radius: number, historical: boolean): void {
    const r = this.veilRect;
    for (let dy = -radius - 2; dy <= radius + 2; dy++) {
      for (let dx = -radius - 2; dx <= radius + 2; dx++) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist > radius + 2) continue;
        const ix = tx + dx - r.x;
        const iz = ty + dy - r.y;
        if (ix < 0 || iz < 0 || ix >= r.w || iz >= r.h) continue;
        const i = iz * r.w + ix;
        if (this.shrouded[i]) continue; // the shroud outranks fog: a survey lifts it, not footsteps
        if (dist <= radius) {
          if (this.fogTarget[i]! !== 0) {
            this.fogTarget[i] = 0;
            this.onFogTile?.(tx + dx, ty + dy, 0);
          }
          if (historical) this.fogCur[i] = 0;
        } else if (!this.fogCleared[i] && this.fogCur[i]! > 0.4) {
          this.fogCleared[i] = 1;
          this.fogTarget[i] = 0.34;
          if (historical) this.fogCur[i] = 0.34;
          this.onFogTile?.(tx + dx, ty + dy, 0.34);
        }
      }
    }
    this.fogAnimating = true;
  }

  /**
   * Terra incognita: sink the veil over an unsurveyed quarter's rect to a
   * depth only a survey can lift. Water tiles are exempt — the sea is not
   * unexplored code. Idempotent per tile; also used to re-veil inner wards
   * after their parent's veil lifts.
   */
  veilQuarterRect(rect: Rect): void {
    const map = this.map;
    if (!map) return;
    const r = this.veilRect;
    let touched = false;
    for (let ty = rect.y; ty < rect.y + rect.h; ty++) {
      for (let tx = rect.x; tx < rect.x + rect.w; tx++) {
        const ix = tx - r.x;
        const iz = ty - r.y;
        if (ix < 0 || iz < 0 || ix >= r.w || iz >= r.h) continue;
        if (map.water.has(`${tx},${ty}`)) continue;
        const i = iz * r.w + ix;
        if (this.shrouded[i]) continue;
        this.shrouded[i] = 1;
        this.fogCur[i] = SHROUD_ALPHA;
        this.fogTarget[i] = SHROUD_ALPHA;
        this.onFogTile?.(tx, ty, SHROUD_ALPHA);
        touched = true;
      }
    }
    if (touched) this.pushVeilAlphas();
  }

  /** Survey: the deep veil animates up to the seen-fringe level and stays lifted. */
  liftQuarterRect(rect: Rect, historical: boolean): void {
    const r = this.veilRect;
    for (let ty = rect.y; ty < rect.y + rect.h; ty++) {
      for (let tx = rect.x; tx < rect.x + rect.w; tx++) {
        const ix = tx - r.x;
        const iz = ty - r.y;
        if (ix < 0 || iz < 0 || ix >= r.w || iz >= r.h) continue;
        const i = iz * r.w + ix;
        if (!this.shrouded[i]) continue;
        this.shrouded[i] = 0;
        this.fogCleared[i] = 1;
        this.fogTarget[i] = SHROUD_LIFTED;
        if (historical) this.fogCur[i] = SHROUD_LIFTED;
        this.onFogTile?.(tx, ty, SHROUD_LIFTED);
      }
    }
    this.fogAnimating = true;
    if (historical) this.pushVeilAlphas();
  }

  private pushVeilAlphas(): void {
    if (!this.veil) return;
    const r = this.veilRect;
    const att = this.veil.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let iz = 0; iz <= r.h; iz++) {
      for (let ix = 0; ix <= r.w; ix++) {
        let a = 0;
        let n = 0;
        for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
          const tx = ix + dx;
          const tz = iz + dz;
          if (tx < 0 || tz < 0 || tx >= r.w || tz >= r.h) continue;
          a += this.fogCur[tz * r.w + tx]!;
          n++;
        }
        att.setW(iz * (r.w + 1) + ix, n > 0 ? a / n : 0);
      }
    }
    att.needsUpdate = true;
  }

  tick(dt: number): void {
    this.waterUniforms.uTime.value += dt;
    if (this.fogAnimating) {
      let maxDelta = 0;
      const k = Math.min(1, dt * 5);
      for (let i = 0; i < this.fogCur.length; i++) {
        const d = this.fogTarget[i]! - this.fogCur[i]!;
        if (d !== 0) {
          const step = Math.abs(d) < 0.01 ? d : d * k;
          this.fogCur[i] = this.fogCur[i]! + step;
          maxDelta = Math.max(maxDelta, Math.abs(d));
        }
      }
      this.pushVeilAlphas();
      if (maxDelta < 0.011) this.fogAnimating = false;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
    this.waterTiles?.geometry.dispose();
    this.waterTilesMat.dispose();
    this.streetMesh?.geometry.dispose();
    this.streetMat?.dispose();
    if (this.bridgeMesh) {
      this.bridgeMesh.geometry.dispose();
      this.bridgeMesh.dispose();
    }
    this.bridgeMat?.dispose();
    if (this.veil) {
      this.veil.geometry.dispose();
      (this.veil.material as THREE.Material).dispose();
    }
  }
}
