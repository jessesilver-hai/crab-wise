// Ground plane (vertex-colored treemap districts + roads + plaza + shore),
// animated water (outer sea + map.water tiles), bridges, and the fog-of-war
// veil. All placement colors derive from the map layout + mulberry32(seed) +
// the census-derived world DNA — no unseeded randomness.
import * as THREE from "three";
import type { DistrictArchetype, DistrictPatch } from "@agent-empires/protocol";
import { mulberry32, quarterOf, type MapLayout } from "../game/map.js";
import { visibleFloor } from "../game/palette.js";
import type { WorldDNA } from "../game/worlddna.js";
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
    const geo = new THREE.PlaneGeometry(side, side, side, side);
    geo.rotateX(-Math.PI / 2);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.mesh.position.set((side - 1) / 2, 0, (side - 1) / 2);
    const colors = new Float32Array((side + 1) * (side + 1) * 3);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    this.jitter = new Float32Array(side * side);
    for (let i = 0; i < side * side; i++) this.jitter[i] = rand();
    this.tileBase = new Int32Array(side * side);
    this.tileColors = new Int32Array(side * side);
    this.applyWaterRelief(geo, map);
    this.computeTileBase();
    this.paint();

    this.water.geometry.dispose();
    this.water.geometry = new THREE.PlaneGeometry(side * 5, side * 5, 40, 40);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set((side - 1) / 2, -0.1, (side - 1) / 2);
    (this.water.material as THREE.MeshLambertMaterial).color.set(this.colors.water);

    this.buildWaterTiles(map);
    this.buildBridges(map);
    this.buildVeil(map);
  }

  /** Re-derive all DNA-driven colors in place (form change via reskin). */
  setDna(colors: GroundColors): void {
    this.colors = colors;
    (this.water.material as THREE.MeshLambertMaterial).color.set(colors.water);
    this.waterTilesMat.color.set(colors.water);
    if (this.map) {
      this.computeTileBase();
      this.paint();
    }
  }

  /** Dip land-plane vertices under water tiles so the sea reads as sunken. */
  private applyWaterRelief(geo: THREE.PlaneGeometry, map: MapLayout): void {
    if (map.water.size === 0) return;
    const side = map.side;
    const att = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let iz = 0; iz <= side; iz++) {
      for (let ix = 0; ix <= side; ix++) {
        let wet = 0;
        let n = 0;
        for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
          const tx = ix + dx;
          const ty = iz + dz;
          if (tx < 0 || ty < 0 || tx >= side || ty >= side) continue;
          n++;
          if (map.water.has(`${tx},${ty}`)) wet++;
        }
        if (wet === 0) continue;
        // fully-wet vertices form the bed; mixed ones slope the shoreline
        att.setY(iz * (side + 1) + ix, wet === n ? -0.42 : -0.16);
      }
    }
    geo.computeVertexNormals();
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
      const horiz = map.roads.has(`${tx - 1},${ty}`) || map.roads.has(`${tx + 1},${ty}`);
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

  /** Static per-tile color: district tint, road, plaza, water, shoreline. */
  private computeTileBase(): void {
    const map = this.map!;
    const side = this.side;
    const g = this.colors;
    const c = map.cityRect;
    const tc = map.townCenter;
    const quarterTint = new Map<string, number>();
    for (const q of map.quarters) quarterTint.set(q.path, g.district[q.archetype] ?? g.base);
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
          if (map.roads.has(key)) color = mixColor(color, g.road, 0.72);
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
    // vertex color = average of adjacent tiles (soft district borders)
    const att = this.mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const col = new THREE.Color();
    for (let iz = 0; iz <= side; iz++) {
      for (let ix = 0; ix <= side; ix++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
          const tx = ix + dx;
          const ty = iz + dz;
          if (tx < 0 || ty < 0 || tx >= side || ty >= side) continue;
          const c = this.tileColors[ty * side + tx]!;
          r += (c >> 16) & 0xff;
          g += (c >> 8) & 0xff;
          b += c & 0xff;
          n++;
        }
        col.setRGB(r / n / 255, g / n / 255, b / n / 255);
        col.convertSRGBToLinear();
        att.setXYZ(iz * (side + 1) + ix, col.r, col.g, col.b);
      }
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
    const floored = visibleFloor(color, 0x24);
    (this.water.material as THREE.MeshLambertMaterial).color.set(floored);
    this.waterTilesMat.color.set(floored);
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
    const geo = new THREE.PlaneGeometry(r.w, r.h, r.w, r.h);
    geo.rotateX(-Math.PI / 2);
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
