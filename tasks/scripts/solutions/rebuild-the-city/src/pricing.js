import { formatMoney, padColumns } from "./format.js";

const BULK_THRESHOLD = 10;
const BULK_DISCOUNT = 0.1;

function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function createCart() {
  return { lines: [] };
}

export function addLine(cart, { sku, name, unitPrice, quantity }) {
  const existing = cart.lines.find((line) => line.sku === sku);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.lines.push({ sku, name, unitPrice, quantity });
  }
  return cart;
}

function lineSubtotal(line) {
  const raw = line.unitPrice * line.quantity;
  const discounted =
    line.quantity >= BULK_THRESHOLD ? raw * (1 - BULK_DISCOUNT) : raw;
  return roundTo(discounted, 2);
}

export function cartTotal(cart) {
  const sum = cart.lines.reduce((total, line) => total + lineSubtotal(line), 0);
  return roundTo(sum, 2);
}

export function receipt(cart) {
  const rows = cart.lines.map((line) => [
    line.name,
    String(line.quantity),
    formatMoney(lineSubtotal(line)),
  ]);
  rows.push(["TOTAL", "", formatMoney(cartTotal(cart))]);
  return padColumns(rows);
}
