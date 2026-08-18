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
const MAX_TREE_FILES = 1200;
const LINES_READ_CAP = 262_144; // sample the head of big files; buckets saturate anyway
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "pdf", "zip", "gz", "tgz", "tar", "7z",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "webm", "ogg", "wav",
  "wasm", "jar", "class", "so", "dylib", "dll", "exe", "bin", "dat", "db", "sqlite", "pyc",
]);
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

async function readBody(req, limit = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

// --- git clone / samples -----------------------------------------------------

const SEED_BUNDLE = path.join(WORK_DIR, "seed.bundle");

async function handleClone(body) {
  await fs.rm(REPO_DIR, { recursive: true, force: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  const url = String(body.url ?? "");

  const hasSeed = await fs.access(SEED_BUNDLE).then(() => true, () => false);
  if (hasSeed) {
    // A persistent castle returns: its archived workspace outranks the url.
    await execFileP("git", ["clone", SEED_BUNDLE, REPO_DIR], {
      timeout: CLONE_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    await fs.rm(SEED_BUNDLE, { force: true });
  } else if (url.startsWith("new:") || url.startsWith("castle:")) {
    // A commissioned realm: bare earth plus a founding stone. The Crown's
    // charge arrives as the first decree; agents raise the work from nothing.
    const prefix = url.startsWith("new:") ? "new:" : "castle:";
    const slug = url.slice(prefix.length).replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "commission";
    await fs.mkdir(REPO_DIR, { recursive: true });
    await fs.writeFile(
      path.join(REPO_DIR, "README.md"),
      `# New Realm — ${slug}\n\nFounded bare by decree of the Crown. The work will rise here, file by file.\n`,
    );
  } else if (url.startsWith("sample:")) {
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
      const fileNode = { name: entry.name, path: childRel, kind: "file" };
      const lines = await countLines(path.join(dir, entry.name), budget);
      if (lines !== null) fileNode.lines = lines;
      node.children.push(fileNode);
    }
  }
  if (hiddenFiles > 0) {
    node.children.push({ name: `+${hiddenFiles} more`, path: `${rel}/__more__`, kind: "file" });
  }
  return node;
}

// Measured line counts so the map's treemap areas stay proportional to real
// code. Head-sample huge files and scale by size (proportion-preserving);
// binaries and budget overruns return null → renderer falls back to weight 1.
async function countLines(file, budget) {
  try {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (BINARY_EXT.has(ext)) return null;
    if (budget.lineBytes !== undefined && budget.lineBytes <= 0) return null;
    const st = await fs.stat(file);
    if (st.size === 0) return 0;
    const toRead = Math.min(st.size, LINES_READ_CAP);
    const buf = Buffer.alloc(toRead);
    const fh = await fs.open(file, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await fh.read(buf, 0, toRead, 0));
    } finally {
      await fh.close();
    }
    if (budget.lineBytes !== undefined) budget.lineBytes -= bytesRead;
    if (bytesRead === 0) return 0;
    const view = buf.subarray(0, bytesRead);
    if (view.subarray(0, Math.min(8192, bytesRead)).includes(0)) return null;
    let n = 1;
    for (let i = 0; i < view.length; i++) if (view[i] === 10) n++;
    if (st.size > bytesRead) n = Math.round((n * st.size) / bytesRead);
    return n;
  } catch {
    return null;
  }
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

// --- castle archive / seed --------------------------------------------------
// A saved castle's workspace leaves the machine as a git bundle and returns
// as a seed the next founding's clone prefers over any url.

const MAX_BUNDLE_BYTES = 30_000_000;

async function handleArchive() {
  await execFileP("git", ["add", "-A"], { cwd: REPO_DIR });
  // nothing new to commit is fine; the bundle still carries every ref
  await execFileP("git", ["commit", "-qm", "the castle rests"], { cwd: REPO_DIR }).catch(() => {});
  const bundlePath = path.join(WORK_DIR, "castle.bundle");
  await fs.rm(bundlePath, { force: true });
  await execFileP("git", ["bundle", "create", bundlePath, "--all"], {
    cwd: REPO_DIR,
    timeout: CLONE_TIMEOUT,
  });
  const buf = await fs.readFile(bundlePath);
  await fs.rm(bundlePath, { force: true });
  if (buf.length > MAX_BUNDLE_BYTES) throw new Error("the castle is too heavy to carry");
  return { ok: true, bytes: buf.length, bundleB64: buf.toString("base64") };
}

async function handleSeed(body) {
  const b64 = String(body.bundleB64 ?? "");
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) throw new Error("empty bundle");
  if (buf.length > MAX_BUNDLE_BYTES) throw new Error("bundle too large");
  await fs.mkdir(WORK_DIR, { recursive: true });
  await fs.writeFile(SEED_BUNDLE, buf);
  return { ok: true, bytes: buf.length };
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
    const body = req.method === "POST" ? await readBody(req, req.url === "/seed" ? 45_000_000 : undefined) : {};

    switch (req.url) {
      case "/clone":
        return send(200, await handleClone(body));
      case "/archive":
        return send(200, await handleArchive());
      case "/seed":
        return send(200, await handleSeed(body));
      case "/tree":
        return send(200, { tree: await buildTree(REPO_DIR, "", 0, { files: MAX_TREE_FILES, lineBytes: 64_000_000 }) });
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
