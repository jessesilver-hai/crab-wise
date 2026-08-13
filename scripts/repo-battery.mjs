// Repo battery: exercise the production sandbox pipeline across a variety of
// real public repositories (sizes, languages, layouts). No LLM tokens spent.
// Run: RELAY_URL=https://crab-wise.fly.dev node scripts/repo-battery.mjs
import WebSocket from "ws";

const RELAY = process.env.RELAY_URL ?? "https://crab-wise.fly.dev";
const WS = RELAY.replace(/^http/, "ws") + "/ws";

const REPOS = [
  { url: "https://github.com/gabrielecirulli/2048", label: "2048 (tiny static JS)", expectFile: "index.html", search: "tile" },
  { url: "https://github.com/Hextris/hextris", label: "hextris (static game)", expectFile: "index.html", search: "canvas" },
  { url: "https://github.com/11ty/eleventy-base-blog", label: "eleventy-base-blog (node site)", expectFile: "package.json", search: "eleventy" },
  { url: "https://github.com/pallets/flask", label: "flask (python lib)", expectFile: "pyproject.toml", search: "Blueprint" },
  { url: "https://github.com/chalk/chalk", label: "chalk (node lib + tests)", expectFile: "package.json", search: "ansi" },
];

let failures = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => {
  failures++;
  console.error(`  ✖ ${m}`);
};
const t = () => Date.now();

async function runRepo({ url, label, expectFile, search }) {
  console.log(`\n▶ ${label}`);
  const ws = new WebSocket(WS);
  const messages = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  const host = () =>
    ws.send(JSON.stringify({ type: "host", protocolVersion: 1, taskId: url, taskTitle: `battery: ${label}`, repoUrl: url }));
  host();

  const waitFor = async (type, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find((m) => m.type === type);
      if (found) return found;
      const err = messages.find((m) => m.type === "sandbox_error" || m.type === "error");
      if (err) {
        // The previous session's machine may still be tearing down; retry.
        if (String(err.message ?? "").includes("one settlement per visitor")) {
          messages.length = 0;
          await new Promise((r) => setTimeout(r, 4000));
          host();
          continue;
        }
        throw new Error(`relay error: ${JSON.stringify(err)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timeout waiting for ${type}`);
  };

  try {
    const t0 = t();
    const { matchId } = await waitFor("hosted", 15000);
    const { token } = await waitFor("sandbox_ready", 90000);
    ok(`sandbox ready in ${((t() - t0) / 1000).toFixed(1)}s`);

    const call = async (op, body, timeoutMs = 120000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${RELAY}/api/sandbox/${matchId}/${op}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: ctrl.signal,
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ...json };
      } finally {
        clearTimeout(timer);
      }
    };

    const tClone = t();
    const clone = await call("clone", { url });
    if (clone.status !== 200) bad(`clone → ${clone.status} ${JSON.stringify(clone).slice(0, 200)}`);
    else ok(`clone in ${((t() - tClone) / 1000).toFixed(1)}s (readme ${clone.readme?.length ?? 0} chars)`);

    const tree = await call("tree");
    const flat = JSON.stringify(tree.tree ?? "");
    if (tree.status !== 200 || !flat.includes(expectFile)) bad(`tree missing ${expectFile} (status ${tree.status}, ${flat.length}B)`);
    else ok(`tree contains ${expectFile} (${flat.length}B)`);

    const read = await call("read", { path: expectFile });
    if (read.status !== 200 || !read.content?.length) bad(`read ${expectFile} → ${read.status}`);
    else ok(`read ${expectFile} (${read.lines} lines)`);

    const tSearch = t();
    const found = await call("search", { query: search });
    if (found.status !== 200) bad(`search → ${found.status}`);
    else ok(`search "${search}" → ${found.hits?.length ?? 0} hits in ${((t() - tSearch) / 1000).toFixed(1)}s`);

    const ex = await call("exec", { command: "git log --oneline -1 && ls | head -5" });
    if (ex.status !== 200 || ex.exitCode !== 0) bad(`exec → status ${ex.status}, exit ${ex.exitCode}`);
    else ok("exec (git log + ls)");

    await call("write", { path: "BATTERY.md", content: "battery marker\n" });
    const diff = await call("diff");
    if (diff.status !== 200 || !diff.patch?.includes("BATTERY.md")) bad(`diff missing marker (status ${diff.status})`);
    else ok("write + diff round-trip");

    // Non-existent path must fail cleanly, not 500.
    const missing = await call("read", { path: "definitely/not/a/file.xyz" });
    if (missing.status >= 500) bad(`missing-file read → ${missing.status} (server error)`);
    else ok(`missing-file read → ${missing.status} (clean failure)`);

    ws.send(JSON.stringify({ type: "end" }));
  } catch (err) {
    bad(String(err.message ?? err));
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

for (const repo of REPOS) await runRepo(repo);

console.log(failures === 0 ? "\nAll repo-battery checks passed." : `\n${failures} FAILURES`);
process.exit(failures > 0 ? 1 : 0);
