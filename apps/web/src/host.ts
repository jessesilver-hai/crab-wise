import { Settlement, SandboxExecutor } from "@agent-empires/runtime";
import type { ThemePack } from "@agent-empires/protocol";
import { hostMatch } from "./relay.js";
import { createMatchView } from "./match-view.js";
import { selectRenderer } from "./renderer-select.js";
import { getCachedTheme, generateTheme, repoKey } from "./themer.js";
import { analyzeCensus, censusBrief } from "./game/census.js";
import { buildComponentGraph } from "./game/components.js";
import { CastleState } from "./game/castlestate.js";
import type { CastleLedger } from "./game/castle.js";
import { generateRepresentation } from "./reprloop.js";

export type SettlementStart = {
  repoUrl: string;
  repoLabel: string;
  apiKey: string;
  model: string;
  /** Auto-issued as the Crown's first decree (sample worlds use this). */
  firstOrder?: string;
  /** Castle Era: found upon (or found) a persistent castle. */
  castle?: { id: string; name: string };
};

/** Only a shape the plan law can actually merge counts as a prior ledger. */
function asLedger(u: unknown): CastleLedger | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const c = u as { version?: unknown; entries?: unknown; seed?: unknown };
  if (c.version !== 1 || typeof c.seed !== "number") return undefined;
  if (typeof c.entries !== "object" || c.entries === null) return undefined;
  return u as CastleLedger;
}

/** Model used when the visitor brings no key and the Crown pays via OpenRouter. */
export const FUNDED_MODEL = "x-ai/grok-4.6";

export async function startSettlement(root: HTMLElement, opts: SettlementStart): Promise<void> {
  const { repoUrl, repoLabel, apiKey } = opts;
  const funded = !apiKey;
  const model = funded ? FUNDED_MODEL : opts.model;

  // A returning castle brings its ledger (claims never move) and its bundle
  // (the relay seeds the sandbox before the clone).
  let priorLedger: CastleLedger | undefined;
  if (opts.castle) {
    try {
      const res = await fetch(`/api/castle/${opts.castle.id}`);
      if (res.ok) priorLedger = asLedger(((await res.json()) as { ledger?: unknown }).ledger);
    } catch {
      // a fresh castle has no record yet
    }
  }

  const { matchId, publish, end, sandbox } = await hostMatch(repoUrl, repoLabel, repoUrl, opts.castle?.id);
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
    // The Crown's verdict travels first: settlement.end() emits an
    // "abandoned" obituary that must never outrun an explicit burn.
    const farewell =
      save && opts.castle && shadow.plan
        ? { id: opts.castle.id, name: opts.castle.name, ledger: shadow.plan.ledger }
        : undefined;
    end(save, farewell);
    settlement?.end();
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

  // The host's shadow castle: the same law the renderer runs, folded here so
  // the departing ledger (and thus the persistent claims) is host-authoritative.
  const shadow = new CastleState();

  const onEvent = (event: Parameters<typeof view.onEvent>[0]) => {
    publish(event);
    view.onEvent(event, false);
    try {
      if (event.type === "match_started") {
        shadow.found(
          event.repoTree,
          event.mapSeed,
          event.depEdges ?? [],
          event.probeHits ?? [],
          priorLedger,
        );
      } else if (event.type === "file_write") {
        shadow.applyWrite(event.path, event.created, event.linesAdded, event.linesRemoved);
      } else if (event.type === "component_facts") {
        shadow.applyFacts(event.path, event.hits);
      } else if (event.type === "castle_repr") {
        shadow.applyRepr(event.componentId, event.form, event.cited);
      }
    } catch {
      // the shadow must never break the session
    }
    if (event.type === "match_started") {
      // The Master Builder studies the measured ledger and may re-dress
      // components — lawfully, with citations. The castle never waits on it.
      void runMasterBuilder(event);
    }
    if (event.type === "match_ended") {
      // Completed runs are already interred by the relay; exits stop prompting.
      matchOver = true;
      window.removeEventListener("beforeunload", warnUnload);
    }
  };

  const runMasterBuilder = async (started: { repoTree: unknown; depEdges?: unknown; probeHits?: unknown }) => {
    try {
      const graph = buildComponentGraph(
        started.repoTree as Parameters<typeof buildComponentGraph>[0],
        (started.depEdges as { from: string; to: string }[] | undefined) ?? [],
        (started.probeHits as Parameters<typeof buildComponentGraph>[2] | undefined) ?? [],
      );
      if (graph.components.length === 0 || abort.signal.aborted) return;
      // one clouded reading earns one re-read; [] is lawful silence
      let choices = await generateRepresentation({ apiKey, model, llm, graph });
      if (choices === null && !abort.signal.aborted) {
        choices = await generateRepresentation({ apiKey, model, llm, graph });
      }
      if (!choices || abort.signal.aborted) return;
      const labelOf = new Map(graph.components.map((c) => [c.id, c.label]));
      choices.forEach((choice, i) => {
        window.setTimeout(() => {
          if (abort.signal.aborted) return;
          onEvent({
            seq: 0,
            ts: Date.now(),
            type: "castle_repr",
            componentId: choice.componentId,
            form: choice.form,
            cited: choice.cited,
          } as Parameters<typeof view.onEvent>[0]);
          onEvent({
            seq: 0,
            ts: Date.now(),
            type: "log",
            level: "info",
            text: `⟡ The Master Builder decrees: ${labelOf.get(choice.componentId) ?? choice.componentId} shall stand as ${choice.form} — ${choice.cited}`,
          } as Parameters<typeof view.onEvent>[0]);
        }, 2500 + i * 1500);
      });
    } catch {
      // the Builder kept his silence; lawful defaults stand
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
    castleLedger: priorLedger,
    onEvent,
  });

  view.setStatusLine("Unearthing the record — cloning the repository…");
  try {
    const { readme, treeSummary, tree } = await settlement.start();
    view.hideOverlay();
    const brief = censusBrief(analyzeCensus(tree));
    settlement.setCensusBrief(brief); // the Worldsmith cites the measured record
    if (opts.firstOrder && !abort.signal.aborted) settlement.speak(opts.firstOrder);

    // No cached theme: divine one in the background while the session runs.
    if (!cachedTheme && !abort.signal.aborted) {
      const narrate = (text: string) =>
        onEvent({ seq: 0, ts: Date.now(), type: "log", level: "info", text });
      narrate(`⟡ The chroniclers read the record of ${repoLabel}…`);
      // Theme divination is stochastic; one clouded vision earns one re-read.
      const divine = async () => {
        const first = await generateTheme({ apiKey, model, llm, repoLabel, readme, treeSummary, censusBrief: brief });
        if (first || abort.signal.aborted) return first;
        narrate("⟡ The vision blurred — the chroniclers read the record once more…");
        return generateTheme({ apiKey, model, llm, repoLabel, readme, treeSummary, censusBrief: brief });
      };
      void divine().then(async (theme) => {
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
          // Surface the failure instead of failing silently. The land already
          // wears its census-derived form; only the bespoke dressing is lost.
          onEvent({
            seq: 0,
            ts: Date.now(),
            type: "log",
            level: "error",
            text:
              "⚠ The chroniclers could not divine this realm's bespoke theme (twice the model's answer failed validation). " +
              "The land still wears its true form — terrain, walls, and coasts are drawn from the measured code — " +
              "but custom names, liturgy, and sprites are absent. Leaving and refounding the realm rolls the bones again.",
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
