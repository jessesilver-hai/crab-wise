/* Temporary headed smoke harness for the sprite renderer (not shipped). */
import type { FileNode, GameEvent } from "@agent-empires/protocol";
import { attachGameRenderer } from "./game/renderer.js";

type FN = FileNode & { lines?: number };
const file = (path: string, lines?: number): FN =>
  ({ kind: "file", name: path.split("/").pop()!, path, ...(lines ? { lines } : {}) }) as FN;
const dir = (path: string, children: FN[]): FN =>
  ({ kind: "dir", name: path.split("/").pop() || ".", path, children }) as FN;

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

const countFiles = (n: FN): number =>
  n.kind === "file" ? 1 : (n.children ?? []).reduce((s, c) => s + countFiles(c as FN), 0);

const r = attachGameRenderer(document.getElementById("app")!);
r.setOrderHandler((kind, target, agentId) =>
  console.info(`[order] ${kind} → ${target} (by ${agentId ?? "?"})`),
);
const ev = (e: GameEvent) => r.handleEvent(e, false);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

(async () => {
  ev({
    type: "match_started",
    matchId: "smoke",
    task: { id: "smoke", title: "Smoke", description: "smoke", flavor: "smoke" },
    mapSeed: 12345,
    repoTree: TREE,
  } as GameEvent);
  await sleep(1200);

  // building-count assert: every file visible once fog is lifted
  const scene = (globalThis as Record<string, unknown>).__aeScene as {
    buildings: Map<string, unknown>;
    map: { hamlets: { count: number }[] };
  };
  const total = countFiles(TREE);
  const hamletFiles = scene.map.hamlets.reduce((s, h) => s + h.count, 0);
  const shown = scene.buildings.size - 1 + hamletFiles; // minus the Citadel
  console.info(
    `[smoke] building-count ${shown === total ? "PASS" : "FAIL"}: files=${total} rendered=${shown}`,
  );

  ev({ type: "agent_spawned", agentId: "king", role: "orchestrator", name: "Aldwin the Grey", model: "m", charge: "Mend the broken parser." } as GameEvent);
  ev({ type: "agent_spawned", agentId: "w1", role: "worker", name: "Ashka the Mason", model: "m", charge: "Rebuild the lexer." } as GameEvent);
  ev({ type: "agent_spawned", agentId: "w2", role: "worker", name: "Veyra of the Vale", model: "m" } as GameEvent);
  await sleep(600);
  ev({ type: "agent_status", agentId: "w1", status: "scouting", detail: "reads src/core/parser" } as GameEvent);
  ev({ type: "agent_moved", agentId: "w1", path: "src/core/parser/lexer.ts" } as GameEvent);
  ev({ type: "agent_status", agentId: "w2", status: "building" } as GameEvent);
  ev({ type: "agent_moved", agentId: "w2", path: "src/render/canvas.ts" } as GameEvent);
  await sleep(900);
  ev({ type: "file_write", agentId: "w1", path: "src/core/parser/lexer.ts", created: false, linesAdded: 42, linesRemoved: 7, buildingKind: "house" } as GameEvent);
  ev({ type: "file_write", agentId: "w2", path: "src/newfile.ts", created: true, linesAdded: 15, linesRemoved: 0, buildingKind: "house" } as GameEvent);
  ev({
    type: "command_result",
    agentId: "w1",
    kind: "test",
    exitCode: 1,
    summary: "2 failed",
    testsFailed: 2,
    testsPassed: 10,
    failures: [
      { name: "parses nested exprs", path: "tests/parser.test.ts" },
      { name: "engine boots", path: "tests/engine.test.ts" },
    ],
  } as GameEvent);
  console.info("[smoke] events fed");
})();
