import { runMatch, type TaskDefinition } from "@agent-empires/runtime";
import { hostMatch } from "./relay.js";
import { createMatchView } from "./match-view.js";
import { attachGameRenderer } from "./game/renderer.js";

export async function startHostedMatch(
  root: HTMLElement,
  opts: { task: TaskDefinition; apiKey: string; model: string },
): Promise<void> {
  const { task, apiKey, model } = opts;

  const { matchId, publish, end } = await hostMatch(task.id, task.title);
  // Update the URL without triggering the hash router (replaceState fires no hashchange).
  history.replaceState(null, "", `#/match/${matchId}`);

  root.innerHTML = "";
  const view = createMatchView(root, { matchId, title: task.title, role: "host" });
  view.showOverlay("loading", "Booting the sandbox and rallying villagers…");
  view.attachRenderer(attachGameRenderer(view.gameMount));

  const abort = new AbortController();
  const warnUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };
  window.addEventListener("beforeunload", warnUnload);
  window.addEventListener(
    "hashchange",
    () => {
      abort.abort();
      end();
      window.removeEventListener("beforeunload", warnUnload);
    },
    { once: true },
  );

  let firstEvent = true;
  try {
    await runMatch({
      apiKey,
      model,
      task,
      signal: abort.signal,
      onEvent: (event) => {
        if (firstEvent) {
          view.hideOverlay();
          firstEvent = false;
        }
        publish(event);
        view.onEvent(event, false);
      },
    });
  } catch (err) {
    if (!abort.signal.aborted) {
      view.showOverlay("abandoned", `The match ended early: ${String(err)}`);
      end();
    }
  } finally {
    window.removeEventListener("beforeunload", warnUnload);
  }
}
