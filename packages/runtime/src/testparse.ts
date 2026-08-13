import { parseTap } from "./tap.js";

export type TestResult = {
  passed: number;
  failed: number;
  failures: { name: string; path?: string }[];
  /** Which parser recognized the output; "exitcode" is the blind fallback. */
  framework: "tap" | "pytest" | "jest" | "gotest" | "cargo" | "exitcode" | "none";
};

/**
 * Best-effort test-output parsing across ecosystems. The game only needs
 * pass/fail counts and failure names for raider placement, so approximate
 * parses are acceptable; the raw output still reaches the agent verbatim.
 */
export function parseTestOutput(output: string, exitCode: number): TestResult {
  // node:test / TAP
  if (/^TAP version/m.test(output) || /^# (pass|fail) \d+$/m.test(output)) {
    const tap = parseTap(output);
    return { ...tap, framework: "tap" };
  }

  // pytest: "== 2 failed, 10 passed in 1.2s ==" + "FAILED tests/test_x.py::test_name"
  const pytestSummary = output.match(/=+ (?:(\d+) failed(?:, )?)?(?:(\d+) passed)?[^=]*=+\s*$/m);
  if (pytestSummary && /(pytest|FAILED |PASSED |::)/.test(output)) {
    const failures = [...output.matchAll(/^FAILED ([^:\s]+)::(\S+)/gm)].map((m) => ({
      name: m[2]!.replace(/\[.*\]$/, ""),
      path: m[1],
    }));
    return {
      failed: Number(pytestSummary[1] ?? 0),
      passed: Number(pytestSummary[2] ?? 0),
      failures: dedupe(failures),
      framework: "pytest",
    };
  }

  // jest / vitest: "Tests: 2 failed, 10 passed" + "✕ name" / "× name" + "FAIL path"
  const jestSummary = output.match(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed/);
  if (jestSummary) {
    const failPaths = [...output.matchAll(/^\s*FAIL\s+(\S+)/gm)].map((m) => m[1]!);
    const failures = [...output.matchAll(/^\s*[✕×✗]\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/gm)].map((m, i) => ({
      name: m[1]!.trim(),
      path: failPaths[Math.min(i, failPaths.length - 1)],
    }));
    return {
      failed: Number(jestSummary[1] ?? 0),
      passed: Number(jestSummary[2] ?? 0),
      failures: dedupe(failures),
      framework: "jest",
    };
  }

  // go test: "--- FAIL: TestName" + "FAIL\tpkg/path"
  const goFails = [...output.matchAll(/^--- FAIL: (\S+)/gm)];
  if (goFails.length > 0 || /^ok\s+\S+\s+[\d.]+s/m.test(output)) {
    const pkg = output.match(/^FAIL\s+(\S+)/m)?.[1];
    const passed = [...output.matchAll(/^--- PASS: /gm)].length || [...output.matchAll(/^ok\s+/gm)].length;
    return {
      failed: goFails.length,
      passed,
      failures: goFails.map((m) => ({ name: m[1]!, path: pkg })),
      framework: "gotest",
    };
  }

  // cargo test: "test result: FAILED. 10 passed; 2 failed" + "test name ... FAILED"
  const cargoSummary = output.match(/test result: \w+\. (\d+) passed; (\d+) failed/);
  if (cargoSummary) {
    const failures = [...output.matchAll(/^test (\S+) \.\.\. FAILED/gm)].map((m) => ({ name: m[1]! }));
    return {
      passed: Number(cargoSummary[1]),
      failed: Number(cargoSummary[2]),
      failures: dedupe(failures),
      framework: "cargo",
    };
  }

  // Unknown output: trust the exit code; one anonymous raider on failure.
  if (exitCode !== 0) {
    return { passed: 0, failed: 1, failures: [{ name: "the build fails" }], framework: "exitcode" };
  }
  return { passed: 1, failed: 0, failures: [], framework: "none" };
}

function dedupe(failures: { name: string; path?: string }[]): { name: string; path?: string }[] {
  const seen = new Set<string>();
  return failures.filter((f) => {
    const key = `${f.path}::${f.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
