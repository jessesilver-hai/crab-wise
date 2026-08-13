/**
 * The herald translates real engineering messages into Age-of-Empires-court
 * dispatches. Deterministic templates, seeded by message length, so replays
 * render identically and no extra LLM calls are spent on flavor.
 */

const OPENERS = [
  "Hark!",
  "My liege,",
  "Word from the fields:",
  "A rider arrives:",
  "By decree,",
  "Hear ye:",
];

const CLOSERS = [
  "So it is written.",
  "The court takes note.",
  "Long live the build.",
  "May the tests be ever green.",
  "So says the herald.",
  "",
];

function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length]!;
}

export function heraldMessage(from: string, to: string | undefined, text: string): string {
  const seed = text.length;
  const opener = pick(OPENERS, seed);
  const closer = pick(CLOSERS, seed + 3);
  const addressee = to ? `unto ${to}` : "unto all the realm";
  return `${opener} ${from} sends word ${addressee}: “${text}” ${closer}`.trim();
}

export function heraldCharge(name: string, charge: string): string {
  return `${name} is charged by the crown: “${charge}”`;
}

export function heraldBattleCry(failed: number): string {
  if (failed === 1) return "A lone raider harries the walls!";
  if (failed <= 3) return `${failed} raiders ride against the town!`;
  return `A warband of ${failed} raiders descends upon the realm!`;
}

export function heraldVictoryTests(passed: number): string {
  return `The raiders are routed! ${passed} banners fly green over the battlements.`;
}
