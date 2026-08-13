// Deterministic end-to-end check of the relay + sandbox pipeline (no LLM):
// host a settlement over ws, receive the sandbox token, then exercise every
// sandboxd op through the relay proxy exactly as the browser runtime would.
import WebSocket from "ws";

const RELAY = process.env.RELAY_URL ?? "http://localhost:8080";
const WS = RELAY.replace(/^http/, "ws") + "/ws";

const fail = (msg) => {
  console.error("✖ " + msg);
  process.exit(1);
};
const ok = (msg) => console.log("✔ " + msg);

const ws = new WebSocket(WS);
const messages = [];
ws.on("message", (d) => messages.push(JSON.parse(String(d))));
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
ws.send(
  JSON.stringify({
    type: "host",
    protocolVersion: 1,
    taskId: "sample:repel-the-invasion",
    taskTitle: "E2E sandbox check",
    repoUrl: "sample:repel-the-invasion",
  }),
);

const waitFor = async (type, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((m) => m.type === type);
    if (found) return found;
    const error = messages.find((m) => m.type === "sandbox_error" || m.type === "error");
    if (error && type !== error.type) fail(`relay error: ${JSON.stringify(error)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`timed out waiting for ${type}; got ${JSON.stringify(messages.map((m) => m.type))}`);
};

const { matchId } = await waitFor("hosted");
ok(`hosted match ${matchId}`);
const { token } = await waitFor("sandbox_ready");
ok("sandbox provisioned");

const call = async (op, body) => {
  const res = await fetch(`${RELAY}/api/sandbox/${matchId}/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) fail(`${op} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
};

// clone sample
const { readme } = await call("clone", { url: "sample:repel-the-invasion" });
if (!readme || readme.length < 50) fail("clone returned no readme");
ok(`clone (readme ${readme.length} chars)`);

// tree
const { tree } = await call("tree");
const flat = JSON.stringify(tree);
if (!flat.includes("parser.js") || !flat.includes("tests")) fail("tree missing expected entries");
ok(`tree (${flat.length} bytes)`);

// read
const { content, lines } = await call("read", { path: "src/parser.js" });
if (!content.includes("function") || lines < 10) fail("read looks wrong");
ok(`read src/parser.js (${lines} lines)`);

// path escape must be rejected
const escapeRes = await fetch(`${RELAY}/api/sandbox/${matchId}/read`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ path: "../../etc/hosts" }),
});
if (escapeRes.ok) fail("path escape was NOT rejected");
ok("path escape rejected");

// bad token must be rejected
const badAuth = await fetch(`${RELAY}/api/sandbox/${matchId}/read`, {
  method: "POST",
  headers: { authorization: "Bearer wrong", "content-type": "application/json" },
  body: JSON.stringify({ path: "src/parser.js" }),
});
if (badAuth.status !== 403) fail(`bad token → ${badAuth.status}, expected 403`);
ok("bad host token rejected");

// search
const { hits } = await call("search", { query: "precedence" });
if (!hits.length) fail("search found nothing for 'precedence'");
ok(`search (${hits.length} hits)`);

// exec: run the failing test suite
const t0 = await call("exec", { command: "node --test --test-reporter=tap tests/*.test.js" });
if (t0.exitCode === 0) fail("sample tests unexpectedly green before fix");
if (!/not ok/.test(t0.output)) fail("no TAP failures in output");
ok(`exec tests (exit ${t0.exitCode}, failing as designed)`);

// write + diff
await call("write", { path: "NOTES.md", content: "# scratch\nsandbox e2e was here\n" });
const { patch, stat } = await call("diff");
if (!patch.includes("NOTES.md")) fail("diff missing written file");
ok(`write + diff (${stat})`);

// list
const { entries } = await call("list", { path: "." });
if (!entries.includes("src/")) fail("list missing src/");
ok("list");

ws.close();
console.log("\nAll sandbox E2E checks passed.");
process.exit(0);
