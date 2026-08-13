# Rebuild the City

Everything this city runs on lives in one sprawling file: `src/everything.js`.
It works, but it mixes three unrelated concerns.

## The refactor

Split `src/everything.js` into three focused modules:

- `src/geometry.js` — distance, midpoint, rectArea, circleArea, boundingBox
- `src/pricing.js` — createCart, addLine, cartTotal, receipt
- `src/format.js` — formatMoney, titleCase, truncate, padColumns

Behavior must not change. `src/everything.js` must keep exporting every name it
exports today (re-exporting from the new modules is fine), so existing callers
keep working.

## Running the tests

```
node --test --test-reporter=tap "tests/*.test.js"
```

`tests/legacy.test.js` passes today and must stay green. `tests/modules.test.js`
fails until the new modules exist. Do not modify anything under `tests/`.
