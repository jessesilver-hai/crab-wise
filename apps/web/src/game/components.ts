/**
 * Component law — the Castle Era's first measurement.
 *
 * A castle is not built from files; it is built from COMPONENTS: the web
 * front, the server, the database, the pipeline, the proving yard. This
 * module derives a deterministic ComponentGraph from three founding-time
 * measurements the runtime already knows how to take:
 *
 *   tree       — the workspace file tree (protocol FileNode)
 *   depEdges   — real import edges from the dependency survey (depscan law)
 *   probeHits  — bounded fact probes (colors, routes, tables) from FACT_SCAN
 *
 * Everything here is pure and engine-free: same inputs, same graph, on the
 * server, in the battery, and in the renderer. The Law of Isomorphism holds:
 * every component and every fact below is a measured thing, never a vibe.
 */

import type { FileNode, ProbeHit } from "@agent-empires/protocol";

export type { ProbeHit } from "@agent-empires/protocol";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ComponentKind =
  | "app-web" // pages, styles, client scripts — the manor the visitor sees
  | "app-server" // routes/handlers — the gatehouse where requests enter
  | "database" // schema, migrations, models — the ore mine
  | "pipeline" // etl/jobs/queues/workers — the rails between
  | "cli" // command tools — the smithy
  | "library" // shared code — the foundry
  | "tests" // trials — the training yard
  | "docs" // chronicle — the library tower
  | "config" // decrees — the signal tower
  | "assets"; // bound relics — the reliquary

export type ComponentFacts = {
  files: number;
  lines: number;
  /** Distinct palette tokens by descending frequency (≤ 6), lowercase hex. */
  palette: string[];
  routes: number;
  tables: number;
  testFiles: number;
  /** Extension → file count, for lore and material choices. */
  langs: Record<string, number>;
};

export type Component = {
  /** Stable id: `${boundary || "root"}:${kind}` — sockets are keyed by this. */
  id: string;
  kind: ComponentKind;
  /** Human label: boundary dir name, or the kind's plain name at root. */
  label: string;
  /** Boundary dir path ("" for root). */
  boundary: string;
  paths: string[];
  facts: ComponentFacts;
};

export type ComponentEdge = { from: string; to: string; weight: number };

export type ComponentGraph = {
  components: Component[];
  edges: ComponentEdge[];
  /** The keep: the component the castle is built around. */
  rootId: string;
};

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

const TEST_RE = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[a-z]+$/i;
const DOC_RE = /(^|\/)(docs?|documentation)(\/|$)|\.(md|rst|adoc|txt)$/i;
const CONFIG_RE =
  /(^|\/)(\.github|\.circleci|infra|deploy|charts?)(\/|$)|(^|\/)[^/]*\.(ya?ml|toml|ini|cfg|lock)$|(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[a-z]+|webpack[^/]*|babel[^/]*|eslint[^/]*|prettier[^/]*|Dockerfile|Makefile|fly[^/]*\.toml)$/i;
const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|mp4|webm|ttf|otf|woff2?|glb|gltf|bin|pdf|zip)$/i;
const WEB_RE = /\.(html?|css|scss|sass|less|vue|svelte)$/i;
const DB_RE = /(^|\/)(db|database|migrations?|models?)(\/|$)|\.(sql|prisma)$|(^|\/)schema\.[a-z]+$/i;
const PIPELINE_RE = /(^|\/)(etl|pipelines?|jobs?|workers?|queues?|crons?|tasks?|ingest|stream)(\/|$)/i;
const CLI_RE = /(^|\/)(bin|cli|cmd)(\/|$)|(^|\/)cli\.[a-z]+$/i;
const SERVER_NAME_RE = /(^|\/)(server|api|routes?|controllers?|handlers?|endpoints?)([./]|$)/i;
const CLIENT_NAME_RE = /(^|\/)(client|frontend|www|public|pages|components|ui)(\/|$)/i;

/**
 * Classify one file. Probe hits outrank name law (a measured route beats a
 * guessed name); name law outranks extension defaults.
 */
export function classifyComponentFile(
  path: string,
  probes: { routes: Set<string>; tables: Set<string> },
): ComponentKind {
  if (TEST_RE.test(path)) return "tests";
  if (ASSET_RE.test(path)) return "assets";
  if (DOC_RE.test(path)) return "docs";
  if (probes.tables.has(path)) return "database";
  if (probes.routes.has(path)) return "app-server";
  if (DB_RE.test(path)) return "database";
  if (PIPELINE_RE.test(path)) return "pipeline";
  if (CLI_RE.test(path)) return "cli";
  if (WEB_RE.test(path)) return "app-web";
  if (CONFIG_RE.test(path)) return "config";
  if (SERVER_NAME_RE.test(path)) return "app-server";
  if (CLIENT_NAME_RE.test(path)) return "app-web";
  return "library";
}

// ---------------------------------------------------------------------------
// Graph derivation
// ---------------------------------------------------------------------------

const MONOREPO_DIRS = /^(packages|apps|crates|services|libs|modules|projects|workspaces|plugins)$/i;

type FileRec = { path: string; name: string; lines: number };

function walkFiles(node: FileNode, out: FileRec[]): void {
  if (node.kind === "file") {
    const lines = (node as FileNode & { lines?: number }).lines ?? 0;
    out.push({ path: node.path, name: node.name, lines });
    return;
  }
  for (const c of node.children ?? []) walkFiles(c, out);
}

/** Boundary = monorepo package dir, else top-level dir, else "" (root). */
function boundaryOf(path: string, packageDirs: Set<string>): string {
  const parts = path.split("/");
  if (parts.length >= 2 && packageDirs.size > 0) {
    const two = `${parts[0]}/${parts[1]}`;
    if (packageDirs.has(two)) return two;
  }
  return parts.length >= 2 ? parts[0]! : "";
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function buildComponentGraph(
  tree: FileNode,
  depEdges: { from: string; to: string }[] = [],
  probeHits: ProbeHit[] = [],
): ComponentGraph {
  const files: FileRec[] = [];
  walkFiles(tree, files);

  // monorepo package boundaries
  const packageDirs = new Set<string>();
  for (const top of tree.children ?? []) {
    if (top.kind === "dir" && MONOREPO_DIRS.test(top.name)) {
      for (const kid of top.children ?? []) {
        if (kid.kind === "dir") packageDirs.add(kid.path);
      }
    }
  }

  // probe indices
  const routeFiles = new Set<string>();
  const tableFiles = new Set<string>();
  const colorsByFile = new Map<string, string[]>();
  for (const h of probeHits) {
    if (h.probe === "route") routeFiles.add(h.path);
    else if (h.probe === "table") tableFiles.add(h.path);
    else if (h.probe === "color") {
      const list = colorsByFile.get(h.path);
      const v = h.value.toLowerCase();
      if (list) list.push(v);
      else colorsByFile.set(h.path, [v]);
    }
  }
  const probes = { routes: routeFiles, tables: tableFiles };

  // group files into components by (boundary, kind)
  const byId = new Map<string, { kind: ComponentKind; boundary: string; recs: FileRec[]; label?: string }>();
  for (const f of files) {
    const kind = classifyComponentFile(f.path, probes);
    const boundary = boundaryOf(f.path, packageDirs);
    const id = `${boundary || "root"}:${kind}`;
    const g = byId.get(id);
    if (g) g.recs.push(f);
    else byId.set(id, { kind, boundary, recs: [f] });
  }

  // fold slivers: a 1-file library/config sliver inside a boundary that has a
  // dominant component joins it — castles want chunky wards, not shed sprawl
  const groups = [...byId.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dominantByBoundary = new Map<string, string>();
  for (const [id, g] of groups) {
    const key = g.boundary;
    const cur = dominantByBoundary.get(key);
    const curSize = cur ? byId.get(cur)!.recs.length : -1;
    if (g.recs.length > curSize) dominantByBoundary.set(key, id);
  }
  const FOLDABLE: ReadonlySet<ComponentKind> = new Set(["library", "config"] as ComponentKind[]);
  for (const [id, g] of groups) {
    const domId = dominantByBoundary.get(g.boundary)!;
    if (id !== domId && g.recs.length === 1 && FOLDABLE.has(g.kind)) {
      byId.get(domId)!.recs.push(...g.recs);
      byId.delete(id);
    }
  }

  // Wards law: a flat repo's loose code files each raise their own ward.
  // Grouping by kind froze growing settlements into one blob — five feature
  // files are five works, and the Law of Isomorphism wants five buildings.
  // The alphabetical anchor keeps the group's historic id so prior ledgers
  // (eras, genomes, flourishes) never orphan; docs/config/assets stay
  // chunky; sheds under 10 lines lean on the anchor; past 24 wards the
  // quarter is a district again, not a scatter.
  const WARD_KINDS: ReadonlySet<ComponentKind> = new Set([
    "app-web",
    "app-server",
    "database",
    "pipeline",
    "cli",
    "library",
    "tests",
  ] as ComponentKind[]);
  const WARD_MIN_LINES = 10;
  const MAX_FILE_WARDS = 24;
  for (const g of [...byId.values()]) {
    if (g.boundary !== "" || !WARD_KINDS.has(g.kind) || g.recs.length < 2) continue;
    const recs = [...g.recs].sort((a, b) => (a.path < b.path ? -1 : 1));
    const keep: FileRec[] = [recs[0]!];
    let made = 0;
    for (const r of recs.slice(1)) {
      if (r.lines < WARD_MIN_LINES || made >= MAX_FILE_WARDS) {
        keep.push(r);
        continue;
      }
      byId.set(`root:file:${r.name}`, { kind: g.kind, boundary: "", recs: [r], label: r.name });
      made++;
    }
    g.recs = keep;
  }

  // materialize components
  const components: Component[] = [];
  for (const [id, g] of [...byId.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const paths = g.recs.map((r) => r.path).sort();
    const langs: Record<string, number> = {};
    let lines = 0;
    let testFiles = 0;
    const colorCount = new Map<string, number>();
    let routes = 0;
    let tables = 0;
    for (const r of g.recs) {
      lines += r.lines;
      const ext = extOf(r.name);
      if (ext) langs[ext] = (langs[ext] ?? 0) + 1;
      if (TEST_RE.test(r.path)) testFiles++;
      for (const c of colorsByFile.get(r.path) ?? []) colorCount.set(c, (colorCount.get(c) ?? 0) + 1);
    }
    const pathSet = new Set(paths);
    for (const h of probeHits) {
      if (!pathSet.has(h.path)) continue;
      if (h.probe === "route") routes++;
      else if (h.probe === "table") tables++;
    }
    const palette = [...colorCount.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 6)
      .map(([hex]) => hex);
    components.push({
      id,
      kind: g.kind,
      label: g.label ?? (g.boundary ? g.boundary.split("/").pop()! : KIND_LABEL[g.kind]),
      boundary: g.boundary,
      paths,
      facts: { files: g.recs.length, lines, palette, routes, tables, testFiles, langs },
    });
  }

  // aggregate file dep edges → component edges
  const pathToComp = new Map<string, string>();
  for (const c of components) for (const p of c.paths) pathToComp.set(p, c.id);
  const edgeW = new Map<string, number>();
  for (const e of depEdges) {
    const a = pathToComp.get(e.from);
    const b = pathToComp.get(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a}→${b}`;
    edgeW.set(key, (edgeW.get(key) ?? 0) + 1);
  }
  const edges: ComponentEdge[] = [...edgeW.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, weight]) => {
      const [from, to] = key.split("→") as [string, string];
      return { from, to, weight };
    });

  // the keep: server outranks web outranks the heaviest remaining non-support
  const keepOrder: ComponentKind[] = ["app-server", "app-web", "pipeline", "cli", "library", "database"];
  let rootId = "";
  for (const kind of keepOrder) {
    const cands = components.filter((c) => c.kind === kind);
    if (cands.length > 0) {
      rootId = cands.sort((a, b) => b.facts.lines - a.facts.lines || (a.id < b.id ? -1 : 1))[0]!.id;
      break;
    }
  }
  if (!rootId && components.length > 0) rootId = components[0]!.id;

  return { components, edges, rootId };
}

const KIND_LABEL: Record<ComponentKind, string> = {
  "app-web": "the web front",
  "app-server": "the server",
  database: "the database",
  pipeline: "the pipeline",
  cli: "the command tools",
  library: "the foundry",
  tests: "the trials",
  docs: "the chronicle",
  config: "the decrees",
  assets: "the relics",
};

/** One line per component — the Grok representation loop reads this brief. */
export function componentBrief(graph: ComponentGraph): string {
  const lines: string[] = [];
  for (const c of graph.components) {
    const facts: string[] = [`${c.facts.files} files`, `${c.facts.lines} lines`];
    if (c.facts.routes > 0) facts.push(`${c.facts.routes} routes`);
    if (c.facts.tables > 0) facts.push(`${c.facts.tables} tables`);
    if (c.facts.palette.length > 0) facts.push(`palette ${c.facts.palette.slice(0, 3).join(" ")}`);
    if (c.facts.testFiles > 0) facts.push(`${c.facts.testFiles} test files`);
    const keep = c.id === graph.rootId ? " [the keep]" : "";
    lines.push(`${c.id} · ${c.kind} · ${c.label}${keep} — ${facts.join(", ")}`);
  }
  for (const e of graph.edges) lines.push(`edge: ${e.from} → ${e.to} ×${e.weight}`);
  return lines.join("\n");
}
