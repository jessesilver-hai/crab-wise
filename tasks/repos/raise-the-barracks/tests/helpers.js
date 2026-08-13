import { createApp } from "../src/server.js";
import { createStore } from "../src/store.js";

export function startServer(seedItems) {
  const app = createApp(createStore(seedItems));
  return new Promise((resolve) => {
    app.listen(0, "127.0.0.1", () => {
      const { port } = app.address();
      resolve({
        baseUrl: "http://127.0.0.1:" + port,
        close: () => new Promise((done) => app.close(done)),
      });
    });
  });
}

export async function request(baseUrl, method, path, body) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
