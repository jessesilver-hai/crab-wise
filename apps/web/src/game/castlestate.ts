/**
 * CastleState — the live half of the isomorphism loop.
 *
 * The renderer never re-derives anything itself: it feeds founding data and
 * live events in here, and receives (plan, changes) back. Changes are the
 * exact visible consequences the engine must animate:
 *
 *   file_write        → applyWrite   → maybe a new component (scaffold it),
 *                                      maybe bigger traits (extend it)
 *   component_facts   → applyFacts   → trait diffs (repaint the manor NOW)
 *   castle_repr       → applyRepr    → a lawful form choice + citation
 *
 * All pure state + law modules; the battery locks the diffs.
 */

import type { FileNode, ProbeHit } from "@agent-empires/protocol";
import { buildComponentGraph, type ComponentGraph } from "./components.js";
import {
  ALLOWED_FORMS,
  planCastle,
  type CastleForm,
  type CastleLedger,
  type CastlePlan,
  type Traits,
} from "./castle.js";
import { genomeSignature, validateBuildingGenome, validateStyleGenome } from "./genome.js";
import { flourishSignature, signWork, validateFlourish } from "./flourish.js";

export type CastleChange =
  | { kind: "added"; componentId: string }
  | { kind: "removed"; componentId: string }
  | { kind: "form"; componentId: string; form: CastleForm; cited?: string }
  | { kind: "traits"; componentId: string; before: Traits; after: Traits }
  | { kind: "genome"; componentId: string; cited?: string }
  | { kind: "style"; name: string; cited: string }
  | { kind: "flourish"; componentId: string; author?: string; cited?: string };

type FN = FileNode & { lines?: number };

export class CastleState {
  private tree: FN | null = null;
  private seed = 0;
  private depEdges: { from: string; to: string }[] = [];
  private hitsByPath = new Map<string, ProbeHit[]>();
  private lines = new Map<string, number>();
  plan: CastlePlan | null = null;
  graph: ComponentGraph | null = null;

  found(
    tree: FileNode,
    seed: number,
    depEdges: { from: string; to: string }[] = [],
    probeHits: ProbeHit[] = [],
    priorLedger?: CastleLedger,
  ): CastlePlan {
    this.tree = structuredClone(tree) as FN;
    this.seed = seed;
    this.depEdges = depEdges;
    this.hitsByPath.clear();
    for (const h of probeHits) {
      const list = this.hitsByPath.get(h.path);
      if (list) list.push(h);
      else this.hitsByPath.set(h.path, [h]);
    }
    this.lines.clear();
    const walk = (n: FN): void => {
      if (n.kind === "file") this.lines.set(n.path, n.lines ?? 0);
      else for (const c of n.children ?? []) walk(c as FN);
    };
    walk(this.tree);
    // a returning castle enters its next commission: new claims stamp the
    // new era while every standing wing keeps the era that raised it
    const prior =
      priorLedger && Object.keys(priorLedger.entries).length > 0
        ? { ...priorLedger, commission: (priorLedger.commission ?? 0) + 1 }
        : priorLedger;
    return this.replan(prior).plan;
  }

  /** A worker wrote a file: grow the tree/lines, re-plan, diff. */
  applyWrite(path: string, created: boolean, linesAdded = 0, linesRemoved = 0): { plan: CastlePlan; changes: CastleChange[] } {
    if (!this.tree) throw new Error("castle not founded");
    if (created && !this.lines.has(path)) this.insertFile(path);
    this.lines.set(path, Math.max(1, (this.lines.get(path) ?? 0) + linesAdded - linesRemoved));
    this.writeLinesIntoTree();
    return this.replan(this.plan?.ledger);
  }

  /** A file's probes were re-taken: replace its hits, re-plan, diff. */
  applyFacts(path: string, hits: ProbeHit[]): { plan: CastlePlan; changes: CastleChange[] } {
    if (!this.tree) throw new Error("castle not founded");
    if (hits.length === 0) this.hitsByPath.delete(path);
    else this.hitsByPath.set(path, hits.filter((h) => h.path === path));
    return this.replan(this.plan?.ledger);
  }

  /** The representation loop spoke: lawful forms land, others fall back. */
  applyRepr(
    componentId: string,
    form: string,
    cited: string,
    genome?: unknown,
  ): { plan: CastlePlan; changes: CastleChange[] } {
    if (!this.plan) throw new Error("castle not founded");
    const ledger = this.plan.ledger;
    const entry = ledger.entries[componentId];
    const comp = this.graph?.components.find((c) => c.id === componentId);
    if (!entry || !comp) return { plan: this.plan, changes: [] };
    const allowed = ALLOWED_FORMS[comp.kind] as readonly string[];
    const lawful = (allowed.includes(form) ? form : allowed[0]) as CastleForm;
    // the keep stays the keep — representation may retitle, never relocate
    const next = entry.ring === 0 ? ("keep" as CastleForm) : lawful;
    // a chosen design genome persists on the claim; unlawful fields fall
    // back inside the validator, so what lands here is always buildable
    let genomeChanged = false;
    if (genome !== undefined && genome !== null) {
      const socket = this.plan.sockets.find((s) => s.componentId === componentId);
      const traits = socket?.traits ?? { size: 1, tint: null, banner: null, gates: 1, shafts: 1, banners: 1, storeys: 1 };
      const validated = validateBuildingGenome(genome, comp.kind, traits, componentId, ledger.seed, this.plan.style);
      genomeChanged = !entry.genome || genomeSignature(entry.genome) !== genomeSignature(validated);
      entry.genome = validated;
    }
    if (entry.form === next && entry.cited === cited && !genomeChanged) return { plan: this.plan, changes: [] };
    entry.form = next;
    entry.cited = cited;
    const out = this.replan(ledger);
    if (!out.changes.some((c) => c.kind === "form" && c.componentId === componentId)) {
      out.changes.push({ kind: "form", componentId, form: next, cited });
    }
    if (genomeChanged && !out.changes.some((c) => c.kind === "genome" && c.componentId === componentId)) {
      out.changes.push({ kind: "genome", componentId, cited });
    }
    return out;
  }

  /**
   * A worker signs the wing they worked in. The path resolves to a
   * construction (exact file first, then directory prefix); no construction,
   * a razed claim, or an unlawful flourish = lawful silence. Marks ride the
   * ledger and the hash, so signed works persist and replay.
   */
  applyFlourish(
    path: string,
    mark: string,
    author: string,
    cited: string,
  ): { plan: CastlePlan; changes: CastleChange[] } {
    if (!this.plan) throw new Error("castle not founded");
    const clean = path.replace(/^\.\/?/, "").replace(/\/+$/, "");
    const comp =
      this.graph?.components.find((c) => c.paths.includes(clean)) ??
      this.graph?.components.find((c) => clean !== "" && c.paths.some((p) => p.startsWith(clean + "/")));
    const entry = comp ? this.plan.ledger.entries[comp.id] : undefined;
    if (!comp || !entry || entry.razed === true) return { plan: this.plan, changes: [] };
    const f = validateFlourish({ mark, author, cited });
    if (!f) return { plan: this.plan, changes: [] };
    const next = signWork(entry.flourishes, f);
    if (!next || flourishSignature(next) === flourishSignature(entry.flourishes)) {
      return { plan: this.plan, changes: [] };
    }
    entry.flourishes = next;
    const out = this.replan(this.plan.ledger);
    // the diff reports the signature shift bare; the fold knows the signer
    const change: CastleChange = { kind: "flourish", componentId: comp.id, author: f.author, cited: f.cited };
    const bare = out.changes.findIndex((c) => c.kind === "flourish" && c.componentId === comp.id);
    if (bare >= 0) out.changes[bare] = change;
    else out.changes.push(change);
    return out;
  }

  /**
   * The Master Builder declared the castle's design language. A style must
   * be named and cited or it is refused. The declaration lands on the
   * CURRENT era: this commission's unchosen wings re-derive under it (the
   * diff carries their genome changes) and the world dressing follows, but
   * earlier quarters keep the style of the era that raised them.
   */
  applyStyle(style: unknown): { plan: CastlePlan; changes: CastleChange[] } {
    if (!this.plan) throw new Error("castle not founded");
    const validated = validateStyleGenome(style);
    if (!validated) return { plan: this.plan, changes: [] };
    const ledger = this.plan.ledger;
    const commission = ledger.commission ?? 0;
    const eras = ledger.eras ?? (ledger.style ? [ledger.style] : []);
    while (eras.length <= commission) eras.push(null);
    eras[commission] = validated;
    ledger.eras = eras;
    ledger.style = validated; // legacy mirror: the latest declared language
    const out = this.replan(ledger);
    out.changes.push({ kind: "style", name: validated.name, cited: validated.cited });
    return out;
  }

  // -------------------------------------------------------------------------

  private insertFile(path: string): void {
    const parts = path.split("/");
    let node: FN = this.tree!;
    let sofar = "";
    for (let i = 0; i < parts.length - 1; i++) {
      sofar = sofar ? `${sofar}/${parts[i]}` : parts[i]!;
      node.children = node.children ?? [];
      let dir = node.children.find((c) => c.kind === "dir" && c.path === sofar) as FN | undefined;
      if (!dir) {
        dir = { kind: "dir", name: parts[i]!, path: sofar, children: [] } as FN;
        node.children.push(dir);
      }
      node = dir;
    }
    node.children = node.children ?? [];
    node.children.push({ kind: "file", name: parts[parts.length - 1]!, path } as FN);
  }

  private writeLinesIntoTree(): void {
    const walk = (n: FN): void => {
      if (n.kind === "file") n.lines = this.lines.get(n.path) ?? n.lines ?? 0;
      else for (const c of n.children ?? []) walk(c as FN);
    };
    walk(this.tree!);
  }

  private replan(prior?: CastleLedger): { plan: CastlePlan; changes: CastleChange[] } {
    const hits: ProbeHit[] = [];
    for (const list of this.hitsByPath.values()) hits.push(...list);
    const graph = buildComponentGraph(this.tree!, this.depEdges, hits);
    const before = this.plan;
    const plan = planCastle(graph, this.seed, prior);
    this.graph = graph;
    this.plan = plan;
    return { plan, changes: before ? diffPlans(before, plan) : [] };
  }
}

/** The visible consequences between two plans — what the engine animates. */
export function diffPlans(a: CastlePlan, b: CastlePlan): CastleChange[] {
  const changes: CastleChange[] = [];
  const A = new Map(a.sockets.map((s) => [s.componentId, s]));
  const B = new Map(b.sockets.map((s) => [s.componentId, s]));
  for (const [id, sb] of B) {
    const sa = A.get(id);
    if (!sa || (sa.razed && !sb.razed)) {
      changes.push({ kind: "added", componentId: id });
      continue;
    }
    if (!sa.razed && sb.razed) {
      changes.push({ kind: "removed", componentId: id });
      continue;
    }
    if (sa.form !== sb.form) changes.push({ kind: "form", componentId: id, form: sb.form, cited: sb.cited });
    if (JSON.stringify(sa.traits) !== JSON.stringify(sb.traits)) {
      changes.push({ kind: "traits", componentId: id, before: sa.traits, after: sb.traits });
    }
    if (genomeSignature(sa.genome) !== genomeSignature(sb.genome)) {
      changes.push({ kind: "genome", componentId: id, cited: sb.cited });
    }
    if (flourishSignature(sa.flourishes) !== flourishSignature(sb.flourishes)) {
      changes.push({ kind: "flourish", componentId: id });
    }
  }
  for (const [id, sa] of A) {
    if (!B.has(id) && !sa.razed) changes.push({ kind: "removed", componentId: id });
  }
  return changes;
}
