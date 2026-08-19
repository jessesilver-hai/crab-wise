/* Castle-era smoke harness (not shipped). Mounts the 3D castle engine with a
 * synthetic commission and exposes window hooks so the puppeteer suite can
 * drive deterministic scenarios. Open /smoke.html to eyeball; `?big=1` mounts
 * the 20-component stress castle; `?still=1` skips the self-running reel. */
import type { FileNode, GameEvent, ProbeHit } from "@agent-empires/protocol";
import { selectRenderer } from "./renderer-select.js";

type FN = FileNode & { lines?: number };
const file = (path: string, lines?: number): FN =>
  ({ kind: "file", name: path.split("/").pop()!, path, ...(lines ? { lines } : {}) }) as FN;
const dir = (path: string, children: FN[]): FN =>
  ({ kind: "dir", name: path.split("/").pop() || ".", path, children }) as FN;

// --- fixtures ---------------------------------------------------------------

/** The bakery commission: web front, server, mine, rails, proving yard. */
export const BAKERY: FN = dir(".", [
  file("index.html", 120),
  file("styles.css", 260),
  file("app.js", 180),
  file("server.js", 240),
  dir("db", [file("db/schema.sql", 60)]),
  dir("etl", [file("etl/import.js", 90)]),
  dir("tests", [file("tests/app.test.js", 110)]),
  file("README.md", 40),
]);

export const BAKERY_PROBES: ProbeHit[] = [
  // the brand color leads by measured frequency; the dark ink is the banner
  { path: "styles.css", probe: "color", value: "#e86a33" },
  { path: "styles.css", probe: "color", value: "#e86a33" },
  { path: "styles.css", probe: "color", value: "#222831" },
  { path: "server.js", probe: "route", value: "GET /" },
  { path: "server.js", probe: "route", value: "GET /menu" },
  { path: "server.js", probe: "route", value: "POST /order" },
  { path: "db/schema.sql", probe: "table", value: "orders" },
  { path: "db/schema.sql", probe: "table", value: "items" },
];

export const BAKERY_EDGES = [
  { from: "app.js", to: "server.js" },
  { from: "etl/import.js", to: "db/schema.sql" },
  { from: "tests/app.test.js", to: "server.js" },
];

/** Twenty-component stress castle: several mines, pipelines, yards, towers. */
function bigFixture(): { tree: FN; probes: ProbeHit[]; edges: { from: string; to: string }[] } {
  const kids: FN[] = [file("server.js", 400), file("index.html", 150), file("styles.css", 300)];
  const probes: ProbeHit[] = [
    { path: "styles.css", probe: "color", value: "#3aa0ff" },
    { path: "server.js", probe: "route", value: "GET /" },
  ];
  const edges: { from: string; to: string }[] = [];
  const tops = [
    "db", "etl", "jobs", "lib", "cli", "docs", "tests", "config", "assets", "auth",
    "billing", "search", "mailer", "store", "metrics", "gateway", "parser",
  ];
  for (let i = 0; i < tops.length; i++) {
    const t = tops[i]!;
    const f = `${t}/${t === "db" ? "schema.sql" : t === "docs" ? "guide.md" : "index.js"}`;
    kids.push(dir(t, [file(f, 120 + i * 90)]));
    if (t === "db") {
      probes.push({ path: f, probe: "table", value: "users" }, { path: f, probe: "table", value: "orders" });
    }
    if (t === "etl" || t === "jobs") edges.push({ from: f, to: "db/schema.sql" });
    else if (i % 2 === 0) edges.push({ from: f, to: "server.js" });
  }
  return { tree: dir(".", kids), probes, edges };
}

// --- harness ----------------------------------------------------------------

let seq = 0;
const ev = <T extends Record<string, unknown>>(body: T): GameEvent =>
  ({ seq: seq++, ts: Date.now(), ...body }) as unknown as GameEvent;

async function main(): Promise<void> {
  const mount = document.getElementById("app")!;
  const renderer = await selectRenderer(mount);

  const params = new URLSearchParams(location.search);
  const big = params.get("big") === "1";
  const still = params.get("still") === "1";
  const fx = big ? bigFixture() : { tree: BAKERY, probes: BAKERY_PROBES, edges: BAKERY_EDGES };

  const feed = (e: GameEvent) => renderer.handleEvent(e, false);
  // Puppeteer drives scenarios through this hook; eyeball runs drive themselves.
  (window as unknown as Record<string, unknown>).__castle = { feed, ev, renderer };

  feed(
    ev({
      type: "match_started",
      matchId: "smoke",
      task: { id: "smoke", title: big ? "Stress Castle" : "The Bakery", description: "smoke", flavor: "smoke" },
      mapSeed: big ? 424242 : 20260818,
      repoTree: fx.tree,
      depEdges: fx.edges,
      probeHits: fx.probes,
    }),
  );

  feed(ev({ type: "agent_spawned", agentId: "king", role: "orchestrator", name: "Aldric", model: "m" }));
  feed(ev({ type: "agent_spawned", agentId: "w1", role: "worker", name: "Berta", model: "m", charge: "raise the works" }));
  feed(ev({ type: "agent_spawned", agentId: "w2", role: "worker", name: "Corin", model: "m", charge: "tend the mine" }));

  if (still || big) return;

  // Self-running reel: growth → repaint → representation → fact loss.
  // (Live razing is impossible by law: no protocol event removes a path.
  // Ruins appear only when a castle is re-founded over a shrunken repo.)
  const later = (ms: number, fn: () => void) => window.setTimeout(fn, ms);
  later(4000, () => {
    feed(ev({ type: "file_write", agentId: "w1", path: "lib/colors.js", created: true, linesAdded: 140, linesRemoved: 0, buildingKind: "house", diffSnippet: "+export const palette = []" }));
  });
  later(9000, () => {
    feed(ev({ type: "component_facts", path: "styles.css", hits: [
      { path: "styles.css", probe: "color", value: "#3aa0ff" },
      { path: "styles.css", probe: "color", value: "#3aa0ff" },
      { path: "styles.css", probe: "color", value: "#222831" },
    ] }));
  });
  later(14000, () => {
    feed(ev({ type: "castle_repr", componentId: "lib:library", form: "well", cited: "the palette utils draw color like water" }));
  });
  later(19000, () => {
    feed(ev({ type: "component_facts", path: "db/schema.sql", hits: [] }));
    feed(ev({ type: "file_write", agentId: "w2", path: "db/schema.sql", created: false, linesAdded: 0, linesRemoved: 60, buildingKind: "house", diffSnippet: "-CREATE TABLE orders" }));
  });
}

void main();
