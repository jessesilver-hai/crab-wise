# Raise the Barracks

A tiny in-memory inventory HTTP service built on `node:http`. No dependencies.

## Working endpoints

- `GET /items` — list items
- `POST /items` — create an item (`{ "name": string, "stock": number }`)

## Missing feature: reservations

- `POST /items/:id/reserve` with `{ "quantity": number }` — reserve stock.
  Responds `201` with the reservation, `404` with `{ "error": "item not found" }`
  for an unknown item, `400` for an invalid quantity, and `409` when there is
  not enough stock (stock unchanged).
  A successful reservation decrements the item's stock.
- `GET /reservations` — list all reservations.

The store (`src/store.js`) already tracks reservations; the HTTP routes in
`src/server.js` still need to be built.

## Running the tests

```
node --test --test-reporter=tap "tests/*.test.js"
```

`tests/items.test.js` passes today; `tests/reserve.test.js` fails until the
feature exists. Do not modify anything under `tests/`.
