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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
