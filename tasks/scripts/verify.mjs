import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const tasksRoot = path.resolve(scriptsDir, "..");
const REPO_IDS = ["repel-the-invasion", "raise-the-barracks", "rebuild-the-city"];

function runTests(cwd) {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "tests/*.test.js"],
    { cwd, encoding: "utf8" }
  );
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const pass = Number((output.match(/^# pass (\d+)/m) ?? [])[1] ?? NaN);
  const fail = Number((output.match(/^# fail (\d+)/m) ?? [])[1] ?? NaN);
  return { code: result.status, pass, fail, output };
}

const rows = [];
let allOk = true;

for (const id of REPO_IDS) {
  const repoDir = path.join(tasksRoot, "repos", id);
  const solutionDir = path.join(scriptsDir, "solutions", id);

  const initial = runTests(repoDir);
  const initialOk =
    initial.code !== 0 && Number.isFinite(initial.fail) && initial.fail > 0;
  if (!initialOk) {
    console.error(`[${id}] expected the initial state to fail, got exit ${initial.code}, fail count ${initial.fail}`);
    console.error(initial.output);
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "agent-empires-" + id + "-"));
  let solved;
  try {
    cpSync(repoDir, tempDir, { recursive: true });
    cpSync(solutionDir, tempDir, { recursive: true });
    solved = runTests(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  const solvedOk = solved.code === 0 && solved.fail === 0 && solved.pass > 0;
  if (!solvedOk) {
    console.error(`[${id}] expected the reference solution to pass, got exit ${solved.code}, fail count ${solved.fail}`);
    console.error(solved.output);
  }

  allOk = allOk && initialOk && solvedOk;
  rows.push({
    repo: id,
    "initial pass": initial.pass,
    "initial fail": initial.fail,
    "initial broken": initialOk ? "yes" : "NO",
    "solved pass": solved.pass,
    "solved fail": solved.fail,
    solvable: solvedOk ? "yes" : "NO",
  });
}

console.table(rows);

if (!allOk) {
  console.error("verify.mjs: FAILED");
  process.exit(1);
}
console.log("verify.mjs: all repos are broken initially and solvable with the reference solution");
