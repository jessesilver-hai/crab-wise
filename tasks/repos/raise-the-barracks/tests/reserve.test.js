import test from "node:test";
import assert from "node:assert/strict";
import { startServer, request } from "./helpers.js";

test("POST /items/:id/reserve creates a reservation and decrements stock", async () => {
  const server = await startServer([{ name: "horses", stock: 5 }]);
  try {
    const reserved = await request(server.baseUrl, "POST", "/items/1/reserve", {
      quantity: 2,
    });
    assert.equal(reserved.status, 201);
    assert.equal(reserved.body.itemId, "1");
    assert.equal(reserved.body.quantity, 2);
    assert.ok(reserved.body.id);

    const items = await request(server.baseUrl, "GET", "/items");
    assert.equal(items.body[0].stock, 3);
  } finally {
    await server.close();
  }
});

test("POST /items/:id/reserve responds 409 when stock is insufficient", async () => {
  const server = await startServer([{ name: "catapults", stock: 1 }]);
  try {
    const reserved = await request(server.baseUrl, "POST", "/items/1/reserve", {
      quantity: 5,
    });
    assert.equal(reserved.status, 409);

    const items = await request(server.baseUrl, "GET", "/items");
    assert.equal(items.body[0].stock, 1);

    const reservations = await request(server.baseUrl, "GET", "/reservations");
    assert.equal(reservations.body.length, 0);
  } finally {
    await server.close();
  }
});

test("POST /items/:id/reserve responds 404 for an unknown item", async () => {
  const server = await startServer([]);
  try {
    const { status, body } = await request(server.baseUrl, "POST", "/items/42/reserve", {
      quantity: 1,
    });
    assert.equal(status, 404);
    assert.equal(body.error, "item not found");
  } finally {
    await server.close();
  }
});

test("POST /items/:id/reserve rejects a non-positive quantity", async () => {
  const server = await startServer([{ name: "rams", stock: 3 }]);
  try {
    const { status } = await request(server.baseUrl, "POST", "/items/1/reserve", {
      quantity: 0,
    });
    assert.equal(status, 400);
  } finally {
    await server.close();
  }
});

test("GET /reservations lists reservations in order", async () => {
  const server = await startServer([{ name: "horses", stock: 10 }]);
  try {
    await request(server.baseUrl, "POST", "/items/1/reserve", { quantity: 2 });
    await request(server.baseUrl, "POST", "/items/1/reserve", { quantity: 1 });

    const { status, body } = await request(server.baseUrl, "GET", "/reservations");
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.equal(body[0].quantity, 2);
    assert.equal(body[1].quantity, 1);
    assert.equal(body[1].itemId, "1");
  } finally {
    await server.close();
  }
});
