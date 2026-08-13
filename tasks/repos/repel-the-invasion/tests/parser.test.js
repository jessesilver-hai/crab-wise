import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/evaluate.js";
import { tokenize } from "../src/tokenizer.js";

test("adds two numbers", () => {
  assert.equal(evaluate("2 + 3"), 5);
});

test("multiplication binds tighter than addition", () => {
  assert.equal(evaluate("2 + 3 * 4"), 14);
});

test("division binds tighter than subtraction", () => {
  assert.equal(evaluate("8 - 6 / 2"), 5);
});

test("division binds tighter than addition", () => {
  assert.equal(evaluate("2 + 12 / 4"), 5);
});

test("subtraction is left-associative", () => {
  assert.equal(evaluate("10 - 4 - 3"), 3);
});

test("parentheses override precedence", () => {
  assert.equal(evaluate("(2 + 3) * 4"), 20);
});

test("nested parentheses", () => {
  assert.equal(evaluate("((1 + 2) * (3 + 1))"), 12);
});

test("decimal numbers", () => {
  assert.equal(evaluate("1.5 + 2.25"), 3.75);
});

test("handles every digit", () => {
  assert.equal(evaluate("19 - 9"), 10);
});

test("unary minus binds tighter than addition", () => {
  assert.equal(evaluate("-2 + 10"), 8);
});

test("unary minus with multiplication", () => {
  assert.equal(evaluate("-3 * 2"), -6);
});

test("variables resolve from scope", () => {
  assert.equal(evaluate("width * height", { width: 6, height: 7 }), 42);
});

test("variable bound to zero", () => {
  assert.equal(evaluate("z + 5", { z: 0 }), 5);
});

test("unknown variable throws", () => {
  assert.throws(() => evaluate("missing + 1", {}));
});

test("unbalanced parenthesis throws", () => {
  assert.throws(() => evaluate("(1 + 2"));
});

test("tokenizer produces one token per lexeme", () => {
  assert.equal(tokenize("3 + 4").length, 3);
});
