import type { Quarter } from "./map.js";

/**
 * The shroud: discovery law for both engines. The realm begins as terra
 * incognita — the citadel, the root plaza, and the land's shape are seen,
 * but every quarter stands unsurveyed: walls and name only, its works unrisen
 * under a deep veil. Surveying is the visitor's own act (a click), free and
 * viewer-local; agent activity surveys quarters for everyone as it always
 * revealed fog. Engine-pure: no DOM, no engine types, no unseeded randomness.
 *
 * Law: a quarter may be surveyed only when every ancestor quarter is already
 * surveyed (you cannot know the inner ward before the outer). A file's plot
 * is visible only when every quarter on its path is surveyed; files on the
 * root plaza are visible from the first frame.
 */
export type Shroud = {
  /** Quarter paths surveyed so far (never contains ""). */
  surveyed: Set<string>;
  isSurveyed(quarterPath: string): boolean;
  /** True when the quarter exists and its ancestor chain is fully surveyed. */
  canSurvey(quarterPath: string): boolean;
  /** Survey one quarter. Returns true when newly surveyed (false = repeat/forbidden). */
  survey(quarterPath: string): boolean;
  /**
   * Agent activity at a path (file_read/file_write/list_dir) uncovers the land:
   * marks every unsurveyed quarter on the path surveyed and returns them,
   * outermost first. Empty when nothing new.
   */
  revealForPath(path: string): string[];
  /** Deepest quarter containing this file/dir path, or null (root plaza). */
  quarterOf(path: string): string | null;
  /** All quarters on the path surveyed → the plot/hamlet may be shown. */
  plotVisible(path: string): boolean;
  /** Every quarter, for engines to iterate deterministically. */
  quarterPaths: string[];
};

export function createShroud(quarters: Quarter[]): Shroud {
  // Deepest-first so quarterOf finds the innermost containing quarter.
  const byDepth = [...quarters].sort((a, b) => b.path.length - a.path.length);
  const known = new Set(quarters.map((q) => q.path));
  const surveyed = new Set<string>();

  const ancestorsOf = (quarterPath: string): string[] => {
    // Quarter paths are directory paths; ancestors are the known prefixes.
    const parts = quarterPath.split("/");
    const out: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (known.has(prefix)) out.push(prefix);
    }
    return out;
  };

  const quarterOf = (path: string): string | null => {
    for (const q of byDepth) {
      if (path === q.path || path.startsWith(q.path + "/")) return q.path;
    }
    return null;
  };

  const isSurveyed = (p: string) => surveyed.has(p);
  const canSurvey = (p: string) =>
    known.has(p) && !surveyed.has(p) && ancestorsOf(p).every((a) => surveyed.has(a));

  return {
    surveyed,
    quarterPaths: quarters.map((q) => q.path),
    isSurveyed,
    canSurvey,
    quarterOf,
    survey(p: string): boolean {
      if (!canSurvey(p)) return false;
      surveyed.add(p);
      return true;
    },
    revealForPath(path: string): string[] {
      const inner = quarterOf(path);
      if (inner === null) return [];
      const chain = [...ancestorsOf(inner), inner].filter((p) => !surveyed.has(p));
      for (const p of chain) surveyed.add(p);
      return chain;
    },
    plotVisible(path: string): boolean {
      const inner = quarterOf(path);
      if (inner === null) return true;
      return [...ancestorsOf(inner), inner].every((p) => surveyed.has(p));
    },
  };
}
