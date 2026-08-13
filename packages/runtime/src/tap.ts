/**
 * Parse `node --test --test-reporter=tap` output. Node emits each test file
 * as a top-level subtest whose name is the file path; failing cases appear as
 * indented `not ok` lines beneath it.
 */
export type TapResult = {
  passed: number;
  failed: number;
  failures: { name: string; path?: string }[];
};

export function parseTap(output: string): TapResult {
  let passed = 0;
  let failed = 0;
  const failures: { name: string; path?: string }[] = [];
  let currentFile: string | undefined;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const planMatch = line.match(/^# (pass|fail) (\d+)$/);
    if (planMatch) {
      if (planMatch[1] === "pass") passed = Number(planMatch[2]);
      else failed = Number(planMatch[2]);
      continue;
    }
    const topLevel = line.match(/^(not ok|ok) \d+ - (.+?)( # .*)?$/);
    if (topLevel) {
      const name = topLevel[2]!;
      if (/\.[cm]?[jt]s$/.test(name)) currentFile = name;
      continue;
    }
    const nested = line.match(/^\s+not ok \d+ - (.+?)( # .*)?$/);
    if (nested) {
      failures.push({ name: nested[1]!, path: currentFile });
    }
  }

  // Deduplicate nested suite wrappers (a failing describe repeats its children).
  const seen = new Set<string>();
  const deduped = failures.filter((f) => {
    const key = `${f.path}::${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { passed, failed, failures: deduped };
}
