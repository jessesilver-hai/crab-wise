/**
 * Temperament law — rostered variability.
 *
 * Two matches on the same repository should not feel like the same crew:
 * each worker draws a TEMPERAMENT, deterministically, from (name, match
 * seed). A temperament is pure prompt-flavor — it colors the worker's voice
 * and biases which maker's mark they lean toward when signing finished work
 * (sign_work) — and never touches the protocol, the ledger, or the hash.
 * The Law of Isomorphism is safe: temperament changes HOW a worker speaks
 * and signs, never WHAT the code measures.
 */
import { FLOURISH_MARKS } from "@agent-empires/protocol";

type Mark = (typeof FLOURISH_MARKS)[number];

export type Temperament = {
  name: string;
  /** Woven into the worker's voice line. */
  voice: string;
  /** The marks this temperament leans toward when signing. */
  marks: readonly [Mark, Mark];
};

export const TEMPERAMENTS: readonly Temperament[] = [
  { name: "stern", voice: "clipped and exact; praise is rare and earned", marks: ["gargoyle", "pennant"] },
  { name: "ornate", voice: "florid, delighting in detail and finish", marks: ["mosaic", "windchime"] },
  { name: "quiet", voice: "few words, all load-bearing", marks: ["garden", "beehive"] },
  { name: "fervent", voice: "urgent, all fire and forward motion", marks: ["forgefire", "lantern"] },
  { name: "wry", voice: "dry humor and understatement, sharp eyes", marks: ["gargoyle", "windchime"] },
  { name: "austere", voice: "measured and spare, wary of excess", marks: ["lantern", "pennant"] },
] as const;

/** Deterministic draw: the same name in the same match is the same soul. */
export function temperamentFor(name: string, seed: number): Temperament {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return TEMPERAMENTS[(h >>> 0) % TEMPERAMENTS.length]!;
}

/** The paragraph woven into the worker's system prompt. */
export function temperamentBrief(t: Temperament): string {
  return (
    `Your temperament is ${t.name}: your voice is ${t.voice}. ` +
    `When you sign finished work with sign_work you lean toward a ${t.marks[0]} or a ${t.marks[1]}, ` +
    `though any lawful mark is yours to choose.`
  );
}
