// Prove the Crown-funded path in production: host a settlement over ws,
// receive the sandbox hostToken, then make one micro LLM call through the
// relay proxy (server-held OpenRouter key, Grok 4.6).
import WebSocket from "ws";

const RELAY = "https://crab-wise.fly.dev";
const ws = new WebSocket(RELAY.replace(/^http/, "ws") + "/ws");
const msgs = [];
ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
ws.send(JSON.stringify({ type: "host", protocolVersion: 1, taskId: "sample:repel-the-invasion", taskTitle: "funded-test", repoUrl: "sample:repel-the-invasion" }));

const waitFor = async (type, ms = 90000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = msgs.find((m) => m.type === type);
    if (m) return m;
    if (msgs.find((m) => m.type === "sandbox_error")) throw new Error(JSON.stringify(msgs.at(-1)));
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${type}; got ${JSON.stringify(msgs.map((m) => m.type))}`);
};
const { matchId } = await waitFor("hosted");
const { token } = await waitFor("sandbox_ready");
console.log("✔ settlement", matchId, "sandbox ready");

// Unauthorized call must be rejected.
const bad = await fetch(`${RELAY}/api/llm/${matchId}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
console.log(bad.status === 403 ? "✔ no-token call rejected (403)" : `✖ expected 403, got ${bad.status}`);

// Funded call: model field is pinned server-side no matter what we send.
const res = await fetch(`${RELAY}/api/llm/${matchId}/v1/messages`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-x-hax", max_tokens: 200, messages: [{ role: "user", content: "Say READY and name your model family in five words or fewer." }] }),
});
const body = await res.json();
const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
console.log(res.ok ? `✔ funded LLM reply (${body.model}): ${text.slice(0, 120)}` : `✖ ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
ws.close();
process.exit(0);
