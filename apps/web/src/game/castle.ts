/**
 * Castle plan law — where every component stands, forever.
 *
 * The castle is a polar city: the keep at the origin, wards in rings, walls
 * between, connectors riding spokes and arcs. Placement is deterministic
 * from (graph, seed) — and once a component has claimed a socket it NEVER
 * moves: the ledger carries claims across commissions, so the castle grows
 * outward wing by wing instead of re-rolling. The ledger is the layout
 * contract; castleHash covers it.
 *
 * Forms: each component kind has a lawful default form and a short list of
 * allowed alternatives the representation loop (Grok) may choose from, with
 * a cited reason. An invalid choice falls back to the default — the Law of
 * Isomorphism allows creativity only inside the buildable vocabulary.
 */

import { mulberry32 } from "./map.js";
import type { Component, ComponentEdge, ComponentGraph, ComponentKind } from "./components.js";
import {
  deriveGenome,
  genomeSignature,
  styleSignature,
  validateBuildingGenome,
  validateStyleGenome,
  type BuildingGenome,
  type StyleGenome,
} from "./genome.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type CastleForm =
  | "keep" // the central donjon — always the root component
  | "manor" // web front: timber great-house, palette on roof and banner
  | "gatehouse" // server: gates = routes
  | "ore-mine" // database: shafts and carts = tables
  | "enginehouse" // pipeline node: the machine that drives the rails
  | "smithy" // cli
  | "foundry" // library
  | "training-yard" // tests: banners = test files
  | "library-tower" // docs: height = lines
  | "signal-tower" // config
  | "reliquary" // assets
  | "well" // small utility (fallback flavor)
  | "chapel"; // creative alternative for docs/lore-heavy components

export const ALLOWED_FORMS: Record<ComponentKind, readonly CastleForm[]> = {
  "app-web": ["manor", "keep"],
  "app-server": ["gatehouse", "keep"],
  database: ["ore-mine"],
  pipeline: ["enginehouse"],
  cli: ["smithy", "foundry"],
  library: ["foundry", "smithy", "well"],
  tests: ["training-yard"],
  docs: ["library-tower", "chapel"],
  config: ["signal-tower", "well"],
  assets: ["reliquary", "chapel"],
};

export function defaultFormFor(kind: ComponentKind): CastleForm {
  return ALLOWED_FORMS[kind][0]!;
}

/** Support kinds live on the outer ring; core kinds ring the keep. */
const SUPPORT_KINDS: ReadonlySet<ComponentKind> = new Set([
  "tests",
  "docs",
  "config",
  "assets",
] as ComponentKind[]);

// ---------------------------------------------------------------------------
// Trait bindings — measured facts become visible properties. Every entry
// here is the isomorphism the spectator can check by clicking.
// ---------------------------------------------------------------------------

export type SizeStep = 1 | 2 | 3 | 4;

export type Traits = {
  /** 1 cottage · 2 hall · 3 great hall · 4 monument (by lines). */
  size: SizeStep;
  /** Primary measured palette token (roof/body) or null → kind default. */
  tint: string | null;
  /** Secondary token (banners/trim) or null. */
  banner: string | null;
  /** gatehouse: arch count. */
  gates: number;
  /** ore-mine: shaft/cart count. */
  shafts: number;
  /** training-yard: banner count. */
  banners: number;
  /** tower forms: storeys. */
  storeys: number;
};

export function traitsFor(c: Component): Traits {
  const L = c.facts.lines;
  const size: SizeStep = L <= 200 ? 1 : L <= 1200 ? 2 : L <= 5000 ? 3 : 4;
  return {
    size,
    tint: c.facts.palette[0] ?? null,
    banner: c.facts.palette[1] ?? null,
    gates: Math.max(1, Math.min(5, c.facts.routes)),
    shafts: Math.max(1, Math.min(6, c.facts.tables)),
    banners: Math.max(1, Math.min(8, c.facts.testFiles)),
    storeys: Math.max(1, Math.min(5, 1 + Math.floor(Math.log10(Math.max(10, L))))),
  };
}

// ---------------------------------------------------------------------------
// Ledger — the growth contract
// ---------------------------------------------------------------------------

export type LedgerEntry = {
  ring: number; // 0 = keep
  slot: number; // index around the ring
  form: CastleForm;
  /** Representation-loop citation ("the database is an ore mine because…"). */
  cited?: string;
  /** Component vanished from the graph — the works stand as a ruin. */
  razed?: boolean;
  /**
   * A CHOSEN design genome (representation loop, cited). Absent = the
   * lawful default derives fresh each plan, so law upgrades can improve
   * unchosen buildings while chosen ones persist forever.
   */
  genome?: BuildingGenome;
};

export type CastleLedger = {
  version: 1;
  seed: number;
  entries: Record<string, LedgerEntry>;
  /** The castle's chosen design language (cited), if any ever was. */
  style?: StyleGenome;
};

export function foundLedger(seed: number): CastleLedger {
  return { version: 1, seed, entries: {} };
}

/** Only a shape the plan law can actually merge counts as a prior ledger. */
export function asLedger(u: unknown): CastleLedger | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const c = u as { version?: unknown; entries?: unknown; seed?: unknown };
  if (c.version !== 1 || typeof c.seed !== "number") return undefined;
  if (typeof c.entries !== "object" || c.entries === null) return undefined;
  return u as CastleLedger;
}

// ---------------------------------------------------------------------------
// Plan geometry
// ---------------------------------------------------------------------------

/** Ring radii in world units (tiles). Ring 0 is the keep itself. */
export const RING_RADIUS = [0, 7, 12.5, 18, 24] as const;
/** Arc length one socket occupies; slots per ring derive from this. */
const SLOT_ARC = 4.6;
/** The curtain wall runs between the inner ward and the outer ward. */
export const WALL_RADIUS = 9.75;

export function slotsOnRing(ring: number): number {
  const r = RING_RADIUS[ring] ?? RING_RADIUS[RING_RADIUS.length - 1]! + (ring - RING_RADIUS.length + 1) * 5.5;
  return Math.max(6, Math.floor((2 * Math.PI * r) / SLOT_ARC));
}

export function ringRadius(ring: number): number {
  return RING_RADIUS[ring] ?? RING_RADIUS[RING_RADIUS.length - 1]! + (ring - RING_RADIUS.length + 1) * 5.5;
}

export type Socket = {
  componentId: string;
  form: CastleForm;
  ring: number;
  slot: number;
  /** World position (y is up in the 3D engine; plan is x/z). */
  x: number;
  z: number;
  /** Facing: radially outward angle (radians). */
  angle: number;
  traits: Traits;
  razed: boolean;
  cited?: string;
  /** Resolved design vector: the chosen genome or the derived default. */
  genome: BuildingGenome;
};

export type Connector = {
  from: string;
  to: string;
  kind: "rails" | "road";
  weight: number;
  /** Polyline in plan space: spoke → arc → spoke. */
  points: { x: number; z: number }[];
};

export type WallTower = { x: number; z: number; angle: number };

export type CastlePlan = {
  seed: number;
  sockets: Socket[];
  /** Curtain wall: closed ring of towers; segments run tower→tower. */
  wall: { radius: number; towers: WallTower[]; gateAngle: number };
  connectors: Connector[];
  ledger: CastleLedger;
  /** The castle's design language (validated) or null = unstyled defaults. */
  style: StyleGenome | null;
  hash: string;
};

// ---------------------------------------------------------------------------
// Plan derivation
// ---------------------------------------------------------------------------

function angleOf(ring: number, slot: number, seed: number): number {
  const n = slotsOnRing(ring);
  const offset = mulberry32((seed ^ (0xca57 + ring)) >>> 0)() * Math.PI * 2;
  return offset + (slot / n) * Math.PI * 2;
}

function posOf(ring: number, slot: number, seed: number): { x: number; z: number; angle: number } {
  const a = angleOf(ring, slot, seed);
  const r = ringRadius(ring);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, angle: a };
}

/**
 * Plan the castle. `ledger` carries prior claims; components without a claim
 * get the next free slot on their lawful ring (outward if full). Existing
 * claims are never altered — only `razed` flips when a component vanishes.
 */
export function planCastle(graph: ComponentGraph, seed: number, prior?: CastleLedger): CastlePlan {
  const ledger: CastleLedger = prior
    ? { version: 1, seed: prior.seed, entries: { ...prior.entries }, ...(prior.style ? { style: prior.style } : {}) }
    : foundLedger(seed);
  const S = ledger.seed;

  const byId = new Map(graph.components.map((c) => [c.id, c]));

  // occupancy from prior claims
  const taken = new Set<string>();
  for (const [, e] of Object.entries(ledger.entries)) taken.add(`${e.ring}:${e.slot}`);

  const claim = (ring: number): { ring: number; slot: number } => {
    for (let r = ring; r < ring + 12; r++) {
      const n = slotsOnRing(r);
      // interleave slots (stride 2 first pass) so early neighbors spread out
      for (const stride of [2, 1]) {
        for (let s = 0; s < n; s += stride) {
          if (!taken.has(`${r}:${s}`)) {
            taken.add(`${r}:${s}`);
            return { ring: r, slot: s };
          }
        }
      }
    }
    return { ring: ring + 12, slot: 0 };
  };

  // deterministic claim order for NEW components: keep first, then core by
  // descending keep-adjacency weight, then support, alphabetical tiebreak
  const w = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.from === graph.rootId) w.set(e.to, (w.get(e.to) ?? 0) + e.weight);
    if (e.to === graph.rootId) w.set(e.from, (w.get(e.from) ?? 0) + e.weight);
  }
  const newcomers = graph.components.filter((c) => !ledger.entries[c.id]);
  const rank = (c: Component): [number, number, string] => [
    c.id === graph.rootId ? 0 : SUPPORT_KINDS.has(c.kind) ? 2 : 1,
    -(w.get(c.id) ?? 0),
    c.id,
  ];
  newcomers.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : 1);
  });
  for (const c of newcomers) {
    // The keep belongs to the software's heart. A support-kind root (a repo
    // that is only a README so far) must not squat the motte — the origin
    // stays bare until an app or library root arrives to claim it.
    if (
      c.id === graph.rootId &&
      !SUPPORT_KINDS.has(c.kind) &&
      !Object.values(ledger.entries).some((e) => e.ring === 0)
    ) {
      ledger.entries[c.id] = { ring: 0, slot: 0, form: "keep" };
      taken.add("0:0");
      continue;
    }
    const home = SUPPORT_KINDS.has(c.kind) ? 2 : 1;
    const { ring, slot } = claim(home);
    ledger.entries[c.id] = { ring, slot, form: defaultFormFor(c.kind) };
  }

  // raze flags: claims whose component is gone stand as ruins
  for (const [id, e] of Object.entries(ledger.entries)) e.razed = !byId.has(id);

  // sockets — the design vector resolves here: a chosen genome (validated
  // against today's law) outranks the derived default; both clamp to traits.
  const style = validateStyleGenome(ledger.style);
  const sockets: Socket[] = Object.entries(ledger.entries)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, e]) => {
      const c = byId.get(id);
      const p = e.ring === 0 ? { x: 0, z: 0, angle: angleOf(1, 0, S) } : posOf(e.ring, e.slot, S);
      const traits: Traits = c
        ? traitsFor(c)
        : { size: 1, tint: null, banner: null, gates: 1, shafts: 1, banners: 1, storeys: 1 };
      const kind = c?.kind ?? "library";
      return {
        componentId: id,
        form: e.form,
        ring: e.ring,
        slot: e.slot,
        x: p.x,
        z: p.z,
        angle: p.angle,
        traits,
        razed: e.razed === true,
        cited: e.cited,
        genome: e.genome
          ? validateBuildingGenome(e.genome, kind, traits, id, S, style)
          : deriveGenome(kind, traits, id, S, style),
      };
    });

  // curtain wall: towers every ~SLOT_ARC*1.6 along WALL_RADIUS; the gate sits
  // on the server's angle (requests enter there) or the keep-facing default
  const gateComp = graph.components.find((c) => c.kind === "app-server" && ledger.entries[c.id]);
  const gateAngle = gateComp
    ? posOf(ledger.entries[gateComp.id]!.ring, ledger.entries[gateComp.id]!.slot, S).angle
    : Math.PI / 2;
  const towerCount = Math.max(8, Math.floor((2 * Math.PI * WALL_RADIUS) / (SLOT_ARC * 1.6)));
  const towers: WallTower[] = [];
  for (let i = 0; i < towerCount; i++) {
    const a = gateAngle + (i / towerCount) * Math.PI * 2;
    towers.push({ x: Math.cos(a) * WALL_RADIUS, z: Math.sin(a) * WALL_RADIUS, angle: a });
  }

  // connectors: polar Manhattan (spoke → arc at the outer of the two rings →
  // spoke); rails when a database/pipeline is on either end
  const socketById = new Map(sockets.map((s) => [s.componentId, s]));
  const connectors: Connector[] = [];
  for (const e of graph.edges) {
    const a = socketById.get(e.from);
    const b = socketById.get(e.to);
    if (!a || !b) continue;
    const ka = byId.get(e.from)?.kind;
    const kb = byId.get(e.to)?.kind;
    const kind: Connector["kind"] =
      ka === "database" || kb === "database" || ka === "pipeline" || kb === "pipeline" ? "rails" : "road";
    connectors.push({ from: e.from, to: e.to, kind, weight: e.weight, points: routeConnector(a, b) });
  }

  const plan: CastlePlan = {
    seed: S,
    sockets,
    wall: { radius: WALL_RADIUS, towers, gateAngle },
    connectors,
    ledger,
    style,
    hash: "",
  };
  plan.hash = castleHash(plan);
  return plan;
}

function routeConnector(a: Socket, b: Socket): { x: number; z: number }[] {
  const points: { x: number; z: number }[] = [{ x: a.x, z: a.z }];
  const rArc = Math.max(ringRadius(a.ring), ringRadius(b.ring)) - 1.6; // just inside the outer ring
  const a0 = Math.atan2(a.z, a.x);
  const a1 = Math.atan2(b.z, b.x);
  // spoke out/in to the arc radius
  points.push({ x: Math.cos(a0) * rArc, z: Math.sin(a0) * rArc });
  // arc sweep (shorter way), sampled every ~12°
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const steps = Math.max(1, Math.ceil(Math.abs(d) / (Math.PI / 15)));
  for (let i = 1; i <= steps; i++) {
    const t = a0 + (d * i) / steps;
    points.push({ x: Math.cos(t) * rArc, z: Math.sin(t) * rArc });
  }
  points.push({ x: b.x, z: b.z });
  return points;
}

// ---------------------------------------------------------------------------
// Hash — the era's layout contract
// ---------------------------------------------------------------------------

export function castleHash(plan: CastlePlan): string {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(`v1|seed:${plan.seed}`);
  for (const s of plan.sockets) {
    mix(
      `|${s.componentId}:${s.ring}:${s.slot}:${s.form}:${s.razed ? 1 : 0}:${s.traits.size}:${s.traits.tint ?? "-"}:${s.traits.gates}:${s.traits.shafts}`,
    );
    mix(`~${genomeSignature(s.genome)}`);
  }
  for (const c of plan.connectors) mix(`|${c.from}>${c.to}:${c.kind}:${c.points.length}`);
  mix(`|gate:${plan.wall.gateAngle.toFixed(4)}:towers:${plan.wall.towers.length}`);
  mix(`|style:${styleSignature(plan.style)}`);
  return (h >>> 0).toString(16).padStart(8, "0");
}
