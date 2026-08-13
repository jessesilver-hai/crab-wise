/**
 * The herald translates real engineering messages into in-world court
 * dispatches. Deterministic templates seeded by message length, so replays
 * render identically and no LLM tokens are spent on flavor. A repo's theme
 * pack can override the lexicon (openers, closers, what the enemy is called).
 */

export type HeraldLexicon = {
  openers: string[];
  closers: string[];
  /** What failing tests are called, e.g. "raiders", "gremlins", "specters". */
  enemyName: string;
};

const DEFAULT_LEXICON: HeraldLexicon = {
  openers: [
    "Hearken.",
    "From the deep record:",
    "The signal speaks:",
    "It is inscribed:",
    "Across the ash:",
    "The wire hums:",
  ],
  closers: [
    "So it is inscribed.",
    "The record endures.",
    "May the seals hold.",
    "The build-light burns on.",
    "Thus the chronicle.",
    "",
  ],
  enemyName: "specters",
};

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length]!;
}

export function heraldMessage(
  from: string,
  to: string | undefined,
  text: string,
  lexicon: HeraldLexicon = DEFAULT_LEXICON,
): string {
  const lex = normalizeLexicon(lexicon);
  const seed = text.length;
  const opener = pick(lex.openers, seed);
  const closer = pick(lex.closers, seed + 3);
  const addressee = to ? `unto ${to}` : "unto all the realm";
  return `${opener} ${from} sends word ${addressee}: “${text}” ${closer}`.trim();
}

export function heraldCharge(name: string, charge: string): string {
  return `${name} is charged by the crown: “${charge}”`;
}

export function heraldBattleCry(failed: number, lexicon: HeraldLexicon = DEFAULT_LEXICON): string {
  const enemy = normalizeLexicon(lexicon).enemyName;
  const one = enemy.replace(/s$/, "");
  if (failed === 1) return `A lone ${one} harries the walls!`;
  if (failed <= 3) return `${failed} ${enemy} ride against the town!`;
  return `A warband of ${failed} ${enemy} descends upon the realm!`;
}

export function heraldVictoryTests(passed: number, lexicon: HeraldLexicon = DEFAULT_LEXICON): string {
  const enemy = normalizeLexicon(lexicon).enemyName;
  return `The ${enemy} are routed! ${passed} banners fly green over the battlements.`;
}

function normalizeLexicon(lex: HeraldLexicon): HeraldLexicon {
  return {
    openers: lex.openers.length ? lex.openers : DEFAULT_LEXICON.openers,
    closers: lex.closers.length ? lex.closers : DEFAULT_LEXICON.closers,
    enemyName: lex.enemyName || DEFAULT_LEXICON.enemyName,
  };
}
