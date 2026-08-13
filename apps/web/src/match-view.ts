import type { GameEvent } from "@agent-empires/protocol";

export type Renderer = {
  handleEvent(e: GameEvent, historical: boolean): void;
  destroy(): void;
  /** Optional: the view supplies a callback for "inspect this file" gestures in-world. */
  setInspectHandler?(cb: (path: string) => void): void;
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
  /** Host only: fetch the current session patch text for the Works viewer. */
  onViewPatch?: () => Promise<string>;
  /** Host only: read a file's current contents from the sandbox for the Inspect panel. */
  onReadFile?: (path: string) => Promise<string>;
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
            <button id="tab-works">⚒ Works <span id="works-badge" class="works-badge" style="display:none">0</span></button>
            <button id="tab-scribe">⌘ Scribe (raw)</button>
          </div>
          <div class="feed" id="feed-herald"></div>
          <div class="feed" id="feed-works" style="display:none">
            <p class="empty-note" id="works-empty">No stone has yet been laid. Changed files appear here.</p>
            <div id="works-list"></div>
            ${isHost ? '<button id="works-patch-btn" class="works-patch-btn">⎘ Unroll the scrolls (view full patch)</button>' : ""}
          </div>
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

  const worksFeed = el("feed-works");
  el("tab-herald").onclick = () => switchTab("herald");
  el("tab-works").onclick = () => switchTab("works");
  el("tab-scribe").onclick = () => switchTab("scribe");
  function switchTab(tab: "herald" | "works" | "scribe") {
    heraldFeed.style.display = tab === "herald" ? "" : "none";
    worksFeed.style.display = tab === "works" ? "" : "none";
    scribeFeed.style.display = tab === "scribe" ? "" : "none";
    el("tab-herald").classList.toggle("active", tab === "herald");
    el("tab-works").classList.toggle("active", tab === "works");
    el("tab-scribe").classList.toggle("active", tab === "scribe");
  }

  // The page must never scroll under the match view; the feeds scroll instead.
  window.scrollTo(0, 0);

  // --- Works ledger: every changed file, live -------------------------------
  type Work = { writes: number; added: number; removed: number; by: string; created: boolean; snippets: string[] };
  const works = new Map<string, Work>();
  function recordWork(e: Extract<GameEvent, { type: "file_write" }>) {
    const w = works.get(e.path) ?? { writes: 0, added: 0, removed: 0, by: "", created: false, snippets: [] };
    w.writes++;
    w.added += e.linesAdded;
    w.removed += e.linesRemoved;
    w.by = name(e.agentId);
    w.created ||= e.created;
    if (e.diffSnippet) {
      w.snippets.push(e.diffSnippet);
      if (w.snippets.length > 10) w.snippets.shift();
    }
    works.set(e.path, w);
    el("works-empty").style.display = "none";
    const badge = el("works-badge");
    badge.style.display = "";
    badge.textContent = String(works.size);
    el("works-list").innerHTML = [...works.entries()]
      .map(
        ([path, w]) => `<div class="work-row" data-path="${escapeHtml(path)}" title="Open the scrolls for this file">
          <span class="mono">${escapeHtml(path)}</span>
          <span class="work-stat">${w.created ? "✦ new · " : ""}${w.writes}×, <span class="add">+${w.added}</span>/<span class="del">−${w.removed}</span> — ${escapeHtml(w.by)}</span>
        </div>`,
      )
      .join("");
    el("works-list")
      .querySelectorAll<HTMLElement>(".work-row")
      .forEach((row) => (row.onclick = () => void openInspect(row.dataset.path!)));
  }

  // --- Inspect panel: the actual code, per file ------------------------------
  function diffHtml(snippet: string): string {
    return snippet
      .split("\n")
      .map((line) => {
        const esc = escapeHtml(line);
        if (line.startsWith("+")) return `<span class="dl-add">${esc}</span>`;
        if (line.startsWith("-") || line.startsWith("−")) return `<span class="dl-del">${esc}</span>`;
        if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
          return `<span class="dl-hunk">${esc}</span>`;
        }
        return esc;
      })
      .join("\n");
  }

  function fileDiffFrom(patch: string, path: string): string {
    const parts = patch.split(/^diff --git /m).filter((p) => p.trim());
    const hit = parts.find((p) => p.startsWith(`a/${path} `) || p.includes(` b/${path}\n`));
    return hit ? "diff --git " + hit : "";
  }

  async function openInspect(path: string) {
    const modal = document.createElement("div");
    modal.className = "patch-modal";
    modal.innerHTML = `<div class="patch-modal-inner inspect">
      <button class="patch-close">✕ seal</button>
      <h3 class="inspect-title mono">${escapeHtml(path)}</h3>
      <div class="inspect-cols">
        <section><h4>⚒ Session changes</h4><pre class="diff" id="ins-diff">consulting the scribes…</pre></section>
        <section><h4>⌕ Source as it stands</h4><pre id="ins-src">…</pre></section>
      </div>
    </div>`;
    root.querySelector(".match-view")!.appendChild(modal);
    modal.querySelector<HTMLButtonElement>(".patch-close")!.onclick = () => modal.remove();
    const diffPre = modal.querySelector<HTMLElement>("#ins-diff")!;
    const srcPre = modal.querySelector<HTMLElement>("#ins-src")!;

    const w = works.get(path);
    const fallback = w?.snippets.length
      ? diffHtml(w.snippets.join("\n· · ·\n"))
      : "No recorded changes to this file this session.";
    if (isHost && opts.onViewPatch) {
      try {
        const patch = await opts.onViewPatch();
        const own = fileDiffFrom(patch, path);
        diffPre.innerHTML = own ? diffHtml(own) : fallback;
      } catch {
        diffPre.innerHTML = fallback;
      }
    } else {
      diffPre.innerHTML = fallback;
    }

    if (isHost && opts.onReadFile) {
      try {
        const src = await opts.onReadFile(path);
        srcPre.textContent = src || "(empty file)";
      } catch (err) {
        srcPre.textContent = `The scroll resists: ${String(err)}`;
      }
    } else {
      srcPre.textContent = "Only the Crown may unroll the source itself; spectators see the recorded changes.";
    }
  }
  if (isHost && opts.onViewPatch) {
    el("works-patch-btn").onclick = async () => {
      const modal = document.createElement("div");
      modal.className = "patch-modal";
      modal.innerHTML = `<div class="patch-modal-inner"><button class="patch-close">✕ seal</button><pre>consulting the scribes…</pre></div>`;
      root.querySelector(".match-view")!.appendChild(modal);
      modal.querySelector<HTMLButtonElement>(".patch-close")!.onclick = () => modal.remove();
      try {
        const patch = await opts.onViewPatch!();
        modal.querySelector("pre")!.textContent = patch.trim() || "No changes yet — the land lies as it was found.";
      } catch (err) {
        modal.querySelector("pre")!.textContent = `The scrolls resist: ${String(err)}`;
      }
    };
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
    div.querySelectorAll<HTMLElement>("[data-inspect]").forEach((n) => {
      n.onclick = () => void openInspect(n.dataset.inspect!);
    });
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
      case "message": {
        const speaker = e.fromId === "crown" ? "The Crown" : name(e.fromId);
        const flavor = e.herald && e.herald !== e.text ? `<em class="liturgy">${escapeHtml(e.herald)}</em><br/>` : "";
        return { cls: "herald-msg", html: `◈ <span class="who">${escapeHtml(speaker)}</span>: ${flavor}${escapeHtml(e.text)}` };
      }
      case "log":
        if (e.level === "error") return { cls: "battle", html: `⚠ ${escapeHtml(e.text.slice(0, 300))}` };
        // chronicler narration (world-generation loading lines) reads "⟡ …"
        if (e.level === "info" && e.text.startsWith("⟡")) {
          return { cls: "system", html: escapeHtml(e.text.slice(0, 300)) };
        }
        return null;
      case "file_write": {
        const label = BUILDING_LABEL[e.buildingKind] ?? "a structure";
        const verb = e.created ? "raises" : "reinforces";
        const snip = e.diffSnippet
          ? `<details class="diff-details"><summary>⌕ view the change</summary><pre class="diff">${diffHtml(e.diffSnippet)}</pre></details>`
          : "";
        return {
          cls: "system",
          html: `⚒ ${who(e.agentId)} ${verb} ${label} at <span class="mono work-link" data-inspect="${escapeHtml(e.path)}">${escapeHtml(e.path)}</span> (+${e.linesAdded}/−${e.linesRemoved})${snip}`,
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
      if (e.type === "file_write") recordWork(e);
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
      r.setInspectHandler?.((path) => void openInspect(path));
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
