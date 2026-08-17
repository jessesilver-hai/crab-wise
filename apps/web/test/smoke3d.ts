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

type Debug = {
  worldReady(): boolean;
  layoutHash(): string;
  map(): {
    plots: Map<string, { tx: number; ty: number }>;
    hamlets: { count: number }[];
    water: Set<string>;
    bridges: Set<string>;
  } | null;
  dna(): { form: string; ground: unknown; fortification: number; loreNotes: { subject: string; line: string }[] } | null;
  waterTilesRendered(): number;
  bridgesRendered(): number;
  decorStats(): { wallSegments: number; props: number; trees: number; rocks: number };
  buildings(): Map<string, unknown>;
  instanceCount(): number;
  drawCalls(): number;
  fps(): number;
  degraded(): boolean;
  fogAlphaAt(tx: number, ty: number): number;
  fxActive(): number;
  menuEntries(): string[];
  projectWorld(x: number, y: number, z: number): { x: number; y: number };
  agents(): Map<string, { unit: { x: number; z: number } }>;
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

  if (BIG) {
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
  const lexPt = dbg().projectWorld(lexer.tx, 0.3, lexer.ty);
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

  // Talk-to on a unit → speak callback (left-click = first entry)
  const w1 = dbg().agents().get("w1")!;
  const uPt = dbg().projectWorld(w1.unit.x, 0.35, w1.unit.z);
  firePointer("pointermove", uPt.x, uPt.y);
  await sleep(150);
  firePointer("pointerdown", uPt.x, uPt.y, 0, 1);
  firePointer("pointerup", uPt.x, uPt.y, 0, 0);
  await sleep(250);
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
    const hkPt = dbg().projectWorld(hk.tx, 0.4, hk.ty);
    firePointer("pointermove", hkPt.x, hkPt.y);
    await sleep(150);
    firePointer("pointerdown", hkPt.x, hkPt.y, 2, 2);
    firePointer("pointerup", hkPt.x, hkPt.y, 2, 0);
    await sleep(250);
    const hookRows = [...document.querySelectorAll("[data-ae3d-row]")] as HTMLElement[];
    const readRow = hookRows.find((el) => (el.textContent ?? "").startsWith("Read "));
    readRow?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await sleep(250);
    check("inspect-callback", cbLog.includes(`inspect:${hk.path}`), `hooks=${hooks.length} rows=${hookRows.map((r) => r.textContent).join(",")}`);
  } else {
    check("inspect-callback", false, "no hook obelisk found after theme_patch");
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

  const pass = results.filter((x) => x.pass).length;
  const fail = results.length - pass;
  console.info(`[smoke3d] SUMMARY pass=${pass} fail=${fail}`);
  stage("done");
})().catch((err) => {
  console.error("[smoke3d] harness error", err);
});
