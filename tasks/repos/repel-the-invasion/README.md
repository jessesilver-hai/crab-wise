# Repel the Invasion

A small arithmetic expression evaluator: tokenizer, Pratt parser, and tree-walking
evaluator with variable scopes.

Something is wrong. The test suite reports failures across the pipeline.

## Layout

- `src/tokenizer.js` — turns an input string into tokens
- `src/parser.js` — builds an AST from tokens
- `src/evaluate.js` — evaluates an AST against a variable scope

## Running the tests

```
node --test --test-reporter=tap "tests/*.test.js"
```

Fix the source files until every test passes. Do not modify anything under `tests/`.
