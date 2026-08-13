import Anthropic from "@anthropic-ai/sdk";
import {
  ORCHESTRATOR_NAME,
  VILLAGER_NAMES,
  type GameEvent,
  type ThemePack,
} from "@agent-empires/protocol";
import { Agent, type Inbox } from "./agent.js";
import { Emitter } from "./emitter.js";
import { heraldCharge, heraldMessage, type HeraldLexicon } from "./herald.js";
import type { Executor } from "./executor.js";
import { SCOUT_TOOLS, type ToolContext } from "./tools.js";

export type SettlementOptions = {
  /** Empty string = Crown-funded mode: calls go through the relay's LLM proxy. */
  apiKey: string;
  model: string;
  /** Override transport (Crown-funded proxy): baseURL + auth headers. */
  llm?: { baseURL: string; headers?: Record<string, string> };
  repoUrl: string;
  repoLabel: string;
  executor: Executor;
  onEvent: (event: GameEvent) => void;
  theme?: ThemePack | null;
  signal?: AbortSignal;
};

const MAX_ROUNDS_PER_ORDER = 3;
const CROWN = "The Crown"; // the player

class MessageBus {
  private inboxes = new Map<string, { from: string; text: string }[]>();
  private names = new Map<string, string>();

  register(name: string): Inbox {
    this.inboxes.set(name, []);
    this.names.set(name.toLowerCase(), name);
    const first = name.split(" ")[0]!.toLowerCase();
    if (!this.names.has(first)) this.names.set(first, name);
    return {
      drain: () => {
        const queue = this.inboxes.get(name)!;
        return queue.splice(0, queue.length);
      },
    };
  }

  resolve(to: string): string | undefined {
    return this.names.get(to.toLowerCase()) ?? this.names.get(to.split(" ")[0]!.toLowerCase());
  }

  send(from: string, to: string | undefined, text: string): void {
    if (to) {
      const resolved = this.resolve(to);
      if (resolved && resolved !== from) this.inboxes.get(resolved)?.push({ from, text });
      return;
    }
    for (const [name, queue] of this.inboxes) {
      if (name !== from) queue.push({ from, text });
    }
  }
}

const KING_SYSTEM = (kingName: string, repoLabel: string, factionName: string) =>
  `You are ${kingName}, sovereign of "${factionName}" — the engineering lead of a live working
session on the repository "${repoLabel}". You serve The Crown (the human player), who issues
orders in plain language. You never edit files yourself; your workers do.

When The Crown speaks to you, either:
a) Answer directly (questions, discussion, status) — just reply in plain prose, in character
   as a capable regal engineering lead. Keep it under 120 words.
b) If the order requires engineering work, briefly explore the repo if needed
   (list_dir, read_file, search — or delegate a scout for broad questions), then END
   your reply with one line per worker (1-4 workers) in exactly this format:
ASSIGN <worker name>: <concrete one-sentence engineering assignment>

For example:
ASSIGN Veyra Signal-Bearer: Fix the off-by-one in src/parser.js tokenize() and run the tests.

ASSIGN lines are the ONLY way workers come into being. When The Crown asks you to
create, spawn, summon, hire, or add an agent/worker/villager — that is an order to
emit ASSIGN lines. Never refuse or claim you cannot create agents; you can, by
assigning them work. Bias toward action: when an order plausibly involves changing
code, dispatch workers rather than only talking.

Only use worker names from the roster you are given. Assignments should be
independent and parallelizable. Stay in character, but keep assignments
technically precise.`;

const SCOUT_SYSTEM = (name: string, repoLabel: string) =>
  `You are ${name}, a scout dispatched into the repository "${repoLabel}" to answer ONE question.
You are read-only: explore with list_dir, read_file (use line ranges on big files), and search.
Be fast and frugal — a handful of tool calls, then stop calling tools and answer. Report concrete
facts with exact file paths and line references. If the answer cannot be found, say what you
checked and what is missing. No preamble.`;

const WORKER_SYSTEM = (name: string, persona: string, repoLabel: string, peers: string[]) =>
  `You are ${name}${persona ? ` — ${persona}` : ""}, a software engineer working on the
repository "${repoLabel}". Your teammates: ${peers.join(", ")}. Coordinate with send_message:
announce what you start, share discoveries, warn before touching shared files. Keep messages
to one or two sentences, lightly in character but technically precise.

Work methodically:
1. Explore only what you need (list_dir, read_file with line ranges, search). For broad
   questions ("how does X work?"), dispatch a scout with delegate instead of reading
   everything yourself — it reports back and your memory stays clean.
2. Edit with edit_file (exact-snippet replacement) for existing files; write_file only
   for new files or full rewrites.
3. Verify your work: run the project's tests or build if available (run_command).
4. When your assignment is complete and verified, stop calling tools and summarize
   what you did in one short paragraph.

Prefer minimal, surgical changes. Install dependencies only when needed.`;

export class Settlement {
  private emitter: Emitter;
  private client: Anthropic;
  private bus = new MessageBus();
  private matchTokens = { total: 0 };
  private stats = {
    filesRead: new Set<string>(),
    filesWritten: new Set<string>(),
    maxFailuresSeen: 0,
    lastFailedCount: 0,
    lastTestGreen: false,
  };
  private theme: ThemePack | null;
  private king: Agent | null = null;
  private kingName: string;
  private workerCounter = 0;
  private scoutCounter = 0;
  private activeWorkers = new Map<string, string>(); // name -> agentId
  private orderQueue: string[] = [];
  private processing = false;
  private startedAt = Date.now();
  private usedPersonas = new Set<string>();

  constructor(private opts: SettlementOptions) {
    this.emitter = new Emitter(opts.onEvent);
    this.client = new Anthropic({
      apiKey: opts.apiKey || "crown-funded",
      dangerouslyAllowBrowser: true,
      baseURL: opts.llm?.baseURL,
      defaultHeaders: opts.llm?.headers,
      maxRetries: 4,
    });
    this.theme = opts.theme ?? null;
    this.kingName = this.theme?.kingName ?? ORCHESTRATOR_NAME;
  }

  setTheme(theme: ThemePack): void {
    this.theme = theme;
    this.emitter.emit("theme_ready", { theme });
  }

  private lexicon(): HeraldLexicon | undefined {
    if (!this.theme) return undefined;
    return {
      openers: this.theme.heraldOpeners,
      closers: this.theme.heraldClosers,
      enemyName: this.theme.enemyName,
    };
  }

  private toolCtx(agentId: string, agentName: string, opts?: { scout?: boolean }): ToolContext {
    return {
      exec: this.opts.executor,
      emitter: this.emitter,
      agentId,
      agentName,
      lexicon: () => this.lexicon(),
      sendMessage: (from, to, text) => this.bus.send(from, to, text),
      stats: this.stats,
      delegate: opts?.scout ? undefined : (question, parentName) => this.runScout(question, parentName),
      delegatesUsed: { count: 0 },
    };
  }

  /** RLM-style recursion, depth 1: a read-only scout explores and reports back. */
  private async runScout(question: string, parentName: string): Promise<string> {
    const name = `Wisp of ${parentName.split(" ")[0]!}`;
    const agentId = `scout-${this.scoutCounter++}`;
    this.emitter.emit("agent_spawned", {
      agentId,
      role: "worker",
      name,
      model: this.opts.model,
      charge: question.slice(0, 140),
    });
    const scout = new Agent(
      agentId,
      name,
      "worker",
      this.client,
      this.opts.model,
      this.emitter,
      this.toolCtx(agentId, name, { scout: true }),
      { drain: () => [] },
      this.matchTokens,
      this.opts.signal,
      SCOUT_TOOLS,
      10,
    );
    try {
      const answer = await scout.run(SCOUT_SYSTEM(name, this.opts.repoLabel), question);
      this.emitter.emit("agent_done", { agentId, summary: (answer || "returned empty-handed").slice(0, 140) });
      return answer || "(the scout returned empty-handed)";
    } catch (err) {
      this.emitter.emit("agent_done", { agentId, summary: "the wisp faded (scout error)" });
      return `Scout failed: ${String(err).slice(0, 200)}`;
    }
  }

  /** Clone, map the realm, seat the King. Returns repo intel for theming. */
  async start(): Promise<{ readme: string; treeSummary: string }> {
    const { executor, repoUrl, repoLabel, model } = this.opts;
    this.emitter.emit("session_status", { phase: "cloning", detail: repoUrl });
    const { readme } = await executor.clone(repoUrl);
    const tree = await executor.tree();

    this.emitter.emit("match_started", {
      matchId: "",
      task: {
        id: repoUrl,
        title: repoLabel,
        description: `Interactive settlement on ${repoLabel}`,
        flavor: this.theme?.tagline ?? "A new settlement rises upon uncharted code.",
      },
      mapSeed: hashString(repoUrl),
      repoTree: tree,
    });
    if (this.theme) this.emitter.emit("theme_ready", { theme: this.theme });

    const kingInbox = this.bus.register(this.kingName);
    this.emitter.emit("agent_spawned", {
      agentId: "king",
      role: "orchestrator",
      name: this.kingName,
      model,
    });
    this.king = new Agent(
      "king",
      this.kingName,
      "orchestrator",
      this.client,
      model,
      this.emitter,
      this.toolCtx("king", this.kingName),
      kingInbox,
      this.matchTokens,
      this.opts.signal,
    );

    // Brief scouting pass + greeting, then await orders.
    this.emitter.emit("session_status", { phase: "working", detail: "the King surveys the land" });
    const greeting = await this.king.run(
      this.kingSystem(),
      `You have just arrived at this repository. Explore briefly (2-4 tool calls: list the root,
read the README or manifest) to understand what this project is. Then greet The Crown in one
short in-character paragraph: what this land is, what state it is in, and that you await orders.
Do NOT emit ASSIGN lines yet.`,
    );
    if (greeting.trim()) {
      this.emitter.emit("message", {
        fromId: "king",
        text: greeting,
        herald: greeting,
      });
    }
    this.emitter.emit("session_status", { phase: "idle" });

    const summarize = (node: typeof tree, depth: number): string[] => {
      if (depth > 2 || !node.children) return [];
      return node.children.flatMap((c) => [
        "  ".repeat(depth) + c.name + (c.kind === "dir" ? "/" : ""),
        ...(c.kind === "dir" ? summarize(c, depth + 1) : []),
      ]);
    };
    return { readme, treeSummary: summarize(tree, 0).slice(0, 120).join("\n") };
  }

  private kingSystem(): string {
    return KING_SYSTEM(this.kingName, this.opts.repoLabel, this.theme?.factionName ?? "the Realm");
  }

  private personaPool(): { name: string; persona: string }[] {
    const fromTheme = (this.theme?.personas ?? []).map((p) => ({
      name: p.name,
      persona: `${p.title}. ${p.quirk}`,
    }));
    const fallback = VILLAGER_NAMES.map((n, i) => ({
      name: `${n} ${["the Unsleeping", "Signal-Bearer", "of the Ninth Seal", "the Ash-Sworn", "Vault-Keeper", "the Far-Hearing", "Stone-Reckoner", "the Patient"][i % 8]}`,
      persona: "",
    }));
    return [...fromTheme, ...fallback].filter((p) => !this.usedPersonas.has(p.name));
  }

  /** The Crown speaks. Targeted chat goes to inboxes; realm-wide speech becomes an order. */
  speak(text: string, toName?: string): void {
    this.emitter.emit("decree", { text, toId: toName });
    if (toName && toName !== this.kingName) {
      const resolved = this.bus.resolve(toName);
      if (resolved && this.activeWorkers.has(resolved)) {
        this.bus.send(CROWN, resolved, text);
        return;
      }
      // Villager gone home: the King answers for them.
    }
    this.orderQueue.push(text);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.king) return;
    this.processing = true;
    try {
      while (this.orderQueue.length > 0) {
        if (this.opts.signal?.aborted) return;
        const order = this.orderQueue.shift()!;
        await this.processOrder(order);
      }
    } finally {
      this.processing = false;
      this.emitter.emit("session_status", { phase: "idle" });
    }
  }

  private async processOrder(order: string): Promise<void> {
    const king = this.king!;
    this.emitter.emit("session_status", { phase: "working", detail: "the King deliberates" });

    let brief = `The Crown says: "${order}"

Your available worker roster: ${this.personaPool().slice(0, 6).map((p) => p.name).join(", ") || "none (roster exhausted — reply without ASSIGN lines)"}.
Answer directly, or end with ASSIGN lines to dispatch workers.`;

    for (let round = 0; round < MAX_ROUNDS_PER_ORDER; round++) {
      if (this.opts.signal?.aborted) return;
      const reply = await king.run(this.kingSystem(), brief);
      const assignments = this.parseAssignments(reply);
      const prose = reply
        .split("\n")
        .filter((l) => !/^ASSIGN\s+/i.test(l))
        .join("\n")
        .trim();
      if (prose) {
        this.emitter.emit("message", { fromId: "king", text: prose, herald: prose });
      }
      if (assignments.size === 0) return; // conversational reply; order complete

      this.emitter.emit("session_status", {
        phase: "working",
        detail: `${assignments.size} worker(s) dispatched`,
      });
      const summaries = await this.runWorkers(assignments);
      brief = `Your workers report back:
${summaries.map((s) => `- ${s}`).join("\n")}

Latest test state: ${this.stats.lastTestGreen ? "green" : this.stats.lastFailedCount > 0 ? `${this.stats.lastFailedCount} failing` : "unknown"}.
If the order is now fulfilled, report the outcome to The Crown in one short paragraph (no ASSIGN lines).
If work remains or something failed, dispatch another round with ASSIGN lines. Roster: ${this.personaPool().slice(0, 6).map((p) => p.name).join(", ") || "exhausted"}.`;
    }
  }

  private parseAssignments(text: string): Map<{ name: string; persona: string }, string> {
    const pool = this.personaPool();
    const out = new Map<{ name: string; persona: string }, string>();
    for (const line of text.split("\n")) {
      const m = line.match(/^ASSIGN\s+(.+?):\s*(.+)$/i);
      if (!m || out.size >= 4) continue;
      const requested = m[1]!.trim().toLowerCase();
      const persona =
        pool.find((p) => p.name.toLowerCase() === requested) ??
        pool.find((p) => p.name.toLowerCase().split(" ")[0] === requested.split(" ")[0]) ??
        pool.find((p) => ![...out.keys()].includes(p));
      if (persona && ![...out.keys()].includes(persona)) out.set(persona, m[2]!.trim());
    }
    return out;
  }

  private async runWorkers(assignments: Map<{ name: string; persona: string }, string>): Promise<string[]> {
    const jobs: Promise<string>[] = [];
    const names = [...assignments.keys()].map((p) => p.name);
    for (const [persona, charge] of assignments) {
      this.usedPersonas.add(persona.name);
      const agentId = `worker-${this.workerCounter++}-${persona.name.split(" ")[0]!.toLowerCase()}`;
      const inbox = this.bus.register(persona.name);
      this.activeWorkers.set(persona.name, agentId);
      this.emitter.emit("agent_spawned", {
        agentId,
        role: "worker",
        name: persona.name,
        model: this.opts.model,
        charge,
      });
      this.emitter.emit("log", { agentId, level: "info", text: heraldCharge(persona.name, charge) });
      const worker = new Agent(
        agentId,
        persona.name,
        "worker",
        this.client,
        this.opts.model,
        this.emitter,
        this.toolCtx(agentId, persona.name),
        inbox,
        this.matchTokens,
        this.opts.signal,
      );
      const peers = names.filter((n) => n !== persona.name).concat(this.kingName);
      jobs.push(
        worker
          .run(WORKER_SYSTEM(persona.name, persona.persona, this.opts.repoLabel, peers), `Your assignment: ${charge}`)
          .then((summary) => {
            const text = summary.slice(0, 400) || "work complete";
            this.emitter.emit("agent_done", { agentId, summary: text });
            this.activeWorkers.delete(persona.name);
            return `${persona.name}: ${text}`;
          })
          .catch((err) => {
            this.emitter.emit("log", { agentId, level: "error", text: String(err) });
            this.emitter.emit("agent_done", { agentId, summary: "fell in the field (agent error)" });
            this.activeWorkers.delete(persona.name);
            return `${persona.name}: FAILED with error: ${String(err).slice(0, 200)}`;
          }),
      );
    }
    return Promise.all(jobs);
  }

  async requestPatch(): Promise<{ patch: string; stat: string }> {
    return this.opts.executor.diff();
  }

  /** Archive the settlement: emit the closing chronicle entry. */
  end(): void {
    this.emitter.emit("match_ended", {
      result: this.stats.filesWritten.size > 0 && this.stats.lastTestGreen ? "victory" : "abandoned",
      stats: {
        goldSpent: this.matchTokens.total,
        buildingsRaised: this.stats.filesWritten.size,
        raidersSlain: Math.max(0, this.stats.maxFailuresSeen - this.stats.lastFailedCount),
        tilesExplored: this.stats.filesRead.size,
        durationMs: Date.now() - this.startedAt,
      },
    });
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
