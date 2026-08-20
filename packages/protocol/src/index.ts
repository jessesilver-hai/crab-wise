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
// Theme pack — LLM-generated per-repo world skin
// ---------------------------------------------------------------------------

/**
 * A pixel sprite drawn by the LLM: rows of characters indexing into the
 * palette; "." is transparent. Rendered client-side into textures.
 */
export const PixelSprite = z.object({
  /** e.g. "villager", "hero", "raider", "tree", "tile", "house", "barracks", … */
  key: z.string(),
  rows: z.array(z.string().max(40)).min(4).max(40),
  palette: z.record(z.string().length(1), z.string().regex(/^#[0-9a-fA-F]{6}$/)),
});
export type PixelSprite = z.infer<typeof PixelSprite>;

// ---------------------------------------------------------------------------
// WorldSpec — bounded LLM-authored world geometry (Level 2 agentic worlds).
// The engine is fixed code; a world is pure data. Anything that fails this
// schema falls back to the nearest archetype client-side.
// ---------------------------------------------------------------------------

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Fixed drawing vocabulary; the renderer composes these into textures. */
export const PrimitiveShape = z.enum([
  "slab",
  "obelisk",
  "arch",
  "mast",
  "orb",
  "shard",
  "frond",
  "coil",
  "ring",
  "beam",
]);
export type PrimitiveShape = z.infer<typeof PrimitiveShape>;

export const Primitive = z.object({
  shape: PrimitiveShape,
  /** Logical canvas px; the renderer rescales composed silhouettes to fit. */
  w: z.number().int().min(2).max(48),
  h: z.number().int().min(2).max(72),
  color: Hex,
  /** Degrees around the base point. */
  tilt: z.number().min(-30).max(30),
});
export type Primitive = z.infer<typeof Primitive>;

export const WorldProp = z.object({
  silhouette: z.array(Primitive).min(1).max(6),
  density: z.number().min(0).max(1),
  placement: z.enum(["ridges", "edges", "scatter", "districts"]),
  glow: z
    .object({ color: Hex, pulseSec: z.number().min(2).max(20) })
    .optional(),
});
export type WorldProp = z.infer<typeof WorldProp>;

export const BuildingSpec = z.object({
  /** Stacked bottom-to-top into the structure's body. */
  silhouette: z.array(Primitive).min(1).max(5),
  roofColor: Hex,
  wallColor: Hex,
  emissive: Hex.optional(),
});
export type BuildingSpec = z.infer<typeof BuildingSpec>;

export const WorldSpec = z.object({
  version: z.literal(1),
  lore: z.object({
    placeName: z.string().max(60),
    epithet: z.string().max(200),
    /** Fake-streamed loading narration; each line herald-logged. */
    loadingLines: z.array(z.string().max(160)).min(3).max(6),
  }),
  sky: z.object({
    top: Hex,
    horizon: Hex,
    hazeAlpha: z.number().min(0).max(0.5),
  }),
  terrain: z.object({
    /** Ground ramp, darkest to lightest. */
    base: z.array(Hex).min(3).max(6),
    pattern: z.enum(["plates", "dunes", "floes", "moss", "tessellae", "shale"]),
    reliefIntensity: z.number().min(0).max(1),
    waterline: z
      .object({ color: Hex, coverage: z.number().min(0).max(0.35) })
      .optional(),
  }),
  props: z.array(WorldProp).max(12),
  /** Per building kind; absent kinds keep archetype defaults. */
  architecture: z.object({
    house: BuildingSpec.optional(),
    barracks: BuildingSpec.optional(),
    market: BuildingSpec.optional(),
    monastery: BuildingSpec.optional(),
    mill: BuildingSpec.optional(),
    towncenter: BuildingSpec.optional(),
  }),
  ambience: z.object({
    particles: z.enum(["embers", "mist", "snow", "spores", "dust", "rain", "none"]),
    tint: Hex,
    rate: z.number().min(0).max(1),
    skyEvents: z
      .object({
        kind: z.enum(["flare", "drift", "aurora", "birds"]),
        everySec: z.number().min(20).max(120),
      })
      .optional(),
  }),
  units: z.object({
    villagerTint: Hex,
    heroTint: Hex,
    raiderTint: Hex,
    /** Scales the walk bob amplitude. */
    gaitBounce: z.number().min(0).max(1),
  }),
});
export type WorldSpec = z.infer<typeof WorldSpec>;

export const ThemePack = z.object({
  factionName: z.string().max(60),
  tagline: z.string().max(160),
  kingName: z.string().max(48),
  /** What failing tests / broken builds are called, e.g. "gremlins". */
  enemyName: z.string().max(32),
  biome: z.object({
    grassColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(6),
    fogColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    /** World-form; selects terrain patterning, prop sets, and ambient weather client-side. */
    archetype: z
      .enum(["ash-steppe", "harbor-citadel", "oracle-forge", "glacier-vault", "verdant-ruin", "dune-monolith"])
      .optional(),
  }),
  heraldOpeners: z.array(z.string().max(60)).min(2).max(8),
  heraldClosers: z.array(z.string().max(60)).min(2).max(8),
  personas: z
    .array(
      z.object({
        name: z.string().max(40),
        title: z.string().max(48),
        quirk: z.string().max(120),
      }),
    )
    .min(3)
    .max(8),
  sprites: z.array(PixelSprite).max(14),
  /** Optional composed world geometry; invalid specs are dropped, not fatal. */
  worldSpec: WorldSpec.optional(),
  /**
   * Isomorphism overrides: the Worldsmith may bend the census-derived world
   * DNA, but every choice must express a measured code fact (the charge asks
   * it to cite them in worldLore). Unknown/invalid values fall back to DNA.
   */
  world: z
    .object({
      timeOfDay: z.enum(["dawn", "noon", "dusk", "night"]).optional(),
      vegetation: z.enum(["barren", "sparse", "wooded", "lush"]).optional(),
      /** Examine-lore lines tying visuals to code facts, e.g. the walls to the test ratio. */
      worldLore: z.array(z.object({ subject: z.string().max(40), line: z.string().max(200) })).max(10).optional(),
    })
    .optional(),
});
export type ThemePack = z.infer<typeof ThemePack>;

// ---------------------------------------------------------------------------
// Repo tree (drives map generation)
// ---------------------------------------------------------------------------

export type FileNode = {
  name: string;
  path: string;
  kind: "file" | "dir";
  /** Measured line count (text files only) — drives building size + treemap area. */
  lines?: number;
  children?: FileNode[];
};

export const FileNode: z.ZodType<FileNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(["file", "dir"]),
    lines: z.number().int().nonnegative().optional(),
    children: z.array(FileNode).optional(),
  }),
);

// ---------------------------------------------------------------------------
// Game events — every agent action becomes exactly one of these.
// Events are sanitized by construction: no API keys, no raw prompts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// District patches — the Worldsmith deepens revealed regions incrementally.
// Same regime as WorldSpec: bounded, validated, discardable without harm.
// ---------------------------------------------------------------------------

export const DistrictLandmark = z.object({
  name: z.string().max(48),
  /** Clickable in-world lore for this landmark. */
  lore: z.string().max(240),
  silhouette: z.array(Primitive).min(1).max(6),
  glow: z.object({ color: Hex, pulseSec: z.number().min(2).max(20) }).optional(),
});
export type DistrictLandmark = z.infer<typeof DistrictLandmark>;

/** A discoverable planted from real repo content (TODO/FIXME etc.). */
export const QuestHook = z.object({
  label: z.string().max(80),
  path: z.string().max(200),
  line: z.number().int().positive().optional(),
  /** The actual source line that spawned this hook. */
  snippet: z.string().max(200),
});
export type QuestHook = z.infer<typeof QuestHook>;

export const DistrictPatch = z.object({
  version: z.literal(1),
  /** Repo-relative directory this patch reskins, "" = repo root. */
  district: z.string().max(200),
  name: z.string().max(48),
  epithet: z.string().max(160),
  groundTint: Hex,
  accent: Hex.optional(),
  props: z.array(WorldProp).max(4).optional(),
  landmarks: z.array(DistrictLandmark).max(2).optional(),
  questHooks: z.array(QuestHook).max(4).optional(),
});
export type DistrictPatch = z.infer<typeof DistrictPatch>;

const base = {
  seq: z.number().int().nonnegative(),
  ts: z.number(), // epoch ms
};

/** One bounded fact-probe hit from the workspace (Castle Era FACT_SCAN law). */
export const ProbeKind = z.enum(["color", "route", "table"]);
export type ProbeKind = z.infer<typeof ProbeKind>;

export const ProbeHit = z.object({
  path: z.string(),
  probe: ProbeKind,
  /** color: "#rrggbb" · route: method/handler token · table: entity name. */
  value: z.string().max(120),
});
export type ProbeHit = z.infer<typeof ProbeHit>;

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
  /** Founding-time import survey: real edges become the street law (v3). */
  depEdges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  /** Founding-time fact survey: measured colors/routes/tables (Castle Era). */
  probeHits: z.array(ProbeHit).optional(),
  /** Castle Era: prior ledger of a persistent castle — claims never move. */
  castleLedger: z.unknown().optional(),
});

/** The LLM-generated world skin arrived (may follow match_started by a while). */
export const ThemeReadyEvent = z.object({
  ...base,
  type: z.literal("theme_ready"),
  theme: ThemePack,
});

/** The player (settlement host) issued an order or spoke to an agent. */
export const DecreeEvent = z.object({
  ...base,
  type: z.literal("decree"),
  /** Target agent id; absent = addressed to the whole realm (routed to the King). */
  toId: z.string().optional(),
  text: z.string().max(4000),
});

/** Session lifecycle phases for the UI status line. */
export const SessionStatusEvent = z.object({
  ...base,
  type: z.literal("session_status"),
  phase: z.enum(["provisioning", "cloning", "theming", "idle", "working"]),
  detail: z.string().optional(),
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
  /** Live progress line, e.g. "reads src/parser.js" — transient in the UI. */
  detail: z.string().max(160).optional(),
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
  /** Compact ±-prefixed change excerpt for live inspection feeds (edits and new files). */
  diffSnippet: z.string().max(2000).optional(),
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

/** An agent inscribed a presentable artifact (report, chart, chronicle). */
export const ScrollFormat = z.enum(["markdown", "svg"]);
export type ScrollFormat = z.infer<typeof ScrollFormat>;

export const ScrollEvent = z.object({
  ...base,
  type: z.literal("scroll"),
  scrollId: z.string(),
  authorId: z.string(),
  authorName: z.string().max(60),
  title: z.string().max(80),
  format: ScrollFormat,
  /** Untrusted agent output; the web client sanitizes before rendering. */
  content: z.string().max(24000),
});

/** Direct conversation between the Crown and one agent. */
export const DialogueEvent = z.object({
  ...base,
  type: z.literal("dialogue"),
  agentId: z.string(),
  agentName: z.string().max(60),
  from: z.enum(["crown", "agent"]),
  text: z.string().max(2000),
});

/** The Worldsmith resolved a revealed district into itself. */
export const ThemePatchEvent = z.object({
  ...base,
  type: z.literal("theme_patch"),
  patch: DistrictPatch,
});

/**
 * Castle Era: a file's fact probes were re-taken after a write. The client
 * folds these into the owning component's facts and repaints its element —
 * the live isomorphism loop (css color → manor tint) rides this event.
 */
export const ComponentFactsEvent = z.object({
  ...base,
  type: z.literal("component_facts"),
  path: z.string(),
  /** Full replacement set of hits for this path (may be empty). */
  hits: z.array(ProbeHit).max(64),
});
export type ComponentFactsEvent = z.infer<typeof ComponentFactsEvent>;

/**
 * Castle Era: the representation loop chose a component's castle form.
 * The form must be lawful for the kind (ALLOWED_FORMS) — the client falls
 * back to the default form when it is not. `cited` is the one-line reason
 * the spectator reads when inspecting the element.
 */
export const CastleReprEvent = z.object({
  ...base,
  type: z.literal("castle_repr"),
  componentId: z.string(),
  form: z.string().max(40),
  cited: z.string().max(240),
  /**
   * Optional design genome (bounded axes: massing, roof, material, openings,
   * ornament, dressing). Carried opaque here; the genome law validates and
   * clamps every field client-side — unlawful values fall to the derived
   * default, so a malformed genome can never break the castle.
   */
  genome: z.record(z.unknown()).optional(),
});
export type CastleReprEvent = z.infer<typeof CastleReprEvent>;

/**
 * Castle Era: the Master Builder declared the castle's design language —
 * a named, cited StyleGenome (material/roof/trim biases, nature, wall,
 * grounds, fog). Opaque here; the genome law validates it client-side and
 * refuses unnamed or uncited styles.
 */
export const CastleStyleEvent = z.object({
  ...base,
  type: z.literal("castle_style"),
  style: z.record(z.unknown()),
});
export type CastleStyleEvent = z.infer<typeof CastleStyleEvent>;

/**
 * Castle Era: the maker's marks a worker may leave on a construction. The
 * vocabulary lives here because the runtime's sign_work tool teaches it and
 * the web-side flourish law validates against it.
 */
export const FLOURISH_MARKS = [
  "lantern",
  "garden",
  "gargoyle",
  "forgefire",
  "pennant",
  "windchime",
  "beehive",
  "mosaic",
] as const;

/**
 * Castle Era: a worker signs the wing they truly worked in — a small cited
 * flourish. `path` is a file the author touched; the castle law resolves it
 * to a construction and refuses marks on wings the author never entered.
 * `mark` rides loose (like genomes): the flourish law validates client-side.
 */
export const CastleFlourishEvent = z.object({
  ...base,
  type: z.literal("castle_flourish"),
  agentId: z.string(),
  /** The signing worker's name — replays carry it whole. */
  author: z.string().max(60),
  path: z.string(),
  mark: z.string().max(24),
  cited: z.string().max(240),
});
export type CastleFlourishEvent = z.infer<typeof CastleFlourishEvent>;

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
  ThemeReadyEvent,
  DecreeEvent,
  SessionStatusEvent,
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
  ScrollEvent,
  DialogueEvent,
  ThemePatchEvent,
  ComponentFactsEvent,
  CastleReprEvent,
  CastleStyleEvent,
  CastleFlourishEvent,
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
    /** Git URL, "sample:<id>", "new:<slug>" or "castle:<id>". Absent for demo sessions. */
    repoUrl: z.string().optional(),
    /** Castle Era: found upon an existing castle — its bundle seeds the clone. */
    castleId: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal("publish"), event: GameEvent }),
  // Ending is intentional: save=true inters the world among the prior worlds;
  // save=false (or a vanished host) discards it entirely.
  z.object({
    type: z.literal("end"),
    save: z.boolean().optional(),
    /** Castle Era: a saved castle carries its ledger and workspace onward. */
    castle: z
      .object({ id: z.string().max(64), name: z.string().max(80), ledger: z.unknown() })
      .optional(),
  }),
]);
export type HostMessage = z.infer<typeof HostMessage>;

// ---------------------------------------------------------------------------
// Sandbox API (browser -> relay proxy -> sandboxd), REST bodies
// ---------------------------------------------------------------------------

export const SandboxExecResult = z.object({
  exitCode: z.number(),
  output: z.string(),
  timedOut: z.boolean(),
});
export type SandboxExecResult = z.infer<typeof SandboxExecResult>;

/** Spectator -> relay */
export const SpectatorMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("watch"), matchId: z.string() }),
]);
export type SpectatorMessage = z.infer<typeof SpectatorMessage>;

/** Relay -> clients */
export const RelayMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hosted"), matchId: z.string() }),
  /** Sandbox provisioned and repo cloned; token authorizes /api/sandbox calls. */
  z.object({ type: z.literal("sandbox_ready"), token: z.string() }),
  z.object({ type: z.literal("sandbox_error"), message: z.string() }),
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

/**
 * What a district LOOKS like: each top-level directory renders as a distinct
 * quarter of the settlement, judged by its name and a sample of its files.
 */
export const DistrictArchetype = z.enum([
  "quarter", // source code — artisan houses, workshops
  "proving", // tests — training grounds: targets, dummies, banners
  "scriptorium", // docs — library, lecterns, scroll racks
  "granary", // config/data — stores, silos, market stalls
  "watchtower", // CI/workflows — walls and towers
  "forge", // build/tooling/scripts — furnaces, anvils
  "bazaar", // assets/static/media — stalls, banners, crates
]);
export type DistrictArchetype = z.infer<typeof DistrictArchetype>;

export function districtArchetype(dirName: string, fileNames: string[] = []): DistrictArchetype {
  const d = dirName.toLowerCase().replace(/\/$/, "");
  if (/^(tests?|__tests__|spec|specs|e2e|cypress)$/.test(d)) return "proving";
  if (/^(docs?|documentation|wiki|examples?|guides?)$/.test(d)) return "scriptorium";
  if (/^(\.github|\.gitlab|\.circleci|ci|workflows)$/.test(d)) return "watchtower";
  if (/^(scripts?|tools?|build|bin|make|gradle|maven)$/.test(d)) return "forge";
  if (/^(assets?|static|public|images?|img|media|fonts?|sounds?|textures?)$/.test(d)) return "bazaar";
  if (/^(config|configs?|data|fixtures|locales?|i18n|migrations)$/.test(d)) return "granary";
  const files = fileNames.map((f) => f.toLowerCase());
  const of = (re: RegExp) => files.filter((f) => re.test(f)).length;
  const n = Math.max(1, files.length);
  if (of(/\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|test_.*\.py$/) / n > 0.4) return "proving";
  if (of(/\.(md|rst|txt|adoc)$/) / n > 0.5) return "scriptorium";
  if (of(/\.(json|ya?ml|toml|ini|cfg|csv)$/) / n > 0.5) return "granary";
  if (of(/\.(png|jpe?g|gif|svg|webp|ico|mp[34]|woff2?|ttf)$/) / n > 0.4) return "bazaar";
  return "quarter";
}

// ---------------------------------------------------------------------------
// Skills — agents earn XP from real deeds (shared by live view and replays).
// Levels follow the classic RuneScape curve, capped at 99.
// ---------------------------------------------------------------------------

export const SKILLS = {
  Lorecraft: 0x3fa7d6, // reading files
  Forgecraft: 0xe8873c, // writing files
  Wayfaring: 0x7bc96f, // exploring dirs, searching
  Trialcraft: 0xc84b4b, // running commands
  Slaying: 0x9d5bd2, // clearing bounties (granted by the ledger keeper)
  Diplomacy: 0xd8c25a, // messages and dialogue
} as const;
export type SkillName = keyof typeof SKILLS;

// XP_TABLE[l-1] = cumulative XP required to hold level l.
const XP_TABLE: number[] = (() => {
  const t = [0];
  let points = 0;
  for (let lvl = 1; lvl < 99; lvl++) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    t.push(Math.floor(points / 4));
  }
  return t;
})();

export function xpForLevel(level: number): number {
  return XP_TABLE[Math.max(1, Math.min(99, Math.floor(level))) - 1]!;
}

export function levelForXp(xp: number): number {
  let lvl = 1;
  while (lvl < 99 && XP_TABLE[lvl]! <= xp) lvl++;
  return lvl;
}

export type XpDrop = {
  agentId: string;
  skill: SkillName;
  xp: number;
  /** Set when this grant crossed a level boundary. */
  leveledTo?: number;
};

export type SkillStats = { total: number; top: [SkillName, number][] };

export class SkillBook {
  private xp = new Map<string, Map<SkillName, number>>();

  grant(agentId: string, skill: SkillName, amount: number): XpDrop {
    const book = this.xp.get(agentId) ?? new Map<SkillName, number>();
    this.xp.set(agentId, book);
    const before = book.get(skill) ?? 0;
    const after = before + Math.max(0, Math.round(amount));
    book.set(skill, after);
    const drop: XpDrop = { agentId, skill, xp: after - before };
    const lvl = levelForXp(after);
    if (lvl > levelForXp(before)) drop.leveledTo = lvl;
    return drop;
  }

  /** Deterministic XP for a game event; Slaying is granted separately on bounty clears. */
  apply(e: GameEvent): XpDrop[] {
    switch (e.type) {
      case "file_read":
        return [this.grant(e.agentId, "Lorecraft", 25 + Math.min(25, Math.floor((e.lines ?? 0) / 40)))];
      case "file_write":
        return [this.grant(e.agentId, "Forgecraft", 40 + Math.min(40, Math.floor((e.linesAdded + e.linesRemoved) / 10)))];
      case "list_dir":
        return [this.grant(e.agentId, "Wayfaring", 15)];
      case "search":
        return [this.grant(e.agentId, "Wayfaring", 10 + Math.min(15, e.matchCount))];
      case "command_run":
        return [this.grant(e.agentId, "Trialcraft", 30)];
      case "message":
        return [this.grant(e.fromId, "Diplomacy", 20)];
      default:
        return [];
    }
  }

  stats(agentId: string): SkillStats {
    const book = this.xp.get(agentId);
    const levels: [SkillName, number][] = (Object.keys(SKILLS) as SkillName[]).map((s) => [
      s,
      levelForXp(book?.get(s) ?? 0),
    ]);
    const total = levels.reduce((a, [, l]) => a + l, 0);
    const top = levels
      .filter(([, l]) => l > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    return { total, top };
  }
}

/** OSRS-style examine text: terse, dry, deterministic per path. */
export function examineLine(path: string, lines: number | undefined, archetype: DistrictArchetype): string {
  const flavors: Record<DistrictArchetype, string[]> = {
    quarter: ["A hall of the artisan quarter.", "Somebody works hard in here.", "The lamps burn late here."],
    proving: ["The proving grounds test all comers.", "Straw dummies bear old wounds.", "Banners of trials past."],
    scriptorium: ["Ink, vellum, and patience.", "The scribes guard their commas.", "Knowledge, shelved and dusted."],
    granary: ["Stores for the lean seasons.", "Counted twice, sealed once.", "The quartermaster's pride."],
    watchtower: ["Eyes on every road.", "The watch never sleeps.", "Signal fires stand ready."],
    forge: ["The anvils never cool.", "Soot and sparks and purpose.", "Hammer-song at all hours."],
    bazaar: ["Wares from distant lands.", "Everything has a price.", "Bright cloth over old stone."],
  };
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  const flavor = flavors[archetype][h % flavors[archetype].length]!;
  const size = lines !== undefined ? ` ${lines} lines strong.` : "";
  return `${path} — ${flavor}${size}`;
}

// ---------------------------------------------------------------------------
// Bounties + renown (shared by web live view, relay Hall of Legends, replays)
// ---------------------------------------------------------------------------

export type Bounty = {
  name: string;
  value: number;
  status: "posted" | "cleared";
  clearedBy?: string;
};

export type LegendSummary = {
  renown: number;
  bountiesPosted: number;
  bountiesCleared: number;
  clearedValue: number;
  factionName?: string;
  result?: z.infer<typeof MatchResult>;
  goldSpent: number;
  title: string;
};

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A failing test's price on the bounty board. Deterministic so every client agrees. */
export function bountyValue(testName: string): number {
  return 100 + (fnv1a(testName) % 151);
}

export function renownTitle(renown: number, cleared: number): string {
  if (renown >= 600) return "Wardbreaker of the First Rank";
  if (renown >= 300) return "Wardbreaker";
  if (cleared >= 1) return "Specter-Bane";
  return "Settler";
}

/**
 * Folds the event stream into a bounty board: the first failing test run posts
 * bounties (one per named failure), later runs clear the ones that stop
 * failing. Unnamed failures fall back to count-based synthetic bounties.
 */
export class BountyLedger {
  private byName = new Map<string, Bounty>();
  private agentNames = new Map<string, string>();
  private posted = false;
  private syntheticCount = 0;
  goldSpent = 0;
  result?: z.infer<typeof MatchResult>;
  factionName?: string;

  /** Returns bounties newly posted/cleared by this event, for live feeds. */
  apply(e: GameEvent): { postedNow: Bounty[]; clearedNow: Bounty[] } {
    const postedNow: Bounty[] = [];
    const clearedNow: Bounty[] = [];
    switch (e.type) {
      case "agent_spawned":
        this.agentNames.set(e.agentId, e.name);
        break;
      case "tokens":
        this.goldSpent = e.matchTotalTokens;
        break;
      case "theme_ready":
        this.factionName = e.theme.factionName;
        break;
      case "match_ended":
        this.result = e.result;
        break;
      case "command_result": {
        if (e.kind !== "test" || e.testsFailed === undefined) break;
        const failingNow = new Set(
          (e.failures ?? []).map((f) => f.name.slice(0, 160)).filter((n) => n.length > 0),
        );
        const by = this.agentNames.get(e.agentId) ?? e.agentId;
        if (e.testsFailed === 0) {
          // Green board: every open bounty falls, named or synthetic.
          for (const b of this.byName.values()) {
            if (b.status === "posted") {
              b.status = "cleared";
              b.clearedBy = by;
              clearedNow.push(b);
            }
          }
          break;
        }
        const named = failingNow.size > 0;
        if (named) {
          // A named board supersedes count-based guesses: retract open synthetics
          // (deleted, not cleared — retraction must never mint renown).
          for (const [key, b] of this.byName) {
            if (b.status === "posted" && key.startsWith("specter #")) this.byName.delete(key);
          }
          for (const name of failingNow) {
            if (!this.byName.has(name)) {
              const b: Bounty = { name, value: bountyValue(name), status: "posted" };
              this.byName.set(name, b);
              postedNow.push(b);
            }
          }
          for (const b of this.byName.values()) {
            if (b.status === "posted" && !b.name.startsWith("specter #") && !failingNow.has(b.name)) {
              b.status = "cleared";
              b.clearedBy = by;
              clearedNow.push(b);
            }
          }
        } else {
          // Count-based fallback: keep exactly testsFailed synthetic bounties open.
          while (this.syntheticCount < e.testsFailed) {
            this.syntheticCount++;
            const name = `specter #${this.syntheticCount}`;
            const b: Bounty = { name, value: bountyValue(name), status: "posted" };
            this.byName.set(name, b);
            postedNow.push(b);
          }
          const open = [...this.byName.values()].filter(
            (b) => b.status === "posted" && b.name.startsWith("specter #"),
          );
          for (let i = open.length; i > e.testsFailed; i--) {
            const b = open[i - 1]!;
            b.status = "cleared";
            b.clearedBy = by;
            clearedNow.push(b);
          }
        }
        this.posted = this.posted || this.byName.size > 0;
        break;
      }
    }
    return { postedNow, clearedNow };
  }

  get bounties(): Bounty[] {
    return [...this.byName.values()];
  }

  summary(): LegendSummary {
    const all = this.bounties;
    const cleared = all.filter((b) => b.status === "cleared");
    const clearedValue = cleared.reduce((s, b) => s + b.value, 0);
    const renown = Math.max(
      0,
      clearedValue + (this.result === "victory" ? 200 : 0) - Math.floor(this.goldSpent / 2500),
    );
    return {
      renown,
      bountiesPosted: all.length,
      bountiesCleared: cleared.length,
      clearedValue,
      factionName: this.factionName,
      result: this.result,
      goldSpent: this.goldSpent,
      title: renownTitle(renown, cleared.length),
    };
  }
}

export type HallEntry = LegendSummary & {
  matchId: string;
  taskTitle: string;
  endedAt: number;
};

/** Fallback worker name pool (ancient-future register); themes override it. */
export const VILLAGER_NAMES = [
  "Ashka",
  "Veyra",
  "Odran",
  "Sable",
  "Imre",
  "Noor",
  "Talvi",
  "Ezel",
] as const;

export const ORCHESTRATOR_NAME = "The Hierophant";
