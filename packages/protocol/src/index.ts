import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Core identifiers
// ---------------------------------------------------------------------------

export const AgentRole = z.enum(["orchestrator", "worker"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum([
  "idle",
  "thinking",
  "moving",
  "scouting",
  "building",
  "fighting",
  "resting",
  "done",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** Building sprite category, derived from file path/type. */
export const BuildingKind = z.enum([
  "house", // generic source file
  "barracks", // test file
  "market", // API / server / routes
  "monastery", // docs / markdown
  "mill", // config / json / build files
  "towncenter", // package.json (repo heart)
]);
export type BuildingKind = z.infer<typeof BuildingKind>;

export const MatchResult = z.enum(["victory", "defeat", "abandoned"]);
export type MatchResult = z.infer<typeof MatchResult>;

// ---------------------------------------------------------------------------
// Repo tree (drives map generation)
// ---------------------------------------------------------------------------

export type FileNode = {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: FileNode[];
};

export const FileNode: z.ZodType<FileNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(["file", "dir"]),
    children: z.array(FileNode).optional(),
  }),
);

// ---------------------------------------------------------------------------
// Game events — every agent action becomes exactly one of these.
// Events are sanitized by construction: no API keys, no raw prompts.
// ---------------------------------------------------------------------------

const base = {
  seq: z.number().int().nonnegative(),
  ts: z.number(), // epoch ms
};

export const MatchStartedEvent = z.object({
  ...base,
  type: z.literal("match_started"),
  matchId: z.string(),
  task: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    /** AoE-style match blurb shown on the loading screen. */
    flavor: z.string(),
  }),
  mapSeed: z.number(),
  repoTree: FileNode,
});

export const AgentSpawnedEvent = z.object({
  ...base,
  type: z.literal("agent_spawned"),
  agentId: z.string(),
  role: AgentRole,
  /** Villager name, e.g. "Aldric the Builder". */
  name: z.string(),
  model: z.string(),
  /** Subtask this agent was charged with (herald-flavored + raw). */
  charge: z.string().optional(),
});

export const AgentStatusEvent = z.object({
  ...base,
  type: z.literal("agent_status"),
  agentId: z.string(),
  status: AgentStatus,
});

/** Agent's attention moved to a path; renderer walks the unit there. */
export const AgentMovedEvent = z.object({
  ...base,
  type: z.literal("agent_moved"),
  agentId: z.string(),
  path: z.string(),
});

export const FileReadEvent = z.object({
  ...base,
  type: z.literal("file_read"),
  agentId: z.string(),
  path: z.string(),
  lines: z.number().optional(),
});

export const SearchEvent = z.object({
  ...base,
  type: z.literal("search"),
  agentId: z.string(),
  query: z.string(),
  matchCount: z.number(),
  /** Paths where matches were found (fog lifts over these). */
  paths: z.array(z.string()),
});

export const ListDirEvent = z.object({
  ...base,
  type: z.literal("list_dir"),
  agentId: z.string(),
  path: z.string(),
});

export const FileWriteEvent = z.object({
  ...base,
  type: z.literal("file_write"),
  agentId: z.string(),
  path: z.string(),
  created: z.boolean(),
  linesAdded: z.number(),
  linesRemoved: z.number(),
  buildingKind: BuildingKind,
});

export const CommandKind = z.enum(["test", "install", "other"]);
export type CommandKind = z.infer<typeof CommandKind>;

export const CommandRunEvent = z.object({
  ...base,
  type: z.literal("command_run"),
  agentId: z.string(),
  command: z.string(),
  kind: CommandKind,
});

export const CommandResultEvent = z.object({
  ...base,
  type: z.literal("command_result"),
  agentId: z.string(),
  command: z.string(),
  kind: CommandKind,
  exitCode: z.number(),
  /** Short human summary, e.g. "3 failed, 9 passed". */
  summary: z.string(),
  testsFailed: z.number().optional(),
  testsPassed: z.number().optional(),
  /** Failing test names + best-guess file, drives raider placement. */
  failures: z
    .array(z.object({ name: z.string(), path: z.string().optional() }))
    .optional(),
});

export const MessageEvent = z.object({
  ...base,
  type: z.literal("message"),
  fromId: z.string(),
  /** Absent = broadcast to all agents. */
  toId: z.string().optional(),
  /** The real inter-agent message. */
  text: z.string(),
  /** AoE-herald flavored rendering of the same message. */
  herald: z.string(),
});

export const TokensEvent = z.object({
  ...base,
  type: z.literal("tokens"),
  agentId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** Running match total across all agents. */
  matchTotalTokens: z.number(),
});

export const ContextEvent = z.object({
  ...base,
  type: z.literal("context"),
  agentId: z.string(),
  usedTokens: z.number(),
  maxTokens: z.number(),
});

export const CompactionEvent = z.object({
  ...base,
  type: z.literal("compaction"),
  agentId: z.string(),
});

export const AgentDoneEvent = z.object({
  ...base,
  type: z.literal("agent_done"),
  agentId: z.string(),
  summary: z.string(),
});

export const MatchEndedEvent = z.object({
  ...base,
  type: z.literal("match_ended"),
  result: MatchResult,
  stats: z.object({
    goldSpent: z.number(), // total tokens
    buildingsRaised: z.number(), // files written
    raidersSlain: z.number(), // test failures fixed
    tilesExplored: z.number(), // files read
    durationMs: z.number(),
  }),
});

/** Raw entry for the honesty panel; truncated real tool output. */
export const LogEvent = z.object({
  ...base,
  type: z.literal("log"),
  agentId: z.string().optional(),
  level: z.enum(["info", "tool", "error"]),
  text: z.string(),
});

export const GameEvent = z.discriminatedUnion("type", [
  MatchStartedEvent,
  AgentSpawnedEvent,
  AgentStatusEvent,
  AgentMovedEvent,
  FileReadEvent,
  SearchEvent,
  ListDirEvent,
  FileWriteEvent,
  CommandRunEvent,
  CommandResultEvent,
  MessageEvent,
  TokensEvent,
  ContextEvent,
  CompactionEvent,
  AgentDoneEvent,
  MatchEndedEvent,
  LogEvent,
]);
export type GameEvent = z.infer<typeof GameEvent>;

// ---------------------------------------------------------------------------
// Relay wire protocol (client <-> relay websocket messages)
// ---------------------------------------------------------------------------

/** Host (player browser) -> relay */
export const HostMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host"),
    protocolVersion: z.number(),
    taskId: z.string(),
    taskTitle: z.string(),
  }),
  z.object({ type: z.literal("publish"), event: GameEvent }),
  z.object({ type: z.literal("end") }),
]);
export type HostMessage = z.infer<typeof HostMessage>;

/** Spectator -> relay */
export const SpectatorMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("watch"), matchId: z.string() }),
]);
export type SpectatorMessage = z.infer<typeof SpectatorMessage>;

/** Relay -> clients */
export const RelayMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hosted"), matchId: z.string() }),
  z.object({ type: z.literal("history"), matchId: z.string(), events: z.array(GameEvent) }),
  z.object({ type: z.literal("event"), event: GameEvent }),
  z.object({ type: z.literal("match_over") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type RelayMessage = z.infer<typeof RelayMessage>;

/** REST: GET /api/matches */
export const MatchSummary = z.object({
  matchId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  startedAt: z.number(),
  status: z.enum(["live", "finished"]),
  result: MatchResult.optional(),
  eventCount: z.number(),
  spectators: z.number(),
});
export type MatchSummary = z.infer<typeof MatchSummary>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Map a file path to the building sprite that represents it. */
export function buildingKindFor(path: string): z.infer<typeof BuildingKind> {
  const lower = path.toLowerCase();
  if (/(^|\/)package\.json$/.test(lower)) return "towncenter";
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower) || /(^|\/)(tests?|__tests__)\//.test(lower)) {
    return "barracks";
  }
  if (/(server|routes?|api|app)\.[cm]?[jt]sx?$/.test(lower) || /(^|\/)(routes?|api)\//.test(lower)) {
    return "market";
  }
  if (/\.(md|txt|rst)$/.test(lower)) return "monastery";
  if (/\.(json|ya?ml|toml|lock|cfg|rc)$/.test(lower) || /config/.test(lower)) return "mill";
  return "house";
}

/** Fixed villager name pool; deterministic per spawn order. */
export const VILLAGER_NAMES = [
  "Aldric",
  "Berta",
  "Cedric",
  "Doria",
  "Edmund",
  "Freya",
  "Godwin",
  "Hilda",
] as const;

export const ORCHESTRATOR_NAME = "King Refactor III";
