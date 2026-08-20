/**
 * Residency law — the Master Builder stays in residence.
 *
 * The founding decree is free: one reading when the castle rises. Every
 * later wake — new constructions to dress, a milestone to answer — draws
 * on the PURSE, a bounded allowance of mid-match taste. The purse keeps a
 * chatty repo from draining the Crown on redecoration: wakes are counted,
 * spaced by a debounce floor, and refused outright once the match has
 * already spent its gold on real work.
 *
 * The WATCH is the pure half of choice-by-default: every fold reports the
 * components newly standing on the plan; those still wearing only the
 * derived default queue for a growth decree in small batches. The derived
 * genome remains the lawful fallback whenever the purse or the veil
 * refuses — the castle never waits and never breaks.
 */
import type { CastlePlan } from "./castle.js";

export const PURSE_LAW = {
  /** Mid-match decree wakes per commission (the founding decree is free). */
  wakes: 6,
  /** Breath between wakes: taste never chatters. */
  debounceMs: 45_000,
  /** Gold (tokens) already spent beyond which taste yields to work. */
  goldCeiling: 900_000,
} as const;

export type Purse = {
  wakesLeft: number;
  lastWakeAt: number;
};

export function foundPurse(): Purse {
  return { wakesLeft: PURSE_LAW.wakes, lastWakeAt: Number.NEGATIVE_INFINITY };
}

export type PurseVerdict = { allowed: true } | { allowed: false; reason: "empty" | "debounce" | "gold" };

/** Ask the purse for one wake. A granted wake is spent on the spot. */
export function tryWake(purse: Purse, now: number, goldSpent: number): PurseVerdict {
  if (purse.wakesLeft <= 0) return { allowed: false, reason: "empty" };
  if (now - purse.lastWakeAt < PURSE_LAW.debounceMs) return { allowed: false, reason: "debounce" };
  if (goldSpent >= PURSE_LAW.goldCeiling) return { allowed: false, reason: "gold" };
  purse.wakesLeft -= 1;
  purse.lastWakeAt = now;
  return { allowed: true };
}

/** Components standing on the plan that the watch has not seen before. */
export function newlySighted(known: ReadonlySet<string>, plan: CastlePlan): string[] {
  return plan.sockets.filter((s) => !s.razed && !known.has(s.componentId)).map((s) => s.componentId);
}

/** Of these ids, the ones still wearing only the derived default. */
export function undressed(plan: CastlePlan, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const e = plan.ledger.entries[id];
    return !!e && e.razed !== true && !e.genome;
  });
}

/** Newcomers are dressed in small batches: one wake, a few citations. */
export const GROWTH_BATCH = 4;

/**
 * The Builder's spoken refusals when the purse gates a Crown wish. The
 * taste channel never fails silently: the Crown always hears why.
 */
export function tasteRefusal(reason: "empty" | "debounce" | "gold"): string {
  switch (reason) {
    case "empty":
      return "The purse holds no more wakes this commission — the castle keeps its dress.";
    case "debounce":
      return "I am still at the drafting table — bring the wish again in a moment.";
    case "gold":
      return "The treasury's gold has gone to real work, as it should — no more taste this commission.";
  }
}
