import { Settlement, SandboxExecutor } from "@agent-empires/runtime";
import type { ThemePack } from "@agent-empires/protocol";
import { hostMatch } from "./relay.js";
import { createMatchView } from "./match-view.js";
import { selectRenderer } from "./renderer-select.js";
import { getCachedTheme, generateTheme, repoKey } from "./themer.js";

export type SettlementStart = {
  repoUrl: string;
  repoLabel: string;
  apiKey: string;
  model: string;
  /** Auto-issued as the Crown's first decree (sample worlds use this). */
  firstOrder?: string;
};

/** Model used when the visitor brings no key and the Crown pays via OpenRouter. */
export const FUNDED_MODEL = "x-ai/grok-4.6";

export async function startSettlement(root: HTMLElement, opts: SettlementStart): Promise<void> {
  const { repoUrl, repoLabel, apiKey } = opts;
  const funded = !apiKey;
  const model = funded ? FUNDED_MODEL : opts.model;

  const { matchId, publish, end, sandbox } = await hostMatch(repoUrl, repoLabel, repoUrl);
  history.replaceState(null, "", `#/match/${matchId}`);

  root.innerHTML = "";
  let settlement: Settlement | null = null;
  let fileReader: ((path: string) => Promise<string>) | null = null;

  // Worlds persist only by choice: departing offers save-or-burn, and only a
  // saved world joins the Prior Worlds. A vanished tab burns unrecorded.
  const abort = new AbortController();
  const warnUnload = (e: BeforeUnloadEvent) => e.preventDefault();
  window.addEventListener("beforeunload", warnUnload);
  let matchOver = false;
  let departed = false;
  const depart = (save: boolean) => {
    if (departed) return;
    departed = true;
    abort.abort();
    settlement?.end();
    end(save);
    window.removeEventListener("beforeunload", warnUnload);
  };

  const view = createMatchView(root, {
    matchId,
    title: repoLabel,
    role: "host",
    onSpeak: (text, toName) => settlement?.speak(text, toName),
    onSpeakTo: (agentId, text) => settlement?.speakTo(agentId, text),
    onOrder: (kind, target, agentId) => settlement?.order(kind, target, agentId),
    onReadFile: async (path) => {
      if (!fileReader) throw new Error("the vessel is not yet raised");
      return fileReader(path);
    },
    onPatch: async () => {
      if (!settlement) return;
      try {
        const { patch, stat } = await settlement.requestPatch();
        if (!patch.trim()) {
          alert("The scribes report no changes yet — nothing to decree.");
          return;
        }
        const blob = new Blob([patch], { type: "text/x-patch" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${repoLabel.replace(/[^\w.-]+/g, "-")}.patch`;
        a.click();
        URL.revokeObjectURL(a.href);
        console.log("patch stat:\n" + stat);
      } catch (err) {
        alert(`The decree could not be sealed: ${String(err)}`);
      }
    },
    onViewPatch: async () => {
      if (!settlement) return "";
      const { patch } = await settlement.requestPatch();
      return patch;
    },
    onLeaveAttempt: () => {
      if (matchOver || departed) {
        location.hash = "#/";
        return;
      }
      void view.confirmLeave().then((choice) => {
        if (choice === "stay") return;
        depart(choice === "save");
        location.hash = "#/";
      });
    },
  });
  view.showOverlay("loading", "Raising the vessel — a sandbox wakes for this repository…");
  void selectRenderer(view.gameMount).then((r) => view.attachRenderer(r));

  window.addEventListener(
    "hashchange",
    () => {
      // Browser-driven exits (back button, overlay's return button) can't show
      // the pretty gate mid-navigation; a native prompt still honors the law.
      if (!departed && !matchOver) {
        const save = confirm(
          "Save this world to the Prior Worlds before you go?\n\nOK — save its chronicle for any visitor to replay.\nCancel — let it burn, unrecorded.",
        );
        depart(save);
      } else {
        depart(true);
      }
    },
    { once: true },
  );

  let hostToken: string;
  try {
    hostToken = await sandbox;
  } catch (err) {
    view.showOverlay("abandoned", `No vessel could be raised: ${String((err as Error).message ?? err)}`);
    depart(false); // a world that never woke leaves no record
    return;
  }

  const executor = new SandboxExecutor(matchId, hostToken);
  fileReader = async (path) => (await executor.read(path)).content;
  const llm = funded
    ? {
        baseURL: `${location.origin}/api/llm/${matchId}`,
        headers: { authorization: `Bearer ${hostToken}` },
      }
    : undefined;
  const cachedTheme: ThemePack | null = await getCachedTheme(repoKey(repoUrl));

  const onEvent = (event: Parameters<typeof view.onEvent>[0]) => {
    publish(event);
    view.onEvent(event, false);
    if (event.type === "match_ended") {
      // Completed runs are already interred by the relay; exits stop prompting.
      matchOver = true;
      window.removeEventListener("beforeunload", warnUnload);
    }
  };

  settlement = new Settlement({
    apiKey,
    model,
    repoUrl,
    repoLabel,
    executor,
    theme: cachedTheme,
    llm,
    signal: abort.signal,
    onEvent,
  });

  view.setStatusLine("Unearthing the record — cloning the repository…");
  try {
    const { readme, treeSummary } = await settlement.start();
    view.hideOverlay();
    if (opts.firstOrder && !abort.signal.aborted) settlement.speak(opts.firstOrder);

    // No cached theme: divine one in the background while the session runs.
    if (!cachedTheme && !abort.signal.aborted) {
      const narrate = (text: string) =>
        onEvent({ seq: 0, ts: Date.now(), type: "log", level: "info", text });
      narrate(`⟡ The chroniclers read the record of ${repoLabel}…`);
      void generateTheme({ apiKey, model, llm, repoLabel, readme, treeSummary }).then(async (theme) => {
        if (abort.signal.aborted) return;
        if (theme) {
          // Fake-stream the world's own loading narration while it morphs in.
          theme.worldSpec?.lore.loadingLines.forEach((line, i) => {
            window.setTimeout(() => {
              if (!abort.signal.aborted) narrate(`⟡ ${line}`);
            }, i * 4000);
          });
          settlement!.setTheme(theme);
          await fetch(`/api/theme/${repoKey(repoUrl)}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(theme),
          }).catch(() => {});
        } else {
          // Surface the failure instead of silently keeping the default skin.
          onEvent({
            seq: 0,
            ts: Date.now(),
            type: "log",
            level: "error",
            text: "The chroniclers' vision failed — this realm keeps the ashen guise. (Theme generation did not validate.)",
          } as Parameters<typeof view.onEvent>[0]);
        }
      });
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      view.showOverlay("abandoned", `The founding failed: ${String((err as Error).message ?? err)}`);
      end();
    }
  }
}
