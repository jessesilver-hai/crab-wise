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

  const reserveMatch = url.pathname.match(/^\/items\/([^/]+)\/reserve$/);
  if (method === "POST" && reserveMatch) {
    const item = store.getItem(reserveMatch[1]);
    if (!item) {
      sendJson(res, 404, { error: "item not found" });
      return;
    }
    const body = await readJsonBody(req);
    const quantity = body.quantity;
    if (!Number.isInteger(quantity) || quantity <= 0) {
      sendJson(res, 400, { error: "quantity must be a positive integer" });
      return;
    }
    if (quantity > item.stock) {
      sendJson(res, 409, { error: "insufficient stock" });
      return;
    }
    item.stock -= quantity;
    const reservation = store.addReservation({ itemId: item.id, quantity });
    sendJson(res, 201, reservation);
    return;
  }

  if (method === "GET" && url.pathname === "/reservations") {
    sendJson(res, 200, store.listReservations());
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
