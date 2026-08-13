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

const BUILDING_LABEL: Record<string, string> = {
  house: "a house",
  barracks: "a barracks",
  market: "a market",
  monastery: "a monastery",
  mill: "a mill",
  towncenter: "the Town Center",
};

export function createMatchView(
  root: HTMLElement,
  opts: { matchId: string; title: string; role: "host" | "spectator" },
): MatchView {
  root.innerHTML = `
    <div class="match-view">
      <div class="topbar">
        <a class="home-link" href="#/">⟵ Agent Empires</a>
        <span class="match-title">${escapeHtml(opts.title)}</span>
        <span class="match-id">${opts.matchId} · ${opts.role === "host" ? "you are hosting" : "spectating"}</span>
        <div class="resources">
          <span class="res gold"><span class="icon">🪙</span><span id="res-gold">0</span></span>
          <span class="res food"><span class="icon">🍖</span><span id="res-food">100%</span></span>
          <span class="res pop"><span class="icon">👥</span><span id="res-pop">0</span></span>
        </div>
      </div>
      <div class="match-body">
        <div class="game-area">
          <div id="game-mount" style="position:absolute;inset:0;"></div>
          <div id="overlay-slot"></div>
        </div>
        <div class="sidebar">
          <div class="sidebar-tabs">
            <button id="tab-herald" class="active">📜 Herald</button>
            <button id="tab-scribe">🖋 Scribe (raw)</button>
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

  el("tab-herald").onclick = () => switchTab("herald");
  el("tab-scribe").onclick = () => switchTab("scribe");
  function switchTab(tab: "herald" | "scribe") {
    heraldFeed.style.display = tab === "herald" ? "" : "none";
    scribeFeed.style.display = tab === "scribe" ? "" : "none";
    el("tab-herald").classList.toggle("active", tab === "herald");
    el("tab-scribe").classList.toggle("active", tab === "scribe");
  }

  const agentNames = new Map<string, string>();
  const contextPct = new Map<string, number>();
  let population = 0;
  let renderer: Renderer | null = null;
  let matchStats: Record<string, number> | null = null;

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
        return { cls: "system", html: `⚑ The match begins: <em>${escapeHtml(e.task.flavor)}</em>` };
      case "agent_spawned": {
        agentNames.set(e.agentId, e.name);
        population++;
        updateResources();
        const charge = e.charge ? ` — charged: “${escapeHtml(e.charge)}”` : "";
        return { cls: "system", html: `⚔ ${who(e.agentId)} enters the realm${charge}` };
      }
      case "message":
        return { cls: "herald-msg", html: `📜 ${escapeHtml(e.herald)}` };
      case "file_write": {
        const label = BUILDING_LABEL[e.buildingKind] ?? "a structure";
        const verb = e.created ? "raises" : "reinforces";
        return {
          cls: "system",
          html: `🔨 ${who(e.agentId)} ${verb} ${label} at <span class="mono">${escapeHtml(e.path)}</span> (+${e.linesAdded}/−${e.linesRemoved})`,
        };
      }
      case "command_result":
        if (e.kind === "test") {
          if ((e.testsFailed ?? 0) > 0) {
            return { cls: "battle", html: `⚔️ Battle! ${e.testsFailed} raider${e.testsFailed === 1 ? "" : "s"} at the gates — ${e.testsPassed ?? 0} banners hold.` };
          }
          return { cls: "triumph", html: `🏆 The raiders are routed! ${e.testsPassed ?? 0} tests fly green banners.` };
        }
        return null;
      case "compaction":
        return { cls: "system", html: `🍖 ${who(e.agentId)} returns to the Town Center for a meal (context compacted)` };
      case "agent_done": {
        population = Math.max(0, population - 1);
        updateResources();
        return { cls: "system", html: `🏠 ${who(e.agentId)} retires to the great hall: “${escapeHtml(e.summary)}”` };
      }
      case "match_ended": {
        matchStats = e.stats as unknown as Record<string, number>;
        return {
          cls: e.result === "victory" ? "triumph" : "battle",
          html: e.result === "victory" ? "👑 WONDER CONSTRUCTED — VICTORY!" : "🏚 The town has fallen — DEFEAT.",
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
      } else if (e.type !== "tokens" && e.type !== "context") {
        addEntry(scribeFeed, "raw", escapeHtml(compactRaw(e)));
      }
      renderer?.handleEvent(e, historical);
      if (e.type === "match_ended") {
        view.showOverlay(e.result === "victory" ? "victory" : "defeat");
      }
    },
    showOverlay(kind, detail) {
      const titles = {
        loading: "Rallying the villagers…",
        victory: "VICTORY",
        defeat: "DEFEAT",
        abandoned: "The town was abandoned",
      } as const;
      const subtitles = {
        loading: detail ?? "The King surveys the land",
        victory: "A Wonder rises over the repository.",
        defeat: "The raiders hold the walls. The tests still fail.",
        abandoned: detail ?? "The host closed the gates (tab). The chronicle survives below.",
      } as const;
      const stats = matchStats
        ? `<table class="stats-table">
            <tr><td>Gold spent (tokens)</td><td>${matchStats.goldSpent?.toLocaleString()}</td></tr>
            <tr><td>Buildings raised (files written)</td><td>${matchStats.buildingsRaised}</td></tr>
            <tr><td>Raiders slain (tests fixed)</td><td>${matchStats.raidersSlain}</td></tr>
            <tr><td>Tiles explored (files read)</td><td>${matchStats.tilesExplored}</td></tr>
            <tr><td>Match duration</td><td>${Math.round((matchStats.durationMs ?? 0) / 1000)}s</td></tr>
          </table>`
        : "";
      overlaySlot.innerHTML = `
        <div class="overlay ${kind}">
          ${kind === "loading" ? '<div class="spinner"></div>' : ""}
          <h2>${titles[kind]}</h2>
          <p class="subtitle" id="overlay-status">${escapeHtml(subtitles[kind])}</p>
          ${kind !== "loading" ? stats : ""}
          ${kind !== "loading" ? '<button onclick="location.hash=\'#/\'">Back to the Lobby</button>' : ""}
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
