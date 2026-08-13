const OPERATORS = new Set(["+", "-", "*", "/"]);

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n") {
      i += 1;
      continue;
    }

    if (isDigit(ch)) {
      let j = i;
      let seenDot = false;
      while (j < input.length && (isDigit(input[j]) || (input[j] === "." && !seenDot))) {
        if (input[j] === ".") seenDot = true;
        j += 1;
      }
      tokens.push({ type: "number", value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i;
      while (j < input.length && isIdentPart(input[j])) {
        j += 1;
      }
      tokens.push({ type: "ident", name: input.slice(i, j) });
      i = j;
      continue;
    }

    if (OPERATORS.has(ch)) {
      tokens.push({ type: "op", op: ch });
      i += 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i += 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i += 1;
      continue;
    }

    throw new Error("Unexpected character '" + ch + "' at position " + i);
  }
  return tokens;
}
