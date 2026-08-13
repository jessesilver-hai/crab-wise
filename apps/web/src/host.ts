import { Settlement, SandboxExecutor } from "@agent-empires/runtime";
import type { ThemePack } from "@agent-empires/protocol";
import { hostMatch } from "./relay.js";
import { createMatchView } from "./match-view.js";
import { attachGameRenderer } from "./game/renderer.js";
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

  const view = createMatchView(root, {
    matchId,
    title: repoLabel,
    role: "host",
    onSpeak: (text, toName) => settlement?.speak(text, toName),
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
  });
  view.showOverlay("loading", "Raising the vessel — a sandbox wakes for this repository…");
  view.attachRenderer(attachGameRenderer(view.gameMount));

  const abort = new AbortController();
  const warnUnload = (e: BeforeUnloadEvent) => e.preventDefault();
  window.addEventListener("beforeunload", warnUnload);
  window.addEventListener(
    "hashchange",
    () => {
      abort.abort();
      settlement?.end();
      end();
      window.removeEventListener("beforeunload", warnUnload);
    },
    { once: true },
  );

  let hostToken: string;
  try {
    hostToken = await sandbox;
  } catch (err) {
    view.showOverlay("abandoned", `No vessel could be raised: ${String((err as Error).message ?? err)}`);
    end();
    return;
  }

  const executor = new SandboxExecutor(matchId, hostToken);
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
      void generateTheme({ apiKey, model, llm, repoLabel, readme, treeSummary }).then(async (theme) => {
        if (theme && !abort.signal.aborted) {
          settlement!.setTheme(theme);
          await fetch(`/api/theme/${repoKey(repoUrl)}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(theme),
          }).catch(() => {});
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
