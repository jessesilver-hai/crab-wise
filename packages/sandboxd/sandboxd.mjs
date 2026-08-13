// sandboxd — the tiny executor that runs INSIDE a session sandbox.
// Zero dependencies on purpose: the container image is `node + git + this file`.
//
// Env:
//   PORT           listen port (default 9800)
//   SANDBOX_TOKEN  bearer token required on every request
//   WORK_DIR       where the repo is cloned (default /work)
//   SAMPLES_DIR    optional dir of sample repos addressable as sample:<name>

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT ?? 9800);
const TOKEN = process.env.SANDBOX_TOKEN ?? "";
const WORK_DIR = process.env.WORK_DIR ?? "/work";
const SAMPLES_DIR = process.env.SAMPLES_DIR ?? "";
const REPO_DIR = path.join(WORK_DIR, "repo");

const MAX_READ_BYTES = 200_000;
const MAX_EXEC_OUTPUT = 60_000;
const MAX_SEARCH_HITS = 80;
const MAX_TREE_FILES = 600;
const TREE_MAX_DEPTH = 4;
const DEFAULT_EXEC_TIMEOUT = 180_000;
const CLONE_TIMEOUT = 120_000;

const IGNORED = new Set(["node_modules", ".git", "dist", "build", "target", "__pycache__", ".venv", "venv", ".next", ".cache", "vendor"]);

function safePath(rel) {
  const clean = String(rel ?? "").replace(/^\.\//, "").replace(/^\/+/, "");
  const abs = path.resolve(REPO_DIR, clean === "" ? "." : clean);
  if (abs !== REPO_DIR && !abs.startsWith(REPO_DIR + path.sep)) {
    throw new Error("path escapes repo root");
  }
  return abs;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error("body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

// --- git clone / samples -----------------------------------------------------

async function handleClone(body) {
  await fs.rm(REPO_DIR, { recursive: true, force: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  const url = String(body.url ?? "");

  if (url.startsWith("sample:")) {
    if (!SAMPLES_DIR) throw new Error("samples not available on this sandbox");
    const name = url.slice("sample:".length).replace(/[^a-z0-9-]/gi, "");
    const src = path.join(SAMPLES_DIR, name);
    await fs.access(src);
    await fs.cp(src, REPO_DIR, { recursive: true });
  } else {
    if (!/^https:\/\/[\w.-]+\/[\w.~/-]+$/.test(url)) throw new Error("only https git URLs are supported");
    await execFileP("git", ["clone", "--depth", "1", "--single-branch", url, REPO_DIR], {
      timeout: CLONE_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  // Baseline commit so /diff always has something to diff against, and so
  // sample repos (no .git) behave like cloned ones.
  const hasGit = await fs.access(path.join(REPO_DIR, ".git")).then(() => true, () => false);
  if (!hasGit) await execFileP("git", ["init", "-q"], { cwd: REPO_DIR });
  await execFileP("git", ["config", "user.email", "sandbox@agent-empires.local"], { cwd: REPO_DIR });
  await execFileP("git", ["config", "user.name", "Agent Empires Sandbox"], { cwd: REPO_DIR });
  if (!hasGit) {
    await execFileP("git", ["add", "-A"], { cwd: REPO_DIR });
    await execFileP("git", ["commit", "-qm", "baseline"], { cwd: REPO_DIR });
  }

  // Surface a README snippet for theming.
  let readme = "";
  for (const candidate of ["README.md", "readme.md", "README.rst", "README.txt", "README"]) {
    try {
      readme = await fs.readFile(path.join(REPO_DIR, candidate), "utf-8");
      break;
    } catch { /* try next */ }
  }
  return { ok: true, readme: readme.slice(0, 6000) };
}

// --- repo tree (collapsed for map generation) --------------------------------

async function buildTree(dir, rel, depth, budget) {
  const name = rel === "" ? "." : path.basename(rel);
  const node = { name, path: rel === "" ? "." : rel, kind: "dir", children: [] };
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  let hiddenFiles = 0;
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (depth >= TREE_MAX_DEPTH || budget.files <= 0) {
        // Collapse deep/overflowing dirs into a single hamlet node.
        const count = await countFiles(path.join(dir, entry.name));
        if (count > 0) {
          node.children.push({ name: entry.name + "/…", path: childRel, kind: "file" });
          budget.files -= 1;
        }
      } else {
        node.children.push(await buildTree(path.join(dir, entry.name), childRel, depth + 1, budget));
      }
    } else {
      if (budget.files <= 0) {
        hiddenFiles++;
        continue;
      }
      budget.files -= 1;
      node.children.push({ name: entry.name, path: childRel, kind: "file" });
    }
  }
  if (hiddenFiles > 0) {
    node.children.push({ name: `+${hiddenFiles} more`, path: `${rel}/__more__`, kind: "file" });
  }
  return node;
}

async function countFiles(dir) {
  let n = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || IGNORED.has(e.name)) continue;
    n += e.isDirectory() ? await countFiles(path.join(dir, e.name)) : 1;
    if (n > 50) return n;
  }
  return n;
}

// --- search -------------------------------------------------------------------

async function handleSearch(query) {
  try {
    const { stdout } = await execFileP(
      "git",
      ["grep", "-n", "--no-color", "-F", "--", query],
      { cwd: REPO_DIR, timeout: 20_000, maxBuffer: 4_000_000 },
    );
    const lines = stdout.split("\n").filter(Boolean).slice(0, MAX_SEARCH_HITS);
    return { hits: lines.map((l) => l.slice(0, 250)) };
  } catch (err) {
    // git grep exits 1 on no matches
    if (err && typeof err.code === "number" && err.code === 1) return { hits: [] };
    throw err;
  }
}

// --- exec ----------------------------------------------------------------------

function handleExec(body) {
  const command = String(body.command ?? "");
  const timeoutMs = Math.min(Number(body.timeoutMs ?? DEFAULT_EXEC_TIMEOUT), 300_000);
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-lc", command], {
      cwd: REPO_DIR,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    let output = "";
    let timedOut = false;
    const append = (chunk) => {
      if (output.length < MAX_EXEC_OUTPUT) output += chunk.toString("utf-8");
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        output: output.slice(0, MAX_EXEC_OUTPUT),
        timedOut,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: String(err), timedOut: false });
    });
  });
}

// --- diff -----------------------------------------------------------------------

async function handleDiff() {
  // -N stages new files as intent-to-add so they appear in the diff.
  await execFileP("git", ["add", "-N", "-A"], { cwd: REPO_DIR });
  const { stdout } = await execFileP("git", ["diff", "--no-color"], {
    cwd: REPO_DIR,
    maxBuffer: 10_000_000,
  });
  const { stdout: stat } = await execFileP("git", ["diff", "--stat", "--no-color"], {
    cwd: REPO_DIR,
    maxBuffer: 1_000_000,
  });
  return { patch: stdout, stat: stat.trim() };
}

// --- server ----------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.url === "/healthz") return send(200, { ok: true });
    if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(401, { error: "unauthorized" });
    }
    const body = req.method === "POST" ? await readBody(req) : {};

    switch (req.url) {
      case "/clone":
        return send(200, await handleClone(body));
      case "/tree":
        return send(200, { tree: await buildTree(REPO_DIR, "", 0, { files: MAX_TREE_FILES }) });
      case "/read": {
        const abs = safePath(body.path);
        const content = await fs.readFile(abs, "utf-8");
        return send(200, {
          content: content.slice(0, MAX_READ_BYTES),
          truncated: content.length > MAX_READ_BYTES,
          lines: content.split("\n").length,
        });
      }
      case "/write": {
        const abs = safePath(body.path);
        let created = true;
        let oldLines = 0;
        try {
          const old = await fs.readFile(abs, "utf-8");
          created = false;
          oldLines = old.split("\n").length;
        } catch {
          await fs.mkdir(path.dirname(abs), { recursive: true });
        }
        const content = String(body.content ?? "");
        await fs.writeFile(abs, content);
        return send(200, { created, oldLines, newLines: content.split("\n").length });
      }
      case "/list": {
        const abs = safePath(body.path ?? ".");
        const entries = await fs.readdir(abs, { withFileTypes: true });
        return send(200, {
          entries: entries
            .filter((e) => !IGNORED.has(e.name))
            .map((e) => (e.isDirectory() ? e.name + "/" : e.name)),
        });
      }
      case "/search":
        return send(200, await handleSearch(String(body.query ?? "")));
      case "/exec":
        return send(200, await handleExec(body));
      case "/diff":
        return send(200, await handleDiff());
      default:
        return send(404, { error: "not found" });
    }
  } catch (err) {
    // Expected filesystem misses are the agent's problem, not a server fault.
    const code = err && err.code;
    const status =
      code === "ENOENT" || code === "ENOTDIR" ? 404 :
      code === "EISDIR" || code === "EACCES" || code === "ERR_FS_FILE_TOO_LARGE" ? 400 : 500;
    send(status, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, () => console.log(`sandboxd listening on :${PORT}, repo dir ${REPO_DIR}`));
