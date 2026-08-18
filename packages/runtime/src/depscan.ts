import type { FileNode } from "@agent-empires/protocol";

/**
 * Founding-time dependency survey: one grep across the fresh clone pulls
 * every import-looking line; a pure resolver maps them onto real repo files.
 * The result ships in match_started as depEdges and becomes the street law.
 * Best-effort by design — an unresolved import is honestly no street.
 */

export type DepEdge = { from: string; to: string };

/** Single shell pass, bounded output, portable GNU grep flags only. */
export const DEP_SCAN_COMMAND =
  "grep -rInE " +
  "--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build " +
  "--exclude-dir=vendor --exclude-dir=target --exclude-dir=__pycache__ " +
  "--include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.cjs' " +
  "--include='*.py' --include='*.rs' --include='*.java' " +
  "-e '^[[:space:]]*(import|from|use|mod|pub)[[:space:]]' -e 'require\\(' -e 'import\\(' " +
  ". 2>/dev/null | head -n 8000";

export type RawHit = { path: string; text: string };

/** Parse "path:lineno:text" grep lines (text may itself contain colons). */
export function parseDepHits(lines: string[]): RawHit[] {
  const hits: RawHit[] = [];
  for (const line of lines) {
    const a = line.indexOf(":");
    if (a <= 0) continue;
    const b = line.indexOf(":", a + 1);
    if (b < 0) continue;
    let path = line.slice(0, a);
    if (path.startsWith("./")) path = path.slice(2);
    const text = line.slice(b + 1);
    if (path && text) hits.push({ path, text });
  }
  return hits;
}

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const WORKSPACE_ROOTS = ["packages", "apps", "libs", "crates", "modules", "services", "plugins"];

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Normalize "a/./b/../c" → "a/c"; returns null when it escapes the repo. */
function norm(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

export function collectFilePaths(tree: FileNode): string[] {
  const out: string[] = [];
  const walk = (n: FileNode) => {
    if (n.kind === "file") out.push(n.path);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

const JS_SPEC = /(?:from|require\(|import\()\s*['"]([^'"]+)['"]/;
const PY_SPEC = /^\s*(?:from\s+([.\w]+)\s+import\b|import\s+([\w.]+))/;
const JAVA_SPEC = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/;
const RS_MOD = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/;
const RS_USE = /^\s*(?:pub\s+)?use\s+crate::([\w:]+)/;

/** Resolve raw grep hits against the real file list. Deterministic. */
export function resolveDepEdges(hits: RawHit[], files: string[], cap = 4000): DepEdge[] {
  const fileSet = new Set(files);
  const tryFile = (p: string | null): string | null => (p && fileSet.has(p) ? p : null);
  const tryJs = (base: string | null): string | null => {
    if (!base) return null;
    if (fileSet.has(base)) return base;
    for (const e of JS_EXTS) if (fileSet.has(base + e)) return base + e;
    for (const e of JS_EXTS) if (fileSet.has(base + "/index" + e)) return base + "/index" + e;
    return null;
  };
  const tryPy = (base: string | null): string | null => {
    if (!base) return null;
    if (fileSet.has(base + ".py")) return base + ".py";
    if (fileSet.has(base + "/__init__.py")) return base + "/__init__.py";
    return null;
  };

  const edges: DepEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string | null) => {
    if (!to || to === from) return;
    const k = `${from}\u0000${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to });
  };

  for (const hit of hits) {
    if (edges.length >= cap) break;
    const { path, text } = hit;
    const dot = path.lastIndexOf(".");
    const ext = dot < 0 ? "" : path.slice(dot).toLowerCase();

    if (JS_EXTS.includes(ext)) {
      const m = JS_SPEC.exec(text);
      if (!m) continue;
      const spec = m[1]!.split("?")[0]!.split("#")[0]!.replace(/\.js$/, "");
      if (spec.startsWith(".")) {
        add(path, tryJs(norm(dirOf(path) + "/" + spec)));
      } else {
        // workspace import: @scope/name or name → packages/name entry
        const segs = spec.split("/");
        const name = segs[0]!.startsWith("@") ? segs[1] : segs[0];
        if (!name) continue;
        const rest = segs.slice(segs[0]!.startsWith("@") ? 2 : 1).join("/");
        for (const root of WORKSPACE_ROOTS) {
          const base = `${root}/${name}`;
          const hitPath =
            (rest ? tryJs(`${base}/${rest}`) ?? tryJs(`${base}/src/${rest}`) : null) ??
            tryJs(`${base}/src/index`) ??
            tryJs(`${base}/index`) ??
            tryJs(base);
          if (hitPath) {
            add(path, hitPath);
            break;
          }
        }
      }
      continue;
    }

    if (ext === ".py") {
      const m = PY_SPEC.exec(text);
      if (!m) continue;
      const mod = (m[1] ?? m[2])!;
      if (mod.startsWith(".")) {
        const ups = (/^\.+/.exec(mod)?.[0].length ?? 1) - 1;
        let base = dirOf(path);
        for (let i = 0; i < ups && base; i++) base = dirOf(base);
        const rel = mod.replace(/^\.+/, "").split(".").filter(Boolean).join("/");
        add(path, tryPy(norm(base + (rel ? "/" + rel : ""))));
      } else {
        const p = mod.split(".").join("/");
        const top = path.split("/")[0]!;
        add(path, tryPy(p) ?? tryPy("src/" + p) ?? (path.includes("/") ? tryPy(top + "/" + p) : null));
      }
      continue;
    }

    if (ext === ".java") {
      const m = JAVA_SPEC.exec(text);
      if (!m) continue;
      const suffix = m[1]!.split(".").join("/") + ".java";
      const matches = files.filter((f) => f === suffix || f.endsWith("/" + suffix));
      if (matches.length === 1) add(path, matches[0]!);
      continue;
    }

    if (ext === ".rs") {
      const mm = RS_MOD.exec(text);
      if (mm) {
        const d = dirOf(path);
        add(path, tryFile((d ? d + "/" : "") + mm[1] + ".rs") ?? tryFile((d ? d + "/" : "") + mm[1] + "/mod.rs"));
        continue;
      }
      const mu = RS_USE.exec(text);
      if (mu) {
        const segs = mu[1]!.split("::").filter(Boolean);
        for (let k = segs.length; k >= 1; k--) {
          const base = "src/" + segs.slice(0, k).join("/");
          const hitPath = tryFile(base + ".rs") ?? tryFile(base + "/mod.rs");
          if (hitPath) {
            add(path, hitPath);
            break;
          }
        }
      }
      continue;
    }
  }
  return edges;
}
