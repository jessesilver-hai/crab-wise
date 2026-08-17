// Replay + Hall of Legends integrity: spins a LOCAL relay (process sandbox
// driver, scratch hall file), drives synthetic event streams, and checks:
// spectator history fidelity, ledger fold, demo/zero-renown hall guards,
// hall persistence across restart, and theme-cache PUT validation.
// Run: node scripts/replay-hall-test.mjs
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import WebSocket from "ws";

const PORT = 8093;
const RELAY = `http://localhost:${PORT}`;
const HALL = "/tmp/ae-hall-test.json";
rmSync(HALL, { force: true });

let failures = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => {
  failures++;
  console.error(`  ✖ ${m}`);
};

function startRelay() {
  const child = spawn("npx", ["tsx", "apps/relay/src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), HALL_PATH: HALL, FLY_API_TOKEN: "", SANDBOX_APP: "", SANDBOX_IMAGE: "" },
    stdio: "ignore",
    detached: false,
  });
  return child;
}

async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${RELAY}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("relay never became healthy");
}

const ts = (seq) => ({ seq, ts: Date.now() });
function syntheticRun(withBounties) {
  const ev = [];
  let seq = 1;
  ev.push({ ...ts(seq++), type: "agent_spawned", agentId: "king", role: "orchestrator", name: "The Regent", model: "m" });
  ev.push({ ...ts(seq++), type: "agent_spawned", agentId: "w1", role: "worker", name: "Ashka", model: "m" });
  if (withBounties) {
    ev.push({ ...ts(seq++), type: "command_result", agentId: "w1", command: "npm test", kind: "test", exitCode: 1, summary: "2 failed", testsFailed: 2, testsPassed: 3, failures: [{ name: "test_alpha" }, { name: "test_beta" }] });
    ev.push({ ...ts(seq++), type: "file_write", agentId: "w1", path: "src/fix.js", created: false, linesAdded: 2, linesRemoved: 1, buildingKind: "house", diffSnippet: "- bad\n+ good" });
    ev.push({ ...ts(seq++), type: "command_result", agentId: "w1", command: "npm test", kind: "test", exitCode: 0, summary: "0 failed", testsFailed: 0, testsPassed: 5, failures: [] });
  }
  ev.push({ ...ts(seq++), type: "tokens", agentId: "w1", inputTokens: 10, outputTokens: 10, matchTotalTokens: 1200 });
  ev.push({ ...ts(seq++), type: "match_ended", result: withBounties ? "victory" : "abandoned", stats: { goldSpent: 1200, buildingsRaised: 1, raidersSlain: 2, tilesExplored: 3, durationMs: 900 } });
  return ev;
}

async function hostAndPublish(taskId, events, endMode = "close") {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const messages = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "host", protocolVersion: 1, taskId, taskTitle: `it: ${taskId}`, repoUrl: "https://example.com/x/y" }));
  const deadline = Date.now() + 10000;
  let matchId = null;
  while (Date.now() < deadline && !matchId) {
    matchId = messages.find((m) => m.type === "hosted")?.matchId ?? null;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!matchId) throw new Error("never hosted");
  for (const e of events) ws.send(JSON.stringify({ type: "publish", event: e }));
  await new Promise((r) => setTimeout(r, 400));
  // Ending is intentional: "save" inters the world, "burn" discards it, and a
  // raw close (host vanished) must also discard unless match_ended came through.
  if (endMode === "save") ws.send(JSON.stringify({ type: "end", save: true }));
  else if (endMode === "burn") ws.send(JSON.stringify({ type: "end", save: false }));
  await new Promise((r) => setTimeout(r, 200));
  ws.close();
  await new Promise((r) => setTimeout(r, 400));
  return matchId;
}

async function finishedIds() {
  const { finished } = await (await fetch(`${RELAY}/api/matches`)).json();
  return finished.map((m) => m.matchId);
}

async function spectateHistory(matchId) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const got = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "watch", matchId }));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const h = got.find((m) => m.type === "history");
    if (h) {
      ws.close();
      return h;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  ws.close();
  throw new Error("no history received");
}

console.log("Replay + Hall integrity (local relay)");
let relay = startRelay();
try {
  await waitHealthy();
  ok("local relay healthy");

  // 1. Demo matches never enter the hall, even with cleared bounties.
  const demoEvents = syntheticRun(true);
  await hostAndPublish("demo", demoEvents);
  let hall = await (await fetch(`${RELAY}/api/hall`)).json();
  if (hall.entries.length !== 0) bad(`demo match entered the hall: ${JSON.stringify(hall.entries)}`);
  else ok("demo matches excluded from the hall");

  // 2. Zero-renown sessions stay out; real cleared bounties get in.
  await hostAndPublish("real-idle", syntheticRun(false));
  hall = await (await fetch(`${RELAY}/api/hall`)).json();
  if (hall.entries.length !== 0) bad("zero-renown session entered the hall");
  else ok("zero-renown sessions excluded");

  const matchId = await hostAndPublish("real-win", syntheticRun(true));
  hall = await (await fetch(`${RELAY}/api/hall`)).json();
  if (hall.entries.length === 1 && hall.entries[0].renown > 0 && hall.entries[0].bountiesCleared === 2) {
    ok(`victorious session recorded (renown ${hall.entries[0].renown}, 2 bounties)`);
  } else bad(`hall wrong after victory: ${JSON.stringify(hall)}`);

  // 3. Spectator history fidelity: every published event comes back in order.
  const history = await spectateHistory(matchId);
  const want = syntheticRun(true).length;
  if (history.events.length !== want) bad(`history has ${history.events.length} events, expected ${want}`);
  else ok(`spectator history intact (${want} events)`);
  const seqs = history.events.map((e) => e.seq);
  if (seqs.every((s, i) => i === 0 || s >= seqs[i - 1])) ok("history ordering preserved");
  else bad("history out of order");

  // 4. Hall persists across relay restart.
  relay.kill();
  await new Promise((r) => setTimeout(r, 500));
  relay = startRelay();
  await waitHealthy();
  hall = await (await fetch(`${RELAY}/api/hall`)).json();
  if (hall.entries.length === 1) ok("hall persisted across restart");
  else bad(`hall lost on restart: ${hall.entries.length} entries`);

  // 5. Intentional saves: only a save=true farewell joins the prior worlds.
  const liveOnly = syntheticRun(false).filter((e) => e.type !== "match_ended");
  const savedId = await hostAndPublish("quit-saved", liveOnly, "save");
  const burnedId = await hostAndPublish("quit-burned", liveOnly, "burn");
  const vanishedId = await hostAndPublish("quit-vanished", liveOnly, "close");
  const ids = await finishedIds();
  if (ids.includes(savedId)) ok("saved quit joins the prior worlds");
  else bad(`saved quit missing from finished list: ${JSON.stringify(ids)}`);
  if (!ids.includes(burnedId)) ok("burned quit leaves no record");
  else bad("burned quit was listed");
  if (!ids.includes(vanishedId)) ok("vanished host leaves no record");
  else bad("vanished host was listed");
  const savedHistory = await spectateHistory(savedId);
  if (savedHistory.events.length === liveOnly.length) ok("saved world replays its chronicle");
  else bad(`saved world history ${savedHistory.events.length} events, expected ${liveOnly.length}`);

  // 7. The obituary race: settlement.end() emits match_ended{abandoned} just
  // before the explicit verdict lands. Burn must still raze the world — and
  // any legend the racy obituary wrote — but a true victory stays interred.
  const abandonedObit = syntheticRun(true).map((e) =>
    e.type === "match_ended" ? { ...e, result: "abandoned" } : e,
  );
  const racedBurnId = await hostAndPublish("raced-burn", abandonedObit, "burn");
  const racedIds = await finishedIds();
  if (!racedIds.includes(racedBurnId)) ok("burn outranks the abandoned obituary");
  else bad("raced burn was interred anyway");
  hall = await (await fetch(`${RELAY}/api/hall`)).json();
  if (!hall.entries.some((h) => h.matchId === racedBurnId)) ok("raced burn leaves no legend");
  else bad("raced burn kept its hall legend");
  const victoryBurnId = await hostAndPublish("victory-then-burn", syntheticRun(true), "burn");
  const vIds = await finishedIds();
  if (vIds.includes(victoryBurnId)) ok("a true victory cannot be razed");
  else bad("completed victory was razed by a burn message");

  // 6. Theme cache PUT validation: garbage → 422, never cached.
  const put = await fetch(`${RELAY}/api/theme/test-key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ factionName: 1, nonsense: true }),
  });
  if (put.status === 422) ok("invalid theme rejected with 422");
  else bad(`invalid theme PUT → ${put.status}`);
  const get = await fetch(`${RELAY}/api/theme/test-key`);
  if (get.status === 404) ok("rejected theme was not cached");
  else bad(`rejected theme retrievable → ${get.status}`);
} catch (err) {
  bad(String(err.message ?? err));
} finally {
  relay.kill();
}

console.log(failures === 0 ? "\nAll replay/hall checks passed." : `\n${failures} FAILURES`);
if (existsSync(HALL)) rmSync(HALL, { force: true });
process.exit(failures > 0 ? 1 : 0);
