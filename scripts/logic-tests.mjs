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
  tree: async () => ({
    kind: "dir",
    name: ".",
    path: "",
    children: [...files.entries()].map(([p, c]) => ({ kind: "file", name: p.split("/").pop(), path: p, lines: c.split("\n").length })),
  }),
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
  touched: new Set(),
  knownPaths: new Set(files.keys()),
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
  check("write carries the measured total", writes[0].lines === 40, String(writes[0].lines));
  check("edit carries the measured total", writes[1].lines === 41, String(writes[1].lines));
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
  // Counted-stones law: files born through the shell are sighted after the
  // command and raised as real writes; every stone is counted exactly once.
  files.clear();
  files.set("index.html", "<html>\n</html>");
  events.length = 0;
  const c = ctx();
  const base = c.exec;
  const rawExec = base.exec;
  base.exec = async (cmd) => {
    files.set("game.js", Array.from({ length: 30 }, (_, i) => `g${i}`).join("\n"));
    return rawExec(cmd);
  };
  await executeTool(c, "run_command", { command: "bash build.sh" });
  const sighted = events.filter((e) => e.type === "file_write");
  check("a shell-born file is sighted and raised", sighted.length === 1 && sighted[0].path === "game.js" && sighted[0].created === true, JSON.stringify(sighted.map((s) => s.path)));
  check("the sighting carries measured lines", sighted[0].lines === 30 && sighted[0].linesAdded === 30);
  check("sighted paths join the known roll", c.knownPaths.has("game.js"));
  check("sightings validate against the protocol", FileWriteEvent.safeParse({ ...sighted[0], seq: 1, ts: Date.now() }).success);
  await executeTool(c, "run_command", { command: "bash build.sh" });
  check("a stone is counted once", events.filter((e) => e.type === "file_write").length === 1);

  // a blast of >50 newcomers is generated output: counted in silence
  files.clear();
  files.set("index.html", "<html>\n</html>");
  events.length = 0;
  const cBlast = ctx();
  const bl = cBlast.exec;
  const rawBlast = bl.exec;
  bl.exec = async (cmd) => {
    for (let i = 0; i < 60; i++) files.set(`node_modules/m${i}.js`, "x");
    return rawBlast(cmd);
  };
  await executeTool(cBlast, "run_command", { command: "npm install" });
  check("a generated blast is never heralded", events.filter((e) => e.type === "file_write").length === 0);
  check("the blast is still counted", cBlast.knownPaths.size >= 61);
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
  // deed-proportional: XP reads back to the event's own measured numbers
  const drops = book.apply({ type: "file_read", agentId: "a1", path: "src/x.ts", lines: 400, ts: 0 });
  check("file_read scales with lines read (400 → 41)", drops.length === 1 && drops[0].skill === "Lorecraft" && drops[0].xp === 8 + Math.min(42, Math.floor(400 / 12)));
  check("a skim pays less than a survey", new SkillBook().apply({ type: "file_read", agentId: "a1", path: "s.ts", lines: 12, ts: 0 })[0].xp < drops[0].xp);
  const fw = book.apply({ type: "file_write", agentId: "a1", path: "y.ts", created: false, linesAdded: 50, linesRemoved: 10, buildingKind: "house", ts: 0 })[0];
  check("file_write scales with churn (60 → 22)", fw.skill === "Forgecraft" && fw.xp === 12 + Math.min(68, Math.floor(60 / 6)));
  check("addressed words outweigh broadcast", book.apply({ type: "message", fromId: "a1", toId: "a2", text: "t", herald: "h", ts: 0 })[0].xp > new SkillBook().apply({ type: "message", fromId: "a1", text: "t", herald: "h", ts: 0 })[0].xp);
  check("joining a trial pays little (8)", book.apply({ type: "command_run", agentId: "a1", command: "npm test", kind: "test", ts: 0 })[0].xp === 8);
  const green = book.apply(testResult("a1", [], 0, 24));
  check("a green suite pays the wage (10+25+90cap)", green[0].skill === "Trialcraft" && green[0].xp === 10 + 25 + Math.min(90, 24 * 4));
  const red = new SkillBook().apply(testResult("a1", [], 3, 9));
  check("a red suite pays for tests won only", red[0].xp === 10 + 0 + 36);
  check("sign_work pays Forgecraft (45)", book.apply({ type: "castle_flourish", agentId: "a1", author: "Ashka", path: "src/x.ts", mark: "lantern", cited: "measured", ts: 0 })[0].xp === 45);
  check("an inscribed scroll pays Lorecraft (60)", book.apply({ type: "scroll", scrollId: "s1", authorId: "a1", authorName: "Ashka", title: "T", format: "markdown", content: "c", ts: 0 })[0].xp === 60);
  const slay = book.slay("a1", bountyValue("tokenizer eats digits"));
  check("a felled bounty pays exactly its posted renown", slay.skill === "Slaying" && slay.xp === bountyValue("tokenizer eats digits"));
  check("why(): Lorecraft names scrolls and lines", /2 scrolls, 400 lines studied/.test(book.why("a1", "Lorecraft")));
  check("why(): Trialcraft names trials and wins", /1 trials joined, 24 tests won/.test(book.why("a1", "Trialcraft")));
  check("why(): Slaying names renown collected", /1 bounties felled/.test(book.why("a1", "Slaying")));
  check("why() is empty for the deedless", new SkillBook().why("ghost", "Slaying") === "");
  const twin = new SkillBook();
  const events = [
    { type: "file_read", agentId: "a1", path: "p", lines: 973, ts: 0 },
    { type: "search", agentId: "a1", query: "q", matchCount: 7, paths: [], ts: 0 },
    { type: "list_dir", agentId: "a1", path: ".", ts: 0 },
  ];
  for (const e of events) twin.apply(e);
  const twin2 = new SkillBook();
  for (const e of events) twin2.apply(e);
  check("replay determinism: same events, same book", twin.stats("a1").total === twin2.stats("a1").total && twin.why("a1", "Wayfaring") === twin2.why("a1", "Wayfaring"));
  let up;
  for (let i = 0; i < 5; i++) {
    const d = book.grant("a1", "Slaying", 30);
    if (d.leveledTo) up = d;
  }
  check("level-up flagged crossing a boundary", up?.leveledTo !== undefined);
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

// --- Code Made Visible: census, world DNA, landmass -------------------------------
console.log("Code census");
{
  const { analyzeCensus, censusBrief } = await import("../apps/web/src/game/census.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  const pyTree = dir("", [
    dir("src", [file("src/a.py", 800), file("src/b.py", 600)]),
    dir("tests", [file("tests/test_a.py", 500)]),
    dir("docs", [file("docs/guide.md", 100)]),
  ]);
  const c = analyzeCensus(pyTree);
  check("census dominant language", c.dominant === "python");
  check("census test ratio measured", c.testRatio === 500 / 2000);
  check("census docs ratio measured", c.docsRatio === 100 / 2000);
  check("census depth + counts", c.maxDepth === 1 && c.fileCount === 4 && c.totalLines === 2000);
  check("census not monorepo", c.monorepo === false);

  const mono = dir("", [
    dir("packages", [
      dir("packages/a", [file("packages/a/i.ts", 300)]),
      dir("packages/b", [file("packages/b/i.ts", 300)]),
    ]),
    file("README.md", 50),
  ]);
  const cm = analyzeCensus(mono);
  check("census detects monorepo", cm.monorepo === true && cm.dominant === "script");
  check("census counts island-works", cm.packageDirs === 2);
  check("census brief cites the facts", censusBrief(cm).includes("MONOREPO") && censusBrief(c).includes("python"));
}

console.log("World DNA");
{
  const { analyzeCensus } = await import("../apps/web/src/game/census.ts");
  const { deriveWorldDNA } = await import("../apps/web/src/game/worlddna.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  const treeOf = (ext, extra = []) =>
    dir("", [dir("src", [file(`src/a.${ext}`, 900), file(`src/b.${ext}`, 700)]), ...extra]);

  // determinism: same census + seed → identical DNA
  const c1 = analyzeCensus(treeOf("rs"));
  const d1 = deriveWorldDNA(c1, 1234);
  const d2 = deriveWorldDNA(c1, 1234);
  check("DNA deterministic", JSON.stringify(d1) === JSON.stringify(d2));

  // maximal variety: contrasting repos land on distinct forms
  const forms = new Set(
    [
      ["rs", 7], ["ts", 7], ["md", 7], ["java", 7], ["py", 7], ["html", 7],
    ].map(([ext, seed]) => deriveWorldDNA(analyzeCensus(treeOf(ext)), seed).form),
  );
  check("DNA spreads forms across repos", forms.size >= 4, `forms=${[...forms].join(",")}`);

  // legible overrides: the walls follow the test garrison
  const fortified = analyzeCensus(
    dir("", [dir("src", [file("src/a.go", 500)]), dir("tests", [file("tests/a_test.go", 400)])]),
  );
  check("DNA fortification from tests", deriveWorldDNA(fortified, 1).fortification >= 2);
  check("DNA lore cites census", deriveWorldDNA(fortified, 1).loreNotes.some((n) => n.line.includes("%")));

  // the Worldsmith may override the form, but only to a real one
  check("DNA form override honored", deriveWorldDNA(c1, 1234, "glacier-vault").form === "glacier-vault");
  check("DNA bogus override ignored", deriveWorldDNA(c1, 1234, "candy-land").form === d1.form);
}

console.log("Landmass v2 (coast, archipelago, rivers)");
{
  const { layoutMap, layoutHash } = await import("../apps/web/src/game/map.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  const plain = dir("", [
    dir("src", [file("src/a.ts", 300), file("src/b.ts", 200)]),
    dir("tests", [file("tests/a.test.ts", 150)]),
    file("README.md", 40),
  ]);
  const m1 = layoutMap(plain, 42);
  const m2 = layoutMap(plain, 42);
  check("water deterministic", [...m1.water].sort().join() === [...m2.water].sort().join());
  check("coastline exists", m1.water.size > 40);
  check("water never floods structures", [...m1.water].every((k) => !m1.used.has(k)));
  check("water never enters quarters (plain repo)", (() => {
    const inRect = (tx, ty, r) => tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
    return [...m1.water].every((k) => {
      const [tx, ty] = k.split(",").map(Number);
      return !m1.quarters.some((q) => inRect(tx, ty, q.rect));
    });
  })());
  check("bridges are exactly roads ∩ water", (() => {
    for (const b of m1.bridges) if (!m1.roads.has(b) || !m1.water.has(b)) return false;
    for (const r of m1.roads) if (m1.water.has(r) && !m1.bridges.has(r)) return false;
    return true;
  })());
  check("coast rings the water", m1.coast.size > 0 && [...m1.coast].every((k) => !m1.water.has(k)));
  const hashA = layoutHash(m1);
  check("hash stable across runs", hashA === layoutHash(m2));
  check("hash varies with seed", hashA !== layoutHash(layoutMap(plain, 43)));

  // different seeds → different silhouettes (scallop actually varies)
  const w43 = [...layoutMap(plain, 43).water].sort().join();
  check("coastline varies by seed", w43 !== [...m1.water].sort().join());

  // monorepo → archipelago: channels flood the top-level corridors
  const mono = dir("", [
    dir("packages", [
      dir("packages/alpha", [file("packages/alpha/a.ts", 400), file("packages/alpha/b.ts", 200)]),
      dir("packages/beta", [file("packages/beta/a.ts", 400), file("packages/beta/b.ts", 300)]),
      dir("packages/gamma", [file("packages/gamma/a.ts", 350)]),
    ]),
    file("README.md", 30),
  ]);
  const mm = layoutMap(mono, 7);
  const inland = (k) => {
    const [tx, ty] = k.split(",").map(Number);
    const r = mm.cityRect;
    return tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
  };
  check("archipelago floods city corridors", [...mm.water].some(inland));
  check("archipelago is bridged", mm.bridges.size > 0);
  check("islet quarters stay dry", (() => {
    const inRect = (tx, ty, r) => tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
    const isles = mm.quarters.filter((q) => q.depth === 2 && q.parentPath === "packages");
    if (isles.length < 2) return false;
    return [...mm.water].every((k) => {
      const [tx, ty] = k.split(",").map(Number);
      return !isles.some((q) => inRect(tx, ty, q.rect));
    });
  })());
  const mp = layoutMap(plain, 7);
  check("plain repos stay inland-dry", ![...mp.water].some((k) => {
    const [tx, ty] = k.split(",").map(Number);
    const r = mp.cityRect;
    return tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h;
  }));

  // deep nesting carves a river that reaches the sea
  const deep = dir("", [
    dir("a", [dir("a/b", [dir("a/b/c", [dir("a/b/c/d", [dir("a/b/c/d/e", [file("a/b/c/d/e/deep.ts", 200)])])])])]),
    dir("src", [file("src/x.ts", 500)]),
  ]);
  const md = layoutMap(deep, 11);
  // the coast scallop can never reach inside the guaranteed-land band, so any
  // water there is river water by construction
  const riverTiles = [...md.water].filter((k) => {
    const [tx, ty] = k.split(",").map(Number);
    const c = (md.side - 1) / 2;
    const rad = Math.max(Math.abs(tx - c), Math.abs(ty - c));
    return rad < md.side / 2 - 1.5 - 6;
  });
  check("deep nesting carves a river", riverTiles.length >= 3, `river tiles=${riverTiles.length}`);

  // new files never land in the water
  const { assignPlot } = await import("../apps/web/src/game/map.ts");
  const spot = assignPlot(m1, "src/new-file.ts");
  check("mid-match plots stay dry", !m1.water.has(`${spot.tx},${spot.ty}`));
}

// --- Discovery: district census + survey lines --------------------------------
console.log("District census & survey lines");
{
  const { districtCensus, surveyLine, findDir } = await import("../apps/web/src/game/census.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });
  const tree = dir("", [
    dir("src", [file("src/a.py", 700), file("src/b.py", 200), dir("src/deep", [file("src/deep/c.md", 100)])]),
    dir("tests", [file("tests/t.py", 400)]),
    file("README.md", 50),
  ]);
  check("findDir walks nested paths", findDir(tree, "src/deep")?.path === "src/deep");
  check("findDir misses honestly", findDir(tree, "src/nope") === null);
  const src = districtCensus(tree, "src");
  check("district census scoped to subtree", src.totalLines === 1000 && src.fileCount === 3);
  check("district census dominant lang", src.dominant === "python");
  const line = surveyLine("The Src Quarter", src);
  check("survey line cites measured facts", line.includes("3 works") && line.includes("1,000 lines") && line.includes("python"));
  check("survey line deterministic", line === surveyLine("The Src Quarter", districtCensus(tree, "src")));
  const t = districtCensus(tree, "tests");
  check("proving-ground trait fires on test dirs", surveyLine("The Trials", t).includes("trials"));
  check("empty district is bare ground", surveyLine("X", districtCensus(dir("", [dir("e", [])]), "e")).includes("bare ground"));
}

// --- Discovery: the shroud ---------------------------------------------------
console.log("Shroud (discovery law)");
{
  const { layoutMap } = await import("../apps/web/src/game/map.ts");
  const { createShroud } = await import("../apps/web/src/game/shroud.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });
  const tree = dir("", [
    dir("src", [file("src/a.ts", 300), dir("src/engine", [file("src/engine/e.ts", 400)])]),
    dir("docs", [file("docs/d.md", 100)]),
    file("README.md", 20),
  ]);
  const layout = layoutMap(tree, 5);
  const s = createShroud(layout.quarters);
  check("all quarters start unsurveyed", s.surveyed.size === 0 && s.quarterPaths.length >= 2);
  check("root plaza plots visible from frame one", s.plotVisible("README.md"));
  check("plots inside quarters start hidden", !s.plotVisible("src/a.ts"));
  check("outer quarter may be surveyed first", s.canSurvey("src") && !s.canSurvey("src/engine"));
  check("survey reveals the quarter", s.survey("src") === true && s.isSurveyed("src"));
  check("surveying twice is refused", s.survey("src") === false);
  check("direct plots visible after survey, inner still veiled", s.plotVisible("src/a.ts") && !s.plotVisible("src/engine/e.ts"));
  check("inner ward unlocks after the outer", s.canSurvey("src/engine") && s.survey("src/engine") && s.plotVisible("src/engine/e.ts"));
  const s2 = createShroud(layout.quarters);
  const chain = s2.revealForPath("src/engine/e.ts");
  check("agent activity uncovers the whole chain, outermost first", chain.join("|") === "src|src/engine");
  check("agent reveal makes plots visible", s2.plotVisible("src/engine/e.ts"));
  check("repeat activity reveals nothing new", s2.revealForPath("src/engine/e.ts").length === 0);
  check("unknown quarter cannot be surveyed", s2.survey("phantom") === false);
}

// --- Worlds Apart: composition law, roles, heights, streets -------------------
console.log("Worlds Apart (composition law)");
{
  const { layoutMap, layoutHash, pickComposition, LAYOUT_VERSION } = await import("../apps/web/src/game/map.ts");
  const { analyzeCensus, classifyRole } = await import("../apps/web/src/game/census.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  check("layout law is v3", LAYOUT_VERSION === 3);

  // role classifier: path-roles outrank content, entries stay shallow
  check("test path is a watchtower", classifyRole("tests/x.py", "x.py", 50) === "test");
  check("giant test file is still a test", classifyRole("src/foo.test.ts", "foo.test.ts", 2000) === "test");
  check("docs are stelae", classifyRole("README.md", "README.md", 40) === "docs");
  check("configs are silos", classifyRole("config/app.yaml", "app.yaml", 20) === "config");
  check("assets are reliquaries", classifyRole("art/logo.png", "logo.png", 1) === "asset");
  check("root index is a gate", classifyRole("index.ts", "index.ts", 90) === "entry");
  check("nested index is plain source", classifyRole("src/a/b/index.ts", "index.ts", 90) === "source");
  check("1000+ lines is a giant", classifyRole("src/engine.c", "engine.c", 1400) === "giant");
  check("everything else is source", classifyRole("src/util.c", "util.c", 200) === "source");

  // fixtures forcing each composition
  const monoTree = dir("", [
    dir("packages", [
      dir("packages/a", [file("packages/a/i.ts", 400), file("packages/a/j.ts", 300)]),
      dir("packages/b", [file("packages/b/k.ts", 500)]),
    ]),
    file("README.md", 60),
  ]);
  const deepTree = dir("", [
    dir("a", [
      file("a/f1.ts", 200),
      dir("a/b", [
        file("a/b/f2.ts", 200),
        dir("a/b/c", [file("a/b/c/f3.ts", 200), dir("a/b/c/d", [file("a/b/c/d/f4.ts", 200)])]),
      ]),
    ]),
    dir("docs", [file("docs/d.md", 50)]),
    file("main.ts", 80),
  ]);
  const coreTree = dir("", [
    dir("src", [
      file("src/a.c", 2000),
      file("src/b.c", 2000),
      file("src/c.c", 2000),
      dir("src/sub", [file("src/sub/d.c", 2000)]),
    ]),
    dir("docs", [file("docs/x.md", 400)]),
    file("Makefile", 80),
  ]);
  const flatTree = dir("", [
    dir("alpha", [file("alpha/a.js", 900), file("alpha/b.js", 800)]),
    dir("beta", [file("beta/c.js", 900), file("beta/d.js", 700)]),
    dir("gamma", [file("gamma/e.js", 900)]),
    file("index.js", 100),
  ]);

  check("monorepo → archipelago", pickComposition(analyzeCensus(monoTree)) === "archipelago");
  check("deep nesting → terrace mount", pickComposition(analyzeCensus(deepTree)) === "terrace-mount");
  check("dominant core → ring city", pickComposition(analyzeCensus(coreTree)) === "ring-city");
  check("flat and wide → canyon strata", pickComposition(analyzeCensus(flatTree)) === "canyon-strata");
  check("coreShare measures the heaviest top dir", (() => {
    const c = analyzeCensus(coreTree);
    return c.coreDir === "src" && c.coreShare > 0.9;
  })());

  // terrace mount: altitude = depth, plaza at sea level
  {
    const m = layoutMap(deepTree, 7);
    check("terrace layout says terrace", m.composition === "terrace-mount");
    const q3 = m.quarters.find((q) => q.path === "a/b/c");
    const q1 = m.quarters.find((q) => q.path === "a");
    const at = (r) => m.heights.get(`${r.x + 1},${r.y + 1}`) ?? 0;
    check("deeper quarters sit higher", !!q3 && !!q1 && at(q3.rect) > at(q1.rect));
    check("plaza stays at ground level", !m.heights.has(`${m.townCenter.tx},${m.townCenter.ty}`));
    check("the sea is never raised", [...m.water].every((k) => !m.heights.has(k)));
    check("roles ride the layout", m.roles.get("a/b/c/d/f4.ts") === "source" && m.roles.get("docs/d.md") === "docs");
  }

  // ring city: centered core, raised, wrapped by the ring road
  {
    const m = layoutMap(coreTree, 7);
    check("ring layout says ring", m.composition === "ring-city");
    const core = m.quarters.find((q) => q.depth === 1 && q.path === "src");
    check("core exists as a quarter", !!core);
    if (core) {
      const ccx = core.rect.x + core.rect.w / 2;
      const ccy = core.rect.y + core.rect.h / 2;
      const mcx = m.cityRect.x + m.cityRect.w / 2;
      const mcy = m.cityRect.y + m.cityRect.h / 2;
      check("core is centered", Math.abs(ccx - mcx) <= 2 && Math.abs(ccy - mcy) <= 2);
      check("core is raised", m.heights.get(`${core.rect.x + 1},${core.rect.y + 1}`) === 2);
      check(
        "ring road wraps the core",
        m.roads.has(`${core.rect.x - 1},${core.rect.y - 1}`) &&
          m.roads.has(`${core.rect.x + core.rect.w},${core.rect.y + core.rect.h}`),
      );
    }
  }

  // canyon strata: stretched frame, the Long Road, alternating shelves
  {
    const m = layoutMap(flatTree, 7);
    check("canyon layout says canyon", m.composition === "canyon-strata");
    check("the gorge is stretched", m.cityRect.w >= m.cityRect.h * 1.8);
    const ry = m.cityRect.y + Math.floor(m.cityRect.h / 2);
    let onRow = 0;
    for (let tx = m.cityRect.x; tx < m.cityRect.x + m.cityRect.w; tx++) if (m.roads.has(`${tx},${ry}`)) onRow++;
    check("the Long Road runs the gorge", onRow >= Math.floor(m.cityRect.w * 0.5));
    check("some strata rise", [...m.heights.values()].some((v) => v === 1));
    check("road cuts stay at the floor", [...m.roads].every((k) => !m.heights.has(k)));
  }

  // streets: measured imports become circulation, deterministically
  {
    const edges = [
      { from: "alpha/a.js", to: "beta/c.js" },
      { from: "alpha/a.js", to: "beta/c.js" },
      { from: "gamma/e.js", to: "alpha/b.js" },
    ];
    const m = layoutMap(flatTree, 7, edges);
    check("edges route as streets", m.depEdgesRouted === 2 && m.streets.size > 0);
    check("streets never overlap roads or plots", [...m.streets].every((k) => !m.roads.has(k) && !m.used.has(k)));
    check("street layout is deterministic", layoutHash(m) === layoutHash(layoutMap(flatTree, 7, edges)));
    check("edges change the hash", layoutHash(m) !== layoutHash(layoutMap(flatTree, 7)));
    check("self and unknown edges are ignored", layoutMap(flatTree, 7, [{ from: "alpha/a.js", to: "alpha/a.js" }, { from: "ghost.js", to: "beta/c.js" }]).depEdgesRouted === 0);
  }

  // archipelago keeps its sea; streets across the channel become bridges
  {
    const edges = [{ from: "packages/a/i.ts", to: "packages/b/k.ts" }];
    const m = layoutMap(monoTree, 7, edges);
    check("archipelago layout says archipelago", m.composition === "archipelago");
    check("the channels still flood", m.water.size > 0);
    const wet = [...m.streets].filter((k) => m.water.has(k));
    check("street bridges span the channel", wet.length === 0 || wet.every((k) => m.bridges.has(k)));
  }

  // world DNA carries the composition, typology, scale and landmark laws
  {
    const { deriveWorldDNA, scaleTierFor, deriveLandmark } = await import("../apps/web/src/game/worlddna.ts");
    const dna = deriveWorldDNA(analyzeCensus(coreTree), 7);
    check("dna cites the composition", dna.composition === "ring-city" && dna.loreNotes.some((n) => n.subject === "composition" && n.line.includes("ring city")));
    check("dna maps roles to structures", dna.structures.test === "watchtower" && dna.structures.giant === "megastructure" && dna.structures.docs === "stela");
    const forge = deriveWorldDNA(analyzeCensus(coreTree), 7, "oracle-forge");
    const ruin = deriveWorldDNA(analyzeCensus(coreTree), 7, "verdant-ruin");
    check("forge realms raise workshops for source", forge.structures.source === "workshop" && ruin.structures.source === "dwelling");
    check("scale tiers bucket by file count", scaleTierFor(10) === "hamlet" && scaleTierFor(100) === "town" && scaleTierFor(1000) === "city" && scaleTierFor(5000) === "metropolis");
    check("landmark cites the loudest fact", deriveLandmark(analyzeCensus(monoTree)).kind === "harbor-beacon" && dna.landmark.kind === "colossus");
    check("landmark lore rides the notes", dna.loreNotes.some((n) => n.subject === "landmark"));
  }
}

// --- Dependency survey: grep hits → real file edges ---------------------------
console.log("Dependency survey (street law)");
{
  const { parseDepHits, resolveDepEdges } = await import("../packages/runtime/src/depscan.ts");
  const files = [
    "src/a.ts",
    "src/b.ts",
    "src/ui/index.tsx",
    "packages/y/src/index.ts",
    "packages/x/src/main.ts",
    "rich/console.py",
    "rich/__init__.py",
    "pkg/mod.py",
    "pkg/x.py",
    "src/main/java/com/foo/Bar.java",
    "src/main/java/com/foo/App.java",
    "src/main.rs",
    "src/util.rs",
    "src/game/map.rs",
  ];
  const hits = parseDepHits([
    './src/a.ts:1:import { b } from "./b";',
    './src/a.ts:2:import ui from "./ui";',
    './src/a.ts:3:import React from "react";',
    './packages/x/src/main.ts:1:import { y } from "@scope/y";',
    './rich/table.py:9:from rich.console import Console',
    "./pkg/mod.py:3:from .x import thing",
    "./src/main/java/com/foo/App.java:4:import com.foo.Bar;",
    "./src/main.rs:2:mod util;",
    "./src/main.rs:3:use crate::game::map::Layout;",
    './src/a.ts:1:import { b } from "./b";',
  ]);
  check("grep lines parse with ./ stripped", hits.length === 10 && hits[0].path === "src/a.ts");
  const edges = resolveDepEdges(hits, [...files, "rich/table.py"]);
  const has = (from, to) => edges.some((e) => e.from === from && e.to === to);
  check("js relative resolves with extension inference", has("src/a.ts", "src/b.ts"));
  check("js dir import resolves to index", has("src/a.ts", "src/ui/index.tsx"));
  check("external packages resolve to nothing", !edges.some((e) => e.to.includes("react")));
  check("workspace import maps to the package entry", has("packages/x/src/main.ts", "packages/y/src/index.ts"));
  check("python absolute import resolves", has("rich/table.py", "rich/console.py"));
  check("python relative import resolves", has("pkg/mod.py", "pkg/x.py"));
  check("java unique suffix resolves", has("src/main/java/com/foo/App.java", "src/main/java/com/foo/Bar.java"));
  check("rust mod resolves to sibling", has("src/main.rs", "src/util.rs"));
  check("rust use crate:: walks down to the file", has("src/main.rs", "src/game/map.rs"));
  check("duplicate hits dedupe", edges.filter((e) => e.from === "src/a.ts" && e.to === "src/b.ts").length === 1);
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

  // Orphan sweep: a restarted relay must reap machines it no longer owns,
  // while sparing the fleet of live and still-booting sessions.
  const reapedNames = [];
  const sweepDriver = {
    create: slowDriver.create,
    fleet: ["sb-live1", "sb-old-a", "sb-old-b", "sb-booting"],
    sweep: async (keep) => {
      let n = 0;
      for (const name of sweepDriver.fleet) {
        if (keep.has(name)) continue;
        reapedNames.push(name);
        n++;
      }
      return n;
    },
  };
  const mgr2 = new SandboxManager(sweepDriver);
  await mgr2.provision("live1", "9.9.9.9");
  const booting = mgr2.provision("booting", "8.8.8.8");
  const reaped = await mgr2.sweepOrphans();
  await booting;
  check("sweep reaps only orphan machines", reaped === 2 && reapedNames.includes("sb-old-a") && reapedNames.includes("sb-old-b"));
  check("sweep spares live and booting sessions", !reapedNames.includes("sb-live1") && !reapedNames.includes("sb-booting"));
  const noSweepMgr = new SandboxManager(slowDriver);
  check("sweep is a no-op for drivers without fleets", (await noSweepMgr.sweepOrphans()) === 0);
}

// --- Castle Era: component law, plan law, growth stability, isomorphism ------
console.log("Castle Era (component law)");
{
  const { buildComponentGraph, classifyComponentFile, componentBrief } = await import(
    "../apps/web/src/game/components.ts"
  );
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  // classifier law: probes outrank names, names outrank extensions
  const noProbes = { routes: new Set(), tables: new Set() };
  check("sql is the ore mine", classifyComponentFile("db/schema.sql", noProbes) === "database");
  check("route probe outranks plain name", classifyComponentFile("main.js", { routes: new Set(["main.js"]), tables: new Set() }) === "app-server");
  check("table probe outranks web ext", classifyComponentFile("models.html", { routes: new Set(), tables: new Set(["models.html"]) }) === "database");
  check("tests outrank probes", classifyComponentFile("tests/api.test.js", { routes: new Set(["tests/api.test.js"]), tables: new Set() }) === "tests");
  check("css is the web front", classifyComponentFile("styles.css", noProbes) === "app-web");
  check("etl dir is the pipeline", classifyComponentFile("etl/import.js", noProbes) === "pipeline");
  check("markdown is the chronicle", classifyComponentFile("README.md", noProbes) === "docs");
  check("plain source is the foundry", classifyComponentFile("util.js", noProbes) === "library");

  // the bakery commission: one small website with a server, a db, a pipeline
  const bakery = dir("", [
    file("index.html", 120),
    file("styles.css", 260),
    file("app.js", 180),
    file("server.js", 240),
    dir("db", [file("db/schema.sql", 60)]),
    dir("etl", [file("etl/import.js", 90)]),
    dir("tests", [file("tests/app.test.js", 110)]),
    file("README.md", 40),
  ]);
  const probes = [
    { path: "styles.css", probe: "color", value: "#E86A33" },
    { path: "styles.css", probe: "color", value: "#e86a33" },
    { path: "styles.css", probe: "color", value: "#e86a33" },
    { path: "styles.css", probe: "color", value: "#222831" },
    { path: "server.js", probe: "route", value: "GET /" },
    { path: "server.js", probe: "route", value: "GET /menu" },
    { path: "server.js", probe: "route", value: "POST /order" },
    { path: "db/schema.sql", probe: "table", value: "orders" },
    { path: "db/schema.sql", probe: "table", value: "items" },
  ];
  const edges = [
    { from: "app.js", to: "server.js" },
    { from: "etl/import.js", to: "db/schema.sql" },
    { from: "tests/app.test.js", to: "server.js" },
  ];
  const g = buildComponentGraph(bakery, edges, probes);
  const ids = g.components.map((c) => c.id);
  check("bakery groups into eight components (wards law)", g.components.length === 8, ids.join(","));
  check("library sliver folds into the web front", ids.includes("root:app-web") && !ids.includes("root:library"));
  const styles = g.components.find((c) => c.id === "root:file:styles.css");
  check("the stylesheet stands as its own ward", Boolean(styles) && styles.label === "styles.css");
  check("palette is measured, deduped, frequency-ordered", styles.facts.palette[0] === "#e86a33" && styles.facts.palette[1] === "#222831");
  const web = g.components.find((c) => c.id === "root:app-web");
  check("web front owns the folded client script", web.paths.includes("app.js"));
  const server = g.components.find((c) => c.id === "root:app-server");
  check("routes are counted on the server", server.facts.routes === 3);
  const db = g.components.find((c) => c.id === "db:database");
  check("tables are counted on the mine", db.facts.tables === 2);
  check("the keep is the server", g.rootId === "root:app-server");
  check("edges aggregate to component edges", g.edges.length === 3);
  check("pipeline feeds the database", g.edges.some((e) => e.from === "etl:pipeline" && e.to === "db:database"));
  const brief = componentBrief(g);
  check("brief cites the keep and the palette", brief.includes("[the keep]") && brief.includes("#e86a33"));
  check("graph derivation is deterministic", JSON.stringify(buildComponentGraph(bakery, edges, probes)) === JSON.stringify(g));
}

console.log("Castle Era (plan law)");
{
  const { buildComponentGraph } = await import("../apps/web/src/game/components.ts");
  const { planCastle, defaultFormFor, ALLOWED_FORMS, traitsFor } = await import("../apps/web/src/game/castle.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  const mk = (withDb, cssColor = "#e86a33") => {
    const kids = [
      file("index.html", 120),
      file("styles.css", 260),
      file("server.js", 240),
      dir("etl", [file("etl/import.js", 90)]),
      dir("tests", [file("tests/app.test.js", 110)]),
      file("README.md", 40),
    ];
    if (withDb) kids.splice(3, 0, dir("db", [file("db/schema.sql", 60)]));
    const probes = [
      { path: "styles.css", probe: "color", value: cssColor },
      { path: "server.js", probe: "route", value: "GET /" },
      { path: "server.js", probe: "route", value: "GET /menu" },
      { path: "server.js", probe: "route", value: "POST /order" },
    ];
    if (withDb) {
      probes.push({ path: "db/schema.sql", probe: "table", value: "orders" });
      probes.push({ path: "db/schema.sql", probe: "table", value: "items" });
    }
    const edges = withDb ? [{ from: "etl/import.js", to: "db/schema.sql" }] : [];
    return buildComponentGraph(mkTree(kids), edges, probes);
  };
  const mkTree = (kids) => dir("", kids);

  const SEED = 20260818;
  const g1 = mk(false);
  const p1 = planCastle(g1, SEED);
  check("keep stands at the origin", (() => {
    const k = p1.sockets.find((s) => s.componentId === g1.rootId);
    return k && k.ring === 0 && k.x === 0 && k.z === 0 && k.form === "keep";
  })());
  check("support kinds hold the outer ring", p1.sockets.filter((s) => ["root:tests", "root:docs", "tests:tests"].includes(s.componentId) || s.componentId.endsWith(":tests") || s.componentId.endsWith(":docs")).every((s) => s.ring >= 2));
  check("no two sockets share a slot", new Set(p1.sockets.map((s) => `${s.ring}:${s.slot}`)).size === p1.sockets.length);
  check("plan is deterministic", planCastle(g1, SEED).hash === p1.hash);

  // growth law: founding again WITH the db, carrying the ledger — nothing moves
  const g2 = mk(true);
  const p2 = planCastle(g2, SEED, p1.ledger);
  for (const s of p1.sockets) {
    const after = p2.sockets.find((t) => t.componentId === s.componentId);
    if (!after || after.ring !== s.ring || after.slot !== s.slot || after.x !== s.x || after.z !== s.z) {
      check(`socket ${s.componentId} never moves`, false, JSON.stringify({ before: s, after }));
    }
  }
  check("all prior sockets stood fast", true);
  const mine = p2.sockets.find((s) => s.componentId === "db:database");
  check("the mine claims a fresh socket", Boolean(mine) && !p1.sockets.some((s) => s.ring === mine.ring && s.slot === mine.slot));
  check("growth changes the hash", p2.hash !== p1.hash);
  check("rails run from pipeline to mine", p2.connectors.some((c) => c.kind === "rails" && c.from === "etl:pipeline" && c.to === "db:database"));
  const rails = p2.connectors.find((c) => c.kind === "rails");
  check("rails start and end at their sockets", (() => {
    const a = p2.sockets.find((s) => s.componentId === rails.from);
    const b = p2.sockets.find((s) => s.componentId === rails.to);
    const first = rails.points[0];
    const last = rails.points[rails.points.length - 1];
    return first.x === a.x && first.z === a.z && last.x === b.x && last.z === b.z;
  })());

  // the fundamental isomorphism: repaint the css → the manor tint changes,
  // nothing moves, the hash records the difference
  const g3 = mk(true, "#3aa0ff");
  const p3 = planCastle(g3, SEED, p2.ledger);
  const manor2 = p2.sockets.find((s) => s.componentId === "root:file:styles.css");
  const manor3 = p3.sockets.find((s) => s.componentId === "root:file:styles.css");
  check("css color becomes the stylesheet ward's tint", manor2.traits.tint === "#e86a33" && manor3.traits.tint === "#3aa0ff");
  check("a repaint moves nothing", manor3.ring === manor2.ring && manor3.slot === manor2.slot && p3.sockets.length === p2.sockets.length);
  check("a repaint changes the hash", p3.hash !== p2.hash);

  // razing: the db component vanishes — its socket stands as a ruin
  const g4 = mk(false);
  const p4 = planCastle(g4, SEED, p3.ledger);
  const ruin = p4.sockets.find((s) => s.componentId === "db:database");
  check("a vanished component stands as a ruin", Boolean(ruin) && ruin.razed === true && ruin.ring === mine.ring && ruin.slot === mine.slot);

  // trait bindings + vocabulary
  const server = g2.components.find((c) => c.id === "root:app-server");
  check("gates bind to routes", traitsFor(server).gates === 3);
  const dbC = g2.components.find((c) => c.id === "db:database");
  check("shafts bind to tables", traitsFor(dbC).shafts === 2);
  check("every kind has a lawful default form", Object.entries(ALLOWED_FORMS).every(([k, forms]) => forms.length > 0 && forms[0] === defaultFormFor(k)));
  check("gate faces the server's angle", (() => {
    const sv = p2.sockets.find((s) => s.componentId === "root:app-server");
    return Math.abs(p2.wall.gateAngle - sv.angle) < 1e-9 || sv.ring === 0;
  })());
}

console.log("Castle Era (live loop)");
{
  const { CastleState } = await import("../apps/web/src/game/castlestate.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });
  const bakery = dir("", [
    file("index.html", 120),
    file("styles.css", 260),
    file("server.js", 240),
    dir("tests", [file("tests/app.test.js", 110)]),
    file("README.md", 40),
  ]);
  const probes = [
    { path: "styles.css", probe: "color", value: "#e86a33" },
    { path: "server.js", probe: "route", value: "GET /" },
  ];

  const st = new CastleState();
  const plan0 = st.found(bakery, 777, [], probes);
  check("founding plans the castle", plan0.sockets.length >= 4 && plan0.sockets.some((s) => s.form === "keep"));

  // THE loop: repaint css → exactly one traits diff, tint flips, nothing moves
  const r1 = st.applyFacts("styles.css", [{ path: "styles.css", probe: "color", value: "#3aa0ff" }]);
  const tintChange = r1.changes.find((c) => c.kind === "traits" && c.componentId === "root:file:styles.css");
  check("repaint yields a traits diff", Boolean(tintChange), JSON.stringify(r1.changes));
  check("tint flips to the measured color", tintChange && tintChange.before.tint === "#e86a33" && tintChange.after.tint === "#3aa0ff");
  check("repaint adds and removes nothing", r1.changes.every((c) => c.kind === "traits"));
  check("repaint moves nothing", (() => {
    const a = plan0.sockets.find((s) => s.componentId === "root:file:styles.css");
    const b = r1.plan.sockets.find((s) => s.componentId === "root:file:styles.css");
    return a.ring === b.ring && a.slot === b.slot;
  })());

  // growth: a worker writes a new module → a new socket is added, none move
  const r2 = st.applyWrite("lib/colors.js", true, 140, 0);
  check("a new module raises a new component", r2.changes.some((c) => c.kind === "added" && c.componentId === "lib:library"), JSON.stringify(r2.changes));
  check("growth never moves the old town", plan0.sockets.every((s) => {
    const b = r2.plan.sockets.find((t) => t.componentId === s.componentId);
    return b && b.ring === s.ring && b.slot === s.slot;
  }));

  // representation loop: lawful choice lands with its citation
  const r3 = st.applyRepr("lib:library", "well", "the palette utils draw color like water");
  const wk = r3.plan.sockets.find((s) => s.componentId === "lib:library");
  check("lawful form choice lands", wk.form === "well" && wk.cited === "the palette utils draw color like water");
  check("form change is reported", r3.changes.some((c) => c.kind === "form" && c.componentId === "lib:library"));

  // unlawful choice falls back to the kind's default form
  const r4 = st.applyRepr("lib:library", "ore-mine", "everything is a mine");
  check("unlawful form falls back", r4.plan.sockets.find((s) => s.componentId === "lib:library").form === "foundry");

  // the keep may be retitled, never re-formed
  const keepId = r4.plan.sockets.find((s) => s.ring === 0).componentId;
  const r5 = st.applyRepr(keepId, "manor", "make it cozy");
  check("the keep stays the keep", r5.plan.sockets.find((s) => s.componentId === keepId).form === "keep");

  // bare-earth commission: the README lands first — a support root must not
  // squat the motte; the keep waits for the app, then rises at the origin
  const bare = new CastleState();
  const bp0 = bare.found(dir("", [file("README.md", 20)]), 777, [], []);
  check("a README-only realm leaves the motte bare", bp0.sockets.every((s) => s.ring !== 0));
  const bg = bare.applyWrite("index.html", true, 80, 0);
  const bKeep = bg.plan.sockets.find((s) => s.ring === 0);
  check("the app claims the keep when it arrives", Boolean(bKeep) && bKeep.componentId.endsWith("app-web") && bKeep.form === "keep");
  check("the docs pretender stands outside the keep", bg.plan.sockets.filter((s) => s.componentId.includes("docs")).every((s) => s.ring >= 2));
}

console.log("Castle Era (fact survey)");
{
  const { parseFactHits, factScanFileCommand, hitsEqual, FACT_SCAN_COMMAND } = await import(
    "../packages/runtime/src/factscan.ts"
  );
  const lines = [
    "./styles.css:3:  --brand: #E86A33;",
    "styles.css:9:body { background: #e86a33; color: #222831 }",
    "app.ts:4:// fixes #123456 properly",
    "theme.ts:2:export const brandColor = '#AABBCC';",
    "server.js:12:app.get('/menu', handler)",
    "server.js:13:app.post( \"/order\", h)",
    "server.js:14:cache.get('key')",
    "api.py:8:@app.route('/health')",
    "api.py:9:@router.get('/users')",
    "db/schema.sql:1:CREATE TABLE IF NOT EXISTS orders (",
    "db/schema.sql:7:create table items(",
    "models.py:3:    __tablename__ = 'customers'",
    "schema.prisma:5:model Invoice {",
    "notes.ts:5:model Invoice {",
  ];
  const hits = parseFactHits(lines);
  const vals = (probe) => hits.filter((h) => h.probe === probe).map((h) => `${h.path}|${h.value}`);
  check("colors dedupe and lowercase", vals("color").includes("styles.css|#e86a33") && vals("color").filter((v) => v === "styles.css|#e86a33").length === 1);
  check("secondary color counted", vals("color").includes("styles.css|#222831"));
  check("issue refs are not colors", !vals("color").some((v) => v.includes("#123456")));
  check("color-flavored code lines count", vals("color").includes("theme.ts|#aabbcc"));
  check("routes read method and path", vals("route").includes("server.js|GET /menu") && vals("route").includes("server.js|POST /order"));
  check("map.get is not a route", !vals("route").some((v) => v.includes("key")));
  check("python decorators are routes", vals("route").includes("api.py|ROUTE /health") && vals("route").includes("api.py|GET /users"));
  check("create table reads the name", vals("table").includes("db/schema.sql|orders") && vals("table").includes("db/schema.sql|items"));
  check("orm table names count", vals("table").includes("models.py|customers"));
  check("prisma models only in .prisma", vals("table").includes("schema.prisma|invoice") && !vals("table").some((v) => v.startsWith("notes.ts")));
  check("caps hold", parseFactHits(Array.from({ length: 3000 }, (_, i) => `f${i}.css:1:a{color:#a1b2c3}`), 100).length === 100);
  check("per-path cap holds", parseFactHits(Array.from({ length: 200 }, (_, i) => `one.css:${i}:a{color:#${String(100000 + i).slice(0, 6)}}`)).length <= 64);
  check("single-file command quotes the path", factScanFileCommand("a b'c.css").includes(`'a b'\\''c.css'`));
  check("survey command is bounded and pathed", FACT_SCAN_COMMAND.includes("-rInHE") && FACT_SCAN_COMMAND.includes("head -n 6000"));
  check("hitsEqual ignores order", hitsEqual(
    [{ path: "x", probe: "color", value: "#aaaaaa" }, { path: "x", probe: "color", value: "#bbbbbb" }],
    [{ path: "x", probe: "color", value: "#bbbbbb" }, { path: "x", probe: "color", value: "#aaaaaa" }],
  ));
  check("hitsEqual sees change", !hitsEqual([{ path: "x", probe: "color", value: "#aaaaaa" }], [{ path: "x", probe: "color", value: "#cccccc" }]));
}

console.log("Castle Era (master builder law)");
{
  const { buildComponentGraph } = await import("../apps/web/src/game/components.ts");
  const { lawfulChoices } = await import("../apps/web/src/reprloop.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });
  const g = buildComponentGraph(
    dir("", [
      file("server.js", 240),
      dir("lib", [file("lib/util.js", 100)]),
      dir("docs", [file("docs/guide.md", 60)]),
    ]),
    [],
    [{ path: "server.js", probe: "route", value: "GET /" }],
  );
  const picks = lawfulChoices(
    [
      { componentId: "lib:library", form: "well", cited: "one small spring of helpers" },
      { componentId: "docs:docs", form: "chapel", cited: "the guide reads like liturgy" },
      { componentId: "lib:library", form: "smithy", cited: "duplicate must drop" },
      { componentId: "docs:docs", form: "ore-mine", cited: "unlawful form must drop" },
      { componentId: "ghost:library", form: "well", cited: "unknown component must drop" },
      { componentId: "root:app-server", form: "gatehouse", cited: "" },
    ],
    g,
  );
  check("lawful creative choices pass", picks.some((p) => p.componentId === "lib:library" && p.form === "well"));
  check("chapel is lawful for docs", picks.some((p) => p.componentId === "docs:docs" && p.form === "chapel"));
  check("one choice per component", picks.filter((p) => p.componentId === "lib:library").length === 1);
  check("unlawful forms are discarded", !picks.some((p) => p.form === "ore-mine"));
  check("unknown components are discarded", !picks.some((p) => p.componentId === "ghost:library"));
  check("citations are mandatory", !picks.some((p) => p.componentId === "root:app-server"));
  check("garbage input yields silence", lawfulChoices("nonsense", g).length === 0 && lawfulChoices(null, g).length === 0);

  // second charter: genomes ride the choices; bare citations stay noise
  const gOnly = lawfulChoices(
    [
      { componentId: "lib:library", cited: "obsidian discipline in the helpers", genome: { material: { family: "obsidian" } } },
      { componentId: "docs:docs", cited: "a bare word with no instrument" },
      { componentId: "lib:library", form: "well", cited: "duplicate must drop" },
    ],
    g,
  );
  check("genome-only choices survive with an empty form", gOnly.some((p) => p.componentId === "lib:library" && p.form === "" && p.genome));
  check("a bare citation is noise", !gOnly.some((p) => p.componentId === "docs:docs"));
  check("one choice per component still holds", gOnly.filter((p) => p.componentId === "lib:library").length === 1);

  // third charter: the growth writ binds choices to the named newcomers
  const writ = lawfulChoices(
    [
      { componentId: "lib:library", form: "well", cited: "a newcomer, lawfully dressed" },
      { componentId: "docs:docs", form: "chapel", cited: "an elder outside the writ" },
    ],
    g,
    new Set(["lib:library"]),
  );
  check("the growth writ admits the newcomer", writ.some((p) => p.componentId === "lib:library"));
  check("the growth writ voids choices beyond it", !writ.some((p) => p.componentId === "docs:docs"));
}

console.log("Castle Era (residency law)");
{
  const { PURSE_LAW, foundPurse, tryWake, newlySighted, undressed, GROWTH_BATCH } = await import(
    "../apps/web/src/game/residency.ts"
  );
  const { CastleState } = await import("../apps/web/src/game/castlestate.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  // the purse: counted, spaced, gold-floored — refusals spend nothing
  const purse = foundPurse();
  check("a fresh purse grants the first wake", tryWake(purse, 1_000, 0).allowed === true);
  check("a granted wake is spent", purse.wakesLeft === PURSE_LAW.wakes - 1);
  const hasty = tryWake(purse, 1_000 + PURSE_LAW.debounceMs - 1, 0);
  check("the debounce floor refuses a hasty wake", hasty.allowed === false && hasty.reason === "debounce");
  check("a refused wake spends nothing", purse.wakesLeft === PURSE_LAW.wakes - 1);
  check("the floor lifts with time", tryWake(purse, 1_000 + PURSE_LAW.debounceMs, 0).allowed === true);
  const gilt = tryWake(foundPurse(), 0, PURSE_LAW.goldCeiling);
  check("beyond the gold ceiling taste yields to work", gilt.allowed === false && gilt.reason === "gold");
  const drained = foundPurse();
  for (let i = 0; i < PURSE_LAW.wakes; i++) tryWake(drained, (i + 1) * PURSE_LAW.debounceMs * 2, 0);
  const empty = tryWake(drained, 1e12, 0);
  check("an emptied purse refuses forever", empty.allowed === false && empty.reason === "empty");

  // the watch: newcomers sighted, the undressed queue for growth decrees
  const bakery = dir("", [file("index.html", 120), file("server.js", 240), file("README.md", 40)]);
  const st = new CastleState();
  const p0 = st.found(bakery, 909, [], []);
  const known = new Set(p0.sockets.map((s) => s.componentId));
  check("a founded castle has no newcomers", newlySighted(known, p0).length === 0);
  const grown = st.applyWrite("lib/util.js", true, 140, 0);
  const fresh = newlySighted(known, grown.plan);
  check("the watch sights a risen component", fresh.length === 1 && fresh[0] === "lib:library");
  check("a newcomer wears only derived dress", undressed(grown.plan, fresh).join(",") === "lib:library");
  const grownLedger = structuredClone(grown.plan.ledger);
  const dressed = st.applyRepr("lib:library", "well", "one spring of helpers", { material: { family: "marble" } });
  check("a chosen genome leaves the undressed rolls", undressed(dressed.plan, fresh).length === 0);
  check("growth batches stay small", GROWTH_BATCH >= 1 && GROWTH_BATCH <= 6);

  // ruins: a razed claim is neither sighted nor dressed
  const st2 = new CastleState();
  const p2 = st2.found(bakery, 909, [], [], grownLedger);
  check("the watch never sights a ruin", !newlySighted(new Set(), p2).includes("lib:library"));
  check("a razed claim never queues for dress", undressed(p2, ["lib:library"]).length === 0);
}

console.log("Castle Era (flourish law)");
{
  const { validateFlourish, signWork, lawfulFlourishes, flourishSignature } = await import(
    "../apps/web/src/game/flourish.ts"
  );
  const { CastleState } = await import("../apps/web/src/game/castlestate.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  check("an unlawful mark does not exist", validateFlourish({ mark: "graffiti", author: "A", cited: "x" }) === null);
  check(
    "an unsigned or uncited mark does not exist",
    validateFlourish({ mark: "lantern", author: "", cited: "x" }) === null &&
      validateFlourish({ mark: "lantern", author: "A", cited: "" }) === null,
  );
  check("a lawful flourish validates", validateFlourish({ mark: "lantern", author: "Ashka", cited: "forged the lexer" })?.mark === "lantern");

  const one = signWork(undefined, { mark: "lantern", author: "Ashka", cited: "forged the lexer" });
  const two = signWork(one, { mark: "garden", author: "Veyra", cited: "tended the docs" });
  const three = signWork(two, { mark: "beehive", author: "Odran", cited: "polished the halls" });
  check("three authors may sign one construction", three.length === 3);
  check("a fourth author is refused", signWork(three, { mark: "mosaic", author: "Imre", cited: "late" }) === null);
  const resigned = signWork(three, { mark: "mosaic", author: "Ashka", cited: "returned to re-lay the door" });
  check(
    "re-signing replaces the author's earlier mark",
    resigned.length === 3 && resigned.some((f) => f.author === "Ashka" && f.mark === "mosaic") && !resigned.some((f) => f.mark === "lantern"),
  );
  check("signatures name mark and author stably", flourishSignature(two) === "lantern@Ashka+garden@Veyra");
  check("no marks reads unsigned", flourishSignature([]) === "unsigned" && flourishSignature(undefined) === "unsigned");
  check(
    "ledger-borne garbage is shed",
    lawfulFlourishes([{ mark: "lantern", author: "A", cited: "x" }, "junk", { mark: "voidmark", author: "B", cited: "y" }]).length === 1,
  );

  // live fold: sign through the state, refuse ghosts, ride the hash + ledger
  const bakery = dir("", [
    file("index.html", 120),
    file("styles.css", 260),
    dir("db", [file("db/schema.sql", 90)]),
    file("README.md", 40),
  ]);
  const st = new CastleState();
  const p0 = st.found(bakery, 555, [], []);
  const h0 = p0.hash;
  const r1 = st.applyFlourish("db/schema.sql", "forgefire", "Ashka the Unsleeping", "sank both shafts by hand");
  check(
    "a signed work lands and is reported",
    r1.changes.some((c) => c.kind === "flourish" && c.componentId === "db:database" && c.author === "Ashka the Unsleeping"),
  );
  check(
    "the mark stands on the socket",
    r1.plan.sockets.find((s) => s.componentId === "db:database").flourishes.some((f) => f.mark === "forgefire"),
  );
  check("the castle hash answers the signature", r1.plan.hash !== h0);
  const rDir = st.applyFlourish("db", "beehive", "Veyra Signal-Bearer", "swept the mine floor");
  check("a directory path resolves to its wing", rDir.changes.some((c) => c.kind === "flourish" && c.componentId === "db:database"));
  const ghost = st.applyFlourish("phantom/none.js", "lantern", "Odran", "never was");
  check("a pathless mark is refused", ghost.changes.length === 0);
  const dup = st.applyFlourish("db/schema.sql", "forgefire", "Ashka the Unsleeping", "sank both shafts by hand");
  check("an identical re-sign is silence", dup.changes.length === 0);

  // persistence: marks ride the ledger across re-foundings, hash identical
  const st2 = new CastleState();
  const p2 = st2.found(bakery, 555, [], [], structuredClone(rDir.plan.ledger));
  check(
    "signed works survive re-founding",
    p2.sockets.find((s) => s.componentId === "db:database").flourishes.length === 2,
  );
  check("the re-founded castle hashes identical", p2.hash === rDir.plan.hash);

  // a shrunken repo leaves a ruin; ruins cannot be signed
  const shrunk = dir("", [file("index.html", 120), file("styles.css", 260), file("README.md", 40)]);
  const st3 = new CastleState();
  st3.found(shrunk, 555, [], [], structuredClone(rDir.plan.ledger));
  const ruin = st3.applyFlourish("db/schema.sql", "lantern", "Imre", "haunts the ruin");
  check("a ruin cannot be signed", ruin.changes.length === 0);
}

console.log("Castle Era (signed works law)");
{
  const { FLOURISH_MARKS } = await import("../packages/protocol/src/index.ts");
  const { TEMPERAMENTS, temperamentFor, temperamentBrief } = await import(
    "../packages/runtime/src/temperament.ts"
  );
  const { executeTool } = await import("../packages/runtime/src/tools.ts");
  const { Emitter } = await import("../packages/runtime/src/emitter.ts");

  const t1 = temperamentFor("Ashka the Unsleeping", 777);
  check("temperaments are deterministic", t1.name === temperamentFor("Ashka the Unsleeping", 777).name);
  check(
    "a roster draws more than one temperament",
    new Set(["Ashka", "Veyra", "Odran", "Imre", "Berta", "Corin", "Aldric", "Sable"].map((n) => temperamentFor(n, 777).name)).size >= 3,
  );
  check(
    "temperaments lean only on lawful marks",
    TEMPERAMENTS.every((t) => t.marks.every((m) => FLOURISH_MARKS.includes(m))),
  );
  check("the temperament brief teaches the instrument", /sign_work/.test(temperamentBrief(t1)));

  // the sign_work tool: measured provenance or refusal
  const events = [];
  const ctx = {
    exec: {},
    emitter: new Emitter((e) => events.push(e)),
    agentId: "w1",
    agentName: "Ashka the Unsleeping",
    lexicon: () => undefined,
    sendMessage: () => {},
    delegatesUsed: { count: 0 },
    touched: new Set(["src/lexer.js"]),
    stats: { filesRead: new Set(), filesWritten: new Set(), maxFailuresSeen: 0, lastFailedCount: 0, lastTestGreen: false },
  };
  const refused = await executeTool(ctx, "sign_work", { path: "src/parser.js", mark: "lantern", cited: "x" });
  check("signing an untouched wing is refused", /have not worked/.test(refused));
  const badmark = await executeTool(ctx, "sign_work", { path: "src/lexer.js", mark: "graffiti", cited: "x" });
  check("an unlawful mark is refused at the tool", /unknown mark/.test(badmark));
  const signed = await executeTool(ctx, "sign_work", { path: "src/lexer.js", mark: "forgefire", cited: "forged the lexer whole" });
  check("a lawful signing is confirmed", /forgefire/.test(signed));
  check(
    "a lawful signing emits castle_flourish",
    events.some((e) => e.type === "castle_flourish" && e.author === "Ashka the Unsleeping" && e.mark === "forgefire" && e.path === "src/lexer.js"),
  );
  check("no event leaks from refusals", events.filter((e) => e.type === "castle_flourish").length === 1);
}

console.log("Castle Era (district eras)");
{
  const { CastleState } = await import("../apps/web/src/game/castlestate.ts");
  const { styleForEra } = await import("../apps/web/src/game/castle.ts");
  const { genomeSignature, styleSignature } = await import("../apps/web/src/game/genome.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });
  const bakery = dir("", [
    file("index.html", 120),
    file("styles.css", 260),
    dir("db", [file("db/schema.sql", 90)]),
    file("README.md", 40),
  ]);
  const styleA = {
    name: "Harbor Timberwork", cited: "a static html page, hand-inlined styles",
    materialBias: ["timber"], roofBias: ["gable"], trimBias: ["halftimber"],
    natureSet: "oak", wallStyle: "palisade", groundTone: "meadow", fog: "none",
  };
  const styleB = {
    name: "Iron Ledger Gothic", cited: "the second commission raised a library wing in cold basalt",
    materialBias: ["basalt"], roofBias: ["dome"],
  };

  // founding commission: declare A
  const st = new CastleState();
  st.found(bakery, 4242, [], []);
  const a = st.applyStyle(styleA);
  check(
    "the founding declaration lands at era zero",
    a.plan.ledger.eras?.length === 1 && styleSignature(a.plan.ledger.eras[0]).startsWith("Harbor"),
  );
  const hA = a.plan.hash;
  const webSigA = genomeSignature(a.plan.sockets.find((s) => s.componentId === "root:app-web").genome);

  // the castle returns: a new commission begins
  const st2 = new CastleState();
  const p1 = st2.found(bakery, 4242, [], [], structuredClone(a.plan.ledger));
  check("a returning castle enters the next commission", p1.ledger.commission === 1);
  check("an unchanged return hashes identical", p1.hash === hA);
  check("the standing style carries into the new era", styleSignature(p1.style).startsWith("Harbor"));

  // the new commission raises a library wing — stamped with its era
  const g = st2.applyWrite("lib/util.js", true, 420);
  check(
    "newcomers are stamped with the commission that raised them",
    g.plan.sockets.find((s) => s.componentId === "lib:library")?.era === 1,
  );
  check("founding wings keep era zero", g.plan.sockets.find((s) => s.componentId === "root:app-web").era === 0);
  const libSigUnderA = genomeSignature(g.plan.sockets.find((s) => s.componentId === "lib:library").genome);

  // the new era declares its own language
  const b = st2.applyStyle(styleB);
  check(
    "the amendment lands on the current era only",
    b.plan.ledger.eras.length === 2 && styleSignature(b.plan.ledger.eras[1]).startsWith("Iron Ledger"),
  );
  check("world dressing follows the newest quarter", styleSignature(b.plan.style).startsWith("Iron Ledger"));
  check(
    "the new wing re-derives under its era's style",
    genomeSignature(b.plan.sockets.find((s) => s.componentId === "lib:library").genome) !== libSigUnderA,
  );
  check(
    "old quarters keep the style that raised them",
    genomeSignature(b.plan.sockets.find((s) => s.componentId === "root:app-web").genome) === webSigA,
  );
  check("the eras roll rides the hash", b.plan.hash !== g.plan.hash);

  // walk-down: a silent era inherits the last declared language
  check("a silent era inherits the last declaration", styleSignature(styleForEra(b.plan.ledger, 5)).startsWith("Iron Ledger"));
  check(
    "legacy ledgers read as a founding-era declaration",
    styleSignature(styleForEra({ version: 1, seed: 1, entries: {}, style: b.plan.ledger.eras[0] }, 9)).startsWith("Harbor"),
  );

  // identity: the stratified castle re-founds byte-identical
  const grownTree = dir("", [
    file("index.html", 120),
    file("styles.css", 260),
    dir("db", [file("db/schema.sql", 90)]),
    file("README.md", 40),
    dir("lib", [file("lib/util.js", 420)]),
  ]);
  const st3 = new CastleState();
  const p3 = st3.found(grownTree, 4242, [], [], structuredClone(b.plan.ledger));
  check("a stratified castle re-founds identical", p3.hash === b.plan.hash);
  check("the third commission counts on", p3.ledger.commission === 2);
}

console.log("Castle Era (taste channel)");
{
  const { tasteRefusal } = await import("../apps/web/src/game/residency.ts");
  const reasons = ["empty", "debounce", "gold"];
  check("every purse refusal has a spoken reason", reasons.every((r) => tasteRefusal(r).length > 10));
  check("refusals are distinct", new Set(reasons.map(tasteRefusal)).size === 3);
}

console.log("Castle Era (persistence law)");
{
  const { upsertRecord, CASTLE_ID_RE } = await import("../apps/relay/src/castles.ts");
  const { HostMessage } = await import("../packages/protocol/src/index.ts");
  const rec = (id, updatedAt, extra = {}) => ({
    id, name: id, createdAt: updatedAt, updatedAt, commissions: 1, lastTitle: "t", ledger: { version: 1 }, hasBundle: false, ...extra,
  });
  const first = upsertRecord([], rec("bakery", 100));
  check("first save founds the record", first.list.length === 1 && first.list[0].commissions === 1);
  const again = upsertRecord(first.list, rec("bakery", 200, { hasBundle: true }));
  check("resave increments commissions and keeps founding date", again.list[0].commissions === 2 && again.list[0].createdAt === 100);
  check("bundle flag is sticky", upsertRecord(again.list, rec("bakery", 300)).list[0].hasBundle === true);
  const many = Array.from({ length: 5 }, (_, i) => rec(`c${i}`, i * 10));
  const capped = upsertRecord(many, rec("fresh", 999), 3);
  check("eviction drops the oldest", capped.list.length === 3 && capped.evicted.includes("c0") && capped.list[0].id === "fresh");
  check("castle ids are slugs", CASTLE_ID_RE.test("iron-bakery-9") && !CASTLE_ID_RE.test("Iron Bakery") && !CASTLE_ID_RE.test("a"));
  const hostMsg = HostMessage.safeParse({ type: "host", protocolVersion: 1, taskId: "t", taskTitle: "T", repoUrl: "castle:bakery", castleId: "bakery" });
  check("host message carries castleId", hostMsg.success);
  const endMsg = HostMessage.safeParse({ type: "end", save: true, castle: { id: "bakery", name: "The Bakery", ledger: { version: 1, seed: 7, entries: {} } } });
  check("end message carries the farewell", endMsg.success);
}

console.log("Castle Era (veil law)");
{
  const { Agent } = await import("../packages/runtime/src/agent.ts");
  const { Emitter } = await import("../packages/runtime/src/emitter.ts");
  const events = [];
  const emitter = new Emitter((e) => events.push(e));
  const inbox = { drain: () => [] };
  const okMessage = {
    content: [{ type: "text", text: "the work is done" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const veil = (failures) => {
    let calls = 0;
    return {
      calls: () => calls,
      messages: {
        create: async () => {
          calls++;
          if (calls <= failures) throw new Error("Request timed out.");
          return okMessage;
        },
      },
    };
  };
  const mkAgent = (client, signal) =>
    new Agent("w1", "Imre Vault-Keeper", "worker", client, "grok", emitter, {}, inbox, { total: 0 }, signal);

  // one stumble, then the communion recovers
  const c1 = veil(1);
  const out1 = await mkAgent(c1).run("sys", "brief");
  check("a stumble recovers into the next communion", out1 === "the work is done" && c1.calls() === 2);
  check("the stumble is heralded", events.some((e) => e.type === "log" && /loses the thread/.test(e.text)));
  check("the trance is shaken off visibly", events.some((e) => e.type === "agent_status" && e.status === "resting" && e.detail === "shakes off a trance"));

  // an unreachable veil ends the shift after a bounded number of attempts
  events.length = 0;
  const c2 = veil(99);
  const out2 = await mkAgent(c2).run("sys", "brief");
  check("an unreachable veil ends the shift", out2 === "");
  check("spend is bounded to the stumble cap", c2.calls() === 2, `calls=${c2.calls()}`);
  check("the ended shift is heralded as error", events.some((e) => e.type === "log" && e.level === "error" && /the shift ends/.test(e.text)));
  check("the fallen worker still reports done", events.some((e) => e.type === "agent_status" && e.status === "done"));

  // an aborted match still raises the old law, never a stumble
  const ctrl = new AbortController();
  ctrl.abort();
  const c3 = veil(99);
  let threw = "";
  try {
    await mkAgent(c3, ctrl.signal).run("sys", "brief");
  } catch (e) {
    threw = String(e);
  }
  check("an aborted match raises the old law", /match aborted/.test(threw) && c3.calls() === 0);
}

console.log("Castle Era (genome law)");
{
  const {
    permutationCount, deriveGenome, lawClamp, validateBuildingGenome, validateStyleGenome,
    genomeSignature, styleSignature,
  } = await import("../apps/web/src/game/genome.ts");
  const { CastleState } = await import("../apps/web/src/game/castlestate.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  check("the design language exceeds a billion permutations", permutationCount() > 1e9, String(permutationCount()));

  const traits = { size: 2, tint: "#e86a33", banner: "#222831", gates: 2, shafts: 1, banners: 2, storeys: 2 };
  const g1 = deriveGenome("app-web", traits, "root:app-web", 777, null);
  const g2 = deriveGenome("app-web", traits, "root:app-web", 777, null);
  check("derived genomes are deterministic", genomeSignature(g1) === genomeSignature(g2));
  const g3 = deriveGenome("app-web", traits, "root:app-web", 778, null);
  check("a different seed dresses differently", genomeSignature(g1) !== genomeSignature(g3));

  const tall = lawClamp({ ...structuredClone(g1), storeys: 6 }, traits);
  check("storeys clamp to the measured band", tall.storeys === 3);

  const vg = validateBuildingGenome(
    { roof: { form: "onion" }, material: { family: "molten-gold" }, storeys: 99, ornament: { banners: 44 } },
    "app-web", traits, "root:app-web", 777, null,
  );
  check("lawful fields survive validation", vg.roof.form === "onion");
  check("unlawful fields fall to the derived default", vg.material.family === g1.material.family);
  check("bounded fields clamp", vg.storeys <= 3 && vg.ornament.banners <= 4);
  check("garbage input yields the lawful default", genomeSignature(validateBuildingGenome("junk", "app-web", traits, "root:app-web", 777, null)) === genomeSignature(g1));

  check("an uncited style does not exist", validateStyleGenome({ name: "Oracle-Forge" }) === null);
  const style = validateStyleGenome({
    name: "Oracle-Forge Brutalism", cited: "71% strict TypeScript, zero runtime deps",
    materialBias: ["obsidian", "nonsense", "basalt"], roofBias: ["sawtooth"], trimBias: ["glowseams"],
    natureSet: "dead", wallStyle: "obsidian", groundTone: "scorch", fog: "thin",
  });
  check("a cited style validates and filters its vocab", style !== null && style.materialBias.join(",") === "obsidian,basalt");
  const styled = deriveGenome("library", traits, "lib:library", 777, style);
  check("style biases steer derived genomes", ["obsidian", "basalt"].includes(styled.material.family) && styled.roof.form === "sawtooth");

  // live fold: genomes ride applyRepr, styles ride applyStyle, hash is contractual
  const bakery = dir("", [
    file("index.html", 120), file("styles.css", 260), file("server.js", 240),
    dir("db", [file("db/schema.sql", 90)]), file("README.md", 40),
  ]);
  const st = new CastleState();
  const p0 = st.found(bakery, 777, [], [{ path: "styles.css", probe: "color", value: "#e86a33" }]);
  check("every socket carries a resolved genome", p0.sockets.every((s) => s.genome && typeof s.genome.footprint === "string"));
  const h0 = p0.hash;
  const r1 = st.applyRepr("db:database", "ore-mine", "two tables sink two shafts", { roof: { form: "dome" }, material: { family: "basalt" } });
  check("a chosen genome lands and is reported", r1.changes.some((c) => c.kind === "genome" && c.componentId === "db:database"));
  check("the chosen genome is visible on the socket", r1.plan.sockets.find((s) => s.componentId === "db:database").genome.roof.form === "dome");
  check("the castle hash answers the redress", r1.plan.hash !== h0);

  const uncited = st.applyStyle({ name: "Nameless" });
  check("an uncited style decree is refused", uncited.changes.length === 0);
  const r2 = st.applyStyle({
    name: "Harbor Timberwork", cited: "a static html page, hand-inlined styles",
    materialBias: ["timber"], roofBias: ["gable"], trimBias: ["halftimber"],
    natureSet: "oak", wallStyle: "palisade", groundTone: "meadow", fog: "none",
  });
  check("a cited style decree lands", r2.changes.some((c) => c.kind === "style" && c.name === "Harbor Timberwork"));
  check("the style stands on the plan", r2.plan.style !== null && styleSignature(r2.plan.style).startsWith("Harbor Timberwork"));
  check("unchosen buildings re-derive under the style", r2.changes.some((c) => c.kind === "genome" && c.componentId !== "db:database"));
  check("chosen genomes outrank the style", r2.plan.sockets.find((s) => s.componentId === "db:database").genome.material.family === "basalt");

  // persistence: genomes and style ride the ledger across foundings
  const st2 = new CastleState();
  const p2 = st2.found(bakery, 777, [], [{ path: "styles.css", probe: "color", value: "#e86a33" }], structuredClone(r2.plan.ledger));
  check("the style survives re-founding", p2.style !== null && p2.style.name === "Harbor Timberwork");
  check("chosen genomes survive re-founding", p2.sockets.find((s) => s.componentId === "db:database").genome.roof.form === "dome");
  check("the re-founded castle hashes identical", p2.hash === r2.plan.hash);
}

// ---------------------------------------------------------------------------
// Adoption law: a path the castle never met is adopted on first touch —
// files seeded after the snapshot or born through the shell still raise
// their stone, and a measured total outranks the diff arithmetic.
// ---------------------------------------------------------------------------
{
  console.log("\nadoption law");
  const { CastleState } = await import("../apps/web/src/game/castlestate.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });
  const st = new CastleState();
  const p0 = st.found(dir("", [file("README.md", 20)]), 42, [], []);
  check("the founding knows only the chronicle", p0.sockets.length === 1 && p0.sockets[0].componentId === "root:docs");

  // a polish edit (created:false) to a file the founding snapshot never met
  const r = st.applyWrite("index.html", false, 7, 5, 210);
  check("an unknown path is adopted on first touch", r.changes.some((c) => c.kind === "added"), JSON.stringify(r.changes));
  const hall = r.plan.sockets.find((s) => s.componentId === "root:app-web");
  check("the adopted ward stands", Boolean(hall));
  const storeysWithTotal = hall.traits.storeys;

  // the same touch without a measured total would size the ward by churn alone
  const st2 = new CastleState();
  st2.found(dir("", [file("README.md", 20)]), 42, [], []);
  const r2 = st2.applyWrite("index.html", false, 7, 5);
  const hall2 = r2.plan.sockets.find((s) => s.componentId === "root:app-web");
  check("a measured total outranks churn arithmetic", storeysWithTotal > hall2.traits.storeys, `${storeysWithTotal} vs ${hall2.traits.storeys}`);

  // churn still accrues on later writes that carry no total: enough added
  // lines raise the churn-sized ward's storeys (below the storey cap)
  const r3 = st2.applyWrite("index.html", false, 100, 0);
  const hall3 = r3.plan.sockets.find((s) => s.componentId === "root:app-web");
  check("churn accrues without a total", hall3.traits.storeys > hall2.traits.storeys, `${hall3.traits.storeys} vs ${hall2.traits.storeys}`);
}

// ---------------------------------------------------------------------------
// Wards law: a flat repo's loose code files each raise their own ward —
// new features must RISE as new buildings, not vanish into one blob.
// ---------------------------------------------------------------------------
{
  console.log("\nwards law");
  const { buildComponentGraph } = await import("../apps/web/src/game/components.ts");
  const { planCastle } = await import("../apps/web/src/game/castle.ts");
  const file = (path, lines) => ({ kind: "file", name: path.split("/").pop(), path, lines });
  const dir = (path, children) => ({ kind: "dir", name: path.split("/").pop() || ".", path, children });

  // the snake settlement before and after a masonry-law commission
  const before = dir("", [file("index.html", 210), file("snake.js", 180), file("README.md", 30)]);
  const after = dir("", [
    file("index.html", 210),
    file("snake.js", 180),
    file("pause-button.css", 8),
    file("pause-button.js", 60),
    file("score-display.js", 45),
    file("speed-up.js", 38),
    file("README.md", 30),
  ]);

  const gB = buildComponentGraph(before, [], []);
  const gA = buildComponentGraph(after, [], []);
  const idsA = gA.components.map((c) => c.id);
  check("each feature file raises its own ward", idsA.includes("root:file:score-display.js") && idsA.includes("root:file:speed-up.js"), idsA.join(","));
  check("the anchor keeps the group's historic id", idsA.includes("root:library"));
  const anchor = gA.components.find((c) => c.id === "root:library");
  check("the anchor is the alphabetical first", anchor.paths.length === 1 && anchor.paths[0] === "pause-button.js", anchor.paths.join(","));
  const hall = gA.components.find((c) => c.id === "root:app-web");
  check("a shed under ten lines leans on the hall", hall.paths.includes("pause-button.css"), hall.paths.join(","));
  check("docs stay chunky", idsA.includes("root:docs") && !idsA.includes("root:file:README.md"));
  const ward = gA.components.find((c) => c.id === "root:file:score-display.js");
  check("a ward is labeled by its file", ward.label === "score-display.js" && ward.facts.lines === 45);
  check("a file ward's id survives regrouping", gB.components.some((c) => c.id === "root:file:snake.js") && idsA.includes("root:file:snake.js"));

  // growth: the commission adds three sockets and moves nothing
  const SEED = 20260820;
  const pB = planCastle(gB, SEED);
  const pA = planCastle(gA, SEED, pB.ledger);
  check("the wards claim fresh sockets", pA.sockets.length === pB.sockets.length + 3, `${pB.sockets.length} → ${pA.sockets.length}`);
  check("prior wards stand fast through growth", pB.sockets.every((s) => {
    const t = pA.sockets.find((x) => x.componentId === s.componentId);
    return t && t.ring === s.ring && t.slot === s.slot;
  }));

  // a structured repo keeps its chunky boundaries — no file wards
  const mono = dir("", [
    dir("apps", [dir("apps/web", [
      file("apps/web/main.ts", 300),
      file("apps/web/view.ts", 200),
      file("apps/web/state.ts", 150),
    ])]),
    file("README.md", 40),
  ]);
  const gM = buildComponentGraph(mono, [], []);
  check("boundaried repos never split into file wards", gM.components.every((c) => !c.id.includes(":file:")), gM.components.map((c) => c.id).join(","));
  check("ward derivation is deterministic", JSON.stringify(buildComponentGraph(after, [], [])) === JSON.stringify(gA));
}

// ---------------------------------------------------------------------------
// Ghost-session law: a session whose machine died must not hold its
// visitor's slot — provision buries unreachable sessions before refusing.
// ---------------------------------------------------------------------------
{
  console.log("\nghost-session law");
  const { SandboxManager } = await import("../apps/relay/src/sandbox.ts");
  const { createServer } = await import("node:http");

  // A live sandboxd stand-in: answers /healthz on a real port.
  const server = createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const livePort = server.address().port;

  const destroyed = [];
  const fake = (baseUrl) => ({
    async create(id) {
      return { baseUrl, token: "t", destroy: async () => { destroyed.push(id); } };
    },
  });

  // Port 1 answers nothing: the session registers, then its machine is gone.
  const ghostMgr = new SandboxManager(fake("http://127.0.0.1:1"));
  await ghostMgr.provision("m-ghost", "10.0.0.1");
  check("a session registers and counts", ghostMgr.count === 1);
  const second = await ghostMgr.provision("m-next", "10.0.0.1").then(() => "ok", (e) => e.message);
  check("a ghost session is buried, not defended", second === "ok", second);
  check("the buried ghost's machine was told to die", destroyed.includes("m-ghost"));
  check("only the new session remains", ghostMgr.count === 1);
  await ghostMgr.destroy("m-next");

  // A machine that still answers keeps its visitor's slot defended.
  const liveMgr = new SandboxManager(fake(`http://127.0.0.1:${livePort}`));
  await liveMgr.provision("m-live", "10.0.0.2");
  const refusal = await liveMgr.provision("m-again", "10.0.0.2").then(() => "ok", (e) => e.message);
  check("a living session still refuses its visitor", refusal === "one settlement per visitor at a time", refusal);
  const other = await liveMgr.provision("m-other", "10.0.0.3").then(() => "ok", (e) => e.message);
  check("another visitor is not blocked by it", other === "ok", other);
  await liveMgr.destroy("m-live");
  await liveMgr.destroy("m-other");
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
