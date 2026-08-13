function roundTo(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

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
