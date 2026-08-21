import { Settlement, SandboxExecutor } from "@agent-empires/runtime";
import type { ThemePack } from "@agent-empires/protocol";
import { hostMatch } from "./relay.js";
import { createMatchView } from "./match-view.js";
import { selectRenderer } from "./renderer-select.js";
import { getCachedTheme, generateTheme, repoKey } from "./themer.js";
import { analyzeCensus, censusBrief } from "./game/census.js";
import { buildComponentGraph } from "./game/components.js";
import { CastleState } from "./game/castlestate.js";
import { asLedger, type CastleLedger } from "./game/castle.js";
import {
  generateGrowthDecree,
  generateMilestoneDecree,
  generateRepresentation,
  generateTasteDecree,
  type BuilderDecree,
} from "./reprloop.js";
import { foundPurse, GROWTH_BATCH, newlySighted, PURSE_LAW, tasteRefusal, tryWake, undressed } from "./game/residency.js";

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
    onSpeak: (text, toName) => {
      // the taste channel: a decree addressed to the Builder never reaches
      // the workers — it goes to the drafting table (or is refused aloud)
      if (toName === "The Master Builder") void runTaste(text);
      else settlement?.speak(text, toName);
    },
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

  // The Builder in residence: the founding decree is free; every later wake
  // (newcomers to dress, milestones to answer) draws on the purse. The watch
  // never blocks the session; its failures fall to lawful derived dress.
  const purse = foundPurse();
  const known = new Set<string>();
  let growthQueue: string[] = [];
  let growthTimer: number | null = null;
  let builderBusy = false;
  let goldSpent = 0;
  const agentNames = new Map<string, string>();

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
        shadow.applyWrite(event.path, event.created, event.linesAdded, event.linesRemoved, event.lines);
      } else if (event.type === "component_facts") {
        shadow.applyFacts(event.path, event.hits);
      } else if (event.type === "castle_repr") {
        shadow.applyRepr(event.componentId, event.form, event.cited, event.genome);
      } else if (event.type === "castle_style") {
        shadow.applyStyle(event.style);
      } else if (event.type === "castle_flourish") {
        shadow.applyFlourish(event.path, event.mark, event.author, event.cited);
      }
    } catch (err) {
      // the shadow must never break the session — but it must confess
      console.warn("[shadow] fold failed", event.type, err);
    }
    try {
      if (event.type === "match_started" && shadow.plan) {
        // founding sockets are the founding decree's business, not the watch's
        for (const s of shadow.plan.sockets) known.add(s.componentId);
      } else if ((event.type === "file_write" || event.type === "component_facts") && shadow.plan) {
        const fresh = newlySighted(known, shadow.plan);
        for (const id of fresh) known.add(id);
        const dressable = undressed(shadow.plan, fresh);
        if (dressable.length > 0) {
          growthQueue.push(...dressable);
          scheduleGrowth();
        }
      } else if (event.type === "tokens") {
        goldSpent = event.matchTotalTokens;
      } else if (event.type === "agent_spawned") {
        agentNames.set(event.agentId, event.name);
      } else if (event.type === "agent_done") {
        void runMilestone(
          `${agentNames.get(event.agentId) ?? "a worker"} laid down the charge: ${event.summary.slice(0, 200)}`,
        );
      }
    } catch (err) {
      // the residency watch must never break the session — but it confesses
      console.warn("[watch] fold failed", event.type, err);
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

  /** Stagger a decree into the stream: the style travels first, then the
   * per-component redresses land against it. */
  const publishDecree = (
    decree: BuilderDecree,
    verbs: { style: string; choice: string },
    delays: { style: number; first: number; step: number },
  ) => {
    const labelOf = new Map((shadow.graph?.components ?? []).map((c) => [c.id, c.label]));
    if (decree.style) {
      const style = decree.style;
      window.setTimeout(() => {
        if (abort.signal.aborted) return;
        onEvent({
          seq: 0,
          ts: Date.now(),
          type: "castle_style",
          style,
        } as Parameters<typeof view.onEvent>[0]);
        onEvent({
          seq: 0,
          ts: Date.now(),
          type: "log",
          level: "info",
          text: `⟡ The Master Builder ${verbs.style} «${style.name}» — ${style.cited}`,
        } as Parameters<typeof view.onEvent>[0]);
      }, delays.style);
    }
    decree.choices.forEach((choice, i) => {
      window.setTimeout(() => {
        if (abort.signal.aborted) return;
        // genome-only choices keep the component's current form
        const form =
          choice.form ||
          shadow.plan?.sockets.find((s) => s.componentId === choice.componentId)?.form;
        if (!form) return;
        onEvent({
          seq: 0,
          ts: Date.now(),
          type: "castle_repr",
          componentId: choice.componentId,
          form,
          cited: choice.cited,
          ...(choice.genome ? { genome: choice.genome } : {}),
        } as Parameters<typeof view.onEvent>[0]);
        onEvent({
          seq: 0,
          ts: Date.now(),
          type: "log",
          level: "info",
          text: `⟡ The Master Builder ${verbs.choice}: ${labelOf.get(choice.componentId) ?? choice.componentId} shall stand as ${form}${choice.genome ? ", redressed" : ""} — ${choice.cited}`,
        } as Parameters<typeof view.onEvent>[0]);
      }, delays.first + i * delays.step);
    });
  };

  const runMasterBuilder = async (started: { repoTree: unknown; depEdges?: unknown; probeHits?: unknown }) => {
    builderBusy = true;
    try {
      const graph = buildComponentGraph(
        started.repoTree as Parameters<typeof buildComponentGraph>[0],
        (started.depEdges as { from: string; to: string }[] | undefined) ?? [],
        (started.probeHits as Parameters<typeof buildComponentGraph>[2] | undefined) ?? [],
      );
      if (graph.components.length === 0 || abort.signal.aborted) return;
      // one clouded reading earns one re-read; empty decree is lawful silence
      let decree = await generateRepresentation({ apiKey, model, llm, graph });
      if (decree === null && !abort.signal.aborted) {
        decree = await generateRepresentation({ apiKey, model, llm, graph });
      }
      if (!decree || abort.signal.aborted) return;
      publishDecree(decree, { style: "declares the style", choice: "decrees" }, { style: 1800, first: 3400, step: 1500 });
    } catch {
      // the Builder kept his silence; lawful defaults stand
    } finally {
      builderBusy = false;
    }
  };

  // Choice-by-default: a burst of new works gathers, then one purse-metered
  // wake dresses the batch. Refusals cost nothing — derived dress stands.
  const GROWTH_GATHER_MS = 15_000;
  const scheduleGrowth = (delay = GROWTH_GATHER_MS): void => {
    if (growthTimer !== null || abort.signal.aborted || matchOver) return;
    growthTimer = window.setTimeout(() => {
      growthTimer = null;
      void runGrowth();
    }, delay);
  };

  const runGrowth = async () => {
    if (abort.signal.aborted || matchOver || !shadow.plan || !shadow.graph) return;
    if (builderBusy) return scheduleGrowth();
    growthQueue = undressed(shadow.plan, [...new Set(growthQueue)]);
    if (growthQueue.length === 0) return;
    const verdict = tryWake(purse, Date.now(), goldSpent);
    if (!verdict.allowed) {
      // a debounced wake waits its turn; an empty or gold-closed purse
      // disperses the queue — derived dress is lawful, waiting is not
      if (verdict.reason === "debounce") scheduleGrowth(PURSE_LAW.debounceMs);
      else growthQueue = [];
      return;
    }
    const batch = growthQueue.slice(0, GROWTH_BATCH);
    growthQueue = growthQueue.slice(GROWTH_BATCH);
    builderBusy = true;
    try {
      const choices = await generateGrowthDecree({
        apiKey,
        model,
        llm,
        graph: shadow.graph,
        style: shadow.plan.style,
        newcomers: batch,
      });
      if (!choices || abort.signal.aborted) return;
      publishDecree({ style: null, choices }, { style: "", choice: "returns for the new works" }, { style: 0, first: 400, step: 1200 });
    } catch {
      // the Builder kept his silence; derived dress stands
    } finally {
      builderBusy = false;
      if (growthQueue.length > 0) scheduleGrowth();
    }
  };

  const runMilestone = async (milestone: string) => {
    if (abort.signal.aborted || matchOver || !shadow.plan || !shadow.graph || builderBusy) return;
    const verdict = tryWake(purse, Date.now(), goldSpent);
    if (!verdict.allowed) return;
    builderBusy = true;
    try {
      const decree = await generateMilestoneDecree({
        apiKey,
        model,
        llm,
        graph: shadow.graph,
        style: shadow.plan.style,
        milestone,
      });
      if (!decree || abort.signal.aborted) return;
      publishDecree(decree, { style: "amends the style to", choice: "revisits" }, { style: 400, first: 1600, step: 1200 });
    } catch {
      // the Builder kept his silence; what stands, stands
    } finally {
      builderBusy = false;
    }
  };

  /** The Builder speaks into the feed — the taste channel never goes mute. */
  const builderSays = (text: string) => {
    onEvent({
      seq: 0,
      ts: Date.now(),
      type: "log",
      level: "info",
      text: `🏛 The Master Builder: ${text}`,
    } as Parameters<typeof view.onEvent>[0]);
  };

  // The Crown's taste channel: a wish spoken to the Builder becomes a cited
  // amendment within the vocabulary — or a spoken, reasoned refusal. Purse-
  // metered like every other wake; refusals cost nothing.
  const runTaste = async (wish: string) => {
    if (abort.signal.aborted || matchOver || !shadow.plan || !shadow.graph) {
      console.warn("[taste] refused at the gate", {
        aborted: abort.signal.aborted,
        matchOver,
        plan: !!shadow.plan,
        graph: !!shadow.graph,
      });
      return;
    }
    if (builderBusy) {
      builderSays(tasteRefusal("debounce"));
      return;
    }
    const verdict = tryWake(purse, Date.now(), goldSpent);
    if (!verdict.allowed) {
      builderSays(tasteRefusal(verdict.reason));
      return;
    }
    builderBusy = true;
    try {
      const decree = await generateTasteDecree({
        apiKey,
        model,
        llm,
        graph: shadow.graph,
        style: shadow.plan.style,
        wish,
      });
      if (!decree || abort.signal.aborted) {
        builderSays("The veil clouded the drafting table; the castle keeps its dress.");
        return;
      }
      builderSays(decree.reply);
      if (decree.style || decree.choices.length > 0) {
        publishDecree(decree, { style: "serves the Crown with", choice: "redresses" }, { style: 600, first: 1800, step: 1200 });
      }
    } catch {
      builderSays("The veil clouded the drafting table; the castle keeps its dress.");
    } finally {
      builderBusy = false;
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
      // Theme divination is stochastic; a clouded vision earns one MEND pass —
      // the model is shown its failed answer and the exact validation issues,
      // which repairs far more reliably than a fresh roll of the same slop.
      const divine = async () => {
        const first = await generateTheme({ apiKey, model, llm, repoLabel, readme, treeSummary, censusBrief: brief });
        if (first.theme || abort.signal.aborted) return first;
        narrate("⟡ The vision blurred — the chroniclers mend the record where it tore…");
        return generateTheme({
          apiKey, model, llm, repoLabel, readme, treeSummary, censusBrief: brief,
          mend: first.candidate && first.issues ? { candidate: first.candidate, issues: first.issues } : undefined,
        });
      };
      void divine().then(async (attempt) => {
        if (abort.signal.aborted) return;
        const theme = attempt.theme;
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
          // Surface the failure WITH the reason instead of failing mutely. The
          // land already wears its census-derived form; only the dressing is lost.
          const why = (attempt.issues ?? "unknown").slice(0, 240);
          onEvent({
            seq: 0,
            ts: Date.now(),
            type: "log",
            level: "error",
            text:
              "⚠ The chroniclers could not divine this realm's bespoke theme — even the mend pass failed validation. " +
              `Where it tore: ${why}. ` +
              "The land still wears its true form (terrain, walls, and coasts are drawn from the measured code), " +
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
