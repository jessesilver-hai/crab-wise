import { renderLobby } from "./lobby.js";
import { renderSpectate } from "./spectate.js";

function route() {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  const m = location.hash.match(/^#\/match\/([\w-]+)/);
  if (m) renderSpectate(app, m[1]!);
  else renderLobby(app);
}

window.addEventListener("hashchange", route);
route();
