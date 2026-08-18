#!/usr/bin/env node
/* Headless runner for the 3D smoke battery (test/smoke3d.html): boots the
 * vite dev server, drives system Chrome (new headless, SwiftShader WebGL)
 * over the DevTools protocol, and mirrors the page console. Exits 0 iff the
 * page prints "[smoke3d] SUMMARY ... fail=0" and no CHECK line FAILed.
 * BIG=1 runs the 1602-file packages/-monorepo variant. Node >= 22 (native
 * WebSocket + fetch); no extra dependencies. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIG = process.env.BIG === "1";
const PORT = Number(process.env.SMOKE_PORT || 5199);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9377);
const CHROME =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// "localhost", not 127.0.0.1: vite may bind ::1 only
const url = `http://localhost:${PORT}/test/smoke3d.html${BIG ? "?big=1" : ""}`;

const children = [];
const profile = mkdtempSync(join(tmpdir(), "ae3d-smoke-"));
function cleanup(code) {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(u, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(u);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${u}`);
}

const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: webRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(vite);
vite.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`[run-smoke3d] vite exited with ${code}`);
    cleanup(1);
  }
});
try {
  await waitHttp(url, 30000);
} catch (err) {
  console.error(`[run-smoke3d] ${err.message}`);
  cleanup(1);
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    // Force software WebGL: headless hardware GL throttles rAF (~10fps,
    // would trip the fps gate), while SwiftShader is the exact path the
    // proactive software-GL degrade targets — same env the battery has
    // always used.
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--window-size=1280,800",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
children.push(chrome);

let target = null;
for (let i = 0; i < 80 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {
    /* CDP not up yet */
  }
  if (!target) await sleep(250);
}
if (!target) {
  console.error("[run-smoke3d] no CDP page target");
  cleanup(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++msgId, method, params }));
let summary = null;
let sawFail = false;
let checks = 0;
ws.onopen = () => {
  send("Runtime.enable");
  send("Page.enable");
  send("Page.navigate", { url });
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? [])
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? "")))
      .join(" ");
    console.log(text);
    if (text.includes("[smoke3d] CHECK ")) {
      checks++;
      if (/ FAIL/.test(text)) sawFail = true;
    }
    const m = text.match(/\[smoke3d\] SUMMARY pass=(\d+) fail=(\d+)/);
    if (m) summary = { pass: Number(m[1]), fail: Number(m[2]) };
  }
  if (msg.method === "Runtime.exceptionThrown") {
    console.error(
      "[page-exception]",
      msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params),
    );
  }
};
ws.onerror = (e) => {
  console.error("[run-smoke3d] ws error", e?.message ?? e);
};

// the composition-law scenario worlds add four extra builds after the main run
const t0 = Date.now();
while (!summary && Date.now() - t0 < 360000) await sleep(500);
if (!summary) {
  console.error("[run-smoke3d] timeout: no SUMMARY within 360s");
  cleanup(1);
}
const ok = summary.fail === 0 && !sawFail && checks === summary.pass + summary.fail;
console.log(
  `[run-smoke3d] ${BIG ? "BIG " : ""}checks=${checks} pass=${summary.pass} fail=${summary.fail} → ${ok ? "OK" : "FAIL"}`,
);
cleanup(ok ? 0 : 1);
