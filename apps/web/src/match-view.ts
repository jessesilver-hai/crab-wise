import {
  BountyLedger,
  SkillBook,
  SKILLS,
  examineLine,
  districtArchetype,
  type DistrictArchetype,
  type FileNode,
  type GameEvent,
  type SkillName,
  type SkillStats,
} from "@agent-empires/protocol";

export type Renderer = {
  handleEvent(e: GameEvent, historical: boolean): void;
  destroy(): void;
  /** Optional: the view supplies a callback for "inspect this file" gestures in-world. */
  setInspectHandler?(cb: (path: string) => void): void;
  /** Optional: the view supplies a callback for "speak to this agent" gestures in-world. */
  setSpeakHandler?(cb: (agentId: string) => void): void;
  /** Optional: real command verbs — right-click a building (attend file) or raider (hunt test). */
  setOrderHandler?(cb: (kind: "attend" | "hunt", target: string, agentId?: string) => void): void;
  /** Optional OSRS feel layer. */
  showXpDrop?(agentId: string, skill: string, xp: number, color?: number): void;
  showLevelUp?(agentId: string, skill: string, level: number): void;
  setSkillStats?(agentId: string, stats: SkillStats): void;
  setExamineProvider?(fn: (kind: "building" | "unit" | "raider" | "hook", id: string) => string | undefined): void;
  setExamineHandler?(cb: (text: string) => void): void;
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
  /** Host only: the Crown addresses one agent face to face. */
  onSpeakTo?: (agentId: string, text: string) => void;
  /** Host only: real command verbs from the map (attend a file / hunt a test). */
  onOrder?: (kind: "attend" | "hunt", target: string, agentId?: string) => void;
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
          <span class="res renown" title="renown earned (bounties cleared)"><span class="icon">☨</span><span id="res-renown">0</span></span>
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
            <button id="tab-bounties">☨ Bounties <span id="bounty-badge" class="works-badge" style="display:none">0</span></button>
            <button id="tab-satchel">❧ Satchel <span id="satchel-badge" class="works-badge" style="display:none">0</span></button>
            <button id="tab-scribe">⌘ Scribe</button>
          </div>
          <div class="feed" id="feed-herald"></div>
          <div class="feed" id="feed-satchel" style="display:none">
            <p class="empty-note" id="satchel-empty">The satchel is empty. Ask the realm to SHOW you something — a report, a chart, a chronicle — and the scroll lands here.</p>
            <div id="satchel-list"></div>
          </div>
          <div class="feed" id="feed-works" style="display:none">
            <p class="empty-note" id="works-empty">No stone has yet been laid. Changed files appear here.</p>
            <div id="works-list"></div>
            ${isHost ? '<button id="works-patch-btn" class="works-patch-btn">⎘ Unroll the scrolls (view full patch)</button>' : ""}
          </div>
          <div class="feed" id="feed-bounties" style="display:none">
            <p class="empty-note" id="bounties-empty">No bounties posted. The first test run names the specters, and each carries a price in renown.</p>
            <div id="bounty-list"></div>
          </div>
          <div class="feed" id="feed-scribe" style="display:none"></div>
          <div id="status-strip"></div>
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
  const bountyFeed = el("feed-bounties");
  const satchelFeed = el("feed-satchel");
  el("tab-herald").onclick = () => switchTab("herald");
  el("tab-works").onclick = () => switchTab("works");
  el("tab-bounties").onclick = () => switchTab("bounties");
  el("tab-satchel").onclick = () => switchTab("satchel");
  el("tab-scribe").onclick = () => switchTab("scribe");
  function switchTab(tab: "herald" | "works" | "bounties" | "satchel" | "scribe") {
    heraldFeed.style.display = tab === "herald" ? "" : "none";
    worksFeed.style.display = tab === "works" ? "" : "none";
    bountyFeed.style.display = tab === "bounties" ? "" : "none";
    satchelFeed.style.display = tab === "satchel" ? "" : "none";
    scribeFeed.style.display = tab === "scribe" ? "" : "none";
    el("tab-herald").classList.toggle("active", tab === "herald");
    el("tab-works").classList.toggle("active", tab === "works");
    el("tab-bounties").classList.toggle("active", tab === "bounties");
    el("tab-satchel").classList.toggle("active", tab === "satchel");
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

  // --- Bounty board: failing tests carry a price in renown -------------------
  const ledger = new BountyLedger();

  // --- Skills: agents earn XP from real deeds --------------------------------
  const skills = new SkillBook();
  const pathLines = new Map<string, number>();
  const dirArch = new Map<string, DistrictArchetype>();
  function indexTree(root: FileNode): void {
    for (const top of root.children ?? []) {
      if (top.kind === "dir") {
        dirArch.set(top.name, districtArchetype(top.name, (top.children ?? []).filter((c) => c.kind === "file").map((c) => c.name)));
      }
    }
    (function walk(n: FileNode) {
      if (n.kind === "file" && n.lines !== undefined) pathLines.set(n.path, n.lines);
      (n.children ?? []).forEach(walk);
    })(root);
  }
  function grantVisuals(drops: { agentId: string; skill: SkillName; xp: number; leveledTo?: number }[], historical: boolean) {
    for (const d of drops) {
      renderer?.setSkillStats?.(d.agentId, skills.stats(d.agentId));
      if (historical) continue;
      renderer?.showXpDrop?.(d.agentId, d.skill, d.xp, SKILLS[d.skill]);
      if (d.leveledTo) {
        renderer?.showLevelUp?.(d.agentId, d.skill, d.leveledTo);
        addEntry(heraldFeed, "triumph", `⚔ ${escapeHtml(name(d.agentId))} has advanced <strong>${d.skill}</strong> to level <strong>${d.leveledTo}</strong>!`);
      }
    }
  }
  function agentIdByName(agentName: string): string | undefined {
    for (const [id, n] of agentNames) if (n === agentName) return id;
    return undefined;
  }

  function renderBounties() {
    const bounties = ledger.bounties;
    if (bounties.length === 0) return;
    el("bounties-empty").style.display = "none";
    const open = bounties.filter((b) => b.status === "posted").length;
    const badge = el("bounty-badge");
    badge.style.display = "";
    badge.textContent = String(open);
    el("bounty-list").innerHTML =
      `<div class="quest-points">✦ Quest Points: ${bounties.filter((b) => b.status === "cleared").length}</div>` +
      bounties
        .map(
        (b) => `<div class="bounty-row ${b.status}">
          <span class="bounty-name mono">${escapeHtml(b.name)}</span>
          <span class="bounty-meta">${
            b.status === "cleared"
              ? `✓ claimed by ${escapeHtml(b.clearedBy ?? "unknown hands")} · +${b.value}`
              : `☨ ${b.value} renown`
          }</span>
        </div>`,
        )
        .join("");
    el("res-renown").textContent = String(ledger.summary().renown);
  }
  function applyBounties(e: GameEvent, historical: boolean): void {
    const { postedNow, clearedNow } = ledger.apply(e);
    if (postedNow.length > 0) {
      const total = postedNow.reduce((s, b) => s + b.value, 0);
      addEntry(
        heraldFeed,
        "battle",
        `☨ The bounty board fills: <strong>${postedNow.length}</strong> specter${postedNow.length === 1 ? "" : "s"} named, ${total} renown at stake. <span class="dim">(see ☨ Bounties)</span>`,
      );
    }
    for (const b of clearedNow) {
      addEntry(
        heraldFeed,
        "triumph",
        `☨ Bounty claimed — <span class="mono">${escapeHtml(b.name)}</span> falls to ${escapeHtml(b.clearedBy ?? "unknown hands")} <strong>(+${b.value} renown)</strong>`,
      );
      const slayer = b.clearedBy && agentIdByName(b.clearedBy);
      if (slayer) grantVisuals([skills.grant(slayer, "Slaying", 150)], historical);
    }
    if (postedNow.length > 0 || clearedNow.length > 0 || e.type === "tokens") renderBounties();
  }

  // --- Inspect panel: the actual code, per file ------------------------------
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

  // --- Satchel: scrolls the realm inscribes for the Crown --------------------
  type Scroll = Extract<GameEvent, { type: "scroll" }>;
  const scrolls = new Map<string, Scroll>();
  function recordScroll(e: Scroll) {
    scrolls.set(e.scrollId, e);
    el("satchel-empty").style.display = "none";
    const badge = el("satchel-badge");
    badge.style.display = "";
    badge.textContent = String(scrolls.size);
    el("satchel-list").innerHTML = [...scrolls.values()]
      .map(
        (s) => `<div class="scroll-row" data-scroll="${escapeHtml(s.scrollId)}" title="Unroll this scroll">
          <span class="scroll-icon">${s.format === "svg" ? "◫" : "❧"}</span>
          <span class="scroll-title">${escapeHtml(s.title)}</span>
          <span class="scroll-by">${escapeHtml(s.authorName)}</span>
        </div>`,
      )
      .join("");
    el("satchel-list")
      .querySelectorAll<HTMLElement>(".scroll-row")
      .forEach((row) => (row.onclick = () => openScroll(row.dataset.scroll!)));
  }
  function openScroll(scrollId: string) {
    const s = scrolls.get(scrollId);
    if (!s) return;
    const modal = document.createElement("div");
    modal.className = "patch-modal";
    const body =
      s.format === "svg"
        ? svgThreatScan(s.content)
          ? `<div class="scroll-svg">${sanitizeSvgDom(s.content) ?? "<p>(the diagram would not resolve)</p>"}</div>`
          : "<p>(this scroll carried forbidden sigils and was burned)</p>"
        : `<div class="scroll-md">${mdMini(s.content)}</div>`;
    modal.innerHTML = `<div class="patch-modal-inner scroll-inner">
      <button class="patch-close">✕ seal</button>
      <h3 class="scroll-heading">❧ ${escapeHtml(s.title)}</h3>
      <p class="scroll-attrib">inscribed by ${escapeHtml(s.authorName)}</p>
      ${body}
      <button class="scroll-keep">⎘ keep (download)</button>
    </div>`;
    root.querySelector(".match-view")!.appendChild(modal);
    modal.querySelector<HTMLButtonElement>(".patch-close")!.onclick = () => modal.remove();
    modal.querySelector<HTMLButtonElement>(".scroll-keep")!.onclick = () => {
      const blob = new Blob([s.content], { type: s.format === "svg" ? "image/svg+xml" : "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${s.title.replace(/[^\w-]+/g, "_").slice(0, 60)}.${s.format === "svg" ? "svg" : "md"}`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  // --- Dialogue: the Crown face to face with one agent ------------------------
  type DialogueEntry = { from: "crown" | "agent"; text: string };
  const dialogues = new Map<string, { name: string; entries: DialogueEntry[] }>();
  let dialogueOpenFor: string | null = null;
  function appendDialogue(e: Extract<GameEvent, { type: "dialogue" }>) {
    const d = dialogues.get(e.agentId) ?? { name: e.agentName, entries: [] };
    d.name = e.agentName;
    d.entries.push({ from: e.from, text: e.text });
    if (d.entries.length > 60) d.entries.shift();
    dialogues.set(e.agentId, d);
    if (dialogueOpenFor === e.agentId) renderDialogueThread(e.agentId);
  }
  function renderDialogueThread(agentId: string) {
    const thread = root.querySelector<HTMLElement>("#dlg-thread");
    if (!thread) return;
    const d = dialogues.get(agentId);
    thread.innerHTML = (d?.entries ?? [])
      .map((m) => `<div class="dlg-line ${m.from}">${m.from === "crown" ? "♛" : "◈"} ${escapeHtml(m.text)}</div>`)
      .join("");
    thread.scrollTop = thread.scrollHeight;
  }
  function openDialogue(agentId: string) {
    root.querySelector("#dialogue-panel")?.remove();
    dialogueOpenFor = agentId;
    const d = dialogues.get(agentId);
    const agentName = d?.name ?? agentNames.get(agentId) ?? agentId;
    const panel = document.createElement("div");
    panel.id = "dialogue-panel";
    panel.innerHTML = `
      <div class="dlg-head"><span>🗨 ${escapeHtml(agentName)}</span><button class="dlg-close">✕</button></div>
      <div id="dlg-thread"></div>
      ${
        isHost && opts.onSpeakTo
          ? '<div class="dlg-input"><input id="dlg-text" maxlength="2000" placeholder="Speak to them directly…"/><button id="dlg-send">Speak</button></div>'
          : '<p class="dlg-note">Only the Crown may speak; you are hearing the exchange.</p>'
      }`;
    root.querySelector(".game-area")!.appendChild(panel);
    panel.querySelector<HTMLButtonElement>(".dlg-close")!.onclick = () => {
      dialogueOpenFor = null;
      panel.remove();
    };
    const input = panel.querySelector<HTMLInputElement>("#dlg-text");
    if (input && opts.onSpeakTo) {
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        opts.onSpeakTo!(agentId, text);
        input.value = "";
      };
      panel.querySelector<HTMLButtonElement>("#dlg-send")!.onclick = submit;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      input.focus();
    }
    renderDialogueThread(agentId);
  }

  // --- Status strip: what every laboring agent is doing right now -------------
  const liveStatus = new Map<string, { name: string; text: string }>();
  function updateStatusStrip(e: Extract<GameEvent, { type: "agent_status" }>, historical: boolean) {
    if (historical) return;
    const busy = e.status === "thinking" || e.status === "scouting" || e.status === "building" || e.status === "fighting";
    if (!busy) liveStatus.delete(e.agentId);
    else {
      const label = e.detail ?? (e.status === "thinking" ? "ponders" : e.status);
      liveStatus.set(e.agentId, { name: name(e.agentId), text: label });
    }
    updateStatusStripRender();
  }
  function updateStatusStripRender() {
    el("status-strip").innerHTML = [...liveStatus.values()]
      .slice(-4)
      .map((s) => `<div class="status-line"><span class="pulse">✦</span> <span class="who">${escapeHtml(s.name)}</span> ${escapeHtml(s.text)}</div>`)
      .join("");
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
    div.querySelectorAll<HTMLElement>("[data-scroll]").forEach((n) => {
      n.onclick = () => openScroll(n.dataset.scroll!);
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
      case "scroll":
        return {
          cls: "triumph",
          html: `❧ ${escapeHtml(e.authorName)} inscribes a scroll — <strong class="scroll-open" data-scroll="${escapeHtml(e.scrollId)}">“${escapeHtml(e.title)}”</strong> <span class="dim">(kept in the ❧ Satchel)</span>`,
        };
      case "dialogue":
        return {
          cls: "decree",
          html:
            e.from === "crown"
              ? `🗨 The Crown, to ${escapeHtml(e.agentName)}: “${escapeHtml(e.text)}”`
              : `🗨 ${escapeHtml(e.agentName)}, to The Crown: “${escapeHtml(e.text)}”`,
        };
      case "theme_patch": {
        const hooks = e.patch.questHooks?.length
          ? ` <span class="dim">· ${e.patch.questHooks.length} old inscription${e.patch.questHooks.length === 1 ? "" : "s"} unearthed</span>`
          : "";
        return {
          cls: "system",
          html: `⟡ The land deepens: <strong>${escapeHtml(e.patch.name)}</strong> — <em>${escapeHtml(e.patch.epithet)}</em>${hooks}`,
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
      applyBounties(e, historical);
      if (e.type === "match_started") indexTree(e.repoTree);
      grantVisuals(skills.apply(e), historical);
      if (e.type === "file_write") recordWork(e);
      if (e.type === "scroll") recordScroll(e);
      if (e.type === "dialogue") appendDialogue(e);
      if (e.type === "agent_status") updateStatusStrip(e, historical);
      if (e.type === "agent_done") {
        liveStatus.delete(e.agentId);
        el("status-strip").querySelectorAll(".status-line").length && updateStatusStripRender();
      }
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
      const legend = ledger.summary();
      const stats = matchStats
        ? `<p class="legend-title">☨ ${escapeHtml(legend.title)} — ${legend.renown} renown${
            legend.bountiesPosted > 0 ? ` · ${legend.bountiesCleared}/${legend.bountiesPosted} bounties claimed` : ""
          }</p>
          <table class="stats-table">
            <tr><td>Renown earned</td><td>${legend.renown}</td></tr>
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
      r.setSpeakHandler?.((agentId) => openDialogue(agentId));
      if (opts.onOrder) r.setOrderHandler?.((kind, target, agentId) => opts.onOrder!(kind, target, agentId));
      r.setExamineProvider?.((kind, id) => {
        if (id === "__towncenter__") return "The Citadel — seat of the Crown. All roads lead here.";
        if (kind === "building" || kind === "hook") {
          return examineLine(id, pathLines.get(id), dirArch.get(id.split("/")[0]!) ?? "quarter");
        }
        if (kind === "unit") {
          const st = skills.stats(id);
          const tops = st.top.map(([s, l]) => `${s} ${l}`).join(", ");
          return `${name(id)} — a loyal hand of the realm. Total level ${st.total}.${tops ? ` (${tops})` : ""}`;
        }
        if (kind === "raider") return `${id} — a specter risen from failing trials. Slaying it pays renown.`;
        return undefined;
      });
      r.setExamineHandler?.((text) => addEntry(heraldFeed, "dim", `✦ ${escapeHtml(text)}`));
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

/** Color-code a ±-prefixed snippet or unified diff for HTML display. */
export function diffHtml(snippet: string): string {
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

/** Extract one file's section from a full unified git diff. */
export function fileDiffFrom(patch: string, path: string): string {
  const parts = patch.split(/^diff --git /m).filter((p) => p.trim());
  const hit = parts.find((p) => p.startsWith(`a/${path} `) || p.includes(` b/${path}\n`));
  return hit ? "diff --git " + hit : "";
}

/**
 * Pure-string threat scan for agent-authored SVG scrolls; runs before the
 * DOM pass so it is testable in node. Reject = burn the scroll.
 */
export function svgThreatScan(src: string): boolean {
  if (!/^\s*<svg[\s>]/i.test(src)) return false;
  const lower = src.toLowerCase();
  const forbidden = ["<script", "<foreignobject", "<iframe", "<embed", "<object", "javascript:", "data:text/html", "<!entity", "<!doctype"];
  if (forbidden.some((f) => lower.includes(f))) return false;
  if (/\son[a-z]+\s*=/i.test(src)) return false;
  return true;
}

/** DOM-level sanitize: parse as SVG, strip event handlers and external refs. */
function sanitizeSvgDom(src: string): string | null {
  const doc = new DOMParser().parseFromString(src, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.tagName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
  for (const node of [...svg.querySelectorAll("script,foreignObject,iframe,embed,object")]) node.remove();
  const walk = (el: Element) => {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim().toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(attr.name);
      else if ((n === "href" || n === "xlink:href") && v && !v.startsWith("#")) el.removeAttribute(attr.name);
    }
    for (const child of [...el.children]) walk(child);
  };
  walk(svg);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("style", "max-width:100%;height:auto");
  return svg.outerHTML;
}

/** Tiny markdown renderer for scrolls: escape-first, then a safe subset. */
export function mdMini(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) out.push(`<ul>${listBuf.map((li) => `<li>${li}</li>`).join("")}</ul>`);
    listBuf = [];
  };
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        out.push(`<pre class="md-code">${escapeHtml(codeBuf.join("\n"))}</pre>`);
        codeBuf = [];
      } else flushList();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList();
      out.push(`<p class="md-h${h[1]!.length}">${inline(h[2]!)}</p>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      listBuf.push(inline(line.replace(/^\s*[-*]\s+/, "")));
      continue;
    }
    flushList();
    if (line.includes("|") && line.trim().length > 1) {
      out.push(`<div class="md-row mono">${inline(line)}</div>`);
      continue;
    }
    if (line.trim() === "") out.push("");
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre class="md-code">${escapeHtml(codeBuf.join("\n"))}</pre>`);
  flushList();
  return out.join("\n");
}
