// The genome compiler: (form, genome, traits, seed) → merged low-poly
// geometry. Every axis of the BuildingGenome design vector renders visibly —
// footprint massing, storeys, bays, taper, all ten roof forms, material
// family palettes, trims, openings, ornament and prop dressing. The measured
// tint law is preserved: every construction carries a procedural roofcap
// whose material color IS the measured palette hex (role "roof"), and banner
// cloth always wears the measured secondary token (role "banner"). All
// placement randomness comes from a mulberry PRNG seeded from
// (planSeed, componentId) — never Math.random — so identical inputs compile
// identical geometry.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "../game/map.js";
import type { CastleForm, Traits } from "../game/castle.js";
import type { Flourish } from "../game/flourish.js";
import type { BuildingGenome, MaterialFamily, PropSet } from "../game/genome.js";
import type { Assets } from "./assets.js";
import { modelOrBox } from "./pieces.js";
import { hashStr, hexColor } from "./util.js";

/** Footprint multiplier per measured size step (1 cottage … 4 monument). */
export const SIZE_SCALE: Record<number, number> = { 1: 0.8, 2: 1.0, 3: 1.3, 4: 1.7 };

/** Default roof/banner registers when a component has no measured palette. */
export const DEFAULT_BANNER = 0xd8a53c;

export type Built = {
  group: THREE.Group;
  roofMats: THREE.MeshStandardMaterial[];
  bannerMats: THREE.MeshStandardMaterial[];
  disposables: { geoms: THREE.BufferGeometry[]; mats: THREE.Material[] };
  height: number;
  radius: number;
  /** Local-space smoke emitters (chimney mouths) when ornament.smoke. */
  smokeAt: { x: number; y: number; z: number }[];
};

export type CompileInput = {
  componentId: string;
  form: CastleForm;
  traits: Traits;
  genome: BuildingGenome;
  seed: number;
  /** Signed works: maker's marks compiled into the perimeter dressing. */
  flourishes?: readonly Flourish[];
};

// ---------------------------------------------------------------------------
// Material family palettes — flat-shaded tones per family.
// ---------------------------------------------------------------------------

type Tone = {
  body: number;
  roof: number;
  accent: number;
  beam: number;
  glow: number;
  bodyEmissive?: number;
  bodyRough?: number;
  roofMetal?: number;
};

const FAMILY_TONES: Record<MaterialFamily, Tone> = {
  stone: { body: 0x9aa0a2, roof: 0x67737c, accent: 0xb9bec0, beam: 0x5c5348, glow: 0xffd98a },
  brick: { body: 0xa9553e, roof: 0x7e3d2e, accent: 0xd9c6a8, beam: 0x4f382a, glow: 0xffd98a },
  timber: { body: 0x9b7a4e, roof: 0x6e4f30, accent: 0xb99a6b, beam: 0x503926, glow: 0xffd98a },
  plaster: { body: 0xe8dcc2, roof: 0xb5563c, accent: 0xcdbf9f, beam: 0x54402c, glow: 0xffd98a },
  obsidian: { body: 0x25222c, roof: 0x1a1721, accent: 0x3a3547, beam: 0x141218, glow: 0x8a5cff, bodyEmissive: 0x1d0f38, bodyRough: 0.45 },
  sandstone: { body: 0xd8b98a, roof: 0xb08a56, accent: 0xe6d0a8, beam: 0x6e5638, glow: 0xffd98a },
  copper: { body: 0x8f7a62, roof: 0x4fae9b, accent: 0x6fc2b2, beam: 0x4a3c2e, glow: 0xaef0e2, roofMetal: 0.35 },
  marble: { body: 0xe9e7e0, roof: 0xcfd4d6, accent: 0xc9ab5e, beam: 0x8f8474, glow: 0xfff0c0 },
  basalt: { body: 0x4c4f52, roof: 0x35383b, accent: 0x63676b, beam: 0x2c2e30, glow: 0xffb46a },
  ice: { body: 0xcfe6f2, roof: 0xa9cfe4, accent: 0xe8f4fb, beam: 0x8fb8cf, glow: 0x9fe8ff, bodyEmissive: 0x16262e, bodyRough: 0.3 },
};

/** The roofcap fallback when a component has no measured tint. */
export function familyRoofTone(family: MaterialFamily): number {
  return FAMILY_TONES[family].roof;
}

// ---------------------------------------------------------------------------
// Geometry helpers — every helper returns a freshly owned BufferGeometry
// already transformed into construction-local space.
// ---------------------------------------------------------------------------

const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();

function placed(geo: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0, rotZ = 0): THREE.BufferGeometry {
  E.set(0, rotY, rotZ);
  Q.setFromEuler(E);
  V.set(1, 1, 1);
  M4.compose(new THREE.Vector3(x, y, z), Q, V);
  geo.applyMatrix4(M4);
  return geo;
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0, rotZ = 0): THREE.BufferGeometry {
  return placed(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), x, y, z, rotY, rotZ);
}

function cylAt(rt: number, rb: number, h: number, sides: number, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  return placed(new THREE.CylinderGeometry(rt, rb, h, sides).translate(0, h / 2, 0), x, y, z, rotY);
}

/** Triangle-listed geometry from flat vertex triples (computes flat normals). */
function tris(v: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/** Gable prism: base w×d grounded at y0, ridge along x at height h. */
function gablePrism(w: number, d: number): THREE.BufferGeometry {
  const x = w / 2;
  const z = d / 2;
  return tris([
    -x, 0, z, x, 0, z, x, 1, 0, -x, 0, z, x, 1, 0, -x, 1, 0,
    x, 0, -z, -x, 0, -z, -x, 1, 0, x, 0, -z, -x, 1, 0, x, 1, 0,
    x, 0, z, x, 0, -z, x, 1, 0,
    -x, 0, -z, -x, 0, z, -x, 1, 0,
  ]);
}

/** Lower slice of a gable: base w×d0 up to a flat ring w×d1 at height 1. */
function gableFrustum(w: number, d0: number, d1: number): THREE.BufferGeometry {
  const x = w / 2;
  const z0 = d0 / 2;
  const z1 = d1 / 2;
  return tris([
    // south slope
    -x, 0, z0, x, 0, z0, x, 1, z1, -x, 0, z0, x, 1, z1, -x, 1, z1,
    // north slope
    x, 0, -z0, -x, 0, -z0, -x, 1, -z1, x, 0, -z0, -x, 1, -z1, x, 1, -z1,
    // gable end trapezoids
    x, 0, z0, x, 0, -z0, x, 1, -z1, x, 0, z0, x, 1, -z1, x, 1, z1,
    -x, 0, -z0, -x, 0, z0, -x, 1, z1, -x, 0, -z0, -x, 1, z1, -x, 1, -z1,
  ]);
}

/** Hip roof: base w×d, ridge along x of length rl at height 1. */
function hipPrism(w: number, d: number): THREE.BufferGeometry {
  const x = w / 2;
  const z = d / 2;
  const r = Math.max(w * 0.12, w - d) / 2;
  return tris([
    -x, 0, z, x, 0, z, r, 1, 0, -x, 0, z, r, 1, 0, -r, 1, 0,
    x, 0, -z, -x, 0, -z, -r, 1, 0, x, 0, -z, -r, 1, 0, r, 1, 0,
    x, 0, z, x, 0, -z, r, 1, 0,
    -x, 0, -z, -x, 0, z, -r, 1, 0,
  ]);
}

/** Sloped wedge: base w×d, top plane from hBack (−z edge) to hFront (+z edge). */
function wedge(w: number, d: number, hBack: number, hFront: number): THREE.BufferGeometry {
  const x = w / 2;
  const z = d / 2;
  const a = [-x, 0, -z];
  const b = [x, 0, -z];
  const c = [x, 0, z];
  const e = [-x, 0, z];
  const A = [-x, hBack, -z];
  const B = [x, hBack, -z];
  const C = [x, hFront, z];
  const E2 = [-x, hFront, z];
  return tris(
    [
      // top slope
      ...E2, ...C, ...B, ...E2, ...B, ...A,
      // front
      ...e, ...c, ...C, ...e, ...C, ...E2,
      // back
      ...b, ...a, ...A, ...b, ...A, ...B,
      // sides
      ...c, ...b, ...B, ...c, ...B, ...C,
      ...a, ...e, ...E2, ...a, ...E2, ...A,
      // bottom
      ...a, ...b, ...c, ...a, ...c, ...e,
    ].flat(),
  );
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

type Lobe = { x: number; z: number; w: number; d: number; sides: number };

const PITCH_F: Record<string, number> = { low: 0.42, mid: 0.72, steep: 1.08 };
const OVERHANG_F: Record<string, number> = { none: 1.0, eave: 1.1, bracketed: 1.18 };

const PROP_TABLE: Record<PropSet, string[]> = {
  none: [],
  bakery: ["sack", "barrel", "crate_big"],
  scholar: ["book_set", "chest", "book_single"],
  forge: ["weaponrack", "torch_lit", "resource_stone"],
  harbor: ["crate_big", "barrel", "tent"],
  martial: ["target", "weaponrack", "banner"],
  arcane: ["torch_lit", "pillar", "book_single"],
  mine: ["resource_stone", "wheelbarrow", "rock_B"],
  garden: ["tree_B", "rock_C", "tree_A"],
  trade: ["crate_A_small", "sack", "tent"],
};

type GlbPlace = { key: string; x?: number; y?: number; z?: number; rotY?: number; s?: number; sy?: number; banner?: boolean };

export function compileGenome(assets: Assets, input: CompileInput): Built {
  const { componentId, form, traits: t, genome: g, seed } = input;
  const rng = mulberry32((hashStr(`${seed}:${componentId}`) || 1) >>> 0);
  const tone = FAMILY_TONES[g.material.family];
  const k = (SIZE_SCALE[t.size] ?? 1) * (form === "keep" ? 1.35 : 1);

  const group = new THREE.Group();
  const disposables = { geoms: [] as THREE.BufferGeometry[], mats: [] as THREE.Material[] };
  const roofMats: THREE.MeshStandardMaterial[] = [];
  const bannerMats: THREE.MeshStandardMaterial[] = [];
  const smokeAt: { x: number; y: number; z: number }[] = [];

  // --- procedural material buckets (one merged mesh per bucket) -------------
  type Bucket = { mat: THREE.MeshStandardMaterial; geoms: THREE.BufferGeometry[]; role?: string };
  const buckets = new Map<string, Bucket>();
  const mat = (opts: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, metalness: 0.05, ...opts });
    disposables.mats.push(m);
    return m;
  };
  const bucketDefs: Record<string, () => Bucket> = {
    body: () => ({
      mat: mat({
        color: tone.body,
        roughness: tone.bodyRough ?? 0.85,
        ...(tone.bodyEmissive ? { emissive: tone.bodyEmissive, emissiveIntensity: 0.5 } : {}),
      }),
      geoms: [],
    }),
    roofS: () => ({ mat: mat({ color: tone.roof, metalness: tone.roofMetal ?? 0.05 }), geoms: [] }),
    trim: () => ({ mat: mat({ color: tone.accent }), geoms: [] }),
    beam: () => ({ mat: mat({ color: tone.beam }), geoms: [] }),
    dark: () => ({ mat: mat({ color: 0x241c12, roughness: 0.95 }), geoms: [] }),
    glow: () => ({ mat: mat({ color: 0x1a140c, emissive: tone.glow, emissiveIntensity: 1.5 }), geoms: [] }),
    ivy: () => ({ mat: mat({ color: 0x4f7a3a, roughness: 1 }), geoms: [] }),
    // flourish cloth: wears the measured banner token (never the roofcap
    // mechanism); registered in bannerMats so banner repaints lerp it too
    cloth: () => {
      const m = mat({ color: hexColor(t.banner ?? "") ?? DEFAULT_BANNER, roughness: 0.7 });
      bannerMats.push(m);
      return { mat: m, geoms: [], role: "banner" };
    },
    roofcap: () => {
      const m = mat({ color: hexColor(t.tint ?? "") ?? tone.roof });
      roofMats.push(m);
      return { mat: m, geoms: [], role: "roof" };
    },
  };
  // normalize to position+normal, non-indexed, so every bucket merges into
  // exactly one mesh (mixed attribute sets make mergeGeometries return null)
  const put = (key: string, geo: THREE.BufferGeometry): void => {
    let g2 = geo;
    if (g2.index) {
      g2 = g2.toNonIndexed();
      geo.dispose();
    }
    if (g2.getAttribute("uv")) g2.deleteAttribute("uv");
    if (!g2.getAttribute("normal")) g2.computeVertexNormals();
    let b = buckets.get(key);
    if (!b) {
      b = bucketDefs[key]!();
      buckets.set(key, b);
    }
    disposables.geoms.push(g2);
    b.geoms.push(g2);
  };

  // --- massing ---------------------------------------------------------------
  const W = 1.5 * k * (0.82 + 0.09 * g.bays);
  const lobes = lobesFor(g.footprint, W);
  const primary = lobes[0]!;
  const storeys = Math.max(1, Math.min(6, g.storeys));
  const H = (g.footprint === "tower" ? 0.6 : 0.48) + 0.08 * k;
  const fAt = (i: number): number => {
    if (g.taper === "gentle") return Math.max(0.4, 1 - 0.07 * i);
    if (g.taper === "stepped") return Math.max(0.4, 1 - 0.18 * Math.floor((i + 1) / 2));
    if (g.taper === "battered") return Math.max(0.4, 1 - 0.06 * i);
    return 1;
  };
  const topY = storeys * H;
  const fTop = fAt(storeys - 1) - (g.taper === "battered" ? 0.08 : 0);

  for (const lobe of lobes) {
    for (let i = 0; i < storeys; i++) {
      const f = fAt(i);
      const y = i * H;
      if (lobe.sides > 0) {
        const r = (Math.max(lobe.w, lobe.d) / 2) * f;
        const rT = g.taper === "battered" ? r - 0.08 : r;
        put("body", cylAt(rT, r, H, lobe.sides, lobe.x, y, lobe.z, Math.PI / lobe.sides));
      } else if (g.taper === "battered") {
        // 4-sided cylinder rotated 45° = an axis-aligned box frustum
        const r = ((lobe.w * f) / 2) * Math.SQRT2;
        const geo = new THREE.CylinderGeometry(r - 0.11, r, H, 4).translate(0, H / 2, 0);
        geo.rotateY(Math.PI / 4);
        geo.scale(1, 1, lobe.d / lobe.w);
        put("body", placed(geo, lobe.x, y, lobe.z));
      } else {
        put("body", boxAt(lobe.w * f, H, lobe.d * f, lobe.x, y, lobe.z));
      }
      // storey band: the floor line makes storeys countable at distance
      if (i > 0) {
        if (lobe.sides > 0) {
          const r = (Math.max(lobe.w, lobe.d) / 2) * f;
          put("trim", cylAt(r + 0.03, r + 0.03, 0.06, lobe.sides, lobe.x, y - 0.03, lobe.z, Math.PI / lobe.sides));
        } else {
          put("trim", boxAt(lobe.w * f + 0.06, 0.06, lobe.d * f + 0.06, lobe.x, y - 0.03, lobe.z));
        }
      }
    }
    // plinth
    if (lobe.sides > 0) {
      const r = Math.max(lobe.w, lobe.d) / 2;
      put("trim", cylAt(r + 0.04, r + 0.05, 0.1, lobe.sides, lobe.x, 0, lobe.z, Math.PI / lobe.sides));
    } else {
      put("trim", boxAt(lobe.w + 0.08, 0.1, lobe.d + 0.08, lobe.x, 0, lobe.z));
    }
  }

  // union extents at the top storey (roof footprint)
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const l of lobes) {
    minX = Math.min(minX, l.x - (l.w / 2) * fTop);
    maxX = Math.max(maxX, l.x + (l.w / 2) * fTop);
    minZ = Math.min(minZ, l.z - (l.d / 2) * fTop);
    maxZ = Math.max(maxZ, l.z + (l.d / 2) * fTop);
  }
  const ov = OVERHANG_F[g.roof.overhang] ?? 1;
  const rw = (maxX - minX) * ov;
  const rd = (maxZ - minZ) * ov;
  const rcx = (minX + maxX) / 2;
  const rcz = (minZ + maxZ) / 2;
  const pitch = PITCH_F[g.roof.pitch] ?? 0.7;
  const R = (Math.max(primary.w, primary.d) / 2) * fTop * ov;
  const radial = g.roof.form === "pyramid" || g.roof.form === "cone" || g.roof.form === "onion" || g.roof.form === "dome";

  // --- roof ------------------------------------------------------------------
  // Structural roof wears the family tone; the roofcap slice wears the
  // measured tint hex — the repaint readback surface on every construction.
  let apexY = topY;
  const capAt = (geo: THREE.BufferGeometry) => put("roofcap", geo);
  const roofAt = (geo: THREE.BufferGeometry) => put("roofS", geo);
  switch (g.roof.form) {
    case "gable": {
      const h = pitch * rd * 0.62;
      roofAt(placed(gableFrustum(rw, rd, rd * 0.45).scale(1, h * 0.55, 1), rcx, topY, rcz));
      capAt(placed(gablePrism(rw * 1.01, rd * 0.46).scale(1, h * 0.45, 1), rcx, topY + h * 0.55, rcz));
      apexY = topY + h;
      break;
    }
    case "hip": {
      const h = pitch * Math.min(rw, rd) * 0.6;
      roofAt(placed(hipPrism(rw, rd).scale(1, h, 1), rcx, topY, rcz));
      capAt(placed(hipPrism(rw * 0.5, rd * 0.5).scale(1.06, h * 0.48, 1.06), rcx, topY + h * 0.52, rcz));
      apexY = topY + h;
      break;
    }
    case "pyramid": {
      const h = pitch * R * 1.5;
      const r4 = R * Math.SQRT2;
      roofAt(placed(new THREE.CylinderGeometry(0.001, r4, h, 4).translate(0, h / 2, 0).rotateY(Math.PI / 4).scale(1, 1, rd / rw || 1), rcx, topY, rcz));
      capAt(placed(new THREE.CylinderGeometry(0.001, r4 * 0.48, h * 0.46, 4).translate(0, h * 0.23, 0).rotateY(Math.PI / 4).scale(1.08, 1, (rd / rw || 1) * 1.08), rcx, topY + h * 0.54, rcz));
      apexY = topY + h;
      break;
    }
    case "cone": {
      const h = pitch * R * 2.0;
      roofAt(cylAt(0.001, R, h, 10, primary.x, topY, primary.z));
      capAt(cylAt(0.001, R * 0.5, h * 0.47, 10, primary.x, topY + h * 0.53, primary.z));
      apexY = topY + h;
      break;
    }
    case "onion": {
      const h = Math.max(0.5, pitch * R * 2.1);
      const prof: [number, number][] = [
        [0.62, 0], [0.95, 0.16], [1.0, 0.3], [0.82, 0.48], [0.5, 0.64], [0.24, 0.8], [0.06, 0.95], [0.001, 1],
      ];
      const lathe = (pts: [number, number][], rs: number): THREE.BufferGeometry =>
        new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r * R * rs), y * h)), 10);
      const low = prof.filter(([, y]) => y <= 0.48);
      const high = prof.filter(([, y]) => y >= 0.48);
      const structGeo = lathe(low, 1);
      structGeo.computeVertexNormals();
      roofAt(placed(structGeo, primary.x, topY, primary.z));
      const capGeo = lathe(high, 1.06);
      capGeo.computeVertexNormals();
      capAt(placed(capGeo, primary.x, topY, primary.z));
      apexY = topY + h;
      break;
    }
    case "dome": {
      const h = R * (0.6 + pitch * 0.45);
      const cut = Math.PI * 0.19;
      const struct = new THREE.SphereGeometry(R, 10, 5, 0, Math.PI * 2, cut, Math.PI / 2 - cut).scale(1, h / R, 1);
      roofAt(placed(struct, primary.x, topY, primary.z));
      const cap = new THREE.SphereGeometry(R * 1.04, 10, 3, 0, Math.PI * 2, 0, cut).scale(1, h / R, 1);
      capAt(placed(cap, primary.x, topY, primary.z));
      apexY = topY + h;
      break;
    }
    case "flat": {
      roofAt(boxAt(rw, 0.1, rd, rcx, topY, rcz));
      capAt(boxAt(rw * 0.68, 0.07, rd * 0.68, rcx, topY + 0.1, rcz));
      // parapet lip
      const lip = 0.16;
      put("body", boxAt(rw + 0.06, lip, 0.08, rcx, topY + 0.08, rcz - rd / 2));
      put("body", boxAt(rw + 0.06, lip, 0.08, rcx, topY + 0.08, rcz + rd / 2));
      put("body", boxAt(0.08, lip, rd + 0.06, rcx - rw / 2, topY + 0.08, rcz));
      put("body", boxAt(0.08, lip, rd + 0.06, rcx + rw / 2, topY + 0.08, rcz));
      apexY = topY + 0.24;
      break;
    }
    case "sawtooth": {
      const n = Math.max(2, Math.min(4, g.bays));
      const tw = rw / n;
      const h = pitch * tw * 0.9;
      for (let i = 0; i < n; i++) {
        const x = rcx - rw / 2 + tw * (i + 0.5);
        // tooth slopes along x: wedge rotated 90°
        roofAt(placed(wedge(rd, tw, h, 0.06), x, topY, rcz, Math.PI / 2));
        // colored panel on the upper half of each slope
        const ang = Math.atan2(h - 0.06, tw);
        capAt(boxAt(tw * 0.52, 0.05, rd * 0.98, x - tw * 0.22, topY + h * 0.66, rcz, 0, -ang));
      }
      apexY = topY + h;
      break;
    }
    case "skillion": {
      const h = pitch * rd * 0.7;
      roofAt(placed(wedge(rw, rd, h + 0.08, 0.08), rcx, topY, rcz));
      // colored panel laid on the upper half of the single slope
      const ang = Math.atan2(h, rd);
      const capGeo = new THREE.BoxGeometry(rw * 1.02, 0.05, (rd * 0.5) / Math.cos(ang));
      capGeo.rotateX(ang);
      capAt(placed(capGeo, rcx, topY + 0.08 + h * 0.75 + 0.04, rcz - rd * 0.25));
      apexY = topY + h + 0.1;
      break;
    }
    case "pagoda": {
      const tiers = Math.max(2, Math.min(3, Math.ceil(storeys / 2)));
      const h = pitch * R * 1.4;
      const tierH = h / tiers;
      for (let j = 0; j < tiers; j++) {
        const rj = (R + 0.18) * (1 - j * 0.28) * Math.SQRT2;
        const geo = new THREE.CylinderGeometry(rj * 0.12, rj, tierH * 0.75, 4).translate(0, (tierH * 0.75) / 2, 0).rotateY(Math.PI / 4);
        const y = topY + j * tierH;
        if (j === tiers - 1) capAt(placed(geo, primary.x, y, primary.z));
        else roofAt(placed(geo, primary.x, y, primary.z));
      }
      apexY = topY + h * 0.92;
      break;
    }
  }
  // secondary lobes under a radial roof get flat slabs so nothing stands topless
  if (radial) {
    for (let i = 1; i < lobes.length; i++) {
      const l = lobes[i]!;
      roofAt(boxAt(l.w * fTop * 1.05, 0.09, l.d * fTop * 1.05, l.x, topY, l.z));
    }
  }
  // bracketed overhang: small brackets under the eave corners
  if (g.roof.overhang === "bracketed") {
    const bx = rw / 2 - 0.08;
    const bz = rd / 2 - 0.08;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      put("beam", boxAt(0.09, 0.16, 0.09, rcx + sx * bx, topY - 0.16, rcz + sz * bz));
    }
  }

  // --- roof cap ornament -------------------------------------------------------
  const capX = radial ? primary.x : rcx;
  const capZ = radial ? primary.z : rcz;
  switch (g.roof.cap) {
    case "finial":
      put("trim", cylAt(0.025, 0.025, 0.26, 5, capX, apexY - 0.02, capZ));
      put("trim", placed(new THREE.SphereGeometry(0.07, 6, 4), capX, apexY + 0.28, capZ));
      break;
    case "spike":
      put("beam", cylAt(0.001, 0.06, 0.55, 6, capX, apexY - 0.02, capZ));
      break;
    case "orb":
      put("trim", placed(new THREE.SphereGeometry(0.13, 8, 5), capX, apexY + 0.1, capZ));
      break;
    case "weathervane":
      put("beam", cylAt(0.018, 0.018, 0.34, 5, capX, apexY - 0.02, capZ));
      put("beam", boxAt(0.34, 0.025, 0.025, capX, apexY + 0.26, capZ, 0.6));
      put("beam", boxAt(0.02, 0.1, 0.07, capX + 0.15 * Math.cos(0.6), apexY + 0.22, capZ - 0.15 * Math.sin(0.6), 0.6));
      break;
    case "chimney": {
      const chx = capX + rw * 0.24;
      const chTop = topY + Math.max(0.4, (apexY - topY) * 0.75) + 0.3;
      put("body", boxAt(0.17, chTop - topY + 0.1, 0.17, chx, topY - 0.05, capZ));
      put("dark", boxAt(0.22, 0.06, 0.22, chx, chTop + 0.05, capZ));
      if (g.ornament.smoke) smokeAt.push({ x: chx, y: chTop + 0.15, z: capZ });
      break;
    }
    case "none":
      break;
  }
  if (g.ornament.smoke && g.roof.cap !== "chimney") smokeAt.push({ x: capX, y: apexY + 0.15, z: capZ });

  // --- crenellation: merlons around the top storey perimeter --------------------
  if (g.ornament.crenellated) {
    const f = fTop;
    for (const l of lobes) {
      if (l.sides > 0) {
        const r = (Math.max(l.w, l.d) / 2) * f + 0.03;
        const n = Math.max(6, Math.round((2 * Math.PI * r) / 0.32));
        for (let i = 0; i < n; i += 2) {
          const a = (i / n) * Math.PI * 2;
          put("trim", boxAt(0.13, 0.15, 0.1, l.x + Math.cos(a) * r, topY, l.z + Math.sin(a) * r, -a));
        }
      } else {
        const hw = (l.w * f) / 2;
        const hd = (l.d * f) / 2;
        const step = 0.3;
        for (let x = -hw; x <= hw; x += step * 2) {
          put("trim", boxAt(0.14, 0.15, 0.09, l.x + x, topY, l.z - hd));
          put("trim", boxAt(0.14, 0.15, 0.09, l.x + x, topY, l.z + hd));
        }
        for (let z = -hd + step; z <= hd - step; z += step * 2) {
          put("trim", boxAt(0.09, 0.15, 0.14, l.x - hw, topY, l.z + z));
          put("trim", boxAt(0.09, 0.15, 0.14, l.x + hw, topY, l.z + z));
        }
      }
    }
  }

  // --- buttresses around the base ------------------------------------------------
  for (let i = 0; i < Math.min(4, Math.max(0, g.ornament.buttresses)); i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const rr = Math.hypot(primary.w, primary.d) / 2 - 0.02;
    const bx = primary.x + Math.cos(a) * rr;
    const bz = primary.z + Math.sin(a) * rr;
    put("body", boxAt(0.24, H * 0.95, 0.34, bx, 0, bz, -a + Math.PI / 2));
    put("body", boxAt(0.17, H * 0.55, 0.24, bx, H * 0.95, bz, -a + Math.PI / 2));
  }

  // --- trims ----------------------------------------------------------------------
  const trimKind = g.material.trim;
  if (trimKind === "quoins") {
    for (const l of lobes) {
      if (l.sides > 0) continue;
      for (let i = 0; i < storeys; i++) {
        const f = fAt(i);
        const hw = (l.w * f) / 2;
        const hd = (l.d * f) / 2;
        for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          put("trim", boxAt(0.12, 0.11, 0.12, l.x + sx * hw, i * H + H * 0.18, l.z + sz * hd));
          put("trim", boxAt(0.1, 0.11, 0.14, l.x + sx * hw, i * H + H * 0.58, l.z + sz * hd));
        }
      }
    }
  } else if (trimKind === "halftimber") {
    for (const l of lobes) {
      if (l.sides > 0) continue;
      for (let i = 0; i < storeys; i++) {
        const f = fAt(i);
        const hw = (l.w * f) / 2;
        const zf = (l.d * f) / 2 + 0.015;
        for (const zs of [zf, -zf]) {
          put("beam", boxAt(l.w * f, 0.06, 0.05, l.x, i * H + H - 0.06, l.z + zs));
          const studs = g.bays + 1;
          for (let sIdx = 0; sIdx <= studs; sIdx++) {
            put("beam", boxAt(0.05, H, 0.05, l.x - hw + (sIdx / studs) * l.w * f, i * H, l.z + zs));
          }
          put("beam", boxAt(Math.min(0.9, l.w * f * 0.5), 0.05, 0.05, l.x, i * H + H * 0.45, l.z + zs, 0, 0.7));
        }
      }
    }
  } else if (trimKind === "ribs") {
    for (const l of lobes) {
      if (l.sides > 0) {
        const r = Math.max(l.w, l.d) / 2;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          put("trim", boxAt(0.08, topY * 0.98, 0.1, l.x + Math.cos(a) * (r * fTop - 0.01), 0, l.z + Math.sin(a) * (r * fTop - 0.01), -a));
        }
      } else {
        const n = g.bays + 1;
        for (let i = 0; i <= n; i++) {
          const x = l.x - (l.w * fTop) / 2 + (i / n) * l.w * fTop;
          put("trim", boxAt(0.07, topY * 0.98, l.d * fTop + 0.05, x, 0, l.z));
        }
      }
    }
  } else if (trimKind === "glowseams") {
    for (const l of lobes) {
      const hw = (l.w * fTop) / 2;
      const hd = (l.d * fTop) / 2;
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        put("glow", boxAt(0.045, topY * 0.96, 0.045, l.x + sx * hw, 0.02, l.z + sz * hd));
      }
      for (let i = 1; i < storeys; i++) {
        put("glow", boxAt(l.w * fAt(i) + 0.05, 0.035, 0.035, l.x, i * H, l.z + (l.d * fAt(i)) / 2 + 0.015));
      }
    }
  } else if (trimKind === "ivy") {
    const n = 3 + g.bays;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.hypot(primary.w, primary.d) / 2 - 0.06;
      const geo = new THREE.IcosahedronGeometry(0.12 + rng() * 0.08, 0).scale(1, 0.75, 0.5);
      put("ivy", placed(geo, primary.x + Math.cos(a) * rr, 0.15 + rng() * H * 1.2, primary.z + Math.sin(a) * rr, -a + Math.PI / 2));
    }
  }

  // --- openings ---------------------------------------------------------------------
  const winBucket = g.ornament.glow ? "glow" : "dark";
  if (g.openings.windows !== "none") {
    let left = Math.min(12, g.bays * storeys);
    for (let i = 0; i < storeys && left > 0; i++) {
      const f = fAt(i);
      const m = Math.min(g.bays, left);
      left -= m;
      const y = i * H + H * 0.42;
      if (primary.sides > 0) {
        const r = (Math.max(primary.w, primary.d) / 2) * f + 0.02;
        for (let j = 0; j < m; j++) {
          const a = Math.PI / 2 + ((j - (m - 1) / 2) * Math.PI) / Math.max(2, m) + i * 0.35;
          windowGeo(g.openings.windows, winBucket, put, primary.x + Math.cos(a) * r, y, primary.z + Math.sin(a) * r, Math.PI / 2 - a);
        }
      } else {
        const zf = primary.z + (primary.d * f) / 2 + 0.02;
        const span = primary.w * f * 0.72;
        for (let j = 0; j < m; j++) {
          const x = primary.x + (m === 1 ? 0 : -span / 2 + (j / (m - 1)) * span);
          windowGeo(g.openings.windows, winBucket, put, x, y, zf, 0);
        }
      }
    }
  }
  // the door stands on the most outward-facing lobe (local +z = the spoke)
  const doorLobe = lobes.reduce((a, b) => (b.z + b.d / 2 > a.z + a.d / 2 ? b : a));
  const doorZ = doorLobe.sides > 0 ? doorLobe.z + Math.max(doorLobe.w, doorLobe.d) / 2 + 0.02 : doorLobe.z + doorLobe.d / 2 + 0.02;
  doorGeo(g.openings.door, put, doorLobe.x, doorZ);

  // --- banners (measured cloth) + form flavor + dressing (GLB pieces) -----------------
  const glb: GlbPlace[] = [];
  const footR = Math.max(rw, rd) / 2;
  for (let i = 0; i < Math.min(4, Math.max(0, g.ornament.banners)); i++) {
    const x = (i % 2 === 0 ? -1 : 1) * (0.35 + 0.22 * Math.floor(i / 2)) * primary.w;
    glb.push({ key: "banner", s: 0.55, x: primary.x + x, z: primary.z + primary.d / 2 + 0.12, banner: true });
  }
  formFlavor(form, t, footR, topY, glb);
  const propKeys = PROP_TABLE[g.dressing.propSet] ?? [];
  const propCount = Math.max(0, Math.min(3, g.dressing.density)) * 2;
  if (propKeys.length > 0) {
    for (let i = 0; i < propCount; i++) {
      let a = rng() * Math.PI * 2;
      // keep the door approach clear
      if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.5) a += Math.PI * 0.6;
      const rr = footR + 0.6 + rng() * 0.8;
      const key = propKeys[i % propKeys.length]!;
      glb.push({
        key,
        x: Math.cos(a) * rr,
        z: Math.sin(a) * rr,
        s: 0.38 + rng() * 0.2,
        rotY: rng() * Math.PI * 2,
        banner: key === "banner" || key === "flag",
      });
    }
  }
  // signed works: each flourish compiles into the shared procedural buckets,
  // so maker's marks cost zero extra draw calls beyond the cloth bucket
  placeFlourishes(componentId, input.flourishes ?? [], footR, topY, put);

  // GLB placement: shared materials merge; banner cloth gets a per-construction
  // cloned material wearing the measured secondary token
  const glbShared = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const clothBuckets: { src: THREE.Material; mat: THREE.MeshStandardMaterial; geoms: THREE.BufferGeometry[] }[] = [];
  const bannerHex = hexColor(t.banner ?? "") ?? DEFAULT_BANNER;
  const pm = new THREE.Matrix4();
  const ps = new THREE.Matrix4();
  for (const p of glb) {
    const s = p.s ?? 1;
    const sy = p.sy ?? s;
    pm.makeRotationY(p.rotY ?? 0);
    ps.makeScale(s, sy, s);
    pm.multiply(ps);
    pm.setPosition(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    for (const part of modelOrBox(assets, p.key).parts) {
      const geo = part.geometry.clone().applyMatrix4(pm);
      disposables.geoms.push(geo);
      if (p.banner) {
        let b = clothBuckets.find((c) => c.src === part.material);
        if (!b) {
          const m = (part.material as THREE.MeshStandardMaterial).clone();
          m.color.set(bannerHex);
          disposables.mats.push(m);
          bannerMats.push(m);
          b = { src: part.material, mat: m, geoms: [] };
          clothBuckets.push(b);
        }
        b.geoms.push(geo);
      } else {
        const list = glbShared.get(part.material) ?? [];
        list.push(geo);
        glbShared.set(part.material, list);
      }
    }
  }

  // --- merge every bucket into one mesh --------------------------------------------
  const addMesh = (geoms: THREE.BufferGeometry[], material: THREE.Material, role?: string): void => {
    if (geoms.length === 0) return;
    let geo: THREE.BufferGeometry | null = geoms[0] ?? null;
    if (geoms.length > 1) {
      try {
        geo = mergeGeometries(geoms, false);
        if (geo) disposables.geoms.push(geo);
      } catch {
        geo = null;
      }
    }
    for (const gg of geo ? [geo] : geoms) {
      const mesh = new THREE.Mesh(gg, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (role) mesh.userData.role = role;
      group.add(mesh);
    }
  };
  for (const [, b] of buckets) addMesh(b.geoms, b.mat, b.role);
  for (const [material, geoms] of glbShared) addMesh(geoms, material);
  for (const c of clothBuckets) addMesh(c.geoms, c.mat, "banner");

  const bbox = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  return {
    group,
    roofMats,
    bannerMats,
    disposables,
    height: Math.max(0.5, bbox.max.y),
    radius: Math.max(0.6, Math.max(size.x, size.z) / 2),
    smokeAt,
  };
}

// ---------------------------------------------------------------------------
// Footprint lobes — every footprint is 1-2 primitive lobes; ell/tee/cross
// compose boxes, round/octagon are n-gon cylinders, tower is tall and slender.
// ---------------------------------------------------------------------------

function lobesFor(footprint: BuildingGenome["footprint"], W: number): Lobe[] {
  switch (footprint) {
    case "square":
      return [{ x: 0, z: 0, w: W, d: W, sides: 0 }];
    case "rect":
      return [{ x: 0, z: 0, w: W * 1.4, d: W * 0.85, sides: 0 }];
    case "ell":
      return [
        { x: -W * 0.15, z: -W * 0.18, w: W * 1.2, d: W * 0.62, sides: 0 },
        { x: W * 0.32, z: W * 0.18, w: W * 0.55, d: W * 1.0, sides: 0 },
      ];
    case "tee":
      return [
        { x: 0, z: -W * 0.15, w: W * 1.25, d: W * 0.6, sides: 0 },
        { x: 0, z: W * 0.28, w: W * 0.55, d: W * 0.75, sides: 0 },
      ];
    case "cross":
      return [
        { x: 0, z: 0, w: W * 1.3, d: W * 0.55, sides: 0 },
        { x: 0, z: 0, w: W * 0.55, d: W * 1.3, sides: 0 },
      ];
    case "round":
      return [{ x: 0, z: 0, w: W, d: W, sides: 12 }];
    case "octagon":
      return [{ x: 0, z: 0, w: W * 1.05, d: W * 1.05, sides: 8 }];
    case "tower":
      return [{ x: 0, z: 0, w: W * 0.62, d: W * 0.62, sides: 0 }];
  }
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

function windowGeo(
  style: BuildingGenome["openings"]["windows"],
  bucket: string,
  put: (key: string, geo: THREE.BufferGeometry) => void,
  x: number,
  y: number,
  z: number,
  rotY: number,
): void {
  switch (style) {
    case "slit":
      put(bucket, boxAt(0.06, 0.3, 0.05, x, y, z, rotY));
      break;
    case "arch":
      put(bucket, boxAt(0.15, 0.22, 0.05, x, y, z, rotY));
      put(bucket, placed(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 8, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), x, y + 0.22, z, rotY));
      break;
    case "round":
      put(bucket, placed(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 10).rotateX(Math.PI / 2), x, y + 0.12, z, rotY));
      break;
    case "lattice":
      put(bucket, boxAt(0.18, 0.24, 0.05, x, y, z, rotY));
      put("beam", boxAt(0.02, 0.26, 0.06, x, y - 0.01, z, rotY));
      put("beam", boxAt(0.2, 0.02, 0.06, x, y + 0.11, z, rotY));
      break;
    case "grand":
      put(bucket, boxAt(0.26, 0.36, 0.05, x, y, z, rotY));
      put(bucket, placed(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 8, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), x, y + 0.36, z, rotY));
      put("trim", boxAt(0.3, 0.04, 0.06, x, y - 0.04, z, rotY));
      break;
    case "none":
      break;
  }
}

function doorGeo(
  style: BuildingGenome["openings"]["door"],
  put: (key: string, geo: THREE.BufferGeometry) => void,
  x: number,
  z: number,
): void {
  switch (style) {
    case "plank":
      put("dark", boxAt(0.32, 0.48, 0.06, x, 0.02, z));
      put("beam", boxAt(0.34, 0.05, 0.07, x, 0.16, z));
      put("beam", boxAt(0.34, 0.05, 0.07, x, 0.34, z));
      break;
    case "arch":
      put("dark", boxAt(0.32, 0.44, 0.06, x, 0.02, z));
      put("dark", placed(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 8, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), x, 0.46, z));
      put("trim", boxAt(0.42, 0.06, 0.08, x, 0.56, z));
      break;
    case "portcullis":
      put("dark", boxAt(0.38, 0.5, 0.06, x, 0.02, z));
      for (let i = 0; i < 4; i++) put("beam", boxAt(0.03, 0.5, 0.08, x - 0.14 + i * 0.09, 0.02, z));
      put("beam", boxAt(0.4, 0.03, 0.08, x, 0.28, z));
      break;
    case "double":
      put("dark", boxAt(0.2, 0.46, 0.06, x - 0.115, 0.02, z));
      put("dark", boxAt(0.2, 0.46, 0.06, x + 0.115, 0.02, z));
      put("beam", boxAt(0.03, 0.48, 0.07, x, 0.02, z));
      break;
    case "rounded":
      put("dark", boxAt(0.3, 0.4, 0.06, x, 0.02, z));
      put("dark", placed(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 10, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), x, 0.42, z));
      break;
  }
}

// ---------------------------------------------------------------------------
// Form flavor — the measured-count laws every form keeps wearing: gates on
// the gatehouse, shaft carts on the ore mine, banner count on the yard.
// ---------------------------------------------------------------------------

function formFlavor(form: CastleForm, t: Traits, footR: number, topY: number, glb: GlbPlace[]): void {
  switch (form) {
    case "keep":
      glb.push({ key: "flag", s: 0.7, x: -footR * 0.5, z: -footR * 0.5, y: topY, banner: true });
      glb.push({ key: "flag", s: 0.7, x: footR * 0.5, z: footR * 0.5, y: topY, banner: true });
      break;
    case "manor":
      glb.push({ key: "banner", s: 0.6, x: -footR * 0.8, z: footR * 0.75, banner: true });
      glb.push({ key: "banner", s: 0.6, x: footR * 0.8, z: footR * 0.75, banner: true });
      break;
    case "gatehouse": {
      const n = Math.max(1, t.gates);
      for (let i = 0; i < n; i++) {
        glb.push({ key: "wall_gate", s: 0.62, x: (i - (n - 1) / 2) * 0.68, z: footR + 0.5 });
      }
      glb.push({ key: "flag", s: 0.6, y: topY, banner: true });
      break;
    }
    case "ore-mine": {
      glb.push({ key: "rock_B", s: 0.85, x: -footR - 0.5, z: 0.35 });
      glb.push({ key: "rock_C", s: 0.6, x: -footR - 0.2, z: 0.9 });
      const n = Math.max(1, t.shafts);
      for (let i = 0; i < n; i++) {
        const a = -0.7 + (i / Math.max(1, n - 1)) * 1.4;
        glb.push({ key: "wheelbarrow", s: 0.52, x: Math.sin(a) * (footR + 0.85), z: Math.cos(a) * (footR + 0.85), rotY: a + Math.PI / 2 });
      }
      break;
    }
    case "training-yard": {
      const r = footR + 1.05;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        glb.push({ key: "fence", s: 0.85, x: Math.cos(a) * r, z: Math.sin(a) * r, rotY: -a + Math.PI / 2 });
      }
      glb.push({ key: "target", s: 0.6, x: 0.4 * r, z: -0.25 * r });
      glb.push({ key: "weaponrack", s: 0.55, x: -0.45 * r, z: 0.3 * r, rotY: 0.8 });
      const n = Math.max(1, t.banners);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.3;
        glb.push({ key: "banner", s: 0.6, x: Math.cos(a) * r * 0.7, z: Math.sin(a) * r * 0.7, banner: true });
      }
      break;
    }
    case "library-tower":
      glb.push({ key: "book_set", s: 0.5, x: footR * 0.7, z: footR * 0.85 });
      break;
    case "signal-tower":
      glb.push({ key: "torch_lit", s: 0.55, x: footR * 0.75, z: footR * 0.7 });
      break;
    case "reliquary":
      glb.push({ key: "chest", s: 0.45, x: footR * 0.75, z: footR * 0.7, rotY: 0.5 });
      glb.push({ key: "chest", s: 0.4, x: -footR * 0.78, z: footR * 0.65, rotY: -0.4 });
      break;
    case "well":
      glb.push({ key: "well", s: 0.8, x: footR + 0.7, z: 0.4 });
      break;
    case "smithy":
      glb.push({ key: "weaponrack", s: 0.55, x: -footR - 0.45, z: 0.55 });
      break;
    case "foundry":
      glb.push({ key: "resource_lumber", s: 0.6, x: footR + 0.5, z: 0.45 });
      break;
    case "enginehouse":
    case "chapel":
      break;
  }
}

// ---------------------------------------------------------------------------
// Signed works — flourishes. Each maker's mark is a tiny procedural build
// anchored on the construction's perimeter, seeded from (componentId, author)
// so the same signature always lands the same way. The door face (local +z)
// stays clear; nothing sits inside the footprint radius except the gargoyle's
// corner perch. All geometry rides the existing material buckets.
// ---------------------------------------------------------------------------

function placeFlourishes(
  componentId: string,
  flourishes: readonly Flourish[],
  footR: number,
  eaveY: number,
  put: (key: string, geo: THREE.BufferGeometry) => void,
): void {
  for (const f of flourishes) {
    const rng = mulberry32((hashStr(`${componentId}:${f.author}`) || 1) >>> 0);
    let a = rng() * Math.PI * 2;
    // keep the door approach (local +z) clear
    if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.6) a += Math.PI * 0.7;
    const rr = footR + 0.75 + rng() * 0.45;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    const face = Math.PI / 2 - a; // rotY turning the piece to front the spoke direction
    switch (f.mark) {
      case "lantern": {
        put("beam", cylAt(0.032, 0.042, 0.52, 5, x, 0, z));
        put("glow", boxAt(0.13, 0.14, 0.13, x, 0.52, z, face));
        put("beam", boxAt(0.17, 0.03, 0.17, x, 0.66, z, face));
        break;
      }
      case "garden": {
        put("beam", boxAt(0.62, 0.07, 0.26, x, 0, z, face));
        put("dark", boxAt(0.56, 0.09, 0.2, x, 0.02, z, face));
        for (let i = -1; i <= 1; i++) {
          const bx = x + Math.cos(face) * i * 0.17;
          const bz = z - Math.sin(face) * i * 0.17;
          put("ivy", placed(new THREE.IcosahedronGeometry(0.055, 0), bx, 0.1, bz));
          put(i === 0 ? "cloth" : "trim", placed(new THREE.SphereGeometry(0.032, 5, 4), bx, 0.18, bz));
        }
        break;
      }
      case "gargoyle": {
        // crouched block-figure perched on the nearest footprint corner
        const ca = Math.PI / 4 + Math.round((a - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2);
        const gx = Math.cos(ca) * (footR + 0.22);
        const gz = Math.sin(ca) * (footR + 0.22);
        const gy = Math.PI / 2 - ca;
        const ox = Math.cos(ca);
        const oz = Math.sin(ca);
        put("trim", boxAt(0.2, 0.12, 0.2, gx, 0, gz, gy)); // plinth
        put("body", boxAt(0.15, 0.13, 0.2, gx, 0.12, gz, gy)); // haunches
        put("body", boxAt(0.11, 0.09, 0.11, gx + ox * 0.07, 0.23, gz + oz * 0.07, gy)); // head
        put("body", boxAt(0.04, 0.16, 0.12, gx - oz * 0.1, 0.16, gz + ox * 0.1, gy, 0.5));
        put("body", boxAt(0.04, 0.16, 0.12, gx + oz * 0.1, 0.16, gz - ox * 0.1, gy, -0.5));
        break;
      }
      case "forgefire": {
        put("dark", cylAt(0.15, 0.08, 0.2, 6, x, 0, z));
        put("beam", cylAt(0.17, 0.15, 0.05, 6, x, 0.2, z));
        put("glow", placed(new THREE.IcosahedronGeometry(0.09, 0), x, 0.28, z));
        break;
      }
      case "pennant": {
        put("beam", cylAt(0.02, 0.027, 0.88, 5, x, 0, z));
        put("trim", placed(new THREE.SphereGeometry(0.035, 5, 4), x, 0.9, z));
        // cloth wedge, both windings so it reads from either side
        const wedgeGeo = tris([
          0, 0.86, 0, 0.32, 0.8, 0, 0, 0.72, 0,
          0, 0.86, 0, 0, 0.72, 0, 0.32, 0.8, 0,
        ]);
        put("cloth", placed(wedgeGeo, x, 0, z, face));
        break;
      }
      case "windchime": {
        // hung close under the eave line, tight against the wall
        const wx = Math.cos(a) * (footR + 0.18);
        const wz = Math.sin(a) * (footR + 0.18);
        const wy = Math.max(0.55, eaveY - 0.06);
        const tang = face + Math.PI / 2;
        put("beam", boxAt(0.34, 0.035, 0.035, wx, wy, wz, tang));
        for (let i = -1; i <= 1; i++) {
          const bx = wx + Math.cos(tang) * i * 0.11;
          const bz = wz - Math.sin(tang) * i * 0.11;
          const len = 0.14 + 0.05 * ((i + 1) % 3);
          put("trim", boxAt(0.026, len, 0.026, bx, wy - len, bz));
        }
        break;
      }
      case "beehive": {
        put("beam", cylAt(0.085, 0.11, 0.15, 6, x, 0, z));
        const dome = new THREE.SphereGeometry(0.16, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.05, 1);
        put("trim", placed(dome, x, 0.15, z));
        put("dark", boxAt(0.06, 0.05, 0.06, x + Math.cos(a) * 0.13, 0.17, z + Math.sin(a) * 0.13, face));
        break;
      }
      case "mosaic": {
        const pat = ["cloth", "trim", "dark"] as const;
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            const ox = i * 0.13;
            const oz = j * 0.13;
            const tx = x + ox * Math.cos(face) + oz * Math.sin(face);
            const tz = z - ox * Math.sin(face) + oz * Math.cos(face);
            put(pat[(i + j * 2 + 9) % 3]!, boxAt(0.11, 0.028, 0.11, tx, 0, tz, face));
          }
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signature — the machine-readable rebuild witness for the smoke battery:
// mesh count + total vertex count of a compile, then everything disposed.
// ---------------------------------------------------------------------------

export function compileSignature(assets: Assets, input: CompileInput): string {
  const b = compileGenome(assets, input);
  let meshes = 0;
  let verts = 0;
  b.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      meshes++;
      const att = m.geometry.getAttribute("position");
      if (att) verts += att.count;
    }
  });
  for (const geo of b.disposables.geoms) geo.dispose();
  for (const m of b.disposables.mats) m.dispose();
  return `${meshes}:${verts}`;
}
