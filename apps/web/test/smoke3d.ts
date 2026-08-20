/* Headless smoke harness for the Castle Era 3D renderer (dev-server only).
 * Founds a bakery-like fixture through the real CastleState path, then drives
 * the live isomorphism loop with synthetic events: repaint, growth theater,
 * rails, representation swap, razing, orbit + inspector. `?big=1` founds a
 * 20-component castle and gates founding time, draw calls and fps instead.
 * Logs "[smoke3d] CHECK <name> PASS|FAIL" lines and a final SUMMARY the
 * external runner (run-smoke3d.mjs) exits on. */
import type { FileNode, GameEvent, ProbeHit } from "@agent-empires/protocol";
import { ringRadius, type CastleForm, type Socket, type Traits } from "../src/game/castle.js";
import { CastleState } from "../src/game/castlestate.js";
import {
  FOOTPRINTS,
  MATERIAL_FAMILIES,
  PROP_SETS,
  ROOF_CAPS,
  ROOF_FORMS,
  ROOF_OVERHANGS,
  ROOF_PITCHES,
  TAPERS,
  TRIMS,
  WINDOW_STYLES,
  DOOR_STYLES,
  type BuildingGenome,
  type StyleGenome,
} from "../src/game/genome.js";
import { attachGameRenderer } from "../src/game3d/renderer.js";

type FN = FileNode & { lines?: number };
const file = (path: string, lines?: number): FN =>
  ({ kind: "file", name: path.split("/").pop()!, path, ...(lines ? { lines } : {}) }) as FN;
const dir = (path: string, children: FN[]): FN =>
  ({ kind: "dir", name: path.split("/").pop() || ".", path, children }) as FN;

const BIG = new URLSearchParams(location.search).has("big");
const SEED = 4242;

// --- console instrumentation (before the renderer attaches) -------------------
let consoleErrors = 0;
const examineLog: string[] = [];
{
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    consoleErrors++;
    origError(...args);
  };
  const origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.startsWith("EXAMINE: ")) examineLog.push(first.slice("EXAMINE: ".length));
    origLog(...args);
  };
  window.addEventListener("error", () => consoleErrors++);
  window.addEventListener("unhandledrejection", () => consoleErrors++);
}

// --- fixtures ------------------------------------------------------------------

/** The bakery: web front, server, db, etl, tests — the era's canonical shape. */
const BAKERY: FN = dir(".", [
  file("index.html", 120),
  file("styles.css", 260),
  file("server.js", 340),
  dir("db", [file("db/schema.sql", 90)]),
  dir("etl", [file("etl/import.js", 150)]),
  dir("tests", [file("tests/app.test.js", 130)]),
]);
const BAKERY_PROBES: ProbeHit[] = [
  { path: "styles.css", probe: "color", value: "#e86a33" },
  { path: "styles.css", probe: "color", value: "#e86a33" },
  { path: "styles.css", probe: "color", value: "#f3d9b0" },
  { path: "server.js", probe: "route", value: "GET /" },
  { path: "server.js", probe: "route", value: "GET /menu" },
  { path: "server.js", probe: "route", value: "POST /order" },
  { path: "db/schema.sql", probe: "table", value: "orders" },
  { path: "db/schema.sql", probe: "table", value: "pastries" },
];
const BAKERY_DEPS = [{ from: "etl/import.js", to: "db/schema.sql" }];

/** 20 components: multiple databases and pipelines so the rails run heavy. */
function bigTree(): { tree: FN; deps: { from: string; to: string }[]; probes: ProbeHit[] } {
  const kids: FN[] = [
    dir("web", [file("web/index.html", 300), file("web/styles.css", 500), file("web/app.js", 900)]),
    dir("api", [file("api/routes.js", 2600), file("api/handlers.js", 1400)]),
    dir("db", [file("db/schema.sql", 300), file("db/seed.sql", 150)]),
    dir("orders", [file("orders/schema.sql", 260), file("orders/views.sql", 120)]),
    dir("models", [file("models/user.js", 700), file("models/post.js", 500)]),
    dir("etl", [file("etl/import.js", 800), file("etl/clean.js", 300)]),
    dir("jobs", [file("jobs/nightly.js", 400)]),
    dir("stream", [file("stream/consume.js", 600)]),
    dir("bin", [file("bin/tool.js", 350)]),
    dir("tests", [file("tests/a.test.js", 300), file("tests/b.test.js", 260)]),
    dir("docs", [file("docs/guide.md", 900)]),
    dir("infra", [file("infra/deploy.yaml", 120)]),
    dir("media", [file("media/logo.png", 1), file("media/hero.png", 1)]),
  ];
  for (let i = 1; i <= 7; i++) {
    kids.push(dir(`lib${i}`, [file(`lib${i}/a.ts`, 220 + i * 40), file(`lib${i}/b.ts`, 180 + i * 20)]));
  }
  return {
    tree: dir(".", kids),
    deps: [
      { from: "etl/import.js", to: "db/schema.sql" },
      { from: "jobs/nightly.js", to: "orders/schema.sql" },
      { from: "stream/consume.js", to: "models/user.js" },
      { from: "api/routes.js", to: "db/schema.sql" },
      { from: "web/app.js", to: "api/routes.js" },
    ],
    probes: [
      { path: "web/styles.css", probe: "color", value: "#7a3ce8" },
      { path: "api/routes.js", probe: "route", value: "GET /a" },
      { path: "api/routes.js", probe: "route", value: "GET /b" },
      { path: "api/routes.js", probe: "route", value: "POST /c" },
      { path: "db/schema.sql", probe: "table", value: "users" },
      { path: "db/schema.sql", probe: "table", value: "posts" },
      { path: "orders/schema.sql", probe: "table", value: "orders" },
    ],
  };
}

// --- harness helpers -------------------------------------------------------------

type Debug = {
  worldReady(): boolean;
  foundMs(): number;
  plan(): { sockets: { componentId: string; ring: number; x: number; z: number; razed: boolean }[] } | null;
  hash(): string;
  rootId(): string;
  componentCount(): number;
  ids(): string[];
  socketWorld(id: string): { x: number; y: number; z: number } | null;
  stateOf(id: string): string | null;
  formOf(id: string): string | null;
  labelOf(id: string): string | null;
  tintOf(id: string): { roof: string | null; banner: string | null };
  genomeOf(id: string): BuildingGenome | null;
  flourishesOf(id: string): { mark: string; author: string; cited: string }[];
  styleOf(): StyleGenome | null;
  groundStyle(): { tone: string; nature: string; hex: string };
  wallStyleName(): string;
  constructionSig(id: string): string | null;
  compileSig(input: { componentId: string; form: CastleForm; traits: Traits; genome: BuildingGenome; seed: number }): string;
  scaffoldCount(): number;
  towers(): number;
  gatePresent(): boolean;
  wallGaps(): number;
  wallSegments(): number;
  cartPositions(): { x: number; z: number }[];
  cartCount(): number;
  railCount(): number;
  roadCount(): number;
  drawCalls(): number;
  fps(): number;
  degraded(): boolean;
  meshCount(): number;
  azimuth(): number;
  pitch(): number;
  inspectorOpen(): string | null;
  inspectorText(): string;
  missingPieces(): string[];
  agents(): Map<string, { unit: { x: number; y: number; z: number } }>;
  groundHeightAt(x: number, z: number): number;
  projectWorld(x: number, y: number, z: number): { x: number; y: number };
};

const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass });
  console.info(`[smoke3d] CHECK ${name} ${pass ? "PASS" : "FAIL"} ${detail}`);
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}
function stage(name: string): void {
  document.title = `stage:${name}`;
  console.info(`[stage] ${name}`);
}
function glRendererString(): string {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return "none";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  } catch {
    return "unknown";
  }
}

const cbLog: string[] = [];
const r = attachGameRenderer(document.getElementById("app")!);
r.setExamineHandler?.((text) => cbLog.push(`examine:${text}`));
r.setSpeakHandler?.((agentId) => cbLog.push(`speak:${agentId}`));
r.setInspectHandler?.((path) => cbLog.push(`inspect:${path}`));
r.setOrderHandler?.((kind, target) => cbLog.push(`order:${kind}:${target}`));

const ev = (e: Record<string, unknown>) =>
  r.handleEvent({ seq: 0, ts: Date.now(), ...e } as unknown as GameEvent, false);
const dbg = () => (globalThis as Record<string, unknown>).__ae3d as Debug;

function canvas(): HTMLCanvasElement {
  return document.querySelector("#app canvas")!;
}
function firePointer(type: string, x: number, y: number, button = 0, buttons = 0): void {
  canvas().dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      clientY: y,
      button,
      buttons,
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
    }),
  );
}

/** Click a construction by aiming at heights along it, retrying until a
 * predicate holds — hover picks re-aim like the old harness did under
 * software GL, where a 300ms window may not contain a rendered frame. */
async function clickConstruction(id: string, done: () => boolean): Promise<void> {
  const pos = dbg().socketWorld(id);
  if (!pos) return;
  for (const dy of [1.2, 0.7, 2.0, 0.4, 2.8]) {
    if (done()) return;
    const pt = dbg().projectWorld(pos.x, pos.y + dy, pos.z);
    firePointer("pointermove", pt.x, pt.y);
    await sleep(150);
    firePointer("pointerdown", pt.x, pt.y, 0, 1);
    firePointer("pointerup", pt.x, pt.y, 0, 0);
    await sleep(300);
  }
}

// --- the run --------------------------------------------------------------------

(async () => {
  const big = BIG ? bigTree() : null;
  ev({
    type: "match_started",
    matchId: BIG ? "smoke3d-big" : "smoke3d",
    task: { id: "smoke", title: "Smoke", description: "smoke", flavor: "a bakery site, commissioned live" },
    mapSeed: SEED,
    repoTree: big ? big.tree : BAKERY,
    depEdges: big ? big.deps : BAKERY_DEPS,
    probeHits: big ? big.probes : BAKERY_PROBES,
  });

  const ready = await until(() => Boolean(dbg()?.worldReady()), 30000);
  check("world-ready", ready, `foundMs=${dbg()?.foundMs?.()}`);
  if (!ready) {
    console.info("[smoke3d] SUMMARY pass=0 fail=1 (castle never founded)");
    return;
  }
  const glInfo = glRendererString();
  const software = /swiftshader|llvmpipe|software/i.test(glInfo);
  console.info(`[smoke3d] gl-renderer=${glInfo} hash=${dbg().hash()}`);
  // founding reveal: keep first, rings outward (~2s), then everything settled
  await sleep(2600);
  stage("founded");
  console.info(
    `[smoke3d] components=${dbg().componentCount()} draw-calls=${dbg().drawCalls()} ` +
      `towers=${dbg().towers()} rails=${dbg().railCount()} carts=${dbg().cartCount()} ` +
      `missing=${JSON.stringify(dbg().missingPieces())}`,
  );

  if (BIG) {
    await runBig(software, glInfo);
    return;
  }

  // ============ castle-composition ==================================================
  const plan = dbg().plan()!;
  check("keep-root", dbg().rootId() === "root:app-server", `root=${dbg().rootId()}`);
  const keepPos = dbg().socketWorld("root:app-server");
  check(
    "keep-at-origin",
    keepPos !== null && Math.abs(keepPos.x) < 0.01 && Math.abs(keepPos.z) < 0.01 && keepPos.y > 0.5,
    JSON.stringify(keepPos),
  );
  const offRing = plan.sockets.filter(
    (s) => s.ring > 0 && Math.abs(Math.hypot(s.x, s.z) - ringRadius(s.ring)) > 0.01,
  );
  check("sockets-on-rings", plan.sockets.length >= 5 && offRing.length === 0, `sockets=${plan.sockets.length} off=${offRing.length}`);
  const expectForms: [string, string][] = [
    ["root:app-web", "manor"],
    ["db:database", "ore-mine"],
    ["etl:pipeline", "enginehouse"],
    ["tests:tests", "training-yard"],
    ["root:app-server", "keep"],
  ];
  check(
    "forms-lawful",
    expectForms.every(([id, form]) => dbg().formOf(id) === form),
    expectForms.map(([id]) => `${id}=${dbg().formOf(id)}`).join(" "),
  );
  // the plan law yields exactly 8 towers at WALL_RADIUS; strict floor is 8
  check("wall-towers", dbg().towers() >= 8, `towers=${dbg().towers()} segments=${dbg().wallSegments()}`);
  check("gate-arch", dbg().gatePresent(), `gaps=${dbg().wallGaps()}`);
  check("draw-call-budget", dbg().drawCalls() <= 300, `calls=${dbg().drawCalls()}`);
  check("no-console-errors", consoleErrors === 0, `errors=${consoleErrors}`);

  // the court arrives (agents ride the same event stream as production)
  ev({ type: "agent_spawned", agentId: "king", role: "orchestrator", name: "Aldwin the Grey", model: "m" });
  ev({ type: "agent_spawned", agentId: "w1", role: "worker", name: "Ashka the Mason", model: "m" });
  ev({ type: "agent_spawned", agentId: "w2", role: "worker", name: "Veyra of the Vale", model: "m" });
  await sleep(300);
  check("agents-spawned", dbg().agents().size === 3, `agents=${dbg().agents().size}`);

  // ============ isomorphism-repaint ================================================
  stage("repaint");
  check("manor-measured-tint", dbg().tintOf("root:app-web").roof === "#e86a33", JSON.stringify(dbg().tintOf("root:app-web")));
  ev({
    type: "component_facts",
    path: "styles.css",
    hits: [
      { path: "styles.css", probe: "color", value: "#3aa0ff" },
      { path: "styles.css", probe: "color", value: "#3aa0ff" },
    ],
  });
  const repainted = await until(() => dbg().tintOf("root:app-web").roof === "#3aa0ff", 2000);
  check("repaint-within-2s", repainted, JSON.stringify(dbg().tintOf("root:app-web")));
  check(
    "repaint-examine-line",
    examineLog.some((l) => /the manor of .+ repainted to #3aa0ff \(styles\.css\)/.test(l)),
    examineLog.filter((l) => l.includes("repainted")).join(" | "),
  );

  // ============ growth (construction theater) ======================================
  stage("growth");
  const idsBefore = dbg().ids();
  const posBefore = new Map(idsBefore.map((id) => [id, dbg().socketWorld(id)!]));
  const meshBefore = dbg().meshCount();
  const w1Before = dbg().agents().get("w1")!.unit;
  const w1Start = { x: w1Before.x, z: w1Before.z };
  ev({
    type: "file_write",
    agentId: "w1",
    path: "lib/colors.js",
    created: true,
    linesAdded: 40,
    linesRemoved: 0,
    buildingKind: "house",
  });
  const scaffolded = await until(() => dbg().stateOf("lib:library") === "scaffold", 3000);
  check(
    "growth-scaffold",
    scaffolded && dbg().meshCount() > meshBefore,
    `state=${dbg().stateOf("lib:library")} mesh ${meshBefore}→${dbg().meshCount()}`,
  );
  const swapped = await until(() => dbg().stateOf("lib:library") === "built", 9000);
  check("growth-swap", swapped && dbg().formOf("lib:library") === "foundry", `form=${dbg().formOf("lib:library")}`);
  const moved = idsBefore.filter((id) => {
    const a = posBefore.get(id)!;
    const b = dbg().socketWorld(id);
    return !b || Math.hypot(a.x - b.x, a.z - b.z) > 1e-6;
  });
  check("growth-sockets-stable", moved.length === 0, `moved=${moved.join(",")}`);
  const libPos = dbg().socketWorld("lib:library")!;
  const w1Now = dbg().agents().get("w1")!.unit;
  check(
    "growth-builder-walked",
    Math.hypot(w1Now.x - libPos.x, w1Now.z - libPos.z) < Math.hypot(w1Start.x - libPos.x, w1Start.z - libPos.z),
    `d0=${Math.hypot(w1Start.x - libPos.x, w1Start.z - libPos.z).toFixed(1)} d1=${Math.hypot(w1Now.x - libPos.x, w1Now.z - libPos.z).toFixed(1)}`,
  );

  // ============ rails-run ==========================================================
  stage("rails");
  check("rails-built", dbg().railCount() >= 1 && dbg().cartCount() >= 1, `rails=${dbg().railCount()} carts=${dbg().cartCount()}`);
  const carts0 = dbg().cartPositions();
  await sleep(1000);
  const carts1 = dbg().cartPositions();
  const anyMoved = carts0.some((c, i) => carts1[i] && Math.hypot(c.x - carts1[i]!.x, c.z - carts1[i]!.z) > 0.4);
  check(
    "rails-carts-move",
    carts0.length >= 1 && anyMoved,
    `${JSON.stringify(carts0)} → ${JSON.stringify(carts1)}`,
  );

  // ============ repr-swap ==========================================================
  stage("repr");
  const CITED = "colors.js is a shared spring the whole bakery drinks from";
  ev({ type: "castle_repr", componentId: "lib:library", form: "well", cited: CITED });
  const reprOk = await until(() => dbg().formOf("lib:library") === "well", 3000);
  check("repr-swap", reprOk, `form=${dbg().formOf("lib:library")}`);
  await clickConstruction("lib:library", () => dbg().inspectorOpen() !== null);
  check(
    "repr-inspector-cited",
    dbg().inspectorOpen() === dbg().labelOf("lib:library") && dbg().inspectorText().includes(CITED),
    `open=${dbg().inspectorOpen()} citedShown=${dbg().inspectorText().includes(CITED)}`,
  );
  // click empty ground dismisses
  {
    const pt = dbg().projectWorld(24, dbg().groundHeightAt(24, 24), 24);
    firePointer("pointermove", pt.x, pt.y);
    await sleep(120);
    firePointer("pointerdown", pt.x, pt.y, 0, 1);
    firePointer("pointerup", pt.x, pt.y, 0, 0);
    await sleep(250);
    check("inspector-dismiss", dbg().inspectorOpen() === null, `open=${dbg().inspectorOpen()}`);
  }

  // ============ razing =============================================================
  stage("razing");
  ev({
    type: "file_write",
    agentId: "w2",
    path: "cache/store.js",
    created: true,
    linesAdded: 60,
    linesRemoved: 0,
    buildingKind: "house",
  });
  await until(() => dbg().stateOf("cache:library") === "scaffold", 3000);
  // measured tables arrive: the library was an ore mine all along
  ev({
    type: "component_facts",
    path: "cache/store.js",
    hits: [
      { path: "cache/store.js", probe: "table", value: "entries" },
      { path: "cache/store.js", probe: "table", value: "evictions" },
    ],
  });
  const mineUp = await until(() => dbg().stateOf("cache:database") === "built", 10000);
  check("razing-mine-built", mineUp && dbg().formOf("cache:database") === "ore-mine", `form=${dbg().formOf("cache:database")} state=${dbg().stateOf("cache:database")}`);
  // the tables vanish: the db component is removed → rubble replaces the mine
  ev({ type: "component_facts", path: "cache/store.js", hits: [] });
  const rubble = await until(() => dbg().stateOf("cache:database") === "rubble", 4000);
  check("razing-rubble", rubble, `state=${dbg().stateOf("cache:database")}`);
  check(
    "razing-examine-line",
    examineLog.some((l) => l.includes("razed to rubble")),
    examineLog.filter((l) => l.includes("razed")).join(" | "),
  );

  // ============ orbit + inspect ====================================================
  stage("orbit");
  const az0 = dbg().azimuth();
  firePointer("pointerdown", 500, 300, 0, 1);
  for (let i = 1; i <= 5; i++) firePointer("pointermove", 500 + i * 22, 300 + i * 4, 0, 1);
  firePointer("pointerup", 610, 320, 0, 0);
  const orbited = await until(() => Math.abs(dbg().azimuth() - az0) > 0.05, 3000);
  check("orbit-azimuth", orbited, `az ${az0.toFixed(3)}→${dbg().azimuth().toFixed(3)}`);
  await sleep(400);
  const examinesBefore = examineLog.length;
  await clickConstruction("root:app-server", () => dbg().inspectorOpen() !== null);
  check(
    "inspect-keep",
    dbg().inspectorOpen() === dbg().labelOf("root:app-server"),
    `open=${dbg().inspectorOpen()} label=${dbg().labelOf("root:app-server")}`,
  );
  check("inspect-examine-line", examineLog.length > examinesBefore, `examines=${examineLog.length}`);

  // ============ genome redress ======================================================
  stage("genome");
  const sigBefore = dbg().constructionSig("root:app-web");
  ev({
    type: "castle_repr",
    componentId: "root:app-web",
    form: "manor",
    cited: "an onion-domed obsidian manor for a storefront that trades at dusk",
    genome: { roof: { form: "onion" }, material: { family: "obsidian" } },
  });
  const gVec = await until(() => {
    const g = dbg().genomeOf("root:app-web");
    return g?.roof.form === "onion" && g?.material.family === "obsidian";
  }, 3000);
  check("genome-redress-vector", gVec, JSON.stringify(dbg().genomeOf("root:app-web")));
  const gRebuilt = await until(() => {
    const s = dbg().constructionSig("root:app-web");
    return s !== null && s !== sigBefore;
  }, 4000);
  check("genome-redress-rebuilt", gRebuilt, `${sigBefore} → ${dbg().constructionSig("root:app-web")}`);
  // the measured tint law survives any redress: the roofcap still wears the hex
  const tintHeld = await until(() => dbg().tintOf("root:app-web").roof === "#3aa0ff", 3000);
  check("genome-redress-tint-law", tintHeld, JSON.stringify(dbg().tintOf("root:app-web")));
  await clickConstruction("root:app-web", () => dbg().inspectorOpen() === dbg().labelOf("root:app-web"));
  check(
    "genome-inspector-design",
    dbg().inspectorText().includes("onion roof") && dbg().inspectorText().includes("obsidian"),
    `open=${dbg().inspectorOpen()}`,
  );

  // ============ style decree ========================================================
  stage("style");
  const groundBefore = dbg().groundStyle().hex;
  const dbSigBefore = dbg().constructionSig("db:database");
  ev({
    type: "castle_style",
    style: {
      name: "Obsidian Dusk",
      cited: "the code is compiled at night, so the castle wears the dark",
      materialBias: ["obsidian"],
      roofBias: ["onion"],
      trimBias: ["glowseams"],
      natureSet: "crystal",
      wallStyle: "obsidian",
      groundTone: "scorch",
      fog: "thin",
    },
  });
  const styled = await until(() => dbg().styleOf()?.name === "Obsidian Dusk", 3000);
  check("style-decree-name", styled, JSON.stringify(dbg().styleOf()?.name ?? null));
  const groundRestyled = await until(() => dbg().groundStyle().hex !== groundBefore, 3000);
  check(
    "style-grounds-restyled",
    groundRestyled && dbg().groundStyle().tone === "scorch",
    `${groundBefore} → ${dbg().groundStyle().hex} tone=${dbg().groundStyle().tone} nature=${dbg().groundStyle().nature}`,
  );
  const wallSwapped = await until(() => dbg().wallStyleName() === "obsidian", 3000);
  check("style-wall-swapped", wallSwapped, `wall=${dbg().wallStyleName()}`);
  // an unchosen construction re-derives under the bias and rebuilds
  const dbRestyled = await until(
    () => dbg().genomeOf("db:database")?.material.family === "obsidian" && dbg().constructionSig("db:database") !== dbSigBefore,
    5000,
  );
  check(
    "style-unchosen-rebuilt",
    dbRestyled,
    `family=${dbg().genomeOf("db:database")?.material.family} sig ${dbSigBefore} → ${dbg().constructionSig("db:database")}`,
  );

  // ============ signed works ========================================================
  stage("signed");
  const hashUnsigned = dbg().hash();
  const mineSig0 = dbg().constructionSig("db:database");
  ev({
    type: "castle_flourish",
    agentId: "w1",
    author: "Ashka the Unsleeping",
    path: "db/schema.sql",
    mark: "forgefire",
    cited: "hammered the schema true through the night",
  });
  const signedUp = await until(() => dbg().flourishesOf("db:database").length === 1, 3000);
  check(
    "flourish-signed",
    signedUp &&
      dbg().flourishesOf("db:database")[0]?.mark === "forgefire" &&
      dbg().flourishesOf("db:database")[0]?.author === "Ashka the Unsleeping",
    JSON.stringify(dbg().flourishesOf("db:database")),
  );
  check("flourish-hash-moved", dbg().hash() !== hashUnsigned && dbg().hash().length === 8, `${hashUnsigned} → ${dbg().hash()}`);
  const flMeshed = await until(() => {
    const s = dbg().constructionSig("db:database");
    return s !== null && s !== mineSig0;
  }, 4000);
  check("flourish-mesh-rebuilt", flMeshed, `${mineSig0} → ${dbg().constructionSig("db:database")}`);
  const hashSigned = dbg().hash();
  // an unlawful mark (outside the closed vocabulary) is lawful silence
  ev({
    type: "castle_flourish",
    agentId: "w2",
    author: "Borin Halfbeard",
    path: "db/schema.sql",
    mark: "graffiti",
    cited: "scrawled his name on the shaft wall",
  });
  await sleep(500);
  check(
    "flourish-unlawful-mark-refused",
    dbg().flourishesOf("db:database").length === 1 && dbg().hash() === hashSigned,
    `n=${dbg().flourishesOf("db:database").length} hash=${dbg().hash()}`,
  );
  // a path that resolves to no construction is refused silently
  ev({
    type: "castle_flourish",
    agentId: "w2",
    author: "Borin Halfbeard",
    path: "nowhere/void.js",
    mark: "lantern",
    cited: "lit a lamp in the void",
  });
  await sleep(500);
  check(
    "flourish-unknown-path-refused",
    dbg().hash() === hashSigned && consoleErrors === 0,
    `hash=${dbg().hash()} errors=${consoleErrors}`,
  );
  // a second author signs the same construction: both marks stand
  const sigOne = dbg().constructionSig("db:database");
  ev({
    type: "castle_flourish",
    agentId: "w2",
    author: "Veyra of the Vale",
    path: "db/schema.sql",
    mark: "pennant",
    cited: "raised the sync pennant over the shafts",
  });
  const secondSigned = await until(() => dbg().flourishesOf("db:database").length === 2, 3000);
  const sigTwo = dbg().constructionSig("db:database");
  check(
    "flourish-second-author",
    secondSigned && dbg().flourishesOf("db:database").some((fl) => fl.mark === "pennant") && sigTwo !== null && sigTwo !== sigOne,
    `marks=${JSON.stringify(dbg().flourishesOf("db:database").map((fl) => fl.mark))} sig ${sigOne} → ${sigTwo}`,
  );
  // identical re-sign is silence: hash and geometry stable across the re-feed
  const hashTwo = dbg().hash();
  ev({
    type: "castle_flourish",
    agentId: "w1",
    author: "Ashka the Unsleeping",
    path: "db/schema.sql",
    mark: "forgefire",
    cited: "hammered the schema true through the night",
  });
  await sleep(500);
  check(
    "flourish-refeed-stable",
    dbg().hash() === hashTwo && dbg().constructionSig("db:database") === sigTwo,
    `hash=${dbg().hash()} sig=${dbg().constructionSig("db:database")}`,
  );
  await clickConstruction("db:database", () => dbg().inspectorOpen() === dbg().labelOf("db:database"));
  check(
    "flourish-inspector-signed",
    dbg().inspectorText().includes("forgefire — Ashka the Unsleeping") &&
      dbg().inspectorText().includes("pennant — Veyra of the Vale"),
    `open=${dbg().inspectorOpen()}`,
  );
  // dismiss so later stages start clean
  {
    const pt = dbg().projectWorld(24, dbg().groundHeightAt(24, 24), 24);
    firePointer("pointermove", pt.x, pt.y);
    await sleep(120);
    firePointer("pointerdown", pt.x, pt.y, 0, 1);
    firePointer("pointerup", pt.x, pt.y, 0, 0);
    await sleep(250);
  }

  // ============ determinism =========================================================
  stage("determinism");
  const stA = new CastleState();
  const planA = stA.found(BAKERY, SEED, BAKERY_DEPS, BAKERY_PROBES);
  const stB = new CastleState();
  const planB = stB.found(BAKERY, SEED, BAKERY_DEPS, BAKERY_PROBES);
  check("determinism-plan-hash", planA.hash === planB.hash && planA.hash.length === 8, `${planA.hash} vs ${planB.hash}`);
  const sampleIds = ["root:app-web", "db:database", "tests:tests"];
  const sigPairs = sampleIds.map((id) => {
    const sa = planA.sockets.find((s) => s.componentId === id);
    const sb = planB.sockets.find((s) => s.componentId === id);
    if (!sa || !sb) return ["missing", "missing?"] as const;
    const mk = (s: Socket, seed: number) =>
      dbg().compileSig({ componentId: id, form: s.form, traits: s.traits, genome: s.genome, seed });
    return [mk(sa, planA.seed), mk(sb, planB.seed)] as const;
  });
  check(
    "determinism-construction-sig",
    sigPairs.every(([a, b]) => a === b && a !== "missing"),
    sigPairs.map(([a, b]) => `${a}${a === b ? "" : "≠" + b}`).join(" "),
  );

  // ============ axis coverage =======================================================
  stage("axes");
  const AXIS_FORMS: CastleForm[] = [
    "keep", "manor", "gatehouse", "ore-mine", "enginehouse",
    "smithy", "foundry", "training-yard", "library-tower", "signal-tower",
  ];
  let axisOk = true;
  let axisDetail = "";
  for (let i = 0; i < 10; i++) {
    const genome: BuildingGenome = {
      footprint: FOOTPRINTS[i % FOOTPRINTS.length]!,
      storeys: 1 + (i % 6),
      bays: 1 + (i % 5),
      taper: TAPERS[i % TAPERS.length]!,
      roof: {
        form: ROOF_FORMS[i]!,
        pitch: ROOF_PITCHES[i % ROOF_PITCHES.length]!,
        overhang: ROOF_OVERHANGS[i % ROOF_OVERHANGS.length]!,
        cap: ROOF_CAPS[i % ROOF_CAPS.length]!,
      },
      material: { family: MATERIAL_FAMILIES[i]!, trim: TRIMS[i % TRIMS.length]! },
      openings: { windows: WINDOW_STYLES[i % WINDOW_STYLES.length]!, door: DOOR_STYLES[i % DOOR_STYLES.length]! },
      ornament: { crenellated: i % 2 === 0, buttresses: i % 5, banners: i % 5, glow: i % 2 === 1, smoke: i % 3 === 0 },
      dressing: { propSet: PROP_SETS[i]!, density: i % 4 },
    };
    const traits: Traits = {
      size: ((i % 4) + 1) as Traits["size"],
      tint: i % 2 === 0 ? "#aa3344" : null,
      banner: "#2255aa",
      gates: 2,
      shafts: 2,
      banners: 2,
      storeys: 1 + (i % 5),
    };
    try {
      const sig = dbg().compileSig({ componentId: `axis-${i}`, form: AXIS_FORMS[i]!, traits, genome, seed: SEED });
      const [meshes, verts] = sig.split(":").map(Number);
      if (!(meshes! > 0 && verts! > 0)) {
        axisOk = false;
        axisDetail += ` i=${i} empty(${sig})`;
      }
    } catch (err) {
      axisOk = false;
      axisDetail += ` i=${i} threw(${String(err)})`;
    }
  }
  check("axis-coverage", axisOk, axisDetail || "10 roofs × 8 footprints × 10 families compiled non-empty");

  // ============ closing gates ======================================================
  check("draw-call-budget-final", dbg().drawCalls() <= 300, `calls=${dbg().drawCalls()}`);
  check("no-console-errors-final", consoleErrors === 0, `errors=${consoleErrors}`);
  console.info(`[smoke3d] fps=${dbg().fps().toFixed(1)} degraded=${dbg().degraded()} gl=${glInfo}`);

  finish();
})().catch((err) => {
  console.error("[smoke3d] harness error", err);
  console.info(`[smoke3d] SUMMARY pass=${results.filter((x) => x.pass).length} fail=${results.length - results.filter((x) => x.pass).length + 1}`);
});

// --- BIG: 20 components, founding time, budget, fps --------------------------------

async function runBig(software: boolean, glInfo: string): Promise<void> {
  check("big-founding-under-8s", dbg().foundMs() <= 8000, `foundMs=${dbg().foundMs()}`);
  check("big-20-components", dbg().componentCount() === 20, `components=${dbg().componentCount()}`);
  const plan = dbg().plan()!;
  const offRing = plan.sockets.filter(
    (s) => s.ring > 0 && Math.abs(Math.hypot(s.x, s.z) - ringRadius(s.ring)) > 0.01,
  );
  check("big-sockets-on-rings", offRing.length === 0, `off=${offRing.length}`);
  check("big-keep-root", dbg().rootId() === "api:app-server", `root=${dbg().rootId()}`);
  check("big-rails", dbg().railCount() >= 3 && dbg().cartCount() >= 3, `rails=${dbg().railCount()} carts=${dbg().cartCount()}`);
  check("big-wall-gaps", dbg().wallGaps() >= 1, `gaps=${dbg().wallGaps()}`);
  check("big-draw-call-budget", dbg().drawCalls() <= 300, `calls=${dbg().drawCalls()}`);

  // a working population over the full castle
  for (let i = 0; i < 12; i++) {
    ev({
      type: "agent_spawned",
      agentId: `w${i}`,
      role: i === 0 ? "orchestrator" : "worker",
      name: `Worker ${i}`,
      model: "m",
    });
  }
  const dirs = ["web", "api", "db", "orders", "models", "etl", "jobs", "stream", "bin", "lib1", "lib2"];
  for (let i = 1; i < 12; i++) {
    const d = dirs[i % dirs.length]!;
    ev({ type: "agent_moved", agentId: `w${i}`, path: `${d}/x.js` });
    ev({ type: "agent_status", agentId: `w${i}`, status: "building" });
  }

  const carts0 = dbg().cartPositions();
  await sleep(3000);
  const carts1 = dbg().cartPositions();
  const movedCount = carts0.filter(
    (c, i) => carts1[i] && Math.hypot(c.x - carts1[i]!.x, c.z - carts1[i]!.z) > 0.4,
  ).length;
  check("big-carts-move", movedCount >= 2, `moved=${movedCount}/${carts0.length}`);

  await sleep(2000);
  const fps = dbg().fps();
  console.info(
    `[smoke3d] BIG fps=${fps.toFixed(1)} degraded=${dbg().degraded()} draw-calls=${dbg().drawCalls()} gl=${glInfo}`,
  );
  // ≥25 is the SwiftShader floor; hardware GL must clear 50
  check("big-fps", fps >= (software ? 25 : 50), `fps=${fps.toFixed(1)} software=${software}`);
  check("big-no-console-errors", consoleErrors === 0, `errors=${consoleErrors}`);
  finish();
}

function finish(): void {
  const pass = results.filter((x) => x.pass).length;
  console.info(`[smoke3d] SUMMARY pass=${pass} fail=${results.length - pass}`);
  stage("done");
}
