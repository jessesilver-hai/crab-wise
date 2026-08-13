import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  GameEvent,
  HostMessage,
  SpectatorMessage,
  RelayMessage,
  MatchSummary,
  PROTOCOL_VERSION,
} from "@agent-empires/protocol";
import { SandboxManager, driverFromEnv } from "./sandbox.js";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_FINISHED_MATCHES = 50;
const MAX_EVENTS_PER_MATCH = 20_000;

// WebContainers in the player browser require cross-origin isolation.
// `credentialless` (not `require-corp`) keeps direct Anthropic fetches working.
const ISOLATION_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

type Match = {
  matchId: string;
  taskId: string;
  taskTitle: string;
  startedAt: number;
  status: "live" | "finished";
  result?: "victory" | "defeat" | "abandoned";
  events: GameEvent[];
  host: WebSocket | null;
  spectators: Set<WebSocket>;
};

const matches = new Map<string, Match>();
const sandboxes = new SandboxManager(driverFromEnv());

// In-memory theme cache: repeat visitors to the same repo pay no theming tokens.
const themeCache = new Map<string, string>();
const THEME_CACHE_MAX = 200;

function newMatchId(): string {
  const adjectives = ["iron", "gilded", "swift", "burning", "silent", "royal", "feral", "amber"];
  const nouns = ["keep", "siege", "raid", "banner", "harvest", "wonder", "rampart", "crusade"];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${a}-${n}-${suffix}`;
}

function send(ws: WebSocket, msg: RelayMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(match: Match, msg: RelayMessage) {
  for (const ws of match.spectators) send(ws, msg);
}

function summarize(m: Match): MatchSummary {
  return {
    matchId: m.matchId,
    taskId: m.taskId,
    taskTitle: m.taskTitle,
    startedAt: m.startedAt,
    status: m.status,
    result: m.result,
    eventCount: m.events.length,
    spectators: m.spectators.size,
  };
}

function finishMatch(match: Match, result: "victory" | "defeat" | "abandoned") {
  if (match.status === "finished") return;
  match.status = "finished";
  match.result = result;
  match.host = null;
  broadcast(match, { type: "match_over" });
  // Cap memory: evict oldest finished matches.
  const finished = [...matches.values()]
    .filter((m) => m.status === "finished")
    .sort((a, b) => a.startedAt - b.startedAt);
  while (finished.length > MAX_FINISHED_MATCHES) {
    const evict = finished.shift()!;
    matches.delete(evict.matchId);
  }
}

const app = Fastify({ logger: { level: "info" } });

app.addHook("onSend", async (_req, reply) => {
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) reply.header(k, v);
});

app.get("/api/matches", async () => {
  const all = [...matches.values()].sort((a, b) => b.startedAt - a.startedAt);
  return {
    live: all.filter((m) => m.status === "live").map(summarize),
    finished: all.filter((m) => m.status === "finished").slice(0, 20).map(summarize),
  };
});

app.get("/healthz", async () => ({ ok: true }));

// --- Sandbox tool-call proxy (host-only, bearer hostToken) -------------------

app.post<{ Params: { matchId: string; op: string } }>(
  "/api/sandbox/:matchId/:op",
  async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const hostToken = auth.replace(/^Bearer /, "");
    try {
      const result = await sandboxes.proxy(
        req.params.matchId,
        hostToken,
        req.params.op,
        req.body,
      );
      reply.code(result.status).header("content-type", "application/json").send(result.body);
    } catch (err) {
      reply.code(502).send({ error: `sandbox unreachable: ${String(err)}` });
    }
  },
);

// --- Theme cache --------------------------------------------------------------

app.get<{ Params: { repoKey: string } }>("/api/theme/:repoKey", async (req, reply) => {
  const cached = themeCache.get(req.params.repoKey);
  if (!cached) return reply.code(404).send({ error: "no cached theme" });
  reply.header("content-type", "application/json").send(cached);
});

app.put<{ Params: { repoKey: string } }>("/api/theme/:repoKey", async (req, reply) => {
  const body = JSON.stringify(req.body);
  if (body.length > 300_000) return reply.code(413).send({ error: "theme too large" });
  if (themeCache.size >= THEME_CACHE_MAX) {
    const oldest = themeCache.keys().next().value;
    if (oldest) themeCache.delete(oldest);
  }
  themeCache.set(req.params.repoKey, body);
  reply.send({ ok: true });
});

// Serve built frontend when present (production); dev uses Vite directly.
const webDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist, wildcard: false });
  // SPA fallback for /match/:id style routes.
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/ws")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.sendFile("index.html");
  });
}

await app.listen({ port: PORT, host: "0.0.0.0" });

// --- WebSocket handling ------------------------------------------------------

const wss = new WebSocketServer({ server: app.server, path: "/ws" });

wss.on("connection", (ws, req) => {
  let role: "host" | "spectator" | null = null;
  let match: Match | null = null;
  const ip = String(req.headers["fly-client-ip"] ?? req.socket.remoteAddress ?? "unknown");

  ws.on("message", (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      send(ws, { type: "error", message: "invalid json" });
      return;
    }

    if (role === null || role === "host") {
      const parsed = HostMessage.safeParse(raw);
      if (parsed.success) {
        const msg = parsed.data;
        if (msg.type === "host") {
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            send(ws, { type: "error", message: "protocol version mismatch; refresh the page" });
            return;
          }
          role = "host";
          match = {
            matchId: newMatchId(),
            taskId: msg.taskId,
            taskTitle: msg.taskTitle,
            startedAt: Date.now(),
            status: "live",
            events: [],
            host: ws,
            spectators: new Set(),
          };
          matches.set(match.matchId, match);
          send(ws, { type: "hosted", matchId: match.matchId });
          // General mode: provision a sandbox for the settlement.
          if (msg.repoUrl) {
            const target = match;
            sandboxes
              .provision(target.matchId, ip)
              .then(({ hostToken }) => send(ws, { type: "sandbox_ready", token: hostToken }))
              .catch((err) => send(ws, { type: "sandbox_error", message: String(err?.message ?? err) }));
          }
          return;
        }
        if (msg.type === "publish" && role === "host" && match) {
          if (match.events.length >= MAX_EVENTS_PER_MATCH) return;
          match.events.push(msg.event);
          broadcast(match, { type: "event", event: msg.event });
          if (msg.event.type === "match_ended") {
            finishMatch(match, msg.event.result);
          }
          return;
        }
        if (msg.type === "end" && role === "host" && match) {
          finishMatch(match, "abandoned");
          return;
        }
      }
    }

    if (role === null) {
      const parsed = SpectatorMessage.safeParse(raw);
      if (parsed.success && parsed.data.type === "watch") {
        const target = matches.get(parsed.data.matchId);
        if (!target) {
          send(ws, { type: "error", message: "match not found" });
          return;
        }
        role = "spectator";
        match = target;
        target.spectators.add(ws);
        send(ws, { type: "history", matchId: target.matchId, events: target.events });
        if (target.status === "finished") send(ws, { type: "match_over" });
        return;
      }
    }

    send(ws, { type: "error", message: "unrecognized message" });
  });

  ws.on("close", () => {
    if (!match) return;
    if (role === "spectator") {
      match.spectators.delete(ws);
    } else if (role === "host" && match.status === "live") {
      // The villagers have abandoned the town.
      finishMatch(match, "abandoned");
      sandboxes.hostDisconnected(match.matchId);
    } else if (role === "host") {
      void sandboxes.destroy(match.matchId);
    }
  });
});

console.log(`relay listening on :${PORT}`);
