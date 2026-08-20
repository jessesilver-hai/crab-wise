/**
 * Flourish law — signed works.
 *
 * A worker who truly labored in a wing may leave ONE small maker's mark on
 * its construction: a lantern by the door, a garden bed, a gargoyle on the
 * corner. The castle starts recording WHO built it, not just what was built.
 *
 * The Law of Isomorphism holds:
 *   - provenance is measured: the runtime refuses sign_work on paths the
 *     author never read or wrote this shift, and the castle law refuses
 *     paths that resolve to no construction;
 *   - the mark is a closed vocabulary (protocol FLOURISH_MARKS), the
 *     citation mandatory — an unlawful flourish simply does not exist;
 *   - marks ride the ledger (validated again on every plan) and fold into
 *     the castle hash, so signed works persist across commissions and
 *     replay identically.
 *
 * One mark per author per construction (re-signing replaces your earlier
 * mark); at most three authors may sign one construction.
 */
import { FLOURISH_MARKS } from "@agent-empires/protocol";

export { FLOURISH_MARKS };
export type FlourishMark = (typeof FLOURISH_MARKS)[number];

export type Flourish = {
  mark: FlourishMark;
  /** The signing worker's name, carried whole for replays. */
  author: string;
  /** One line naming the work done there. */
  cited: string;
};

export const FLOURISH_LAW = {
  maxPerConstruction: 3,
  maxAuthor: 60,
  maxCited: 240,
} as const;

/** A flourish exists only with a lawful mark, an author, and a citation. */
export function validateFlourish(raw: unknown): Flourish | null {
  if (typeof raw !== "object" || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const mark =
    typeof f.mark === "string" && (FLOURISH_MARKS as readonly string[]).includes(f.mark)
      ? (f.mark as FlourishMark)
      : null;
  const author = typeof f.author === "string" ? f.author.trim().slice(0, FLOURISH_LAW.maxAuthor) : "";
  const cited = typeof f.cited === "string" ? f.cited.trim().slice(0, FLOURISH_LAW.maxCited) : "";
  if (!mark || !author || !cited) return null;
  return { mark, author, cited };
}

/**
 * Sign a construction: re-signing replaces the author's earlier mark IN
 * PLACE (order is signature-stable, so an identical re-sign is silence);
 * a fourth author is refused (null). Existing unlawful entries are shed.
 */
export function signWork(existing: readonly Flourish[] | undefined, f: Flourish): Flourish[] | null {
  const list = lawfulFlourishes(existing);
  const idx = list.findIndex((e) => e.author === f.author);
  if (idx >= 0) {
    const out = [...list];
    out[idx] = f;
    return out;
  }
  if (list.length >= FLOURISH_LAW.maxPerConstruction) return null;
  return [...list, f];
}

/** Ledger-borne lists re-validate on every plan: unlawful entries vanish. */
export function lawfulFlourishes(raw: unknown): Flourish[] {
  if (!Array.isArray(raw)) return [];
  const out: Flourish[] = [];
  const authors = new Set<string>();
  for (const item of raw) {
    const f = validateFlourish(item);
    if (!f || authors.has(f.author)) continue;
    authors.add(f.author);
    out.push(f);
    if (out.length >= FLOURISH_LAW.maxPerConstruction) break;
  }
  return out;
}

/** Stable one-line signature — folded into the castle hash. */
export function flourishSignature(list: readonly Flourish[] | undefined): string {
  if (!list || list.length === 0) return "unsigned";
  return list.map((f) => `${f.mark}@${f.author}`).join("+");
}
