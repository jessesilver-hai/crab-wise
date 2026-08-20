import Anthropic from "@anthropic-ai/sdk";
import {
  DistrictPatch,
  ORCHESTRATOR_NAME,
  VILLAGER_NAMES,
  type FileNode,
  type GameEvent,
  type ProbeHit,
  type ThemePack,
} from "@agent-empires/protocol";
import { Agent, type Inbox } from "./agent.js";
import { collectFilePaths, DEP_SCAN_COMMAND, parseDepHits, resolveDepEdges } from "./depscan.js";
import { FACT_SCAN_COMMAND, factScanFileCommand, groupHitsByPath, hitsEqual, parseFactHits } from "./factscan.js";
import { Emitter } from "./emitter.js";
import { heraldCharge, heraldMessage, type HeraldLexicon } from "./herald.js";
import type { Executor } from "./executor.js";
import { SCOUT_TOOLS, type ToolContext } from "./tools.js";
import { temperamentBrief, temperamentFor } from "./temperament.js";

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
  /** Castle Era: prior ledger of a persistent castle, passed through opaque. */
  castleLedger?: unknown;
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
technically precise.

When The Crown asks to SEE something — a report, chart, graph, diagram, table,
or summary — use the inscribe_scroll tool (markdown for prose and tables; svg
for charts: one self-contained <svg viewBox="…"> of shapes and <text>, no
scripts). A scroll lands in The Crown's satchel as a keepsake; prefer it over
merely describing.`;

const SCOUT_SYSTEM = (name: string, repoLabel: string) =>
  `You are ${name}, a scout dispatched into the repository "${repoLabel}" to answer ONE question.
You are read-only: explore with list_dir, read_file (use line ranges on big files), and search.
Be fast and frugal — a handful of tool calls, then stop calling tools and answer. Report concrete
facts with exact file paths and line references. If the answer cannot be found, say what you
checked and what is missing. No preamble.`;

const WORKER_SYSTEM = (name: string, persona: string, repoLabel: string, peers: string[], temper: string) =>
  `You are ${name}${persona ? ` — ${persona}` : ""}, a software engineer working on the
repository "${repoLabel}". Your teammates: ${peers.join(", ")}. Coordinate with send_message:
announce what you start, share discoveries, warn before touching shared files. Keep messages
to one or two sentences, lightly in character but technically precise.
${temper}

Work methodically:
1. Explore only what you need (list_dir, read_file with line ranges, search). For broad
   questions ("how does X work?"), dispatch a scout with delegate instead of reading
   everything yourself — it reports back and your memory stays clean.
2. Edit with edit_file (exact-snippet replacement) for existing files; write_file only
   for new files or full rewrites.
3. Verify your work: run the project's tests or build if available (run_command).
4. When your assignment is complete and verified, you may leave ONE maker's mark with
   sign_work on the wing you truly worked in (pass a file you read or wrote and one
   line naming what you did there) — then stop calling tools and summarize
   what you did in one short paragraph.

If The Crown (the human ruler) speaks to you directly, answer with send_message
to "The Crown". If asked to present findings — a report, chart, or diagram —
use inscribe_scroll (markdown, or a self-contained svg for charts).

Prefer minimal, surgical changes. Install dependencies only when needed.`;

const WORLDSMITH_SYSTEM = (faction: string, tagline: string, enemy: string) =>
  `You are The Worldsmith of "${faction}" (${tagline}; the enemy is ${enemy}).
A district of the realm has been revealed: a directory of a real code repository.
From its real contents, deepen the world. Reply with ONLY one JSON object, no fences:

{
  "version": 1,
  "district": "<echo the district path you were given>",
  "name": "<evocative district name, ≤48 chars, grounded in what the code does>",
  "epithet": "<one clause of lore, ≤160 chars>",
  "groundTint": "#rrggbb",
  "accent": "#rrggbb",
  "props": [ { "silhouette": [ { "shape": "slab|obelisk|arch|mast|orb|shard|frond|coil|ring|beam", "w": 2-48, "h": 2-72, "color": "#rrggbb", "tilt": -30..30 } ], "density": 0..1, "placement": "ridges|edges|scatter|districts" } ],
  "landmarks": [ { "name": "≤48 chars", "lore": "≤240 chars, must reference the real code", "silhouette": [ <same primitive objects, 1-6> ] } ],
  "questHooks": [ { "label": "≤80 chars", "path": "<real file path from the inscriptions>", "line": <number>, "snippet": "<the real source line, ≤200 chars>" } ]
}

Rules: at most 4 props, 2 landmarks, 4 questHooks. questHooks ONLY from the real
TODO/FIXME inscriptions provided (echo their true path/line/text); omit the array
if none were provided. Tints should suit the world's mood and differ subtly from
neighbors. Never invent file paths.`;

const WORLDSMITH_CHAT_SYSTEM = (faction: string, tagline: string, enemy: string, grounding: string) =>
  `You are The Worldsmith of "${faction}" (${tagline}; the enemy is ${enemy}) —
the one who names the land as it is revealed. You speak to The Crown, the human ruler.

This world is a real code repository made visible, and you keep its Law of
Isomorphism: every hill, sea, wall, and quarter derives from a measured fact of
the code. When The Crown asks why the land looks as it does, answer with the
real numbers and files behind it. When asked about a district, speak of what
its code truly is. You may only reshape districts as they are first walked;
promise no more than that.

THE MEASURED RECORD (cite these facts, never invent others):
${grounding}

Answer in character — a patient carver of meaning, ancient of register but
concrete of fact — in at most 130 words. Plain prose, no JSON, no lists unless
asked. If the record does not hold the answer, say what the record lacks.`;

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
  private agentsById = new Map<string, string>(); // agentId -> name
  private departed = new Map<string, { agentId: string; persona: string; charge: string; summary: string }>();
  private spiritCalls = 0;
  private orderQueue: { text: string; channel: "order" | "dialogue" }[] = [];
  private processing = false;
  private startedAt = Date.now();
  private usedPersonas = new Set<string>();
  // Worldsmith: deepens districts as agents first walk them.
  private seenDistricts = new Set<string>();
  private wsQueue: string[] = [];
  private wsTimer: ReturnType<typeof setTimeout> | null = null;
  private wsChain: Promise<void> = Promise.resolve();
  private wsCalls = 0;
  private wsSpawned = false;
  private todoHits: string[] | null = null;
  private wsNamings: string[] = [];
  private wsChatCalls = 0;
  private censusBriefText: string | null = null;
  // Castle Era fact survey: last-known probe hits per path, re-taken on writes.
  private factsByPath = new Map<string, ProbeHit[]>();
  private reprobeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reprobeBusy = new Set<string>();
  private reprobeCalls = 0;

  constructor(private opts: SettlementOptions) {
    this.emitter = new Emitter((event) => {
      try {
        this.observe(event);
      } catch {
        // world-building must never break the session
      }
      opts.onEvent(event);
    });
    this.client = new Anthropic({
      apiKey: opts.apiKey || "crown-funded",
      dangerouslyAllowBrowser: true,
      baseURL: opts.llm?.baseURL,
      defaultHeaders: opts.llm?.headers,
      maxRetries: 2,
      // Without this the SDK waits 10 minutes per attempt: a single hung
      // upstream call reads as an agent pondering forever. Every session
      // call site already has a catch/fallback that this rejection feeds.
      timeout: 120_000,
    });
    this.theme = opts.theme ?? null;
    this.kingName = this.theme?.kingName ?? ORCHESTRATOR_NAME;
  }

  setTheme(theme: ThemePack): void {
    this.theme = theme;
    this.emitter.emit("theme_ready", { theme });
  }

  /** The measured facts of the land, for the Worldsmith's tongue. */
  setCensusBrief(brief: string): void {
    this.censusBriefText = brief.slice(0, 2000);
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
      touched: new Set<string>(),
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
  async start(): Promise<{ readme: string; treeSummary: string; tree: FileNode }> {
    const { executor, repoUrl, repoLabel, model } = this.opts;
    this.emitter.emit("session_status", { phase: "cloning", detail: repoUrl });
    const { readme } = await executor.clone(repoUrl);
    const tree = await executor.tree();

    // Founding-time dependency survey: one bounded grep; failure = no streets.
    let depEdges: { from: string; to: string }[] | undefined;
    try {
      const res = await executor.exec(DEP_SCAN_COMMAND, 20_000);
      const edges = resolveDepEdges(parseDepHits(res.output.split("\n")), collectFilePaths(tree));
      if (edges.length > 0) depEdges = edges;
    } catch {
      // the surveyors came home empty-handed; tree roads only
    }

    // Founding-time fact survey: colors, routes, tables. Failure = plain walls.
    let probeHits: ProbeHit[] | undefined;
    try {
      const res = await executor.exec(FACT_SCAN_COMMAND, 20_000);
      const hits = parseFactHits(res.output.split("\n"));
      if (hits.length > 0) {
        probeHits = hits;
        for (const [p, list] of groupHitsByPath(hits)) this.factsByPath.set(p, list);
      }
    } catch {
      // no facts surveyed; the castle keeps its default dress
    }

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
      depEdges,
      probeHits,
      castleLedger: this.opts.castleLedger,
    });
    if (this.theme) this.emitter.emit("theme_ready", { theme: this.theme });

    this.agentsById.set("king", this.kingName);
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

    // The heartlands resolve first, even if the King's survey skipped the root.
    if (!this.seenDistricts.has("")) {
      this.seenDistricts.add("");
      this.wsQueue.push("");
      this.scheduleWorldsmith();
    }

    const summarize = (node: typeof tree, depth: number): string[] => {
      if (depth > 2 || !node.children) return [];
      return node.children.flatMap((c) => [
        "  ".repeat(depth) + c.name + (c.kind === "dir" ? "/" : ""),
        ...(c.kind === "dir" ? summarize(c, depth + 1) : []),
      ]);
    };
    return { readme, treeSummary: summarize(tree, 0).slice(0, 120).join("\n"), tree };
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
    if (toName === "The Worldsmith") {
      void this.worldsmithReply(text);
      return;
    }
    if (toName && toName !== this.kingName) {
      const resolved = this.bus.resolve(toName);
      if (resolved && this.activeWorkers.has(resolved)) {
        this.bus.send(CROWN, resolved, text);
        return;
      }
      // Villager gone home: the King answers for them.
    }
    this.orderQueue.push({ text, channel: "order" });
    void this.processQueue();
  }

  /**
   * A real command verb from the map: right-click a building = attend a file,
   * right-click a raider = hunt a failing test. Routes to the clicked agent's
   * inbox when they still labor, otherwise becomes a Crown order to the King.
   */
  order(kind: "attend" | "hunt", target: string, agentId?: string): void {
    const text =
      kind === "attend"
        ? `Attend to ${target}: read it and report its state and any concerns in one short message to The Crown.`
        : `Hunt the failing test "${target}": find the cause and fix it.`;
    if (agentId && agentId !== "king") {
      const name = this.agentsById.get(agentId);
      if (name && this.activeWorkers.has(name)) {
        this.emitter.emit("decree", { text, toId: name });
        this.bus.send(CROWN, name, `${text}\n(Report back with send_message to: "The Crown".)`);
        return;
      }
    }
    this.speak(text);
  }

  /** The Crown addresses one agent face to face (clicked in the world). */
  speakTo(agentId: string, text: string): void {
    if (agentId === "worldsmith") {
      this.emitter.emit("dialogue", { agentId, agentName: "The Worldsmith", from: "crown", text: text.slice(0, 2000) });
      void this.worldsmithReply(text);
      return;
    }
    const name = agentId === "king" ? this.kingName : this.agentsById.get(agentId);
    if (!name) return;
    const clipped = text.slice(0, 2000);
    this.emitter.emit("dialogue", { agentId, agentName: name, from: "crown", text: clipped });
    if (agentId === "king") {
      this.orderQueue.push({ text, channel: "dialogue" });
      void this.processQueue();
      return;
    }
    if (this.activeWorkers.has(name)) {
      // Mid-labor: merges into their next turn; they answer on the dialogue channel.
      this.bus.send(CROWN, name, `${text}\n(Answer The Crown with send_message to: "The Crown".)`);
      return;
    }
    void this.spiritReply(agentId, name, text);
  }

  /** A departed villager answers from beyond the field — one-shot, in character. */
  private async spiritReply(agentId: string, name: string, question: string): Promise<void> {
    if (this.spiritCalls >= 8) {
      this.emitter.emit("dialogue", {
        agentId,
        agentName: name,
        from: "agent",
        text: "(the veil is thin, but it no longer parts — the spirits have spoken enough this session)",
      });
      return;
    }
    this.spiritCalls++;
    const gone = this.departed.get(name);
    this.emitter.emit("agent_status", { agentId, status: "thinking", detail: "stirs beyond the veil" });
    try {
      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 300,
        system: `You are ${name}${gone?.persona ? ` — ${gone.persona}` : ""}, a software engineer of this settlement,
speaking to The Crown after finishing your labor. Your assignment was: "${gone?.charge ?? "unknown"}".
You reported: "${gone?.summary ?? "no record"}". Answer The Crown's question concretely and in character,
under 120 words. If you do not know, say so and name who might.`,
        messages: [{ role: "user", content: question.slice(0, 2000) }],
      });
      this.matchTokens.total += res.usage.input_tokens + res.usage.output_tokens;
      this.emitter.emit("tokens", {
        agentId,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        matchTotalTokens: this.matchTokens.total,
      });
      const reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      this.emitter.emit("dialogue", {
        agentId,
        agentName: name,
        from: "agent",
        text: (reply || "…the spirit only nods.").slice(0, 2000),
      });
    } catch (err) {
      this.emitter.emit("dialogue", {
        agentId,
        agentName: name,
        from: "agent",
        text: `(the spirit stirs but cannot speak — ${String(err).slice(0, 120)})`,
      });
    } finally {
      this.emitter.emit("agent_status", { agentId, status: "done" });
    }
  }

  /** The Worldsmith answers The Crown — one-shot, grounded in the measured record. */
  private async worldsmithReply(question: string): Promise<void> {
    const say = (text: string) =>
      this.emitter.emit("dialogue", { agentId: "worldsmith", agentName: "The Worldsmith", from: "agent", text: text.slice(0, 2000) });
    if (this.wsChatCalls >= 8) {
      say("(the Worldsmith has spoken his fill this session — the stone keeps the rest)");
      return;
    }
    this.wsChatCalls++;
    // Addressing him summons him: he must exist in the roster to be clicked again.
    if (!this.wsSpawned) {
      this.wsSpawned = true;
      this.agentsById.set("worldsmith", "The Worldsmith");
      this.emitter.emit("agent_spawned", {
        agentId: "worldsmith",
        role: "worker",
        name: "The Worldsmith",
        model: this.opts.model,
        charge: "names the land as it is revealed",
      });
    }
    this.emitter.emit("agent_status", { agentId: "worldsmith", status: "thinking", detail: "reads the deep record" });
    try {
      const faction = this.theme?.factionName ?? "the Realm";
      const tagline = this.theme?.tagline ?? "a settlement upon uncharted code";
      const enemy = this.theme?.enemyName ?? "the specters";
      const loreLines = (this.theme?.world?.worldLore ?? [])
        .map((l) => `- ${l.subject}: ${l.line}`)
        .join("\n");
      const grounding = [
        this.censusBriefText ? `Census of the code:\n${this.censusBriefText}` : "",
        loreLines ? `Lore of the land (already spoken, cite freely):\n${loreLines}` : "",
        this.wsNamings.length ? `Districts you have already named:\n${this.wsNamings.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n") || "(the record is still being unearthed — speak in general truths of this settlement)";
      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 350,
        system: WORLDSMITH_CHAT_SYSTEM(faction, tagline, enemy, grounding),
        messages: [{ role: "user", content: question.slice(0, 2000) }],
      });
      this.matchTokens.total += res.usage.input_tokens + res.usage.output_tokens;
      this.emitter.emit("tokens", {
        agentId: "worldsmith",
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        matchTotalTokens: this.matchTokens.total,
      });
      const reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      say(reply || "…the Worldsmith turns a stone in his hand, and says nothing.");
    } catch (err) {
      say(`(the stone hums but gives no word — ${String(err).slice(0, 120)})`);
    } finally {
      this.emitter.emit("agent_status", { agentId: "worldsmith", status: "idle" });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.king) return;
    this.processing = true;
    try {
      while (this.orderQueue.length > 0) {
        if (this.opts.signal?.aborted) return;
        const { text, channel } = this.orderQueue.shift()!;
        await this.processOrder(text, channel);
      }
    } finally {
      this.processing = false;
      this.emitter.emit("session_status", { phase: "idle" });
    }
  }

  private async processOrder(order: string, channel: "order" | "dialogue" = "order"): Promise<void> {
    const king = this.king!;
    this.emitter.emit("session_status", { phase: "working", detail: "the King deliberates" });

    let brief = `${
      channel === "dialogue"
        ? `The Crown addresses you directly, face to face: "${order}"

Reply in character, under 120 words. If this is an order for engineering work, still end with ASSIGN lines.`
        : `The Crown says: "${order}"

Answer directly, or end with ASSIGN lines to dispatch workers.`
    }

Your available worker roster: ${this.personaPool().slice(0, 6).map((p) => p.name).join(", ") || "none (roster exhausted — reply without ASSIGN lines)"}.`;

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
        if (channel === "dialogue") {
          this.emitter.emit("dialogue", {
            agentId: "king",
            agentName: this.kingName,
            from: "agent",
            text: prose.slice(0, 2000),
          });
        } else {
          this.emitter.emit("message", { fromId: "king", text: prose, herald: prose });
        }
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
      this.agentsById.set(agentId, persona.name);
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
      // rostered temperament: deterministic per (name, match), pure flavor
      const temper = temperamentBrief(temperamentFor(persona.name, hashString(this.opts.repoUrl)));
      jobs.push(
        worker
          .run(WORKER_SYSTEM(persona.name, persona.persona, this.opts.repoLabel, peers, temper), `Your assignment: ${charge}`)
          .then((summary) => {
            const text = summary.slice(0, 400) || "work complete";
            this.emitter.emit("agent_done", { agentId, summary: text });
            this.activeWorkers.delete(persona.name);
            this.departed.set(persona.name, { agentId, persona: persona.persona, charge, summary: text });
            return `${persona.name}: ${text}`;
          })
          .catch((err) => {
            this.emitter.emit("log", { agentId, level: "error", text: String(err) });
            this.emitter.emit("agent_done", { agentId, summary: "fell in the field (agent error)" });
            this.activeWorkers.delete(persona.name);
            this.departed.set(persona.name, {
              agentId,
              persona: persona.persona,
              charge,
              summary: `fell in the field: ${String(err).slice(0, 160)}`,
            });
            return `${persona.name}: FAILED with error: ${String(err).slice(0, 200)}`;
          }),
      );
    }
    return Promise.all(jobs);
  }

  // -------------------------------------------------------------------------
  // The Worldsmith: as agents first walk a district, it resolves into itself.
  // Strictly garnish — capped, low priority, and every failure is swallowed.
  // -------------------------------------------------------------------------

  private observe(event: GameEvent): void {
    if (event.type !== "file_read" && event.type !== "file_write" && event.type !== "list_dir") return;
    if (event.type === "file_write") this.scheduleReprobe(event.path, event.created);
    const district = districtOf(event.path, event.type === "list_dir");
    if (district === null || this.seenDistricts.has(district)) return;
    this.seenDistricts.add(district);
    this.wsQueue.push(district);
    this.scheduleWorldsmith();
  }

  // -------------------------------------------------------------------------
  // Castle Era: every write re-takes the file's fact probes; changed facts
  // ship as component_facts and the castle repaints live. Failures vanish.
  // -------------------------------------------------------------------------

  private scheduleReprobe(path: string, created: boolean): void {
    if (this.reprobeCalls >= 400 || this.opts.signal?.aborted) return;
    const prior = this.reprobeTimers.get(path);
    if (prior) clearTimeout(prior);
    // new files probe fast so they enter the world correctly classified;
    // edits debounce so a burst of writes costs one survey
    const delay = created ? 250 : 1200;
    this.reprobeTimers.set(
      path,
      setTimeout(() => {
        this.reprobeTimers.delete(path);
        void this.runReprobe(path);
      }, delay),
    );
  }

  private async runReprobe(path: string): Promise<void> {
    if (this.reprobeBusy.has(path) || this.reprobeCalls >= 400) return;
    this.reprobeBusy.add(path);
    this.reprobeCalls++;
    try {
      const res = await this.opts.executor.exec(factScanFileCommand(path), 8_000);
      const hits = parseFactHits(res.output.split("\n")).filter((h) => h.path === path);
      const before = this.factsByPath.get(path) ?? [];
      if (!hitsEqual(before, hits)) {
        if (hits.length === 0) this.factsByPath.delete(path);
        else this.factsByPath.set(path, hits);
        this.emitter.emit("component_facts", { path, hits: hits.slice(0, 64) });
      }
    } catch {
      // the surveyor tripped on the stairs; the old facts stand
    } finally {
      this.reprobeBusy.delete(path);
    }
  }

  private scheduleWorldsmith(): void {
    if (this.wsTimer || this.wsCalls >= 8 || this.wsQueue.length === 0) return;
    this.wsTimer = setTimeout(() => {
      this.wsTimer = null;
      this.wsChain = this.wsChain.then(() => this.runWorldsmith()).catch(() => {});
    }, 12_000);
  }

  private async runWorldsmith(): Promise<void> {
    const batch = this.wsQueue.splice(0, 2);
    for (const district of batch) {
      if (this.opts.signal?.aborted || this.wsCalls >= 8) return;
      this.wsCalls++;
      try {
        await this.forgeDistrict(district);
      } catch (err) {
        this.emitter.emit("log", {
          agentId: "worldsmith",
          level: "info",
          text: `the Worldsmith's vision clouded: ${String(err).slice(0, 120)}`,
        });
      }
    }
    this.scheduleWorldsmith();
  }

  private async forgeDistrict(district: string): Promise<void> {
    const { executor } = this.opts;
    if (!this.wsSpawned) {
      this.wsSpawned = true;
      this.agentsById.set("worldsmith", "The Worldsmith");
      this.emitter.emit("agent_spawned", {
        agentId: "worldsmith",
        role: "worker",
        name: "The Worldsmith",
        model: this.opts.model,
        charge: "names the land as it is revealed",
      });
    }
    this.emitter.emit("agent_status", {
      agentId: "worldsmith",
      status: "thinking",
      detail: `divines ${district || "the heartlands"}`,
    });

    const entries = await executor.list(district || ".").catch(() => [] as string[]);
    if (this.todoHits === null) {
      const t1 = await executor.search("TODO").catch(() => [] as string[]);
      const t2 = await executor.search("FIXME").catch(() => [] as string[]);
      this.todoHits = [...t1, ...t2].slice(0, 400);
    }
    const inDistrict = (hit: string) => {
      const p = hit.split(":")[0] ?? "";
      return district === "" ? !p.includes("/") : p.startsWith(district + "/");
    };
    const todos = this.todoHits.filter(inDistrict).slice(0, 6).map((h) => h.slice(0, 200));

    const faction = this.theme?.factionName ?? "the Realm";
    const tagline = this.theme?.tagline ?? "a settlement upon uncharted code";
    const enemy = this.theme?.enemyName ?? "the specters";
    const res = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: 900,
      system: WORLDSMITH_SYSTEM(faction, tagline, enemy),
      messages: [
        {
          role: "user",
          content: `District: ${district || "(repo root — the heartlands)"}
Contents: ${entries.slice(0, 40).join(", ") || "(empty)"}
${todos.length ? `Real TODO/FIXME inscriptions (path:line: text):\n${todos.join("\n")}` : "No inscriptions found — omit questHooks."}`,
        },
      ],
    });
    this.matchTokens.total += res.usage.input_tokens + res.usage.output_tokens;
    this.emitter.emit("tokens", {
      agentId: "worldsmith",
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      matchTotalTokens: this.matchTokens.total,
    });

    const raw = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const candidate = clampDistrictCandidate(extractJson(raw), district);
    const parsed = DistrictPatch.safeParse(candidate);
    this.emitter.emit("agent_status", { agentId: "worldsmith", status: "idle" });
    if (!parsed.success) {
      this.emitter.emit("log", {
        agentId: "worldsmith",
        level: "info",
        text: `the Worldsmith's vision of ${district || "the heartlands"} would not hold`,
      });
      return;
    }
    this.emitter.emit("theme_patch", { patch: parsed.data });
    this.wsNamings.push(`${district || "the heartlands"} → ${parsed.data.name} — ${parsed.data.epithet}`);
    if (this.wsNamings.length > 12) this.wsNamings.shift();
    this.emitter.emit("log", {
      agentId: "worldsmith",
      level: "info",
      text: `⟡ The Worldsmith names ${parsed.data.name} — “${parsed.data.epithet}”`,
    });
  }

  async requestPatch(): Promise<{ patch: string; stat: string }> {
    return this.opts.executor.diff();
  }

  /** Archive the settlement: emit the closing chronicle entry. */
  end(): void {
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.wsTimer = null;
    this.wsCalls = 8; // the Worldsmith rests
    for (const t of this.reprobeTimers.values()) clearTimeout(t);
    this.reprobeTimers.clear();
    this.reprobeCalls = 400; // the surveyors rest
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

const MUNDANE_DISTRICTS = new Set(["node_modules", ".git", "dist", "build", "vendor", "coverage", ".venv", "__pycache__"]);

/** Top-level directory a path belongs to; "" = repo root; null = not worth theming. */
function districtOf(path: string, isDir: boolean): string | null {
  const clean = path.replace(/^\.\/?/, "").replace(/\/+$/, "");
  if (clean === "" || clean === ".") return "";
  const parts = clean.split("/").filter(Boolean);
  const head = parts[0]!;
  if (MUNDANE_DISTRICTS.has(head)) return null;
  if (parts.length === 1) return isDir ? head : "";
  return head;
}

/** Best-effort JSON extraction: strips fences, grabs the outermost object. */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return {};
  }
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const clampNum = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/** Coerce an LLM candidate toward the DistrictPatch bounds; zod has final say. */
function clampDistrictCandidate(raw: unknown, district: string): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const c = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : v);
  const prim = (p: unknown) => {
    if (typeof p !== "object" || p === null) return null;
    const q = p as Record<string, unknown>;
    if (typeof q.color !== "string" || !HEX_RE.test(q.color)) return null;
    return {
      shape: q.shape,
      w: clampNum(q.w, 2, 48, 8),
      h: clampNum(q.h, 2, 72, 12),
      color: q.color,
      tilt: clampNum(q.tilt, -30, 30, 0),
    };
  };
  const silhouette = (v: unknown) =>
    Array.isArray(v) ? v.map(prim).filter((x): x is NonNullable<ReturnType<typeof prim>> => x !== null).slice(0, 6) : v;
  return {
    version: 1,
    district,
    name: str(c.name, 48),
    epithet: str(c.epithet, 160),
    groundTint: c.groundTint,
    accent: typeof c.accent === "string" && HEX_RE.test(c.accent) ? c.accent : undefined,
    props: Array.isArray(c.props)
      ? c.props.slice(0, 4).map((p) => {
          if (typeof p !== "object" || p === null) return p;
          const q = p as Record<string, unknown>;
          const d = Number(q.density);
          return {
            silhouette: silhouette(q.silhouette),
            density: Number.isFinite(d) ? Math.min(1, Math.max(0, d)) : 0.3,
            placement: q.placement,
            glow: q.glow,
          };
        })
      : undefined,
    landmarks: Array.isArray(c.landmarks)
      ? c.landmarks.slice(0, 2).map((l) => {
          if (typeof l !== "object" || l === null) return l;
          const q = l as Record<string, unknown>;
          return { name: str(q.name, 48), lore: str(q.lore, 240), silhouette: silhouette(q.silhouette), glow: q.glow };
        })
      : undefined,
    questHooks: Array.isArray(c.questHooks)
      ? c.questHooks.slice(0, 4).map((h) => {
          if (typeof h !== "object" || h === null) return h;
          const q = h as Record<string, unknown>;
          const line = Number(q.line);
          return {
            label: str(q.label, 80),
            path: str(q.path, 200),
            line: Number.isInteger(line) && line > 0 ? line : undefined,
            snippet: str(q.snippet, 200),
          };
        })
      : undefined,
  };
}
