import type { ProbeHit } from "@agent-empires/protocol";

/**
 * Fact survey (Castle Era): one bounded grep pulls every line that might
 * carry a measurable fact — a hex color, a route registration, a table
 * declaration. A strict parser turns the coarse net into ProbeHits; the
 * client folds them into component facts, and the castle wears them
 * (palette → manor tint, routes → gate arches, tables → mine shafts).
 * Best-effort by design — a failed survey is honestly plain walls.
 */

const EXCLUDES =
  "--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build " +
  "--exclude-dir=vendor --exclude-dir=target --exclude-dir=__pycache__ --exclude-dir=coverage ";

const INCLUDES =
  "--include='*.css' --include='*.scss' --include='*.less' --include='*.styl' " +
  "--include='*.html' --include='*.vue' --include='*.svelte' " +
  "--include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.cjs' " +
  "--include='*.py' --include='*.rb' --include='*.sql' --include='*.prisma' ";

// Coarse ERE net (portable BSD/GNU); the parser below is the law.
const PATTERNS =
  "-e '#[0-9a-fA-F]{6}' " +
  "-e '\\.(get|post|put|delete|patch|route) *\\(' " +
  "-e 'CREATE[[:space:]]+TABLE|create_table|createTable|__tablename__' " +
  "-e '^[[:space:]]*model [A-Za-z_]' ";

/** Whole-workspace survey at founding. -H forces path:line:text everywhere. */
export const FACT_SCAN_COMMAND =
  `grep -rInHE ${EXCLUDES}${INCLUDES}${PATTERNS}. 2>/dev/null | head -n 6000`;

/** Re-survey a single file after a write. */
export function factScanFileCommand(path: string): string {
  const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
  return `grep -InHE ${PATTERNS}${quoted} 2>/dev/null | head -n 200`;
}

const STYLE_EXT = /\.(css|scss|less|styl|html|vue|svelte)$/i;
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb)$/i;
const COLORISH = /color|background|theme|palette|fill|stroke|accent|brand/i;
const HEX = /#([0-9a-fA-F]{6})\b/g;
const JS_ROUTE = /\.(get|post|put|delete|patch)\s*\(\s*["'`](\/[^"'`]{0,70})["'`]/i;
const PY_ROUTE = /@\w+\.(get|post|put|delete|patch|route)\s*\(\s*["']([^"']{1,70})["']/i;
const TABLE_RES: RegExp[] = [
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w{1,60})/i,
  /create_table\s*[:(]\s*["':]?(\w{1,60})/,
  /createTable\s*\(\s*["'](\w{1,60})/,
  /__tablename__\s*=\s*["'](\w{1,60})/,
];
const PRISMA_MODEL = /^\s*model\s+(\w{1,60})\s*\{/;

/** Parse grep "path:line:text" output into deduped, capped ProbeHits. */
export function parseFactHits(lines: string[], cap = 1200, perPathCap = 64): ProbeHit[] {
  const hits: ProbeHit[] = [];
  const seen = new Set<string>();
  const perPath = new Map<string, number>();
  const add = (path: string, probe: ProbeHit["probe"], value: string) => {
    if (hits.length >= cap) return;
    const n = perPath.get(path) ?? 0;
    if (n >= perPathCap) return;
    const key = `${path}\u0000${probe}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    perPath.set(path, n + 1);
    hits.push({ path, probe, value: value.slice(0, 120) });
  };

  for (const line of lines) {
    if (hits.length >= cap) break;
    const a = line.indexOf(":");
    if (a <= 0) continue;
    const b = line.indexOf(":", a + 1);
    if (b < 0) continue;
    let path = line.slice(0, a);
    if (path.startsWith("./")) path = path.slice(2);
    const text = line.slice(b + 1);
    if (!path || !text) continue;

    // colors: style files always; code files only on color-flavored lines
    if (STYLE_EXT.test(path) || COLORISH.test(text)) {
      for (const m of text.matchAll(HEX)) add(path, "color", `#${m[1]!.toLowerCase()}`);
    }

    if (CODE_EXT.test(path)) {
      const jr = JS_ROUTE.exec(text);
      if (jr) add(path, "route", `${jr[1]!.toUpperCase()} ${jr[2]}`);
      const pr = PY_ROUTE.exec(text);
      if (pr && pr[2]!.startsWith("/")) {
        const method = pr[1]!.toLowerCase() === "route" ? "ROUTE" : pr[1]!.toUpperCase();
        add(path, "route", `${method} ${pr[2]}`);
      }
    }

    if (path.toLowerCase().endsWith(".prisma")) {
      const pm = PRISMA_MODEL.exec(text);
      if (pm) add(path, "table", pm[1]!.toLowerCase());
    }
    for (const re of TABLE_RES) {
      const tm = re.exec(text);
      if (tm) {
        add(path, "table", tm[1]!.toLowerCase());
        break;
      }
    }
  }
  return hits;
}

export function groupHitsByPath(hits: ProbeHit[]): Map<string, ProbeHit[]> {
  const by = new Map<string, ProbeHit[]>();
  for (const h of hits) {
    const list = by.get(h.path);
    if (list) list.push(h);
    else by.set(h.path, [h]);
  }
  return by;
}

/** Order-insensitive equality of two hit sets for one path. */
export function hitsEqual(a: ProbeHit[], b: ProbeHit[]): boolean {
  if (a.length !== b.length) return false;
  const key = (h: ProbeHit) => `${h.probe}\u0000${h.value}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((v, i) => v === sb[i]);
}
