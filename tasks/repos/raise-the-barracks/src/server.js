import http from "node:http";
import { sendJson, readJsonBody } from "./json.js";

export function createApp(store) {
  return http.createServer((req, res) => {
    handle(req, res, store).catch((error) => {
      sendJson(res, 400, { error: error.message });
    });
  });
}

async function handle(req, res, store) {
  const url = new URL(req.url, "http://localhost");
  const { method } = req;

  if (method === "GET" && url.pathname === "/items") {
    sendJson(res, 200, store.listItems());
    return;
  }

  if (method === "POST" && url.pathname === "/items") {
    const body = await readJsonBody(req);
    if (typeof body.name !== "string" || typeof body.stock !== "number") {
      sendJson(res, 400, { error: "name and stock are required" });
      return;
    }
    const item = store.addItem({ name: body.name, stock: body.stock });
    sendJson(res, 201, item);
    return;
  }

  // Reservations are not wired up yet. The store already supports them
  // (store.addReservation / store.listReservations); the routes for
  // POST /items/:id/reserve and GET /reservations still need to be built here.

  sendJson(res, 404, { error: "not found" });
}
