import { parse } from "./parser.js";

export function evaluate(input, scope = {}) {
  return evaluateNode(parse(input), scope);
}

function evaluateNode(node, scope) {
  switch (node.type) {
    case "number":
      return node.value;
    case "variable": {
      const value = scope[node.name];
      if (value === undefined) {
        throw new Error("Unknown variable: " + node.name);
      }
      return value;
    }
    case "negate":
      return -evaluateNode(node.operand, scope);
    case "binary": {
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0) {
            throw new Error("Division by zero");
          }
          return left / right;
      }
    }
  }
  throw new Error("Unknown node type: " + node.type);
}
