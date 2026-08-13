# AGENT EMPIRES

Point it at a repository. A civilization wakes upon the code — AI agents labor,
specters rise from failing tests, and you rule it all by decree.

Agent Empires is a public web experiment that turns real software-engineering
agent sessions into a live, spectatable real-time-strategy chronicle in an
**ancient-future** register (the mythic dread of Eggers, the monumental sci-fi
of Villeneuve). You bring an Anthropic API key, paste a public git URL, and a
settlement is founded on your repo:

- The **map** is generated from the repo tree — directories become territories,
  files become building plots, fog of war covers unexplored code.
- A **Hierophant** (orchestrator agent) greets you and awaits orders. You speak
  in plain language from the command bar; he dispatches **worker agents** who
  read, search, edit, and run commands — every tool call rendered as scouting,
  construction, and battle.
- **Failing tests spawn specters** beside the offending structures; a green run
  routs them. Tokens drain as gold; context pressure reads as hunger.
- Agents **message each other** (a real inter-agent bus) and the herald renders
  their traffic as liturgical dispatch — with the raw log one tab away.
- One LLM call **themes the whole world to your repo's vibe**: faction name,
  worker personas, herald lexicon, biome palette, and pixel sprites drawn by
  the model as palette-indexed grids. Themes are cached per repo.
- Anyone can **spectate** any living settlement; late joiners get the full
  chronicle replayed.
- When the work pleases you, download the session as a **`.patch`**.

## Trust model

**No key needed.** By default the Crown funds inference: the browser agent loop
calls the relay's LLM proxy, which forwards to OpenRouter (Grok 4.6) with a
server-held key. The proxy only answers the live host of a settlement (bearer
sandbox token), pins the model server-side, and caps calls per settlement.

**Bring your own Anthropic key and it never leaves your browser.** The agent
loop then calls Anthropic directly (their CORS browser-access header). Either
way, only *tool calls* (file reads/writes, shell commands) travel to the
server, which proxies them to an isolated, per-session sandbox VM with a hard
TTL. The relay receives sanitized game events only.

## Architecture

```
Player browser                        Relay (Fly)                 Sandbox VM (per session)
┌─────────────────────────┐          ┌───────────────────┐        ┌──────────────────────┐
│ agent loop + your key ──┼─────────▶│                   │        │ sandboxd (zero-dep)  │
│    │ tool calls         │   ws +   │ rooms · history   │  http  │ clone/read/write/    │
│    └────────────────────┼─────────▶│ sandbox manager ──┼───────▶│ search/exec/diff     │
│ Pixi isometric renderer │   REST   │ theme cache       │        │ git + node + python  │
└─────────────────────────┘          └───────────────────┘        └──────────────────────┘
        ▲ Anthropic API (direct)            │ broadcast ▼ spectators
```

- `apps/web` — Vite + PixiJS frontend: lobby, isometric renderer, command bar
- `apps/relay` — Fastify + ws: match rooms, event history, sandbox drivers
  (`process` for dev, Fly Machines for prod), theme cache
- `packages/protocol` — zod event schema shared by everything
- `packages/runtime` — browser agent runtime: interactive Settlement, executor
  abstraction, generalized test-output parsing (TAP/pytest/jest/go/cargo)
- `packages/sandboxd` — the tiny in-sandbox executor (single zero-dep file)
- `tasks/` — three built-in sample worlds (solvable, verified by
  `tasks/scripts/verify.mjs`)

## Run it locally

```bash
npm install
npm run dev:relay   # relay on :8080 (process sandbox driver — dev only)
npm run dev         # frontend on :5173
```

Open http://localhost:5173, paste an Anthropic key, pick a sample world or a
public git URL. `node scripts/e2e-sandbox.mjs` exercises the full sandbox
pipeline without spending tokens; the lobby's demo skirmish plays a scripted
match through the real relay.

## Deploy (Fly.io)

Two apps: the always-on relay and a sandbox app whose machines are created
per-session via the Machines API.

```bash
fly apps create crab-wise
fly apps create crab-wise-sandbox
fly deploy --config fly.toml                     # relay + frontend
fly deploy --app crab-wise-sandbox \
  --dockerfile infra/sandbox.Dockerfile --build-only --push \
  --image-label sandbox                          # push sandbox image
fly secrets set --app crab-wise \
  FLY_API_TOKEN=<deploy token for crab-wise-sandbox> \
  SANDBOX_APP=crab-wise-sandbox \
  SANDBOX_IMAGE=registry.fly.io/crab-wise-sandbox:sandbox
```

Abuse controls are deliberately blunt: hard session TTL (30 min), small
machines, a global sandbox cap, one settlement per IP.

## Honest limitations

- Public https git repos only; sandboxes include node/python toolchains (no JVM/Go/Rust yet).
- Test parsing is best-effort outside TAP/pytest/jest/go/cargo — unknown
  frameworks fall back to exit codes (one anonymous specter).
- The relay keeps rooms in memory; a restart forgets finished chronicles.
- If the host closes their tab, the settlement sleeps (spectators keep the log).
