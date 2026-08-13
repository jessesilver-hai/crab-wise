import test from "node:test";
import assert from "node:assert/strict";
import {
  distance,
  midpoint,
  rectArea,
  circleArea,
  boundingBox,
  createCart,
  addLine,
  cartTotal,
  receipt,
  formatMoney,
  titleCase,
  truncate,
  padColumns,
} from "../src/everything.js";

test("legacy: distance", () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test("legacy: midpoint", () => {
  assert.deepEqual(midpoint({ x: 0, y: 0 }, { x: 4, y: 6 }), { x: 2, y: 3 });
});

test("legacy: rectArea", () => {
  assert.equal(rectArea(3, 4), 12);
  assert.throws(() => rectArea(-1, 4));
});

test("legacy: circleArea", () => {
  assert.equal(circleArea(1), 3.1416);
  assert.equal(circleArea(0), 0);
});

test("legacy: boundingBox", () => {
  const box = boundingBox([
    { x: 1, y: 2 },
    { x: 4, y: -1 },
    { x: 3, y: 5 },
  ]);
  assert.deepEqual(box, {
    minX: 1,
    minY: -1,
    maxX: 4,
    maxY: 5,
    width: 3,
    height: 6,
  });
});

test("legacy: addLine merges duplicate skus", () => {
  const cart = createCart();
  addLine(cart, { sku: "wood", name: "Wood", unitPrice: 2, quantity: 2 });
  addLine(cart, { sku: "wood", name: "Wood", unitPrice: 2, quantity: 3 });
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0].quantity, 5);
});

test("legacy: cartTotal applies the bulk discount", () => {
  const cart = createCart();
  addLine(cart, { sku: "stone", name: "Stone", unitPrice: 2.5, quantity: 4 });
  addLine(cart, { sku: "gold", name: "Gold", unitPrice: 1, quantity: 10 });
  assert.equal(cartTotal(cart), 19);
});

test("legacy: receipt renders aligned columns", () => {
  const cart = createCart();
  addLine(cart, { sku: "stone", name: "Stone", unitPrice: 3, quantity: 2 });
  assert.equal(receipt(cart), "Stone  2  $6.00\nTOTAL     $6.00");
});

test("legacy: formatMoney", () => {
  assert.equal(formatMoney(3), "$3.00");
});

test("legacy: titleCase", () => {
  assert.equal(titleCase("the old MILL"), "The Old Mill");
});

test("legacy: truncate", () => {
  assert.equal(truncate("aqueduct", 5), "aq...");
  assert.equal(truncate("wall", 10), "wall");
  assert.equal(truncate("abcdef", 3), "abc");
});

test("legacy: padColumns", () => {
  assert.equal(
    padColumns([
      ["a", "bb"],
      ["ccc", "d"],
    ]),
    "a    bb\nccc  d"
  );
});
