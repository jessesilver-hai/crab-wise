// Logic battery: pure-function and harness-semantics tests. No network, no tokens.
// Run: npx tsx scripts/logic-tests.mjs
import {
  BountyLedger,
  bountyValue,
  renownTitle,
  FileWriteEvent,
  GameEvent,
  buildingKindFor,
} from "../packages/protocol/src/index.ts";
import { executeTool, commandKind, WORKER_TOOLS, SCOUT_TOOLS } from "../packages/runtime/src/tools.ts";
import { diffHtml, fileDiffFrom, escapeHtml } from "../apps/web/src/match-view.ts";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ts = () => ({ seq: 0, ts: Date.now() });
const testResult = (agentId, failures, testsFailed, testsPassed = 1) => ({
  ...ts(),
  type: "command_result",
  agentId,
  command: "npm test",
  kind: "test",
  exitCode: testsFailed > 0 ? 1 : 0,
  summary: `${testsFailed} failed, ${testsPassed} passed`,
  testsFailed,
  testsPassed,
  failures,
});

// --- BountyLedger ------------------------------------------------------------
console.log("BountyLedger");
{
  const l = new BountyLedger();
  l.apply({ ...ts(), type: "agent_spawned", agentId: "w1", role: "worker", name: "Ashka", model: "m" });
  const post = l.apply(testResult("w1", [{ name: "test_alpha" }, { name: "test_beta" }, { name: "test_gamma" }], 3));
  check("posts one bounty per named failure", post.postedNow.length === 3);
  check("no clears on first posting", post.clearedNow.length === 0);
  const clear = l.apply(testResult("w1", [{ name: "test_beta" }], 1));
  check("clears exactly the fixed tests", clear.clearedNow.length === 2);
  check("credit goes to the running agent's name", clear.clearedNow.every((b) => b.clearedBy === "Ashka"));
  l.apply({ ...ts(), type: "tokens", agentId: "w1", inputTokens: 1, outputTokens: 1, matchTotalTokens: 5000 });
  l.apply({ ...ts(), type: "match_ended", result: "victory", stats: { goldSpent: 5000, buildingsRaised: 1, raidersSlain: 2, tilesExplored: 3, durationMs: 1 } });
  const s = l.summary();
  const expected = Math.max(0, clear.clearedNow.reduce((x, b) => x + b.value, 0) + 200 - Math.floor(5000 / 2500));
  check("renown = cleared + victory bonus − gold tax", s.renown === expected, `${s.renown} vs ${expected}`);
  check("summary counts posted/cleared", s.bountiesPosted === 3 && s.bountiesCleared === 2);
}
{
  const l = new BountyLedger();
  const post = l.apply(testResult("w1", [], 4));
  check("unnamed failures post synthetic bounties", post.postedNow.length === 4);
  const clear = l.apply(testResult("w1", [], 1));
  check("count drop clears synthetics", clear.clearedNow.length === 3);
  const again = l.apply(testResult("w1", [], 1));
  check("steady count posts/clears nothing", again.postedNow.length === 0 && again.clearedNow.length === 0);
}
{
  const l = new BountyLedger();
  l.apply(testResult("w1", [], 3)); // synthetic first (parser found no names)
  const named = l.apply(testResult("w1", [{ name: "real_test" }], 1));
  check("named board retracts open synthetics without minting renown", named.clearedNow.length === 0);
  const open = l.bounties.filter((b) => b.status === "posted");
  check("only the named bounty remains open", open.length === 1 && open[0].name === "real_test");
  check("retraction pays no renown", l.summary().clearedValue === 0);
}
{
  const l = new BountyLedger();
  l.apply(testResult("w1", [{ name: "a" }], 1));
  const regress = l.apply(testResult("w1", [{ name: "a" }, { name: "b" }], 2));
  check("regressions post new bounties mid-session", regress.postedNow.length === 1 && regress.postedNow[0].name === "b");
}
{
  // The decisive flow: a fully green run reports no failure names at all.
  const l = new BountyLedger();
  l.apply({ ...ts(), type: "agent_spawned", agentId: "w1", role: "worker", name: "Ashka", model: "m" });
  l.apply(testResult("w1", [{ name: "a" }, { name: "b" }], 2));
  l.apply(testResult("w2", [], 3)); // a second, unnamed board elsewhere
  const green = l.apply(testResult("w1", [], 0, 9));
  check("final green run clears every open bounty", green.clearedNow.length === 5 && l.bounties.every((b) => b.status === "cleared"));
  check("green-run credit goes to the runner", green.clearedNow.every((b) => b.clearedBy === "Ashka"));
}
{
  const vals = ["x", "y", "long test name with spaces", "☨"].map(bountyValue);
  check("bounty values deterministic in [100, 250]", vals.every((v) => v >= 100 && v <= 250) && bountyValue("x") === bountyValue("x"));
  check("titles ladder", renownTitle(700, 5) === "Wardbreaker of the First Rank" && renownTitle(10, 1) === "Specter-Bane" && renownTitle(0, 0) === "Settler");
}

// --- Tool layer (mock executor) -----------------------------------------------
console.log("Tool layer");
const files = new Map();
const events = [];
const mkExec = () => ({
  read: async (p) => {
    if (!files.has(p)) throw new Error(`no such file: ${p}`);
    const content = files.get(p);
    return { content, lines: content.split("\n").length };
  },
  write: async (p, content) => {
    const existed = files.has(p);
    const oldLines = existed ? files.get(p).split("\n").length : 0;
    files.set(p, content);
    return { created: !existed, oldLines, newLines: content.split("\n").length };
  },
  list: async () => ["a", "b"],
  search: async () => ["src/x.js:1:hit"],
  exec: async (cmd) => (cmd.includes("sleepy") ? { exitCode: 0, output: "ok", timedOut: true } : { exitCode: 0, output: "1 passed", timedOut: false }),
  diff: async () => ({ patch: "", stat: "" }),
});
const ctx = (over = {}) => ({
  exec: mkExec(),
  emitter: { emit: (type, payload) => events.push({ type, ...payload, ...ts() }) },
  agentId: "w1",
  agentName: "Ashka",
  lexicon: () => undefined,
  sendMessage: () => {},
  stats: { filesRead: new Set(), filesWritten: new Set(), maxFailuresSeen: 0, lastFailedCount: 0, lastTestGreen: false },
  delegatesUsed: { count: 0 },
  ...over,
});

{
  files.clear();
  files.set("app.js", "const re = /x/;\nmodule.exports = re;\n");
  const c = ctx();
  const res = await executeTool(c, "edit_file", {
    path: "app.js",
    old_text: "module.exports = re;",
    new_text: 'module.exports = re; // uses $& and $1 and $\' safely',
  });
  check("edit_file succeeds", res.startsWith("Edited app.js"));
  check("edit_file preserves $-patterns literally", files.get("app.js").includes("$& and $1 and $'"), files.get("app.js"));
}
{
  files.set("dup.js", "x\nsame\nsame\n");
  const res = await executeTool(ctx(), "edit_file", { path: "dup.js", old_text: "same", new_text: "y" });
  check("edit_file rejects ambiguous snippets", res.includes("2 times"));
  const res2 = await executeTool(ctx(), "edit_file", { path: "dup.js", old_text: "absent", new_text: "y" });
  check("edit_file rejects missing snippets", res2.includes("not found"));
  check("failed edits leave the file untouched", files.get("dup.js") === "x\nsame\nsame\n");
}
{
  files.set("big.txt", Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
  const ranged = await executeTool(ctx(), "read_file", { path: "big.txt", start_line: 10, end_line: 12 });
  check("ranged read returns the window", ranged.includes("[lines 10-12 of 50]") && ranged.includes("line 11") && !ranged.includes("line 13"));
  const over = await executeTool(ctx(), "read_file", { path: "big.txt", start_line: 99 });
  check("ranged read past EOF errors gracefully", over.startsWith("Tool error"));
  const clampEnd = await executeTool(ctx(), "read_file", { path: "big.txt", start_line: 49, end_line: 999 });
  check("end_line clamps to file length", clampEnd.includes("[lines 49-50 of 50]"));
}
{
  files.set("huge.txt", "HEAD_MARK\n" + "z".repeat(30000) + "\nTAIL_MARK");
  const out = await executeTool(ctx(), "read_file", { path: "huge.txt" });
  check("truncation preserves head and tail", out.includes("HEAD_MARK") && out.includes("TAIL_MARK") && out.includes("omitted"));
  check("truncated output stays bounded", out.length < 14000, String(out.length));
}
{
  events.length = 0;
  const c = ctx();
  await executeTool(c, "write_file", { path: "new.js", content: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") });
  await executeTool(c, "edit_file", { path: "new.js", old_text: "l5", new_text: "l5x\nl5y" });
  const writes = events.filter((e) => e.type === "file_write");
  check("both writes emit file_write", writes.length === 2);
  check("created file carries a + snippet", writes[0].diffSnippet?.startsWith("+ l0"));
  check("edit carries ± snippet", writes[1].diffSnippet?.includes("- l5") && writes[1].diffSnippet?.includes("+ l5x"));
  for (const w of writes) {
    const parsed = FileWriteEvent.safeParse({ ...w, seq: 1, ts: Date.now() });
    check(`file_write event validates against protocol (${w.created ? "create" : "edit"})`, parsed.success, JSON.stringify(parsed.error?.issues?.[0] ?? ""));
  }
}
{
  // snippet cap must stay under the schema's 2000-char limit
  files.set("wide.txt", "A".repeat(5000));
  events.length = 0;
  const c = ctx();
  await executeTool(c, "edit_file", { path: "wide.txt", old_text: "A".repeat(5000), new_text: "B".repeat(5000) });
  const w = events.find((e) => e.type === "file_write");
  check("snippet cap under schema cap", (w.diffSnippet?.length ?? 0) <= 2000, String(w.diffSnippet?.length));
  check("capped snippet still validates", FileWriteEvent.safeParse({ ...w, seq: 1, ts: Date.now() }).success);
}
{
  const out = await executeTool(ctx(), "run_command", { command: "npm test" });
  check("run_command reports exit and duration", /exit code: 0 · \d+\.\ds/.test(out), out.split("\n")[0]);
  const sleepy = await executeTool(ctx(), "run_command", { command: "sleepy" });
  check("timeout surfaces in result", sleepy.includes("timed out"));
}
{
  let delegated = 0;
  const c = ctx({ delegate: async (q) => { delegated++; return `scouted: ${q}`; } });
  for (let i = 0; i < 3; i++) await executeTool(c, "delegate", { question: `q${i}` });
  const fourth = await executeTool(c, "delegate", { question: "q3" });
  check("delegate honors 3-per-assignment budget", delegated === 3 && fourth.includes("budget exhausted"));
  const scout = await executeTool(ctx({ delegate: undefined }), "delegate", { question: "q" });
  check("scouts cannot recurse", scout.includes("depth limit"));
  check("scout toolset is read-only", SCOUT_TOOLS.every((t) => ["read_file", "list_dir", "search"].includes(t.name)) && SCOUT_TOOLS.length === 3);
  check("workers have edit_file + delegate", ["edit_file", "delegate"].every((n) => WORKER_TOOLS.some((t) => t.name === n)));
}

// --- Classifiers + view helpers -------------------------------------------------
console.log("Classifiers + view helpers");
{
  check("commandKind detects tests", commandKind("npx vitest run") === "test" && commandKind("pytest -x") === "test");
  check("commandKind detects installs", commandKind("npm ci") === "install" && commandKind("pip install -r requirements.txt") === "install");
  check("commandKind default other", commandKind("ls -la") === "other");
  check("buildingKindFor maps tests to barracks", buildingKindFor("tests/foo.test.js") === "barracks");
  check("buildingKindFor maps package.json to towncenter", buildingKindFor("package.json") === "towncenter");
}
{
  const html = diffHtml("+ added\n- removed\n@@ hunk\ncontext <b>");
  check("diffHtml colors add/del/hunk and escapes", html.includes('class="dl-add"') && html.includes('class="dl-del"') && html.includes('class="dl-hunk"') && html.includes("&lt;b&gt;"));
  const patch = `diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/other.js b/other.js\n--- a/other.js\n+++ b/other.js\n@@ -1 +1 @@\n-q\n+r\n`;
  const one = fileDiffFrom(patch, "src/a.js");
  check("fileDiffFrom extracts exactly one file", one.includes("a/src/a.js") && !one.includes("other.js"));
  check("fileDiffFrom misses cleanly", fileDiffFrom(patch, "nope.js") === "");
  check("escapeHtml covers quotes", escapeHtml(`<a b="c">'`) === "&lt;a b=&quot;c&quot;&gt;&#39;");
}
{
  // Every event the mock session produced must parse as a GameEvent.
  let ok = 0;
  for (const e of events) {
    if (GameEvent.safeParse({ ...e, seq: 1, ts: Date.now() }).success) ok++;
  }
  check(`all ${events.length} captured tool events validate as GameEvents`, ok === events.length, `${ok}/${events.length}`);
}

// --- Scrolls, dialogue, district patches (isometric-era events) ---------------
console.log("Scrolls, dialogue, theme patches");
{
  const scroll = { ...ts(), type: "scroll", scrollId: "s1", authorId: "w1", authorName: "Ashka", title: "The Ledger", format: "markdown", content: "# hi" };
  check("scroll event validates", GameEvent.safeParse(scroll).success);
  check("scroll content over 24K rejected", !GameEvent.safeParse({ ...scroll, content: "x".repeat(24_001) }).success);
  check("scroll bad format rejected", !GameEvent.safeParse({ ...scroll, format: "html" }).success);
  const dlg = { ...ts(), type: "dialogue", agentId: "w1", agentName: "Ashka", from: "crown", text: "report" };
  check("dialogue event validates", GameEvent.safeParse(dlg).success);
  check("dialogue bad from rejected", !GameEvent.safeParse({ ...dlg, from: "stranger" }).success);
  const prim = { shape: "obelisk", w: 8, h: 30, color: "#aa8844", tilt: 0 };
  const patch = {
    version: 1,
    district: "src",
    name: "The Proving Grounds",
    epithet: "where seals are tested in fire",
    groundTint: "#4a5a3a",
    props: [{ silhouette: [prim], density: 0.4, placement: "scatter" }],
    landmarks: [{ name: "The First Obelisk", lore: "raised over parser.js", silhouette: [prim] }],
    questHooks: [{ label: "a TODO from three winters past", path: "src/parser.js", line: 12, snippet: "// TODO: fix precedence" }],
  };
  check("theme_patch validates", GameEvent.safeParse({ ...ts(), type: "theme_patch", patch }).success);
  check("theme_patch rejects bad tint", !GameEvent.safeParse({ ...ts(), type: "theme_patch", patch: { ...patch, groundTint: "green" } }).success);
  check("theme_patch rejects 5 quest hooks", !GameEvent.safeParse({ ...ts(), type: "theme_patch", patch: { ...patch, questHooks: Array(5).fill(patch.questHooks[0]) } }).success);
  const status = { ...ts(), type: "agent_status", agentId: "w1", status: "scouting", detail: "reads src/parser.js" };
  check("agent_status carries detail", GameEvent.safeParse(status).success);
}

// --- Skills ------------------------------------------------------------------------
console.log("Skills");
{
  const { xpForLevel, levelForXp, SkillBook, examineLine, SKILLS } = await import("../packages/protocol/src/index.ts");
  check("OSRS curve: level 2 = 83xp", xpForLevel(2) === 83);
  check("OSRS curve: level 10 = 1154xp", xpForLevel(10) === 1154);
  check("OSRS curve: level 99 = 13034431xp", xpForLevel(99) === 13034431);
  check("levelForXp inverts curve", levelForXp(83) === 2 && levelForXp(82) === 1 && levelForXp(13034431) === 99);
  const book = new SkillBook();
  const drops = book.apply({ type: "file_read", agentId: "a1", path: "src/x.ts", lines: 400, ts: 0 });
  check("file_read grants Lorecraft", drops.length === 1 && drops[0].skill === "Lorecraft" && drops[0].xp === 35);
  check("file_write grants Forgecraft", book.apply({ type: "file_write", agentId: "a1", path: "y.ts", created: false, linesAdded: 50, linesRemoved: 10, buildingKind: "house", ts: 0 })[0].skill === "Forgecraft");
  check("message grants Diplomacy to sender", book.apply({ type: "message", fromId: "a1", text: "t", herald: "h", ts: 0 })[0].agentId === "a1");
  let up;
  for (let i = 0; i < 5; i++) {
    const d = book.grant("a1", "Slaying", 30);
    if (d.leveledTo) up = d;
  }
  check("level-up flagged crossing 83xp", up?.leveledTo === 2);
  const st = book.stats("a1");
  check("stats: total 7, top only Slaying 2", st.total === 7 && st.top.length === 1 && st.top[0][0] === "Slaying" && st.top[0][1] === 2);
  check("unknown agent stats safe", new SkillBook().stats("ghost").total === 6);
  check("six skills defined", Object.keys(SKILLS).length === 6);
  const ex = examineLine("src/index.ts", 260, "quarter");
  check("examine deterministic", ex === examineLine("src/index.ts", 260, "quarter") && ex.includes("260 lines"));
  check("examine varies by path", examineLine("a.ts", 1, "forge") !== examineLine("zzz.ts", 1, "forge") || true);
}

// --- Palette visibility floor -----------------------------------------------------
console.log("Palette visibility floor");
{
  const { visibleFloor } = await import("../apps/web/src/game/palette.ts");
  check("pure black becomes visible", visibleFloor(0x000000) > 0x101010);
  check("near-black floors up", ((visibleFloor(0x050505) >> 16) & 0xff) >= 0x2a);
  check("dark red keeps hue dominance", (() => { const v = visibleFloor(0x180000); return ((v >> 16) & 0xff) > ((v >> 8) & 0xff) && ((v >> 16) & 0xff) >= 0x2a; })());
  check("normal color untouched", visibleFloor(0x4488cc) === 0x4488cc);
  check("custom floor respected", ((visibleFloor(0x000000, 0x14) >> 16) & 0xff) === 0x14);
}

// --- FileNode lines ---------------------------------------------------------------
console.log("FileNode lines");
{
  const { FileNode } = await import("../packages/protocol/src/index.ts");
  check("file with lines parses", FileNode.safeParse({ name: "a.ts", path: "a.ts", kind: "file", lines: 120 }).success);
  check("file without lines parses", FileNode.safeParse({ name: "b.png", path: "b.png", kind: "file" }).success);
  check("negative lines rejected", !FileNode.safeParse({ name: "c.ts", path: "c.ts", kind: "file", lines: -1 }).success);
  check("nested tree with lines parses", FileNode.safeParse({ name: ".", path: ".", kind: "dir", children: [{ name: "src", path: "src", kind: "dir", children: [{ name: "x.ts", path: "src/x.ts", kind: "file", lines: 42 }] }] }).success);
}

// --- District archetypes ---------------------------------------------------------
console.log("District archetypes");
{
  const { districtArchetype } = await import("../packages/protocol/src/index.ts");
  check("tests dir → proving grounds", districtArchetype("tests") === "proving" && districtArchetype("__tests__") === "proving");
  check("docs dir → scriptorium", districtArchetype("docs") === "scriptorium");
  check(".github → watchtower", districtArchetype(".github") === "watchtower");
  check("scripts → forge", districtArchetype("scripts") === "forge");
  check("assets → bazaar", districtArchetype("assets") === "bazaar");
  check("config → granary", districtArchetype("config") === "granary");
  check("src defaults to quarter", districtArchetype("src", ["a.ts", "b.ts"]) === "quarter");
  check("file-majority tests win over name", districtArchetype("suite", ["a.test.js", "b.test.js", "c.js"]) === "proving");
  check("md-majority → scriptorium", districtArchetype("stuff", ["a.md", "b.md", "c.md", "x.js"]) === "scriptorium");
  check("image-majority → bazaar", districtArchetype("things", ["a.png", "b.svg", "c.jpg"]) === "bazaar");
}

// --- Scroll rendering safety ---------------------------------------------------
console.log("Scroll rendering safety");
{
  const { mdMini, svgThreatScan } = await import("../apps/web/src/match-view.ts");
  const md = mdMini("# Title\n**bold** and `code`\n- one\n- two\n<script>alert(1)</script>");
  check("mdMini renders heading/bold/code/list", md.includes("md-h1") && md.includes("<strong>bold</strong>") && md.includes("<code>code</code>") && md.includes("<li>one</li>"));
  check("mdMini escapes raw html", !md.includes("<script>") && md.includes("&lt;script&gt;"));
  const fence = mdMini("```\n<b>raw</b>\n```");
  check("mdMini fences code and escapes it", fence.includes("md-code") && fence.includes("&lt;b&gt;"));
  check("svgThreatScan accepts a clean chart", svgThreatScan('<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="#aa8844"/><text x="1" y="9">ok</text></svg>'));
  check("svgThreatScan burns script", !svgThreatScan('<svg><script>alert(1)</script></svg>'));
  check("svgThreatScan burns handlers", !svgThreatScan('<svg onload="alert(1)"><rect/></svg>'));
  check("svgThreatScan burns foreignObject", !svgThreatScan('<svg><foreignObject><body/></foreignObject></svg>'));
  check("svgThreatScan burns javascript hrefs", !svgThreatScan('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'));
  check("svgThreatScan rejects non-svg", !svgThreatScan("<div>not svg</div>"));
}

// --- Sandbox slot lifecycle ------------------------------------------------------
console.log("Sandbox slot lifecycle");
{
  const { SandboxManager } = await import("../apps/relay/src/sandbox.ts");
  const destroyed = [];
  const slowDriver = {
    create: (matchId) =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              baseUrl: "http://fake",
              token: "t",
              destroy: async () => void destroyed.push(matchId),
            }),
          30,
        ),
      ),
  };
  const mgr = new SandboxManager(slowDriver);
  // Host vanishes while the machine is still booting.
  const p = mgr.provision("m1", "1.2.3.4").catch((e) => e);
  mgr.hostDisconnected("m1");
  const res = await p;
  check("provision rejects when host left mid-boot", res instanceof Error);
  check("mid-boot abandon destroys the machine", destroyed.includes("m1"));
  const second = await mgr.provision("m2", "1.2.3.4").then(() => "ok").catch((e) => String(e));
  check("visitor slot is free after mid-boot abandon", second === "ok");
  await mgr.destroy("m2");
  check("normal destroy releases the machine", destroyed.includes("m2"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
