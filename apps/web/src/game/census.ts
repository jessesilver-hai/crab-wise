import type { FileNode } from "@agent-empires/protocol";

/**
 * Code census: deterministic, measurable facts about a repository tree.
 * This is the ground truth the world's appearance is derived from — every
 * visual divergence between realms must trace back to a row in this census
 * (or to a Worldsmith choice that cites it). Engine-pure: no Date, no
 * unseeded randomness, no I/O.
 */

/** Broad language families with distinct architectural temperament. */
export type LangFamily =
  | "script" // js/ts — mercantile sprawl
  | "python" // py — scholar terraces
  | "systems" // c/c++/rust/zig — stone and forges
  | "jvm" // java/kotlin/scala — marble bureaucracy
  | "go" // go — harbor pragmatism
  | "web" // html/css — artisan facades
  | "prose" // md/rst/txt — scriptoria
  | "data" // json/yaml/csv — granaries
  | "shell" // sh/bash — wayfarer camps
  | "ruby" // rb — garden guilds
  | "other";

const EXT_FAMILY: Record<string, LangFamily> = {
  js: "script", jsx: "script", ts: "script", tsx: "script", mjs: "script", cjs: "script", vue: "script", svelte: "script",
  py: "python", ipynb: "python",
  c: "systems", h: "systems", cc: "systems", cpp: "systems", hpp: "systems", cxx: "systems", rs: "systems", zig: "systems", m: "systems", asm: "systems", s: "systems",
  java: "jvm", kt: "jvm", kts: "jvm", scala: "jvm", groovy: "jvm",
  go: "go",
  html: "web", htm: "web", css: "web", scss: "web", less: "web", sass: "web",
  md: "prose", rst: "prose", txt: "prose", adoc: "prose", tex: "prose",
  json: "data", yaml: "data", yml: "data", toml: "data", csv: "data", tsv: "data", xml: "data", ini: "data", cfg: "data", lock: "data",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "shell", bat: "shell", cmd: "shell",
  rb: "ruby", erb: "ruby", rake: "ruby",
};

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb|c|cc)$|(^|\/)test_[^/]*\.py$/i;
const DOC_PATH = /(^|\/)(docs?|documentation|wiki|guides?)(\/|$)|\.(md|rst|txt|adoc)$/i;
const CONFIG_PATH = /\.(json|ya?ml|toml|ini|cfg|lock)$|(^|\/)(config|configs|\.github|\.circleci)(\/|$)/i;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|mp[34]|wav|ogg|woff2?|ttf|otf|eot|glb|gltf|obj|fbx|pdf|zip)$/i;
/** Top-level dirs that mark a many-packages workshop when they hold ≥2 dirs. */
const MONOREPO_DIRS = /^(packages|apps|crates|services|libs|modules|projects|workspaces|plugins)$/i;

export type Census = {
  /** Language families ranked by share of total lines (0..1), desc. */
  languages: { family: LangFamily; share: number }[];
  /** Dominant family (share of the top entry, or "other" for empty repos). */
  dominant: LangFamily;
  totalLines: number;
  fileCount: number;
  dirCount: number;
  maxDepth: number;
  /** Share of lines living under test paths. */
  testRatio: number;
  docsRatio: number;
  configRatio: number;
  /** Share of FILES that are binary-ish assets (lines lie for binaries). */
  assetRatio: number;
  /** Share of lines in files ≥ 1000 lines — megalith construction. */
  giantShare: number;
  /** True when a top-level container dir holds ≥2 package dirs. */
  monorepo: boolean;
  /** Dir children across monorepo containers — the islet count. */
  packageDirs: number;
  topLevelDirs: number;
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function analyzeCensus(tree: FileNode): Census {
  const langLines = new Map<LangFamily, number>();
  let totalLines = 0;
  let fileCount = 0;
  let dirCount = 0;
  let maxDepth = 0;
  let testLines = 0;
  let docLines = 0;
  let configLines = 0;
  let assetFiles = 0;
  let giantLines = 0;
  let monorepo = false;
  let packageDirs = 0;
  let topLevelDirs = 0;

  const walk = (node: FileNode, depth: number) => {
    if (node.kind === "dir") {
      if (node.path !== "" && node.path !== ".") {
        dirCount++;
        maxDepth = Math.max(maxDepth, depth);
      }
      const children = node.children ?? [];
      if (depth === 1 && MONOREPO_DIRS.test(node.name)) {
        const kids = children.filter((c) => c.kind === "dir").length;
        if (kids >= 2) {
          monorepo = true;
          packageDirs += kids;
        }
      }
      if (depth === 1) topLevelDirs++;
      for (const c of children) walk(c, depth + 1);
      return;
    }
    fileCount++;
    const lines = typeof (node as FileNode & { lines?: number }).lines === "number"
      ? Math.max(1, (node as FileNode & { lines?: number }).lines!)
      : 1;
    totalLines += lines;
    const fam = EXT_FAMILY[extOf(node.name)] ?? "other";
    langLines.set(fam, (langLines.get(fam) ?? 0) + lines);
    if (TEST_PATH.test(node.path)) testLines += lines;
    if (DOC_PATH.test(node.path)) docLines += lines;
    if (CONFIG_PATH.test(node.path)) configLines += lines;
    if (ASSET_EXT.test(node.name)) assetFiles++;
    if (lines >= 1000) giantLines += lines;
  };
  walk(tree, 0);

  const denom = Math.max(1, totalLines);
  const languages = [...langLines.entries()]
    .map(([family, n]) => ({ family, share: n / denom }))
    .sort((a, b) => b.share - a.share || (a.family < b.family ? -1 : 1));

  return {
    languages,
    dominant: languages[0]?.family ?? "other",
    totalLines,
    fileCount,
    dirCount,
    maxDepth,
    testRatio: testLines / denom,
    docsRatio: docLines / denom,
    configRatio: configLines / denom,
    assetRatio: fileCount > 0 ? assetFiles / fileCount : 0,
    giantShare: giantLines / denom,
    monorepo,
    packageDirs,
    topLevelDirs,
  };
}

/** Find the directory node at dirPath ("" → the root). */
export function findDir(tree: FileNode, dirPath: string): FileNode | null {
  if (dirPath === "" || dirPath === ".") return tree;
  let node: FileNode | null = tree;
  for (const part of dirPath.split("/")) {
    if (!node || node.kind !== "dir") return null;
    node = (node.children ?? []).find((c) => c.kind === "dir" && c.name === part) ?? null;
  }
  return node && node.kind === "dir" ? node : null;
}

/** Census of one district's subtree — the facts a survey reveals. */
export function districtCensus(tree: FileNode, dirPath: string): Census | null {
  const dir = findDir(tree, dirPath);
  return dir ? analyzeCensus(dir) : null;
}

/**
 * The chronicle line a survey speaks: measured facts only, deterministic.
 * One headline plus the district's single strongest trait (fixed priority).
 */
export function surveyLine(label: string, c: Census): string {
  if (c.fileCount === 0) return `⚑ ${label} surveyed: bare ground — nothing dwells here yet.`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const top = c.languages[0];
  const head =
    `⚑ ${label} surveyed: ${c.fileCount} works, ${c.totalLines.toLocaleString()} lines` +
    (top && top.family !== "other" ? ` — ${top.family} holds ${pct(top.share)}` : "") +
    ".";
  let trait = "";
  if (c.giantShare >= 0.4) trait = ` Megaliths brood here: ${pct(c.giantShare)} of its lines dwell in giant files.`;
  else if (c.testRatio >= 0.3) trait = ` A proving ground — ${pct(c.testRatio)} of its lines stand as trials.`;
  else if (c.docsRatio >= 0.5) trait = ` A scriptorium — ${pct(c.docsRatio)} of its lines are chronicle.`;
  else if (c.assetRatio >= 0.5) trait = ` A reliquary — ${pct(c.assetRatio)} of its works are bound relics.`;
  else if (c.configRatio >= 0.5) trait = ` A granary of decrees — ${pct(c.configRatio)} of its lines are provision.`;
  else if (c.maxDepth >= 3) trait = ` Passages run ${c.maxDepth} halls deep.`;
  return head + trait;
}

/** Compact census table for the Worldsmith's prompt — facts it must express. */
export function censusBrief(c: Census): string {
  const langs = c.languages.slice(0, 4).map((l) => `${l.family} ${(l.share * 100).toFixed(0)}%`).join(", ");
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  return [
    `languages: ${langs || "none measured"}`,
    `size: ${c.fileCount} files, ${c.totalLines.toLocaleString()} lines, nesting depth ${c.maxDepth}`,
    `tests ${pct(c.testRatio)} of lines · docs ${pct(c.docsRatio)} · config ${pct(c.configRatio)} · binary assets ${pct(c.assetRatio)} of files`,
    `giant files (≥1k lines) hold ${pct(c.giantShare)} of all lines`,
    c.monorepo ? `structure: MONOREPO of ${c.packageDirs} packages — the realm is an archipelago` : `structure: single settlement (${c.topLevelDirs} top-level dirs)`,
  ].join("\n");
}
