import { tokenize } from "./tokenizer.js";

const PRECEDENCE = { "+": 1, "-": 1, "*": 2, "/": 1 };

export function parse(input) {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parsePrimary() {
    const token = next();
    if (!token) {
      throw new Error("Unexpected end of input");
    }
    if (token.type === "number") {
      return { type: "number", value: token.value };
    }
    if (token.type === "ident") {
      return { type: "variable", name: token.name };
    }
    if (token.type === "lparen") {
      const inner = parseExpression(0);
      const closing = next();
      if (!closing || closing.type !== "rparen") {
        throw new Error("Expected closing parenthesis");
      }
      return inner;
    }
    if (token.type === "op" && token.op === "-") {
      return { type: "negate", operand: parseExpression(0) };
    }
    throw new Error("Unexpected token: " + token.type);
  }

  function parseExpression(minPrecedence) {
    let left = parsePrimary();
    while (true) {
      const token = peek();
      if (!token || token.type !== "op") {
        break;
      }
      const precedence = PRECEDENCE[token.op];
      if (precedence < minPrecedence) {
        break;
      }
      next();
      const right = parseExpression(precedence + 1);
      left = { type: "binary", op: token.op, left, right };
    }
    return left;
  }

  const ast = parseExpression(0);
  if (pos < tokens.length) {
    throw new Error("Unexpected trailing input");
  }
  return ast;
}
