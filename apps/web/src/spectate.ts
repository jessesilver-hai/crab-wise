import { spectateMatch } from "./relay.js";
import { createMatchView } from "./match-view.js";
import { selectRenderer } from "./renderer-select.js";

export function renderSpectate(root: HTMLElement, matchId: string): void {
  const view = createMatchView(root, { matchId, title: "…", role: "spectator" });
  void selectRenderer(view.gameMount).then((r) => view.attachRenderer(r));
  view.showOverlay("loading", "Fetching the chronicle…");

  let gotAny = false;
  let ended = false;
  const close = spectateMatch(
    matchId,
    (event, historical) => {
      if (!gotAny) {
        view.hideOverlay();
        gotAny = true;
      }
      if (event.type === "match_started") {
        const title = root.querySelector(".match-title");
        if (title) title.textContent = event.task.title;
      }
      if (event.type === "match_ended") ended = true;
      view.onEvent(event, historical);
    },
    () => {
      // Socket closed or match over; if no match_ended arrived it was abandoned.
      if (!ended) view.showOverlay("abandoned");
    },
    (message) => {
      view.showOverlay("abandoned", message);
    },
  );

  window.addEventListener("hashchange", () => close(), { once: true });
}
