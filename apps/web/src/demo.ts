import { Emitter } from "@agent-empires/runtime";
import { heraldMessage, heraldCharge } from "@agent-empires/runtime";
import type { FileNode, GameEvent } from "@agent-empires/protocol";
import { hostMatch } from "./relay.js";
import { createMatchView } from "./match-view.js";
import { attachGameRenderer } from "./game/renderer.js";

/**
 * A scripted skirmish for visitors without an API key: same event pipeline,
 * same relay hosting (so it is spectatable), no LLM behind it.
 */

const DEMO_TREE: FileNode = {
  name: ".",
  path: ".",
  kind: "dir",
  children: [
    { name: "package.json", path: "package.json", kind: "file" },
    { name: "README.md", path: "README.md", kind: "file" },
    {
      name: "src",
      path: "src",
      kind: "dir",
      children: [
        { name: "tokenizer.js", path: "src/tokenizer.js", kind: "file" },
        { name: "parser.js", path: "src/parser.js", kind: "file" },
        { name: "evaluate.js", path: "src/evaluate.js", kind: "file" },
      ],
    },
    {
      name: "tests",
      path: "tests",
      kind: "dir",
      children: [{ name: "parser.test.js", path: "tests/parser.test.js", kind: "file" }],
    },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startDemoMatch(root: HTMLElement): Promise<void> {
  const { matchId, publish } = await hostMatch("demo", "Demo Skirmish: The Broken Parser");
  history.replaceState(null, "", `#/match/${matchId}`);

  root.innerHTML = "";
  const view = createMatchView(root, { matchId, title: "Demo Skirmish: The Broken Parser", role: "host" });
  view.attachRenderer(attachGameRenderer(view.gameMount));

  let aborted = false;
  window.addEventListener("hashchange", () => (aborted = true), { once: true });

  const emitter = new Emitter((e: GameEvent) => {
    publish(e);
    view.onEvent(e, false);
  });

  const KING = "king";
  const W1 = "worker-0-ashka";
  const W2 = "worker-1-veyra";
  const names: Record<string, string> = {
    [KING]: "The Hierophant",
    [W1]: "Ashka the Unsleeping",
    [W2]: "Veyra Signal-Bearer",
  };
  let gold = 0;
  const spend = (agentId: string, inTok: number, outTok: number) => {
    gold += inTok + outTok;
    emitter.emit("tokens", { agentId, inputTokens: inTok, outputTokens: outTok, matchTotalTokens: gold });
    emitter.emit("context", { agentId, usedTokens: gold / 2, maxTokens: 200_000 });
  };
  const say = (fromId: string, text: string, toId?: string) => {
    emitter.emit("message", { fromId, toId, text, herald: heraldMessage(names[fromId]!, toId ? names[toId] : undefined, text) });
  };
  const failures = [
    { name: "divides with correct precedence", path: "tests/parser.test.js" },
    { name: "tokenizes the digit nine", path: "tests/parser.test.js" },
    { name: "binds unary minus tightly", path: "tests/parser.test.js" },
    { name: "throws on unknown variables", path: "tests/parser.test.js" },
  ];

  const script: (() => void)[] = [
    () =>
      emitter.emit("match_started", {
        matchId,
        task: {
          id: "demo",
          title: "Demo Skirmish: The Broken Parser",
          description: "A scripted demonstration match. No LLM tokens were spent.",
          flavor: "Four specters haunt the parser fields. Watch a scripted order drive them out — then bring your own key and rule a living settlement.",
        },
        mapSeed: 20260813,
        repoTree: DEMO_TREE,
      }),
    () => emitter.emit("agent_spawned", { agentId: KING, role: "orchestrator", name: names[KING]!, model: "scripted-demo" }),
    () => {
      emitter.emit("agent_moved", { agentId: KING, path: "package.json" });
      emitter.emit("file_read", { agentId: KING, path: "package.json", lines: 12 });
      spend(KING, 900, 60);
    },
    () => {
      emitter.emit("agent_moved", { agentId: KING, path: "tests/parser.test.js" });
      emitter.emit("file_read", { agentId: KING, path: "tests/parser.test.js", lines: 120 });
      spend(KING, 1400, 90);
    },
    () => say(KING, "Four tests fail in the parser fields. Ashka takes the tokenizer, Veyra the parser."),
    () => {
      emitter.emit("agent_spawned", { agentId: W1, role: "worker", name: names[W1]!, model: "scripted-demo", charge: "Fix the tokenizer: digit boundary bug" });
      emitter.emit("log", { agentId: W1, level: "info", text: heraldCharge(names[W1]!, "Fix the tokenizer digit bug") });
    },
    () => {
      emitter.emit("agent_spawned", { agentId: W2, role: "worker", name: names[W2]!, model: "scripted-demo", charge: "Fix precedence and unary minus in the parser" });
    },
    () => {
      emitter.emit("agent_moved", { agentId: W1, path: "src/tokenizer.js" });
      emitter.emit("file_read", { agentId: W1, path: "src/tokenizer.js", lines: 60 });
      spend(W1, 1100, 80);
    },
    () => {
      emitter.emit("agent_moved", { agentId: W2, path: "src/parser.js" });
      emitter.emit("file_read", { agentId: W2, path: "src/parser.js", lines: 95 });
      spend(W2, 1300, 70);
    },
    () => {
      emitter.emit("command_run", { agentId: W2, command: "node --test --test-reporter=tap tests/*.test.js", kind: "test" });
      spend(W2, 1500, 40);
    },
    () =>
      emitter.emit("command_result", {
        agentId: W2, command: "node --test --test-reporter=tap tests/*.test.js", kind: "test",
        exitCode: 1, summary: "4 failed, 12 passed", testsFailed: 4, testsPassed: 12, failures,
      }),
    () => say(W1, "Found it — isDigit excludes '9'. Rebuilding the tokenizer now.", W2),
    () => {
      emitter.emit("search", { agentId: W2, query: "precedence", matchCount: 3, paths: ["src/parser.js", "src/evaluate.js"] });
      spend(W2, 900, 50);
    },
    () => {
      emitter.emit("file_write", { agentId: W1, path: "src/tokenizer.js", created: false, linesAdded: 3, linesRemoved: 3, buildingKind: "house" });
      spend(W1, 1200, 220);
    },
    () => {
      emitter.emit("file_write", { agentId: W2, path: "src/parser.js", created: false, linesAdded: 9, linesRemoved: 6, buildingKind: "house" });
      spend(W2, 1600, 340);
    },
    () => say(W2, "Precedence table fixed and unary minus now binds tightly. Running the tests."),
    () => {
      emitter.emit("command_run", { agentId: W2, command: "node --test --test-reporter=tap tests/*.test.js", kind: "test" });
      spend(W2, 1700, 40);
    },
    () =>
      emitter.emit("command_result", {
        agentId: W2, command: "node --test --test-reporter=tap tests/*.test.js", kind: "test",
        exitCode: 1, summary: "1 failed, 15 passed", testsFailed: 1, testsPassed: 15,
        failures: [failures[3]!],
      }),
    () => {
      emitter.emit("compaction", { agentId: W1 });
    },
    () => say(W1, "One raider left: unknown variables return 0 instead of throwing. On it.", KING),
    () => {
      emitter.emit("agent_moved", { agentId: W1, path: "src/evaluate.js" });
      emitter.emit("file_read", { agentId: W1, path: "src/evaluate.js", lines: 40 });
      spend(W1, 1000, 60);
    },
    () => {
      emitter.emit("file_write", { agentId: W1, path: "src/evaluate.js", created: false, linesAdded: 4, linesRemoved: 1, buildingKind: "house" });
      spend(W1, 1100, 180);
    },
    () => {
      emitter.emit("command_run", { agentId: W1, command: "node --test --test-reporter=tap tests/*.test.js", kind: "test" });
      spend(W1, 1800, 40);
    },
    () =>
      emitter.emit("command_result", {
        agentId: W1, command: "node --test --test-reporter=tap tests/*.test.js", kind: "test",
        exitCode: 0, summary: "0 failed, 16 passed", testsFailed: 0, testsPassed: 16, failures: [],
      }),
    () => {
      emitter.emit("agent_done", { agentId: W1, summary: "Tokenizer and evaluator mended; all tests green." });
      emitter.emit("agent_done", { agentId: W2, summary: "Parser precedence and unary minus restored." });
    },
    () => say(KING, "The fields are quiet. Light the Beacon."),
    () =>
      emitter.emit("match_ended", {
        result: "victory",
        stats: { goldSpent: gold, buildingsRaised: 3, raidersSlain: 4, tilesExplored: 5, durationMs: 58_000 },
      }),
  ];

  for (const step of script) {
    if (aborted) return;
    step();
    await sleep(1100 + Math.random() * 1500);
  }
}
