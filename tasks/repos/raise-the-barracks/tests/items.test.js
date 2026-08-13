import test from "node:test";
import assert from "node:assert/strict";
import { startServer, request } from "./helpers.js";

test("GET /items returns seeded items", async () => {
  const server = await startServer([
    { name: "pikes", stock: 12 },
    { name: "shields", stock: 4 },
  ]);
  try {
    const { status, body } = await request(server.baseUrl, "GET", "/items");
    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.deepEqual(body[0], { id: "1", name: "pikes", stock: 12 });
    assert.deepEqual(body[1], { id: "2", name: "shields", stock: 4 });
  } finally {
    await server.close();
  }
});

test("POST /items creates an item", async () => {
  const server = await startServer([]);
  try {
    const created = await request(server.baseUrl, "POST", "/items", {
      name: "arrows",
      stock: 30,
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { id: "1", name: "arrows", stock: 30 });

    const listed = await request(server.baseUrl, "GET", "/items");
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].name, "arrows");
  } finally {
    await server.close();
  }
});

test("POST /items rejects an invalid payload", async () => {
  const server = await startServer([]);
  try {
    const { status } = await request(server.baseUrl, "POST", "/items", {
      name: "swords",
    });
    assert.equal(status, 400);
  } finally {
    await server.close();
  }
});
