import test from "node:test";
import assert from "node:assert/strict";
import { distance, circleArea, boundingBox } from "../src/geometry.js";
import { createCart, addLine, cartTotal, receipt } from "../src/pricing.js";
import { titleCase, truncate, formatMoney } from "../src/format.js";

test("geometry module: distance and circleArea", () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 6, y: 8 }), 10);
  assert.equal(circleArea(2), 12.5664);
});

test("geometry module: boundingBox", () => {
  const box = boundingBox([
    { x: 0, y: 0 },
    { x: 2, y: 3 },
  ]);
  assert.equal(box.width, 2);
  assert.equal(box.height, 3);
});

test("pricing module: cartTotal with the bulk discount", () => {
  const cart = createCart();
  addLine(cart, { sku: "wood", name: "Wood", unitPrice: 1, quantity: 12 });
  assert.equal(cartTotal(cart), 10.8);
});

test("pricing module: receipt uses the formatting helpers", () => {
  const cart = createCart();
  addLine(cart, { sku: "iron", name: "Iron", unitPrice: 2, quantity: 3 });
  assert.equal(receipt(cart), "Iron   3  $6.00\nTOTAL     $6.00");
});

test("format module: titleCase, truncate, formatMoney", () => {
  assert.equal(titleCase("town CENTER"), "Town Center");
  assert.equal(truncate("fortification", 7), "fort...");
  assert.equal(formatMoney(0.5), "$0.50");
});
