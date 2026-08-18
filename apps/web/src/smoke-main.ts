/* Temporary headed smoke harness for the renderers (not shipped). Default
 * mounts the 3D engine like the real app; `?r=2d` picks the sprite engine. */
import type { FileNode, GameEvent } from "@agent-empires/protocol";
import { selectRenderer } from "./renderer-select.js";

type FN = FileNode & { lines?: number };
const file = (path: string, lines?: number): FN =>
  ({ kind: "file", name: path.split("/").pop()!, path, ...(lines ? { lines } : {}) }) as FN;
const dir = (path: string, children: FN[]): FN =>
  ({ kind: "dir", name: path.split("/").pop() || ".", path, children }) as FN;

/** ?comp=terrace|ring|canyon|isles picks a composition fixture (default terrace). */
const TERRACE: FN = dir(".", [
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
        dir("src/core/parser/tokens", [
          file("src/core/parser/tokens/keywords.ts", 220),
          file("src/core/parser/tokens/symbols.ts", 180),
        ]),
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

const RING: FN = dir(".", [
  dir("src", [
    file("src/a.c", 2000),
    file("src/b.c", 2000),
    file("src/c.c", 2000),
    dir("src/sub", [file("src/sub/d.c", 2000)]),
  ]),
  dir("docs", [file("docs/x.md", 400)]),
  dir("tests", [file("tests/t.c", 350)]),
  file("Makefile", 80),
]);

const CANYON: FN = dir(".", [
  dir("alpha", [file("alpha/a.js", 900), file("alpha/b.js", 800), file("alpha/a.test.js", 300)]),
  dir("beta", [file("beta/c.js", 900), file("beta/d.js", 700), file("beta/conf.yaml", 60)]),
  dir("gamma", [file("gamma/e.js", 900), file("gamma/g.md", 150)]),
  file("index.js", 100),
]);

const ISLES: FN = dir(".", [
  dir("packages", [
    dir("packages/a", [file("packages/a/i.ts", 400), file("packages/a/j.ts", 300)]),
    dir("packages/b", [file("packages/b/k.ts", 500), file("packages/b/l.test.ts", 200)]),
    dir("packages/c", [file("packages/c/m.ts", 350)]),
  ]),
  file("README.md", 60),
]);

const COMP = new URLSearchParams(location.search).get("comp") ?? "terrace";
const TREE: FN = COMP === "ring" ? RING : COMP === "canyon" ? CANYON : COMP === "isles" ? ISLES : TERRACE;
const DEP_EDGES =
  COMP === "canyon"
    ? [
        { from: "alpha/a.js", to: "beta/c.js" },
        { from: "gamma/e.js", to: "alpha/b.js" },
        { from: "beta/d.js", to: "alpha/a.js" },
      ]
    : COMP === "isles"
      ? [
          { from: "packages/a/i.ts", to: "packages/b/k.ts" },
          { from: "packages/c/m.ts", to: "packages/a/j.ts" },
        ]
      : undefined;

/** Per-composition agent walk targets so the shroud lifts over each fixture's quarters. */
const MOVE_PATHS: Record<string, string[]> = {
  terrace: ["src/core/parser/lexer.ts", "src/render/canvas.ts"],
  ring: ["src/a.c", "src/sub/d.c"],
  canyon: ["alpha/a.js", "beta/c.js", "gamma/e.js"],
  isles: ["packages/a/i.ts", "packages/b/k.ts", "packages/c/m.ts"],
};
const [MOVE1, MOVE2, MOVE3] = MOVE_PATHS[COMP] ?? MOVE_PATHS.terrace ?? [];

const countFiles = (n: FN): number =>
  n.kind === "file" ? 1 : (n.children ?? []).reduce((s, c) => s + countFiles(c as FN), 0);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

(async () => {
  const r = await selectRenderer(document.getElementById("app")!);
  r.setOrderHandler?.((kind, target, agentId) =>
    console.info(`[order] ${kind} → ${target} (by ${agentId ?? "?"})`),
  );
  const ev = (e: GameEvent) => r.handleEvent(e, false);

  ev({
    type: "match_started",
    matchId: "smoke",
    task: { id: "smoke", title: "Smoke", description: "smoke", flavor: "smoke" },
    mapSeed: 12345,
    repoTree: TREE,
    depEdges: DEP_EDGES,
  } as GameEvent);
  await sleep(1200);

  // building-count assert (2D engine only — the 3D scene keeps no such map)
  const scene = (globalThis as Record<string, unknown>).__aeScene as
    | {
        buildings: Map<string, unknown>;
        map: { hamlets: { count: number }[] };
      }
    | undefined;
  if (scene) {
    const total = countFiles(TREE);
    const hamletFiles = scene.map.hamlets.reduce((s, h) => s + h.count, 0);
    const shown = scene.buildings.size - 1 + hamletFiles; // minus the Citadel
    console.info(
      `[smoke] building-count ${shown === total ? "PASS" : "FAIL"}: files=${total} rendered=${shown}`,
    );
  }

  ev({ type: "agent_spawned", agentId: "king", role: "orchestrator", name: "Aldwin the Grey", model: "m", charge: "Mend the broken parser." } as GameEvent);
  ev({ type: "agent_spawned", agentId: "w1", role: "worker", name: "Ashka the Mason", model: "m", charge: "Rebuild the lexer." } as GameEvent);
  ev({ type: "agent_spawned", agentId: "w2", role: "worker", name: "Veyra of the Vale", model: "m" } as GameEvent);
  await sleep(600);
  ev({ type: "agent_status", agentId: "w1", status: "scouting", detail: `reads ${MOVE1}` } as GameEvent);
  ev({ type: "agent_moved", agentId: "w1", path: MOVE1 } as GameEvent);
  ev({ type: "agent_status", agentId: "w2", status: "building" } as GameEvent);
  ev({ type: "agent_moved", agentId: "w2", path: MOVE2 } as GameEvent);
  if (MOVE3) {
    await sleep(300);
    ev({ type: "agent_moved", agentId: "king", path: MOVE3 } as GameEvent);
  }
  await sleep(900);
  ev({ type: "file_write", agentId: "w1", path: MOVE1, created: false, linesAdded: 42, linesRemoved: 7, buildingKind: "house" } as GameEvent);
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
