// everything.js — the whole city in one file.
//
// This started as a geometry helper for the map editor. Then the market
// needed pricing, and the pricing needed receipts, and receipts needed
// formatting, and now everything lives here. It all works. It is all tangled.

// Shared helper: used by geometry (circleArea) and pricing (money math).
function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Geometry: distances, areas, bounding boxes for the city map.
// ---------------------------------------------------------------------------

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function rectArea(width, height) {
  if (width < 0 || height < 0) {
    throw new Error("Dimensions must be non-negative");
  }
  return width * height;
}

export function circleArea(radius) {
  if (radius < 0) {
    throw new Error("Radius must be non-negative");
  }
  return roundTo(Math.PI * radius * radius, 4);
}

export function boundingBox(points) {
  if (points.length === 0) {
    throw new Error("boundingBox needs at least one point");
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// ---------------------------------------------------------------------------
// Pricing: the market cart. Bulk orders of 10+ of a line get a discount.
// ---------------------------------------------------------------------------

const BULK_THRESHOLD = 10;
const BULK_DISCOUNT = 0.1;

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

// ---------------------------------------------------------------------------
// Formatting: text helpers for receipts, signs, and announcements.
// ---------------------------------------------------------------------------

export function formatMoney(amount) {
  return "$" + amount.toFixed(2);
}

export function titleCase(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }
  return text.slice(0, maxLength - 3) + "...";
}

export function padColumns(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
}
