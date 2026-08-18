// Kit-per-world-form accents (game/kits.ts is the law): each form family
// scatters its own CC0 accent models over the wilderness ring and along
// quarter wall exteriors, compositions add terrain accents (background
// mountains, canyon rubble), and harbor realms upgrade their crossings with
// real bridge spans. Placement is a pure function of the map layout + seeded
// rng; models load lazily (only what the current world needs) and any load
// failure degrades silently to the existing decor vocabulary.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mulberry32, type MapLayout, type Rect } from "../game/map.js";
import { BRIDGE_MODELS, COMPOSITION_ACCENTS, FAMILY_ACCENTS, type KitPiece } from "../game/kits.js";
import type { WorldDNA } from "../game/worlddna.js";
import { bakeStatic, type StaticModel } from "./assets.js";
import { heightAt } from "./terrain3d.js";
import { hashStr, mixColor } from "./util.js";

/** Family/composition accents lean subtly toward the DNA trim register. */
const ACCENT_TINT_MIX = 0.25;
/** Bridge spans sit on the plank deck (ground.ts places its top at ~0.07). */
const BRIDGE_DECK_Y = 0.07;

type AccentKind = "family" | "composition" | "bridge";

type AccentPlacement = {
  url: string;
  kind: AccentKind;
  x: number;
  z: number;
  y: number;
  rotY: number;
  scale: number;
  /** Bridges: true when the crossing runs along world x. The final rotation
   * also depends on the baked model's own long axis, resolved at realize. */
  alongX?: boolean;
  tint?: number;
};

export type AccentStats = {
  placed: number;
  family: number;
  composition: number;
  bridge: number;
  /** Model URLs this world needs that are still in flight. */
  pending: number;
  /** Model URLs this world needs whose load failed (decor fallback stands). */
  errors: number;
};

export class Accents {
  readonly group = new THREE.Group();
  private loader = new GLTFLoader();
  private cache = new Map<string, StaticModel>();
  private failed = new Set<string>();
  private inFlight = new Set<string>();
  private meshes: THREE.InstancedMesh[] = [];
  private placements: AccentPlacement[] = [];
  private neededUrls = new Set<string>();
  private realizedUrls = new Set<string>();
  private counts: Record<AccentKind, number> = { family: 0, composition: 0, bridge: 0 };
  private disposed = false;
  private scratch = new THREE.Matrix4();
  private scratchColor = new THREE.Color();

  placedCount(): number {
    return this.counts.family + this.counts.composition + this.counts.bridge;
  }

  stats(): AccentStats {
    let pending = 0;
    let errors = 0;
    for (const url of this.neededUrls) {
      if (this.inFlight.has(url)) pending++;
      else if (this.failed.has(url)) errors++;
    }
    return { placed: this.placedCount(), ...this.counts, pending, errors };
  }

  /** (Re)derive all accent placements for a world and stream in exactly the
   * models it needs. Re-entrant: reskins that change the form rebuild whole. */
  build(map: MapLayout, seed: number, dna: WorldDNA): void {
    if (this.disposed) return;
    this.clearMeshes();
    this.realizedUrls.clear();
    this.counts = { family: 0, composition: 0, bridge: 0 };
    this.placements = computePlacements(map, seed, dna);
    this.neededUrls = new Set(this.placements.map((p) => p.url));
    for (const url of this.neededUrls) {
      if (this.cache.has(url)) this.realizeUrl(url);
      else if (!this.failed.has(url) && !this.inFlight.has(url)) this.request(url);
      // in-flight loads realize on arrival against the then-current placements
    }
  }

  private request(url: string): void {
    this.inFlight.add(url);
    // same spurious-abort retry the base asset loader needed under headless
    // SwiftShader in the first moments of page life
    const attempt = (triesLeft: number) => {
      this.loader.load(
        url,
        (gltf) => {
          if (this.disposed) return;
          try {
            this.cache.set(url, bakeStatic(gltf.scene));
          } catch (err) {
            this.failed.add(url);
            console.warn(`[accents3d] bake failed for ${url}; keeping base decor:`, err);
          }
          this.inFlight.delete(url);
          if (this.cache.has(url)) this.realizeUrl(url);
        },
        undefined,
        (err) => {
          if (triesLeft > 0) {
            setTimeout(() => attempt(triesLeft - 1), 450 * (3 - triesLeft + 1));
            return;
          }
          this.inFlight.delete(url);
          this.failed.add(url);
          console.warn(`[accents3d] load failed for ${url}; keeping base decor:`, err);
        },
      );
    };
    attempt(3);
  }

  /** Realize every current placement of one loaded model as InstancedMeshes. */
  private realizeUrl(url: string): void {
    if (this.disposed || this.realizedUrls.has(url)) return;
    const model = this.cache.get(url);
    if (!model) return;
    const list = this.placements.filter((p) => p.url === url);
    if (list.length === 0) return;
    this.realizedUrls.add(url);
    // bakeStatic normalizes the long footprint axis to 1 tile; a bridge span
    // must lay that axis along the crossing
    const modelAlongX = model.size.x >= model.size.z;
    for (const part of model.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      list.forEach((p, i) => {
        let rotY = p.rotY;
        if (p.alongX !== undefined) rotY = p.alongX === modelAlongX ? 0 : Math.PI / 2;
        this.scratch.makeRotationY(rotY);
        this.scratch.scale(new THREE.Vector3(p.scale, p.scale, p.scale));
        this.scratch.setPosition(p.x, p.y, p.z);
        mesh.setMatrixAt(i, this.scratch);
        this.scratchColor.set(p.tint ?? 0xffffff);
        mesh.setColorAt(i, this.scratchColor);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    this.counts[list[0]!.kind] += list.length;
  }

  private clearMeshes(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.dispose(); // instance attributes only; geometries live in the cache
    }
    this.meshes = [];
  }

  dispose(): void {
    this.disposed = true;
    this.clearMeshes();
    const mats = new Set<THREE.Material>();
    for (const model of this.cache.values()) {
      for (const p of model.parts) {
        p.geometry.dispose();
        mats.add(p.material);
      }
    }
    for (const mat of mats) {
      const map = (mat as THREE.MeshStandardMaterial).map;
      if (map) map.dispose();
      mat.dispose();
    }
    this.cache.clear();
    this.placements = [];
    this.neededUrls.clear();
  }
}

// --- placement law (pure: map + seed + dna → placements) ---------------------

function inRect(r: Rect, tx: number, ty: number): boolean {
  return tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
}

/** Tile i (clockwise) on the one-tile-outside ring of a rect. */
function ringAt(r: Rect, i: number): { tx: number; ty: number } {
  const x = r.x - 1;
  const y = r.y - 1;
  const w = r.w + 2;
  const h = r.h + 2;
  const per = 2 * w + 2 * (h - 2);
  let k = ((i % per) + per) % per;
  if (k < w) return { tx: x + k, ty: y };
  k -= w;
  if (k < h - 2) return { tx: x + w - 1, ty: y + 1 + k };
  k -= h - 2;
  if (k < w) return { tx: x + w - 1 - k, ty: y + h - 1 };
  k -= w;
  return { tx: x, ty: y + h - 1 - k };
}

function computePlacements(map: MapLayout, seed: number, dna: WorldDNA): AccentPlacement[] {
  const out: AccentPlacement[] = [];
  const c = map.cityRect;
  const free = (tx: number, ty: number): boolean => {
    if (tx < 2 || ty < 2 || tx >= map.side - 2 || ty >= map.side - 2) return false;
    const k = `${tx},${ty}`;
    return !map.water.has(k) && !map.used.has(k) && !map.roads.has(k) && !map.streets.has(k);
  };
  // accents stay off quarter floors: those are shrouded, prop-governed ground
  const inAnyQuarter = (tx: number, ty: number): boolean =>
    map.quarters.some((q) => inRect(q.rect, tx, ty));
  const trimTint = mixColor(0xffffff, dna.buildingTint.trim, ACCENT_TINT_MIX);
  const taken = new Set<string>();
  const claim = (tx: number, ty: number): boolean => {
    const k = `${tx},${ty}`;
    if (taken.has(k) || !free(tx, ty) || inAnyQuarter(tx, ty)) return false;
    taken.add(k);
    return true;
  };

  // --- family accents: wilderness ring + quarter wall exteriors --------------
  const familyPieces = FAMILY_ACCENTS[dna.form] ?? [];
  if (familyPieces.length > 0) {
    const rng = mulberry32((seed ^ 0xacce27) >>> 0);
    const target = Math.min(24, Math.max(10, Math.round(map.side * 0.3)));
    const spots: { tx: number; ty: number }[] = [];
    for (const q of map.quarters) {
      let got = 0;
      for (let a = 0; a < 8 && got < 2 && spots.length < target; a++) {
        const { tx, ty } = ringAt(q.rect, Math.floor(rng() * 4096));
        if (!claim(tx, ty)) continue;
        spots.push({ tx, ty });
        got++;
      }
    }
    for (let a = 0; a < target * 40 && spots.length < target; a++) {
      const tx = 2 + Math.floor(rng() * (map.side - 4));
      const ty = 2 + Math.floor(rng() * (map.side - 4));
      if (inRect(c, tx, ty)) continue; // wilderness ring only for the fill
      if (!claim(tx, ty)) continue;
      spots.push({ tx, ty });
    }
    // harbor law: the scatter is lanterns; one gold chest stands by the plaza
    const harbor = dna.form === "harbor-citadel";
    const scatter = harbor ? familyPieces.filter((p) => !p.url.includes("chest")) : familyPieces;
    const chest = harbor ? familyPieces.find((p) => p.url.includes("chest")) : undefined;
    spots.forEach((s, i) => {
      const piece: KitPiece = scatter[i % scatter.length] ?? familyPieces[0]!;
      out.push({
        url: piece.url,
        kind: "family",
        x: s.tx + (rng() - 0.5) * 0.5,
        z: s.ty + (rng() - 0.5) * 0.5,
        y: heightAt(map, s.tx, s.ty),
        rotY: Math.floor(rng() * 4) * (Math.PI / 2),
        scale: (piece.scale ?? 0.75) * (0.8 + rng() * 0.4),
        tint: trimTint,
      });
    });
    if (chest) {
      const tc = map.townCenter;
      let placed = false;
      for (let radius = 2; radius < map.side && !placed; radius++) {
        for (let dy = -radius; dy <= radius && !placed; dy++) {
          for (let dx = -radius; dx <= radius && !placed; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const tx = tc.tx + dx;
            const ty = tc.ty + dy;
            if (!claim(tx, ty)) continue;
            out.push({
              url: chest.url,
              kind: "family",
              x: tx,
              z: ty,
              y: heightAt(map, tx, ty),
              rotY: Math.floor(rng() * 4) * (Math.PI / 2),
              scale: (chest.scale ?? 0.45) * 0.5,
              tint: trimTint,
            });
            placed = true;
          }
        }
      }
    }
  }

  // --- composition accents ----------------------------------------------------
  const compPieces = COMPOSITION_ACCENTS[map.composition] ?? [];
  if (compPieces.length > 0) {
    const rng = mulberry32((seed ^ 0x3a0c15) >>> 0);
    if (map.composition === "terrace-mount") {
      // background peaks in the outer wilderness margin, well clear of walls
      const count = 3 + Math.floor(rng() * 4);
      const placedSpots: { tx: number; ty: number }[] = [];
      for (let a = 0; a < 600 && placedSpots.length < count; a++) {
        const tx = 2 + Math.floor(rng() * (map.side - 4));
        const ty = 2 + Math.floor(rng() * (map.side - 4));
        const clear =
          tx <= c.x - 3 || tx >= c.x + c.w + 2 || ty <= c.y - 3 || ty >= c.y + c.h + 2;
        if (!clear) continue;
        if (placedSpots.some((s) => Math.abs(s.tx - tx) < 4 && Math.abs(s.ty - ty) < 4)) continue;
        if (!claim(tx, ty)) continue;
        const piece = compPieces[placedSpots.length % compPieces.length]!;
        placedSpots.push({ tx, ty });
        out.push({
          url: piece.url,
          kind: "composition",
          x: tx,
          z: ty,
          y: heightAt(map, tx, ty),
          rotY: rng() * Math.PI * 2,
          // footprint is bake-normalized to 1 tile; the manifest hint (2.2)
          // times this factor makes them read as background peaks, not props
          scale: (piece.scale ?? 1) * (1.5 + rng() * 0.7),
        });
      }
    } else if (map.composition === "canyon-strata") {
      // rubble and stairs along the gorge's two long flanks
      const target = Math.min(14, Math.max(6, Math.floor(c.w / 3)));
      let placed = 0;
      for (let a = 0; a < target * 40 && placed < target; a++) {
        const tx = c.x + Math.floor(rng() * c.w);
        const north = rng() < 0.5;
        const off = 1 + Math.floor(rng() * 4);
        const ty = north ? c.y - off : c.y + c.h - 1 + off;
        if (!claim(tx, ty)) continue;
        const piece = compPieces[placed % compPieces.length]!;
        placed++;
        out.push({
          url: piece.url,
          kind: "composition",
          x: tx + (rng() - 0.5) * 0.5,
          z: ty + (rng() - 0.5) * 0.5,
          y: heightAt(map, tx, ty),
          rotY: Math.floor(rng() * 4) * (Math.PI / 2),
          scale: (piece.scale ?? 0.8) * (0.75 + rng() * 0.5),
          tint: trimTint,
        });
      }
    }
  }

  // --- harbor bridges: real spans over the plank law ---------------------------
  const harborWorld = dna.form === "harbor-citadel" || map.composition === "archipelago";
  if (harborWorld && BRIDGE_MODELS.length > 0) {
    for (const key of [...map.bridges].sort()) {
      const [tx, ty] = key.split(",").map(Number) as [number, number];
      // same orientation law as the plank treatment in ground.ts
      const horiz =
        map.roads.has(`${tx - 1},${ty}`) ||
        map.roads.has(`${tx + 1},${ty}`) ||
        map.streets.has(`${tx - 1},${ty}`) ||
        map.streets.has(`${tx + 1},${ty}`);
      const piece = BRIDGE_MODELS[hashStr(key) % BRIDGE_MODELS.length]!;
      out.push({
        url: piece.url,
        kind: "bridge",
        x: tx,
        z: ty,
        y: BRIDGE_DECK_Y,
        rotY: 0,
        scale: piece.scale ?? 1.02,
        alongX: horiz,
      });
    }
  }

  return out;
}
