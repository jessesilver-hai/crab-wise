import type { FileSystemTree } from "@webcontainer/api";

export type TaskMeta = {
  id: string;
  title: string;
  description: string;
  flavor: string;
  acceptCommand: string[];
  workerCount: number;
  files: FileSystemTree;
};

const rawFiles = import.meta.glob("../repos/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function buildTree(repoId: string): FileSystemTree {
  const prefix = `../repos/${repoId}/`;
  const tree: FileSystemTree = {};
  for (const [globPath, contents] of Object.entries(rawFiles)) {
    if (!globPath.startsWith(prefix)) continue;
    const parts = globPath.slice(prefix.length).split("/");
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const existing = node[part];
      if (existing && "directory" in existing) {
        node = existing.directory;
      } else {
        const directory: FileSystemTree = {};
        node[part] = { directory };
        node = directory;
      }
    }
    node[parts[parts.length - 1]!] = { file: { contents } };
  }
  return tree;
}

// Node 22 does not accept a bare directory as a --test positional; it does
// expand glob patterns itself, so no shell is needed for this to work.
const ACCEPT_COMMAND = ["node", "--test", "--test-reporter=tap", "tests/*.test.js"];

export const TASKS: TaskMeta[] = [
  {
    id: "repel-the-invasion",
    title: "Repel the Invasion",
    description:
      "The arithmetic expression engine is under attack: four subtle bugs are hiding in " +
      "src/tokenizer.js, src/parser.js, and src/evaluate.js. Run " +
      'node --test --test-reporter=tap "tests/*.test.js" to see the failing cases, then fix the ' +
      "source files until every test passes. The tests define correct behavior — do not " +
      "modify anything under tests/.",
    flavor: "Enemy scouts have slipped bugs past the walls. Hunt them down before the tests fall.",
    acceptCommand: ACCEPT_COMMAND,
    workerCount: 3,
    files: buildTree("repel-the-invasion"),
  },
  {
    id: "raise-the-barracks",
    title: "Raise the Barracks",
    description:
      "The inventory service in src/server.js handles GET /items and POST /items, but the " +
      "reservation feature is missing. Implement POST /items/:id/reserve (body " +
      '{ "quantity": number }; respond 201 with the reservation, 404 for an unknown item, ' +
      "400 for a non-positive quantity, 409 when stock is insufficient, and decrement " +
      "stock on success) plus GET /reservations. src/store.js already tracks reservations " +
      '— extend the routes, not the world. Run node --test --test-reporter=tap "tests/*.test.js"; ' +
      "tests/reserve.test.js must go green. The tests are read-only: do not modify " +
      "anything under tests/.",
    flavor: "The villagers have gathered the resources. Build the barracks and muster the garrison.",
    acceptCommand: ACCEPT_COMMAND,
    workerCount: 2,
    files: buildTree("raise-the-barracks"),
  },
  {
    id: "rebuild-the-city",
    title: "Rebuild the City",
    description:
      "src/everything.js is a working god-file mixing three concerns. Split it into " +
      "src/geometry.js (distance, midpoint, rectArea, circleArea, boundingBox), " +
      "src/pricing.js (createCart, addLine, cartTotal, receipt), and src/format.js " +
      "(formatMoney, titleCase, truncate, padColumns) without changing behavior. " +
      "src/everything.js must keep exporting every current name (re-exports are fine) so " +
      "tests/legacy.test.js stays green while tests/modules.test.js starts passing. Run " +
      'node --test --test-reporter=tap "tests/*.test.js" to check. Do not modify anything under tests/.',
    flavor: "The old keep held everything under one roof. Raise proper districts from its stones.",
    acceptCommand: ACCEPT_COMMAND,
    workerCount: 3,
    files: buildTree("rebuild-the-city"),
  },
];
