/* Headless smoke harness for the 3D renderer (not shipped; dev-server only).
 * Drives the SAME synthetic match fixture + seed as the 2D smoke page so the
 * layout hash must come out identical. Logs "[smoke3d] CHECK <name> PASS|FAIL"
 * lines plus stage markers for the external screenshot/console driver. */
import type { FileNode, GameEvent } from "@agent-empires/protocol";
import { attachGameRenderer } from "../src/game3d/renderer.js";

type FN = FileNode & { lines?: number };
const file = (path: string, lines?: number): FN =>
  ({ kind: "file", name: path.split("/").pop()!, path, ...(lines ? { lines } : {}) }) as FN;
const dir = (path: string, children: FN[]): FN =>
  ({ kind: "dir", name: path.split("/").pop() || ".", path, children }) as FN;

// EXACT copy of the 2D smoke fixture (src/smoke-main.ts) — do not edit.
const TREE: FN = dir(".", [
  file("package.json", 40),
  file("README.md", 120),
  dir("src", [
    file("src/index.ts", 60),
    file("src/util.ts", 250),
    dir("src/core", [
      file("src/core/engine.ts", 1400),
      file("src/core/state.ts", 500),
      dir("src/core/parser", [
        file("src/core/parser/lexer.ts", 900),
        file("src/core/parser/ast.ts", 450),
        file("src/core/parser/expr.ts", 120),
        file("src/core/parser/stmt.ts", 60),
      ]),
    ]),
    dir("src/render", [
      file("src/render/canvas.ts", 700),
      file("src/render/svg.ts", 300),
      file("src/render/colors.ts", 90),
    ]),
  ]),
  dir("tests", [
    file("tests/parser.test.ts", 320),
    file("tests/engine.test.ts", 210),
  ]),
  dir("docs", [file("docs/guide.md", 80), file("docs/api.md", 45)]),
]);
const SEED = 12345;

/** ?big=1 → ~1600-file synthetic packages/ monorepo (1200 plots + hamlets)
 * + 40 units — the archipelago + bridges must render under load. */
const BIG = new URLSearchParams(location.search).has("big");
function bigTree(): FN {
  const pkgs: FN[] = [];
  for (let d = 0; d < 40; d++) {
    const dn = `packages/p${String(d).padStart(2, "0")}`;
    const files: FN[] = [];
    for (let f = 0; f < 40; f++) {
      files.push(file(`${dn}/f${String(f).padStart(2, "0")}.ts`, ((d * 37 + f * 13) % 600) + 20));
    }
    pkgs.push(dir(dn, files));
  }
  return dir(".", [file("package.json", 40), file("README.md", 120), dir("packages", pkgs)]);
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

/** One world-unit of terrain level in world Y (mirrors game3d/terrain3d.ELEV). */
const ELEV = 0.35;

type Debug = {
  worldReady(): boolean;
  layoutHash(): string;
  map(): {
    plots: Map<string, { tx: number; ty: number }>;
    quarters: { path: string; rect: { x: number; y: number; w: number; h: number } }[];
    hamlets: { count: number }[];
    water: Set<string>;
    bridges: Set<string>;
    roads: Set<string>;
    streets: Set<string>;
    cityRect: { x: number; y: number; w: number; h: number };
    townCenter: { tx: number; ty: number };
  } | null;
  dna(): {
    form: string;
    ground: unknown;
    fortification: number;
    landmark: { kind: string; subject: string; line: string };
    loreNotes: { subject: string; line: string }[];
  } | null;
  heightAt(tx: number, ty: number): number;
  streetTiles(): number;
  structureAt(path: string): { kind: string; model: string } | null;
  landmark(): { kind: string; tx: number; ty: number } | null;
  composition(): string | null;
  waterTilesRendered(): number;
  bridgesRendered(): number;
  decorStats(): { wallSegments: number; props: number; trees: number; rocks: number };
  buildings(): Map<string, unknown>;
  instanceCount(): number;
  drawCalls(): number;
  fps(): number;
  degraded(): boolean;
  fogAlphaAt(tx: number, ty: number): number;
  shroud(): { surveyed: string[]; unsurveyed: number };
  survey(path: string): boolean;
  hiddenPlotCount(): number;
  plotScale(path: string): number;
  fxActive(): number;
  menuEntries(): string[];
  projectWorld(x: number, y: number, z: number): { x: number; y: number };
  agents(): Map<string, { unit: { x: number; y: number; z: number } }>;
};

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
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

const cbLog: string[] = [];
const r = attachGameRenderer(document.getElementById("app")!);
r.setOrderHandler?.((kind, target, agentId) => {
  cbLog.push(`order:${kind}:${target}`);
  console.info(`[cb] order ${kind} → ${target} (by ${agentId ?? "?"})`);
});
r.setSpeakHandler?.((agentId) => {
  cbLog.push(`speak:${agentId}`);
  console.info(`[cb] speak → ${agentId}`);
});
r.setInspectHandler?.((path) => {
  cbLog.push(`inspect:${path}`);
  console.info(`[cb] inspect → ${path}`);
});
r.setExamineHandler?.((text) => {
  cbLog.push(`examine:${text}`);
  console.info(`[cb] examine → ${text}`);
});
r.setExamineProvider?.(() => undefined);

const ev = (e: Record<string, unknown>) => r.handleEvent({ seq: 0, ts: Date.now(), ...e } as unknown as GameEvent, false);

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

(async () => {
  ev({
    type: "match_started",
    matchId: "smoke3d",
    task: { id: "smoke", title: "Smoke", description: "smoke", flavor: "smoke" },
    mapSeed: SEED,
    repoTree: BIG ? bigTree() : TREE,
  });

  const dbg = () => (globalThis as Record<string, unknown>).__ae3d as Debug;
  const ready = await until(() => Boolean(dbg()?.worldReady()), 20000);
  check("world-ready", ready);
  if (!ready) {
    console.info("[smoke3d] SUMMARY pass=0 fail=1 (world never built)");
    return;
  }
  await sleep(600);
  stage("first-paint");
  const glInfo = glRendererString();
  const software = /swiftshader|llvmpipe|software/i.test(glInfo);
  console.info(`[smoke3d] gl-renderer=${glInfo}`);

  // 1. layout hash logged + exposed
  const hash = dbg().layoutHash();
  check("layout-hash", /^[0-9a-f]{8}$/.test(hash), `hash=${hash}`);
  console.info(`[smoke3d] layout-hash=${hash}`);

  // 2. building instances == plot count (Citadel excluded), hamlets honest
  const map = dbg().map()!;
  const plotCount = map.plots.size;
  const instances = dbg().instanceCount() - 1; // minus the Citadel record
  check("instance-count", instances === plotCount, `plots=${plotCount} instances=${instances}`);
  const totalFiles = BIG ? 1602 : 17;
  const hamletFiles = map.hamlets.reduce((s, h) => s + h.count, 0);
  check("file-coverage", plotCount + hamletFiles === totalFiles, `plots=${plotCount} hamlets=${hamletFiles}`);
  console.info(`[smoke3d] draw-calls=${dbg().drawCalls()}`);

  // world DNA computed + exposed; water/bridge render counts match the layout
  const dna = dbg().dna();
  check(
    "dna-computed",
    dna !== null && typeof dna.form === "string" && dna.ground !== undefined && dna.loreNotes.length > 0,
    `form=${dna?.form} fort=${dna?.fortification} lore=${dna?.loreNotes.length}`,
  );
  check(
    "water-render",
    map.water.size > 0 && dbg().waterTilesRendered() === map.water.size,
    `water=${map.water.size} rendered=${dbg().waterTilesRendered()}`,
  );
  check(
    "bridges-render",
    dbg().bridgesRendered() === map.bridges.size && (!BIG || map.bridges.size > 0),
    `bridges=${map.bridges.size} rendered=${dbg().bridgesRendered()} big=${BIG}`,
  );
  const decor = dbg().decorStats();
  console.info(
    `[smoke3d] decor walls=${decor.wallSegments} props=${decor.props} trees=${decor.trees} rocks=${decor.rocks}`,
  );

  // --- Worlds Apart: composition, streets, the Crown landmark -------------------
  const composition = dbg().composition();
  check(
    "composition-exposed",
    typeof composition === "string" && composition.length > 0 && (!BIG || composition === "archipelago"),
    `composition=${composition}`,
  );
  check(
    "streets-render",
    dbg().streetTiles() === map.streets.size,
    `streets=${map.streets.size} rendered=${dbg().streetTiles()}`,
  );
  const lm = dbg().landmark();
  check(
    "landmark-placed",
    lm !== null && lm.kind === dna?.landmark.kind && !map.water.has(`${lm.tx},${lm.ty}`),
    `landmark=${JSON.stringify(lm)} dna=${dna?.landmark.kind}`,
  );
  check(
    "landmark-unshrouded",
    lm !== null && dbg().fogAlphaAt(lm.tx, lm.ty) < 0.05,
    `alpha=${lm ? dbg().fogAlphaAt(lm.tx, lm.ty).toFixed(3) : -1}`,
  );

  // --- the shroud: terra incognita at first frame -------------------------------
  const quarters = map.quarters;
  const sh0 = dbg().shroud();
  check(
    "shroud-initial",
    quarters.length > 0 && sh0.surveyed.length === 0 && sh0.unsurveyed === quarters.length,
    `unsurveyed=${sh0.unsurveyed} quarters=${quarters.length}`,
  );
  const hidden0 = dbg().hiddenPlotCount();
  check("shroud-hidden-plots", hidden0 > 0, `hidden=${hidden0}`);
  const HINT = "⟡ The land lies unsurveyed — click a darkened quarter to chart it.";
  check(
    "survey-hint-once",
    cbLog.filter((c) => c === `examine:${HINT}`).length === 1,
    `hints=${cbLog.filter((c) => c.startsWith("examine:⟡")).length}`,
  );

  if (BIG) {
    // archipelago discovery: islets are charted one at a time, parent first
    const isletQs = quarters
      .filter((q) => q.path.startsWith("packages/"))
      .map((q) => q.path)
      .sort();
    check("shroud-islet-parent", dbg().survey("packages"), "survey packages");
    check("shroud-islet-survey", isletQs.length >= 2 && dbg().survey(isletQs[0]!), `islets=${isletQs.length}`);
    const shBig = dbg().shroud();
    check(
      "shroud-islet-isolation",
      shBig.surveyed.includes(isletQs[0]!) &&
        !shBig.surveyed.includes(isletQs[1]!) &&
        shBig.unsurveyed === quarters.length - 2,
      `surveyed=${shBig.surveyed.length} unsurveyed=${shBig.unsurveyed}`,
    );

    // perf probe: 40 units + raiders over ~1200 instanced buildings
    for (let i = 0; i < 40; i++) {
      ev({
        type: "agent_spawned",
        agentId: `w${i}`,
        role: i === 0 ? "orchestrator" : "worker",
        name: `Worker ${i}`,
        model: "m",
      });
    }
    for (let i = 0; i < 39; i++) {
      ev({ type: "agent_moved", agentId: `w${i + 1}`, path: `packages/p${String(i % 40).padStart(2, "0")}/f0${i % 10}.ts` });
      ev({ type: "agent_status", agentId: `w${i + 1}`, status: "building" });
    }
    ev({
      type: "command_result",
      agentId: "w1",
      command: "npm test",
      kind: "test",
      exitCode: 1,
      summary: "4 failed",
      testsFailed: 4,
      testsPassed: 10,
      failures: [0, 1, 2, 3].map((i) => ({ name: `big failure ${i}`, path: `packages/p0${i}/f00.ts` })),
    });
    await sleep(4000);
    stage("mid");
    await sleep(5000);
    const d2 = dbg() as unknown as { risingCount(): number; fogAnimating(): boolean };
    console.info(`[smoke3d] BIG rising=${d2.risingCount()} fogAnimating=${d2.fogAnimating()}`);
    const fpsBig = dbg().fps();
    console.info(
      `[smoke3d] BIG fps=${fpsBig.toFixed(1)} degraded=${dbg().degraded()} draw-calls=${dbg().drawCalls()} gl=${glInfo}`,
    );
    check("fps-big", fpsBig >= 50 || software, `fps=${fpsBig.toFixed(1)} software=${software}`);
    const pass = results.filter((x) => x.pass).length;
    console.info(`[smoke3d] SUMMARY pass=${pass} fail=${results.length - pass}`);
    stage("done");
    return;
  }

  // --- typology: the skyline is the census (roles → structures → models) --------
  const sTest = dbg().structureAt("tests/parser.test.ts");
  check(
    "typology-watchtower",
    sTest?.kind === "watchtower" && /^tower_/.test(sTest?.model ?? ""),
    JSON.stringify(sTest),
  );
  const sDoc = dbg().structureAt("docs/guide.md");
  check("typology-stela", sDoc?.kind === "stela", JSON.stringify(sDoc));
  const sGiant = dbg().structureAt("src/core/engine.ts");
  check(
    "typology-megastructure",
    sGiant?.kind === "megastructure" && sGiant?.model === "castle",
    JSON.stringify(sGiant),
  );

  // --- click-to-survey: deep veil, hover affordance, ceremony, census line ------
  const srcQ = quarters.find((q) => q.path === "src")!;
  // pick the interior tile farthest from the town center: the citadel + Crown
  // landmark reveals must never have touched it
  let deepTile: [number, number] | null = null;
  let deepD = -1;
  for (let ty = srcQ.rect.y + 1; ty < srcQ.rect.y + srcQ.rect.h - 1; ty++) {
    for (let tx = srcQ.rect.x + 1; tx < srcQ.rect.x + srcQ.rect.w - 1; tx++) {
      if (map.water.has(`${tx},${ty}`)) continue;
      const d = Math.hypot(tx - map.townCenter.tx, ty - map.townCenter.ty);
      if (d > deepD) {
        deepD = d;
        deepTile = [tx, ty];
      }
    }
  }
  check(
    "shroud-deep-veil",
    deepTile !== null && dbg().fogAlphaAt(deepTile[0], deepTile[1]) > 0.7,
    `alpha=${deepTile ? dbg().fogAlphaAt(deepTile[0], deepTile[1]).toFixed(3) : -1}`,
  );
  const qcx = srcQ.rect.x + srcQ.rect.w / 2;
  const qcz = srcQ.rect.y + srcQ.rect.h / 2;
  const qc = dbg().projectWorld(qcx, dbg().heightAt(qcx, qcz) * ELEV + 0.05, qcz);
  firePointer("pointermove", qc.x, qc.y);
  await sleep(300);
  const surveyHover = (document.querySelector('[data-ae3d="action"]') as HTMLElement)?.textContent ?? "";
  check("survey-hover", surveyHover.includes("Survey the quarter"), `text="${surveyHover}"`);
  firePointer("pointerdown", qc.x, qc.y, 0, 1);
  firePointer("pointerup", qc.x, qc.y, 0, 0);
  // the quarter label is the dir name with a trailing slash ("src/")
  const surveyLineOk = await until(() => cbLog.some((c) => c.startsWith("examine:⚑ src/ surveyed:")), 8000);
  check("survey-line", surveyLineOk, cbLog.filter((c) => c.includes("surveyed")).join(" | "));
  const srcPlot = [...map.plots.keys()].find((p) => p.startsWith("src/") && p.split("/").length === 2);
  const risen = await until(
    () => dbg().hiddenPlotCount() < hidden0 && (!srcPlot || dbg().plotScale(srcPlot) > 0),
    4000,
  );
  check(
    "survey-rise",
    risen && dbg().shroud().surveyed.includes("src"),
    `plot=${srcPlot} scale=${srcPlot ? dbg().plotScale(srcPlot) : -1} hidden=${dbg().hiddenPlotCount()}`,
  );
  // agent activity charts quarters for everyone through the normal event path
  ev({ type: "file_read", agentId: "scout", path: "docs/guide.md", lines: 80 });
  const autoRevealOk = await until(() => dbg().shroud().surveyed.includes("docs"), 4000);
  check("shroud-autoreveal", autoRevealOk, `surveyed=${dbg().shroud().surveyed.join(",")}`);

  await sleep(2000);

  // --- mid-match events ------------------------------------------------------
  ev({ type: "agent_spawned", agentId: "king", role: "orchestrator", name: "Aldwin the Grey", model: "m", charge: "Mend the broken parser." });
  ev({ type: "agent_spawned", agentId: "w1", role: "worker", name: "Ashka the Mason", model: "m", charge: "Rebuild the lexer." });
  ev({ type: "agent_spawned", agentId: "w2", role: "worker", name: "Veyra of the Vale", model: "m" });
  await sleep(400);
  ev({ type: "agent_status", agentId: "w1", status: "scouting", detail: "reads src/core/parser" });
  ev({ type: "agent_moved", agentId: "w1", path: "src/core/parser/lexer.ts" });
  ev({ type: "agent_status", agentId: "w2", status: "building" });
  ev({ type: "agent_moved", agentId: "w2", path: "src/render/canvas.ts" });
  ev({ type: "file_read", agentId: "w1", path: "src/core/parser/ast.ts", lines: 450 });
  ev({ type: "file_write", agentId: "w1", path: "src/core/parser/lexer.ts", created: false, linesAdded: 42, linesRemoved: 7, buildingKind: "house" });
  ev({ type: "file_write", agentId: "w2", path: "src/newfile.ts", created: true, linesAdded: 15, linesRemoved: 0, buildingKind: "house" });
  // a config file born mid-match must rise as a silo (grain), by typology law
  ev({ type: "file_write", agentId: "w2", path: "src/theme.yaml", created: true, linesAdded: 12, linesRemoved: 0, buildingKind: "house" });
  ev({ type: "message", fromId: "king", text: "To the walls! The parser must stand.", herald: "h" });
  ev({
    type: "command_result",
    agentId: "w1",
    command: "npm test",
    kind: "test",
    exitCode: 1,
    summary: "2 failed",
    testsFailed: 2,
    testsPassed: 10,
    failures: [
      { name: "parses nested exprs", path: "tests/parser.test.ts" },
      { name: "engine boots", path: "tests/engine.test.ts" },
    ],
  });
  ev({ type: "scroll", scrollId: "s1", authorId: "w1", authorName: "Ashka", title: "Report", format: "markdown", content: "# hi" });
  ev({ type: "tokens", agentId: "w1", inputTokens: 1000, outputTokens: 200, matchTotalTokens: 1200 });
  await sleep(1200);
  stage("mid");

  // fog revealed at the lexer plot (poll: the veil fades smoothly, and a
  // software rasterizer may only manage a few frames per second)
  const lexer = map.plots.get("src/core/parser/lexer.ts")!;
  const fogOk = await until(() => dbg().fogAlphaAt(lexer.tx, lexer.ty) < 0.05, 6000);
  check("fog-reveal", fogOk, `alpha=${dbg().fogAlphaAt(lexer.tx, lexer.ty).toFixed(3)}`);
  const raiders = (dbg() as unknown as { raiders(): Map<string, unknown> }).raiders();
  check("raiders-spawned", raiders.size === 2, `raiders=${raiders.size}`);
  const sSilo = dbg().structureAt("src/theme.yaml");
  check("typology-silo", sSilo?.kind === "silo" && sSilo?.model === "grain", JSON.stringify(sSilo));

  await sleep(1400);

  // --- theme + district patch --------------------------------------------------
  ev({
    type: "theme_ready",
    theme: {
      factionName: "The Lexicant Order",
      tagline: "t",
      kingName: "Aldwin",
      enemyName: "gremlins",
      biome: {
        grassColors: ["#3f5a33", "#54744a"],
        fogColor: "#0a0805",
        accentColor: "#d8963c",
        archetype: "dune-monolith",
      },
      heraldOpeners: ["a", "b"],
      heraldClosers: ["a", "b"],
      personas: [
        { name: "A", title: "t", quirk: "q" },
        { name: "B", title: "t", quirk: "q" },
        { name: "C", title: "t", quirk: "q" },
      ],
      sprites: [],
    },
  });
  ev({
    type: "theme_patch",
    patch: {
      version: 1,
      district: "src/core",
      name: "The Enginarium",
      epithet: "where the state machines dream",
      groundTint: "#7a5a2c",
      accent: "#e8b25a",
      landmarks: [
        {
          name: "The First Compiler",
          lore: "It still hums on cold nights.",
          silhouette: [{ shape: "obelisk", w: 10, h: 40, color: "#8a7a5a", tilt: 0 }],
          glow: { color: "#ffcf6a", pulseSec: 4 },
        },
      ],
      questHooks: [
        {
          label: "the TODO of lexer.ts",
          path: "src/core/parser/lexer.ts",
          snippet: "TODO: handle unicode",
        },
      ],
      props: [
        {
          silhouette: [{ shape: "shard", w: 6, h: 12, color: "#9a8a6a", tilt: 5 }],
          density: 0.8,
          placement: "scatter",
        },
      ],
    },
  });
  await sleep(1600);
  stage("theme");
  await sleep(1400);

  // --- hover action text --------------------------------------------------------
  // aim inside the building volume: terrain level + plinth clearance
  const lexPt = dbg().projectWorld(lexer.tx, dbg().heightAt(lexer.tx, lexer.ty) * ELEV + 0.7, lexer.ty);
  firePointer("pointermove", lexPt.x, lexPt.y);
  await sleep(300);
  const actionEl = document.querySelector('[data-ae3d="action"]') as HTMLElement;
  const hoverText = actionEl?.textContent ?? "";
  check("hover-action", hoverText.includes("Attend house of lexer.ts"), `text="${hoverText}"`);

  // --- context menu on right-click ----------------------------------------------
  firePointer("pointerdown", lexPt.x, lexPt.y, 2, 2);
  firePointer("pointerup", lexPt.x, lexPt.y, 2, 0);
  await sleep(250);
  const entries = dbg().menuEntries();
  check(
    "menu-entries",
    entries[0] === "Attend house of lexer.ts" &&
      entries[1] === "Examine" &&
      entries[2] === "Walk here" &&
      entries[entries.length - 1] === "Cancel",
    JSON.stringify(entries),
  );
  stage("menu");
  await sleep(1800);

  // click the Attend row → order callback
  const row0 = document.querySelector('[data-ae3d-row="0"]') as HTMLElement;
  row0?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  await sleep(250);
  check("order-callback", cbLog.includes("order:attend:src/core/parser/lexer.ts"), cbLog.join(" | "));

  // Talk-to on a unit → speak callback (left-click = first entry). Units
  // wander; wait for w1 to settle near its site, then retry the click while
  // it keeps strolling (same assertion, hardened aim).
  await until(() => {
    const u = dbg().agents().get("w1")!.unit;
    return Math.hypot(u.x - lexer.tx, u.z - lexer.ty) < 3;
  }, 15000);
  for (let attempt = 0; attempt < 5 && !cbLog.some((c) => c === "speak:w1"); attempt++) {
    const w1 = dbg().agents().get("w1")!;
    const uPt = dbg().projectWorld(w1.unit.x, w1.unit.y + 0.35, w1.unit.z);
    firePointer("pointermove", uPt.x, uPt.y);
    await sleep(80);
    firePointer("pointerdown", uPt.x, uPt.y, 0, 1);
    firePointer("pointerup", uPt.x, uPt.y, 0, 0);
    await sleep(250);
  }
  check("speak-callback", cbLog.some((c) => c === "speak:w1"), cbLog.filter((c) => c.startsWith("speak")).join(","));

  // Examine via menu → examine callback + toast
  firePointer("pointerdown", lexPt.x, lexPt.y, 2, 2);
  firePointer("pointerup", lexPt.x, lexPt.y, 2, 0);
  await sleep(200);
  const rows = [...document.querySelectorAll("[data-ae3d-row]")] as HTMLElement[];
  const exRow = rows.find((el) => el.textContent === "Examine");
  exRow?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  await sleep(300);
  const toast = document.querySelector('[data-ae3d="examine"]');
  check("examine-callback", cbLog.some((c) => c.startsWith("examine:")) && toast !== null, `toast=${toast !== null}`);

  // Read (inspect) via the quest-hook obelisk planted by the theme_patch
  const hooks = (dbg() as unknown as { hookTiles(): { tx: number; ty: number; path: string }[] }).hookTiles();
  if (hooks.length > 0) {
    const hk = hooks[0]!;
    const hkBase = dbg().heightAt(hk.tx, hk.ty) * ELEV;
    let lastRows = "";
    // the obelisk is a thin pillar amid taller structures now: probe several
    // heights along it until the ray finds a visible sliver
    for (const dy of [1.15, 0.9, 0.6, 1.25, 0.35]) {
      if (cbLog.includes(`inspect:${hk.path}`)) break;
      const hkPt = dbg().projectWorld(hk.tx, hkBase + dy, hk.ty);
      firePointer("pointermove", hkPt.x, hkPt.y);
      await sleep(120);
      firePointer("pointerdown", hkPt.x, hkPt.y, 2, 2);
      firePointer("pointerup", hkPt.x, hkPt.y, 2, 0);
      await sleep(250);
      const hookRows = [...document.querySelectorAll("[data-ae3d-row]")] as HTMLElement[];
      lastRows = hookRows.map((el) => el.textContent).join(",");
      const readRow = hookRows.find((el) => (el.textContent ?? "").startsWith("Read "));
      const cancelRow = hookRows.find((el) => el.textContent === "Cancel");
      (readRow ?? cancelRow)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      await sleep(250);
    }
    check("inspect-callback", cbLog.includes(`inspect:${hk.path}`), `hooks=${hooks.length} rows=${lastRows}`);
  } else {
    check("inspect-callback", false, "no hook obelisk found after theme_patch");
  }

  // --- the Crown landmark: examine surfaces the census line verbatim -------------
  if (lm) {
    const lore = dbg().dna()!.landmark.line;
    const lmBase = dbg().heightAt(lm.tx, lm.ty) * ELEV;
    let lastHover = "";
    for (const dy of [1.4, 0.9, 1.9, 0.5, 0.25]) {
      if (cbLog.includes(`examine:${lore}`)) break;
      const pt = dbg().projectWorld(lm.tx, lmBase + dy, lm.ty);
      firePointer("pointermove", pt.x, pt.y);
      await sleep(150);
      lastHover = (document.querySelector('[data-ae3d="action"]') as HTMLElement)?.textContent ?? "";
      firePointer("pointerdown", pt.x, pt.y, 0, 1);
      firePointer("pointerup", pt.x, pt.y, 0, 0);
      await sleep(300);
    }
    check(
      "landmark-examine",
      cbLog.includes(`examine:${lore}`),
      `lore="${lore}" hover="${lastHover}" at=${lm.tx},${lm.ty}`,
    );
  } else {
    check("landmark-examine", false, "no landmark to click");
  }

  // --- xp drops + level-up --------------------------------------------------------
  r.showXpDrop?.("w1", "Forgecraft", 44, 0xe8873c);
  r.showXpDrop?.("w1", "Lorecraft", 25, 0x3fa7d6);
  r.showLevelUp?.("w1", "Forgecraft", 12);
  await sleep(400);
  check("xp-levelup-visible", dbg().fxActive() > 0, `fxActive=${dbg().fxActive()}`);

  // --- raider clears + victory ----------------------------------------------------
  ev({
    type: "command_result",
    agentId: "w1",
    command: "npm test",
    kind: "test",
    exitCode: 0,
    summary: "12 passed",
    testsFailed: 0,
    testsPassed: 12,
    failures: [],
  });
  await sleep(800);
  ev({
    type: "match_ended",
    result: "victory",
    stats: { goldSpent: 1200, buildingsRaised: 2, raidersSlain: 2, tilesExplored: 3, durationMs: 60000 },
  });
  await sleep(1200);
  stage("victory");

  // --- fps probe -------------------------------------------------------------------
  await sleep(3200);
  const fps = dbg().fps();
  console.info(
    `[smoke3d] fps=${fps.toFixed(1)} degraded=${dbg().degraded()} draw-calls=${dbg().drawCalls()} gl=${glInfo}`,
  );
  // ≥50 on hardware; a software rasterizer (SwiftShader) passes with a caveat
  check("fps", fps >= 50 || software, `fps=${fps.toFixed(1)} software=${software}`);

  // --- composition-law worlds: the four fixture repos from the logic battery ----
  // (EXACT copies of scripts/logic-tests.mjs "Worlds Apart" fixtures, seed 7)
  const monoTree = dir("", [
    dir("packages", [
      dir("packages/a", [file("packages/a/i.ts", 400), file("packages/a/j.ts", 300)]),
      dir("packages/b", [file("packages/b/k.ts", 500)]),
    ]),
    file("README.md", 60),
  ]);
  const deepTree = dir("", [
    dir("a", [
      file("a/f1.ts", 200),
      dir("a/b", [
        file("a/b/f2.ts", 200),
        dir("a/b/c", [file("a/b/c/f3.ts", 200), dir("a/b/c/d", [file("a/b/c/d/f4.ts", 200)])]),
      ]),
    ]),
    dir("docs", [file("docs/d.md", 50)]),
    file("main.ts", 80),
  ]);
  const coreTree = dir("", [
    dir("src", [
      file("src/a.c", 2000),
      file("src/b.c", 2000),
      file("src/c.c", 2000),
      dir("src/sub", [file("src/sub/d.c", 2000)]),
    ]),
    dir("docs", [file("docs/x.md", 400)]),
    file("Makefile", 80),
  ]);
  const flatTree = dir("", [
    dir("alpha", [file("alpha/a.js", 900), file("alpha/b.js", 800)]),
    dir("beta", [file("beta/c.js", 900), file("beta/d.js", 700)]),
    dir("gamma", [file("gamma/e.js", 900)]),
    file("index.js", 100),
  ]);

  const scenarios: {
    name: string;
    tree: FN;
    depEdges?: { from: string; to: string }[];
    verify: (d: Debug) => void;
  }[] = [
    {
      name: "terrace",
      tree: deepTree,
      verify: (d) => {
        const m = d.map()!;
        check("terrace-composition", d.composition() === "terrace-mount", `composition=${d.composition()}`);
        const q3 = m.quarters.find((q) => q.path === "a/b/c");
        const q1 = m.quarters.find((q) => q.path === "a");
        const lvl = (r: { x: number; y: number }) => d.heightAt(r.x + 1, r.y + 1);
        check(
          "terrace-altitude",
          !!q3 && !!q1 && lvl(q3.rect) > lvl(q1.rect),
          `deep=${q3 ? lvl(q3.rect) : -1} shallow=${q1 ? lvl(q1.rect) : -1}`,
        );
        check(
          "terrace-plaza-low",
          d.heightAt(m.townCenter.tx, m.townCenter.ty) === 0,
          `plaza=${d.heightAt(m.townCenter.tx, m.townCenter.ty)}`,
        );
      },
    },
    {
      name: "ring",
      tree: coreTree,
      verify: (d) => {
        const m = d.map()!;
        check("ring-composition", d.composition() === "ring-city", `composition=${d.composition()}`);
        const core = m.quarters.find((q) => q.path === "src");
        check(
          "ring-core-raised",
          !!core && d.heightAt(core.rect.x + 1, core.rect.y + 1) === 2,
          `core=${core ? d.heightAt(core.rect.x + 1, core.rect.y + 1) : -1}`,
        );
        check(
          "ring-road",
          !!core &&
            m.roads.has(`${core.rect.x - 1},${core.rect.y - 1}`) &&
            m.roads.has(`${core.rect.x + core.rect.w},${core.rect.y + core.rect.h}`),
          "corners of the ring road",
        );
        const g = d.structureAt("src/a.c");
        check("ring-megastructure", g?.kind === "megastructure" && g?.model === "castle", JSON.stringify(g));
        check("ring-landmark", d.landmark()?.kind === "colossus", JSON.stringify(d.landmark()));
      },
    },
    {
      name: "canyon",
      tree: flatTree,
      depEdges: [
        { from: "alpha/a.js", to: "beta/c.js" },
        { from: "gamma/e.js", to: "alpha/b.js" },
      ],
      verify: (d) => {
        const m = d.map()!;
        check("canyon-composition", d.composition() === "canyon-strata", `composition=${d.composition()}`);
        check("canyon-stretched", m.cityRect.w >= m.cityRect.h * 1.8, `w=${m.cityRect.w} h=${m.cityRect.h}`);
        const ry = m.cityRect.y + Math.floor(m.cityRect.h / 2);
        let onRow = 0;
        for (let tx = m.cityRect.x; tx < m.cityRect.x + m.cityRect.w; tx++)
          if (m.roads.has(`${tx},${ry}`)) onRow++;
        check("canyon-long-road", onRow >= Math.floor(m.cityRect.w * 0.5), `onRow=${onRow} w=${m.cityRect.w}`);
        check(
          "canyon-streets",
          m.streets.size > 0 && d.streetTiles() === m.streets.size,
          `streets=${m.streets.size} rendered=${d.streetTiles()}`,
        );
      },
    },
    {
      name: "isles",
      tree: monoTree,
      verify: (d) => {
        const m = d.map()!;
        check("isles-composition", d.composition() === "archipelago", `composition=${d.composition()}`);
        check(
          "isles-water",
          m.water.size > 0 && d.waterTilesRendered() === m.water.size,
          `water=${m.water.size} rendered=${d.waterTilesRendered()}`,
        );
        check("isles-landmark", d.landmark()?.kind === "harbor-beacon", JSON.stringify(d.landmark()));
      },
    },
  ];
  for (const sc of scenarios) {
    const div = document.createElement("div");
    div.style.cssText = "position:fixed;left:0;top:0;width:640px;height:400px;opacity:0;pointer-events:none;";
    document.body.appendChild(div);
    const rr = attachGameRenderer(div);
    rr.handleEvent(
      {
        seq: 0,
        ts: Date.now(),
        type: "match_started",
        matchId: `smoke3d-${sc.name}`,
        task: { id: sc.name, title: "S", description: "s", flavor: "s" },
        mapSeed: 7,
        repoTree: sc.tree,
        ...(sc.depEdges ? { depEdges: sc.depEdges } : {}),
      } as unknown as GameEvent,
      false,
    );
    // each attach overwrites the __ae3d debug handle: read it fresh
    const sd = () => (globalThis as Record<string, unknown>).__ae3d as Debug;
    const okS = await until(() => Boolean(sd()?.worldReady()), 20000);
    check(`${sc.name}-ready`, okS);
    if (okS) sc.verify(sd());
    rr.destroy();
    div.remove();
  }

  const pass = results.filter((x) => x.pass).length;
  const fail = results.length - pass;
  console.info(`[smoke3d] SUMMARY pass=${pass} fail=${fail}`);
  stage("done");
})().catch((err) => {
  console.error("[smoke3d] harness error", err);
});
