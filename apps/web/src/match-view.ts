import type { GameEvent } from "@agent-empires/protocol";

export type Renderer = {
  handleEvent(e: GameEvent, historical: boolean): void;
  destroy(): void;
};

export type MatchView = {
  onEvent(e: GameEvent, historical: boolean): void;
  showOverlay(kind: "loading" | "victory" | "defeat" | "abandoned", detail?: string): void;
  hideOverlay(): void;
  setStatusLine(text: string): void;
  gameMount: HTMLElement;
  attachRenderer(r: Renderer): void;
};

export type MatchViewOptions = {
  matchId: string;
  title: string;
  role: "host" | "spectator";
  /** Host only: the Crown speaks (order or targeted message). */
  onSpeak?: (text: string, toName?: string) => void;
  /** Host only: request the settlement's patch download. */
  onPatch?: () => void;
};

const BUILDING_LABEL: Record<string, string> = {
  house: "a dwelling",
  barracks: "a bastion",
  market: "a trade-vault",
  monastery: "a sanctum",
  mill: "an engine-granary",
  towncenter: "the Citadel",
};

const PHASE_LABEL: Record<string, string> = {
  provisioning: "raising the vessel",
  cloning: "unearthing the record",
  theming: "divining the realm",
  idle: "awaiting the Crown",
  working: "the realm labors",
};

export function createMatchView(root: HTMLElement, opts: MatchViewOptions): MatchView {
  const isHost = opts.role === "host";
  root.innerHTML = `
    <div class="match-view">
      <div class="topbar">
        <a class="home-link" href="#/">⟵ Agent Empires</a>
        <span class="match-title">${escapeHtml(opts.title)}</span>
        <span class="match-id">${opts.matchId} · ${isHost ? "you are the Crown" : "spectating"}</span>
        <span class="status-chip" id="status-chip"></span>
        <div class="resources">
          <span class="res gold" title="tokens spent"><span class="icon">◆</span><span id="res-gold">0</span></span>
          <span class="res food" title="context remaining"><span class="icon">☽</span><span id="res-food">100%</span></span>
          <span class="res pop" title="agents"><span class="icon">⧉</span><span id="res-pop">0</span></span>
          ${isHost ? '<button id="patch-btn" class="patch-btn" title="Download the session diff as a .patch">⎘ Royal Decree</button>' : ""}
        </div>
      </div>
      <div class="match-body">
        <div class="game-area">
          <div id="game-mount" style="position:absolute;inset:0;"></div>
          ${isHost ? `
          <div class="command-bar">
            <select id="cmd-target"><option value="">⟡ The Realm</option></select>
            <input id="cmd-input" placeholder="Speak, and the realm obeys — issue an order or address a worker…" maxlength="2000"/>
            <button id="cmd-send">Decree</button>
          </div>` : ""}
          <div id="overlay-slot"></div>
        </div>
        <div class="sidebar">
          <div class="sidebar-tabs">
            <button id="tab-herald" class="active">◈ Herald</button>
            <button id="tab-scribe">⌘ Scribe (raw)</button>
          </div>
          <div class="feed" id="feed-herald"></div>
          <div class="feed" id="feed-scribe" style="display:none"></div>
        </div>
      </div>
    </div>`;

  const el = (id: string) => root.querySelector<HTMLElement>("#" + id)!;
  const heraldFeed = el("feed-herald");
  const scribeFeed = el("feed-scribe");
  const overlaySlot = el("overlay-slot");
  const gameMount = el("game-mount");
  const statusChip = el("status-chip");

  el("tab-herald").onclick = () => switchTab("herald");
  el("tab-scribe").onclick = () => switchTab("scribe");
  function switchTab(tab: "herald" | "scribe") {
    heraldFeed.style.display = tab === "herald" ? "" : "none";
    scribeFeed.style.display = tab === "scribe" ? "" : "none";
    el("tab-herald").classList.toggle("active", tab === "herald");
    el("tab-scribe").classList.toggle("active", tab === "scribe");
  }

  // Command bar wiring (host only)
  if (isHost && opts.onSpeak) {
    const input = root.querySelector<HTMLInputElement>("#cmd-input")!;
    const target = root.querySelector<HTMLSelectElement>("#cmd-target")!;
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      opts.onSpeak!(text, target.value || undefined);
      input.value = "";
    };
    root.querySelector<HTMLButtonElement>("#cmd-send")!.onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }
  if (isHost && opts.onPatch) {
    root.querySelector<HTMLButtonElement>("#patch-btn")!.onclick = () => opts.onPatch!();
  }

  const agentNames = new Map<string, string>();
  const activeAgents = new Set<string>();
  const contextPct = new Map<string, number>();
  let population = 0;
  let renderer: Renderer | null = null;
  let matchStats: Record<string, number> | null = null;
  let kingName = "";

  function syncTargetOptions() {
    const target = root.querySelector<HTMLSelectElement>("#cmd-target");
    if (!target) return;
    const current = target.value;
    target.innerHTML = `<option value="">⟡ The Realm${kingName ? ` (${escapeHtml(kingName)})` : ""}</option>`;
    for (const id of activeAgents) {
      const agentName = agentNames.get(id);
      if (!agentName || agentName === kingName) continue;
      const option = document.createElement("option");
      option.value = agentName;
      option.textContent = agentName;
      target.appendChild(option);
    }
    target.value = current;
  }

  function addEntry(feed: HTMLElement, cls: string, html: string) {
    const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40;
    const div = document.createElement("div");
    div.className = `entry ${cls}`;
    div.innerHTML = html;
    feed.appendChild(div);
    while (feed.children.length > 400) feed.removeChild(feed.firstChild!);
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  }

  const name = (id: string) => agentNames.get(id) ?? id;
  const who = (id: string) => `<span class="who">${escapeHtml(name(id))}</span>`;

  function updateResources() {
    const maxCtx = Math.max(0, ...contextPct.values());
    el("res-food").textContent = `${Math.max(0, 100 - Math.round(maxCtx))}%`;
    el("res-pop").textContent = String(population);
  }

  function heraldFor(e: GameEvent): { cls: string; html: string } | null {
    switch (e.type) {
      case "match_started":
        return { cls: "system", html: `⟡ The settlement is founded: <em>${escapeHtml(e.task.flavor)}</em>` };
      case "theme_ready": {
        const title = root.querySelector(".match-title");
        if (title) title.textContent = `${e.theme.factionName}`;
        return {
          cls: "triumph",
          html: `☀ The realm reveals its true face: <strong>${escapeHtml(e.theme.factionName)}</strong> — <em>${escapeHtml(e.theme.tagline)}</em>`,
        };
      }
      case "decree":
        return {
          cls: "decree",
          html: `♛ The Crown${e.toId ? ` (to ${escapeHtml(e.toId)})` : ""}: “${escapeHtml(e.text)}”`,
        };
      case "session_status":
        statusChip.textContent = PHASE_LABEL[e.phase] ?? e.phase;
        statusChip.dataset.phase = e.phase;
        return null;
      case "agent_spawned": {
        agentNames.set(e.agentId, e.name);
        activeAgents.add(e.agentId);
        if (e.role === "orchestrator") kingName = e.name;
        population++;
        updateResources();
        syncTargetOptions();
        const charge = e.charge ? ` — charged: “${escapeHtml(e.charge)}”` : "";
        return { cls: "system", html: `⧉ ${who(e.agentId)} enters the realm${charge}` };
      }
      case "message":
        return { cls: "herald-msg", html: `◈ ${escapeHtml(e.herald)}` };
      case "file_write": {
        const label = BUILDING_LABEL[e.buildingKind] ?? "a structure";
        const verb = e.created ? "raises" : "reinforces";
        return {
          cls: "system",
          html: `⚒ ${who(e.agentId)} ${verb} ${label} at <span class="mono">${escapeHtml(e.path)}</span> (+${e.linesAdded}/−${e.linesRemoved})`,
        };
      }
      case "command_result":
        if (e.kind === "test") {
          if ((e.testsFailed ?? 0) > 0) {
            return { cls: "battle", html: `⚔ ${e.testsFailed} specter${e.testsFailed === 1 ? "" : "s"} at the gates — ${e.testsPassed ?? 0} seals hold.` };
          }
          return { cls: "triumph", html: `☀ The specters are routed — ${e.testsPassed ?? 0} seals burn green.` };
        }
        return null;
      case "compaction":
        return { cls: "system", html: `☽ ${who(e.agentId)} returns to the Citadel to shed old memory` };
      case "agent_done": {
        population = Math.max(0, population - 1);
        activeAgents.delete(e.agentId);
        updateResources();
        syncTargetOptions();
        return { cls: "system", html: `⌂ ${who(e.agentId)} rests: “${escapeHtml(e.summary || "the work is done")}”` };
      }
      case "match_ended": {
        matchStats = e.stats as unknown as Record<string, number>;
        return {
          cls: e.result === "victory" ? "triumph" : "battle",
          html: e.result === "victory" ? "☀ THE BEACON IS LIT — the chronicle closes in victory." : "⚱ The chronicle closes. The settlement sleeps.",
        };
      }
      case "tokens":
        el("res-gold").textContent = e.matchTotalTokens.toLocaleString();
        return null;
      case "context":
        contextPct.set(e.agentId, (e.usedTokens / e.maxTokens) * 100);
        updateResources();
        return null;
      default:
        return null;
    }
  }

  const view: MatchView = {
    onEvent(e, historical) {
      const entry = heraldFor(e);
      if (entry) addEntry(heraldFeed, entry.cls, entry.html);
      if (e.type === "log") {
        addEntry(scribeFeed, `raw ${e.level === "error" ? "error" : ""}`, `${e.agentId ? `[${escapeHtml(name(e.agentId))}] ` : ""}${escapeHtml(e.text)}`);
      } else if (e.type !== "tokens" && e.type !== "context" && e.type !== "theme_ready") {
        addEntry(scribeFeed, "raw", escapeHtml(compactRaw(e)));
      }
      renderer?.handleEvent(e, historical);
      if (e.type === "match_ended") {
        view.showOverlay(e.result === "victory" ? "victory" : e.result === "defeat" ? "defeat" : "abandoned");
      }
    },
    showOverlay(kind, detail) {
      const titles = {
        loading: "The vessel descends…",
        victory: "THE BEACON IS LIT",
        defeat: "THE SEALS ARE BROKEN",
        abandoned: "The settlement sleeps",
      } as const;
      const subtitles = {
        loading: detail ?? "Ancient machinery wakes beneath the ash.",
        victory: "The work is done; the record endures.",
        defeat: "The specters hold the walls. The tests still fail.",
        abandoned: detail ?? "The Crown departed. The chronicle survives below.",
      } as const;
      const stats = matchStats
        ? `<table class="stats-table">
            <tr><td>Tokens spent</td><td>${matchStats.goldSpent?.toLocaleString()}</td></tr>
            <tr><td>Structures raised (files written)</td><td>${matchStats.buildingsRaised}</td></tr>
            <tr><td>Specters banished (tests fixed)</td><td>${matchStats.raidersSlain}</td></tr>
            <tr><td>Ground surveyed (files read)</td><td>${matchStats.tilesExplored}</td></tr>
            <tr><td>Session length</td><td>${Math.round((matchStats.durationMs ?? 0) / 1000)}s</td></tr>
          </table>`
        : "";
      overlaySlot.innerHTML = `
        <div class="overlay ${kind}">
          ${kind === "loading" ? '<div class="spinner"></div>' : ""}
          <h2>${titles[kind]}</h2>
          <p class="subtitle" id="overlay-status">${escapeHtml(subtitles[kind])}</p>
          ${kind !== "loading" ? stats : ""}
          ${kind !== "loading" ? '<button onclick="location.hash=\'#/\'">Return to the Threshold</button>' : ""}
        </div>`;
    },
    hideOverlay() {
      overlaySlot.innerHTML = "";
    },
    setStatusLine(text) {
      const status = overlaySlot.querySelector("#overlay-status");
      if (status) status.textContent = text;
    },
    gameMount,
    attachRenderer(r) {
      renderer = r;
    },
  };
  return view;
}

function compactRaw(e: GameEvent): string {
  const { seq: _s, ts: _t, ...rest } = e as Record<string, unknown>;
  let text = JSON.stringify(rest);
  if (text.length > 300) text = text.slice(0, 300) + "…";
  return text;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
