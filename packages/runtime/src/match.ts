import Anthropic from "@anthropic-ai/sdk";
import { WebContainer, type FileSystemTree } from "@webcontainer/api";
import {
  type FileNode,
  type GameEvent,
  ORCHESTRATOR_NAME,
  VILLAGER_NAMES,
} from "@agent-empires/protocol";
import { Agent, type Inbox } from "./agent.js";
import { Emitter } from "./emitter.js";
import { heraldCharge, heraldMessage } from "./herald.js";
import { parseTap } from "./tap.js";
import type { MatchOutcome, RuntimeOptions } from "./types.js";
import type { ToolContext } from "./tools.js";

// WebContainer.boot() is once-per-page; memoize so repeated matches reuse it.
let containerPromise: Promise<WebContainer> | null = null;
export function bootContainer(): Promise<WebContainer> {
  containerPromise ??= WebContainer.boot();
  return containerPromise;
}

function treeToFileNodes(tree: FileSystemTree, base = ""): FileNode[] {
  return Object.entries(tree).map(([name, node]) => {
    const path = base ? `${base}/${name}` : name;
    if ("directory" in node) {
      return { name, path, kind: "dir" as const, children: treeToFileNodes(node.directory, path) };
    }
    return { name, path, kind: "file" as const };
  });
}

class MessageBus {
  private inboxes = new Map<string, { from: string; text: string }[]>();
  private names = new Map<string, string>(); // lowercase name -> agent name key

  register(name: string): Inbox {
    this.inboxes.set(name, []);
    this.names.set(name.toLowerCase(), name);
    // Also route bare first names ("Aldric" for "Aldric the Builder").
    const first = name.split(" ")[0]!.toLowerCase();
    if (!this.names.has(first)) this.names.set(first, name);
    return {
      drain: () => {
        const queue = this.inboxes.get(name)!;
        return queue.splice(0, queue.length);
      },
    };
  }

  send(from: string, to: string | undefined, text: string): void {
    if (to) {
      const resolved = this.names.get(to.toLowerCase()) ?? this.names.get(to.split(" ")[0]!.toLowerCase());
      if (resolved && resolved !== from) this.inboxes.get(resolved)?.push({ from, text });
      return;
    }
    for (const [name, queue] of this.inboxes) {
      if (name !== from) queue.push({ from, text });
    }
  }
}

const WORKER_SYSTEM = (
  name: string,
  taskTitle: string,
  peers: string[],
) => `You are ${name}, a software engineer on a small team working on: "${taskTitle}".
Your teammates: ${peers.join(", ")}. Coordinate with send_message: announce what you start,
share important discoveries, and warn teammates before touching files they may be editing.
Keep messages to one or two sentences.

Work methodically:
1. Explore only what you need (list_dir, read_file, search).
2. Make focused edits with write_file (always write complete file contents).
3. Verify with: node --test --test-reporter=tap tests/*.test.js
4. When your assignment is genuinely complete and verified, stop calling tools and
   summarize what you did in one short paragraph.

Rules: never modify files under tests/ unless your assignment explicitly says to.
Do not install dependencies; the project has none. Prefer minimal, surgical changes.`;

const ORCHESTRATOR_SYSTEM = (
  taskTitle: string,
) => `You are ${ORCHESTRATOR_NAME}, the engineering lead planning: "${taskTitle}".
Explore the repository briefly (list_dir, read_file, search) to understand the work, then
divide it among your workers. You do not edit files yourself.`;

/** Runs one full match: boot, plan, delegate, verify, declare the outcome. */
export async function runMatch(opts: RuntimeOptions): Promise<MatchOutcome> {
  const { task, apiKey, model, onEvent, signal } = opts;
  const startedAt = Date.now();
  const emitter = new Emitter(onEvent);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const matchTokens = { total: 0 };
  const stats = {
    filesRead: new Set<string>(),
    filesWritten: new Set<string>(),
    maxFailuresSeen: 0,
    lastFailedCount: 0,
  };
  const bus = new MessageBus();

  const wc = await bootContainer();
  // Clear any previous match's files, then mount this task's repo.
  for (const entry of await wc.fs.readdir("/", { withFileTypes: true })) {
    await wc.fs.rm("/" + entry.name, { recursive: true, force: true });
  }
  await wc.mount(task.files);

  emitter.emit("match_started", {
    matchId: "", // relay assigns the public id; renderer ignores this field
    task: { id: task.id, title: task.title, description: task.description, flavor: task.flavor },
    mapSeed: Math.floor(Math.random() * 2 ** 31),
    repoTree: { name: ".", path: ".", kind: "dir", children: treeToFileNodes(task.files) },
  });

  const makeToolCtx = (agentId: string, agentName: string): ToolContext => ({
    wc,
    emitter,
    agentId,
    agentName,
    sendMessage: (from, to, text) => bus.send(from, to, text),
    stats,
  });

  // --- The King scouts and plans -------------------------------------------
  const kingId = "king";
  const kingInbox = bus.register(ORCHESTRATOR_NAME);
  emitter.emit("agent_spawned", { agentId: kingId, role: "orchestrator", name: ORCHESTRATOR_NAME, model });
  const king = new Agent(
    kingId, ORCHESTRATOR_NAME, "orchestrator", client, model, emitter,
    makeToolCtx(kingId, ORCHESTRATOR_NAME), kingInbox, matchTokens, signal,
  );

  const workerCount = Math.min(Math.max(task.workerCount, 1), 4);
  const workerNames = VILLAGER_NAMES.slice(0, workerCount).map((n, i) => {
    const titles = ["the Builder", "the Swift", "the Wise", "the Bold"];
    return `${n} ${titles[i % titles.length]}`;
  });

  const planText = await king.run(
    ORCHESTRATOR_SYSTEM(task.title),
    `${task.description}

Explore the repo as needed, then produce assignments for exactly ${workerCount} workers
named ${workerNames.join(", ")}. End your final message with one line per worker in
exactly this format (no other trailing text):
ASSIGN <worker name>: <one-sentence assignment>`,
  );

  const assignments = new Map<string, string>();
  for (const line of planText.split("\n")) {
    const m = line.match(/^ASSIGN\s+(.+?):\s*(.+)$/);
    if (m) {
      const target = workerNames.find((w) => w.toLowerCase().startsWith(m[1]!.trim().toLowerCase().split(" ")[0]!));
      if (target) assignments.set(target, m[2]!.trim());
    }
  }
  // Fallback: everyone gets the whole task if the king's plan didn't parse.
  for (const name of workerNames) {
    if (!assignments.has(name)) assignments.set(name, task.description);
  }

  // --- Workers labor in parallel -------------------------------------------
  const runWorkers = async (charges: Map<string, string>, extraBrief: string) => {
    const jobs: Promise<void>[] = [];
    let idx = 0;
    for (const [name, charge] of charges) {
      const agentId = `worker-${idx++}-${name.split(" ")[0]!.toLowerCase()}`;
      const inbox = bus.register(name);
      emitter.emit("agent_spawned", { agentId, role: "worker", name, model, charge });
      emitter.emit("log", { agentId, level: "info", text: heraldCharge(name, charge) });
      const worker = new Agent(
        agentId, name, "worker", client, model, emitter,
        makeToolCtx(agentId, name), inbox, matchTokens, signal,
      );
      const peers = [...charges.keys()].filter((n) => n !== name).concat(ORCHESTRATOR_NAME);
      jobs.push(
        worker
          .run(
            WORKER_SYSTEM(name, task.title, peers),
            `Project context: ${task.description}\n\nYour assignment: ${charge}${extraBrief}`,
          )
          .then((summary) => {
            emitter.emit("agent_done", { agentId, summary: summary.slice(0, 300) || "work complete" });
          })
          .catch((err) => {
            emitter.emit("log", { agentId, level: "error", text: String(err) });
            emitter.emit("agent_done", { agentId, summary: "fell in the field (agent error)" });
          }),
      );
    }
    await Promise.all(jobs);
  };

  await runWorkers(assignments, "");

  // --- Acceptance check, with one rally round if the raiders still stand ---
  const runAcceptance = async (): Promise<{ pass: boolean; failed: number; passed: number; failures: { name: string; path?: string }[] }> => {
    const proc = await wc.spawn(task.acceptCommand[0]!, task.acceptCommand.slice(1));
    let output = "";
    proc.output.pipeTo(new WritableStream({ write(c) { output += c; } }));
    const exitCode = await proc.exit;
    const tap = parseTap(output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""));
    stats.maxFailuresSeen = Math.max(stats.maxFailuresSeen, tap.failed);
    emitter.emit("command_result", {
      agentId: kingId,
      command: task.acceptCommand.join(" "),
      kind: "test",
      exitCode,
      summary: `${tap.failed} failed, ${tap.passed} passed`,
      testsFailed: tap.failed,
      testsPassed: tap.passed,
      failures: tap.failures,
    });
    return { pass: exitCode === 0, ...tap };
  };

  let verdict = await runAcceptance();
  if (!verdict.pass && !signal?.aborted) {
    const failureList = verdict.failures.map((f) => `- ${f.name}${f.path ? ` (${f.path})` : ""}`).join("\n");
    emitter.emit("message", {
      fromId: kingId,
      text: `Tests still failing after first pass: rallying the workers.`,
      herald: heraldMessage(ORCHESTRATOR_NAME, undefined, "The raiders still stand! Rally to the walls!"),
    });
    const rallyCharges = new Map<string, string>();
    const rallyWorkers = workerNames.slice(0, Math.max(1, Math.min(2, workerNames.length)));
    for (const name of rallyWorkers) {
      rallyCharges.set(
        `${name.split(" ")[0]} of the Second Rally`,
        `Fix the remaining failing tests:\n${failureList}\nRun the tests first to see current state.`,
      );
    }
    await runWorkers(rallyCharges, "\n\nThis is a rally round: previous work left tests failing. Verify with the test command before finishing.");
    verdict = await runAcceptance();
  }

  const outcome: MatchOutcome = {
    result: verdict.pass ? "victory" : "defeat",
    stats: {
      goldSpent: matchTokens.total,
      buildingsRaised: stats.filesWritten.size,
      raidersSlain: Math.max(0, stats.maxFailuresSeen - verdict.failed),
      tilesExplored: stats.filesRead.size,
      durationMs: Date.now() - startedAt,
    },
  };
  emitter.emit("match_ended", { result: outcome.result, stats: outcome.stats });
  return outcome;
}

export type { GameEvent };
