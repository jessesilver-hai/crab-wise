import { TASKS } from "@agent-empires/tasks";
import { fetchMatches } from "./relay.js";
import { startSettlement } from "./host.js";
import { startDemoMatch } from "./demo.js";
import { escapeHtml } from "./match-view.js";
import type { HallEntry, MatchSummary } from "@agent-empires/protocol";

const KEY_STORAGE = "agent-empires-api-key";

export function renderLobby(root: HTMLElement): void {
  const savedKey = localStorage.getItem(KEY_STORAGE) ?? "";
  root.innerHTML = `
    <div class="lobby">
      <div class="hero">
        <h1>AGENT EMPIRES</h1>
        <p class="tagline">Point it at a repository. A civilization wakes upon the code —
        agents labor, specters rise from failing tests, and you rule it all by decree.</p>
        <div class="rule"></div>
      </div>
      <div class="lobby-grid">
        <div class="panel" id="found-panel">
          <h2>Found a Settlement</h2>
          <div class="form-row">
            <input id="repo-url" type="text" placeholder="paste a public repo URL and press Enter — the Crown funds the rest" />
          </div>
          <div class="error-note" id="start-error"></div>
          <div class="sample-label">— or touch a world and it wakes —</div>
          <div id="sample-list"></div>
          <div class="sample-label">— common grounds —</div>
          <div id="common-list"></div>
          <details class="advanced">
            <summary>Advanced — bring your own Anthropic key (Claude)</summary>
            <div class="form-row">
              <label>Anthropic API key</label>
              <input id="api-key" type="password" placeholder="sk-ant-… (never leaves your browser)" value="${escapeHtml(savedKey)}" />
              <div class="key-note">
                By default the Crown pays for inference (Grok 4.6 via OpenRouter) — no key needed.
                With your key, only tool calls travel to the sandbox.
                <label style="display:inline"><input id="remember-key" type="checkbox" style="width:auto" ${savedKey ? "checked" : ""}/> remember key in this browser</label>
              </div>
            </div>
            <div class="form-row">
              <label>Model</label>
              <select id="model">
                <option value="">Grok 4.6 — Crown-funded, no key needed</option>
                <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (your key)</option>
                <option value="claude-haiku-4-5">Claude Haiku 4.5 (your key, scrappier workers)</option>
              </select>
            </div>
          </details>
          <button id="demo-btn" class="demo-link">◉ Watch a Demo (no key, no repo)</button>
        </div>
        <div class="panel">
          <h2>Living Settlements</h2>
          <div id="live-list"><p class="empty-note">Consulting the watchtower…</p></div>
          <h2 style="margin-top:1.5rem">The Chronicle</h2>
          <div id="finished-list"><p class="empty-note">No records yet.</p></div>
          <h2 style="margin-top:1.5rem">☨ Hall of Legends</h2>
          <div id="hall-list"><p class="empty-note">No legends yet. Clear bounties — fix failing tests — and be remembered.</p></div>
        </div>
      </div>
      <p class="footer-note">
        Real software-engineering agents, rendered as an ancient-future strategy chronicle.<br/>
        Sessions run in isolated sandboxes · themes are divined per repository · your key stays client-side ·
        <a href="/assets/3d/LICENSES.md" target="_blank" rel="noopener">3D art credits (KayKit, CC0)</a> · <a href="/assets/iso/LICENSES.md" target="_blank" rel="noopener">pixel art credits</a>
      </p>
    </div>`;

  // Paste-or-pick: any card is a launch button; Enter in the URL field goes.
  const errorNote = root.querySelector<HTMLElement>("#start-error")!;
  const repoInput = root.querySelector<HTMLInputElement>("#repo-url")!;
  const foundPanel = root.querySelector<HTMLElement>("#found-panel")!;
  let starting = false;

  function begin(repoUrl: string, repoLabel: string, firstOrder?: string) {
    if (starting) return;
    const key = root.querySelector<HTMLInputElement>("#api-key")!.value.trim();
    const model = root.querySelector<HTMLSelectElement>("#model")!.value;
    const remember = root.querySelector<HTMLInputElement>("#remember-key")!.checked;
    if (key && !key.startsWith("sk-ant-")) {
      errorNote.textContent = "That does not look like an Anthropic API key (sk-ant-…).";
      root.querySelector<HTMLDetailsElement>(".advanced")!.open = true;
      return;
    }
    if (model && !key) {
      errorNote.textContent = "Claude models need your Anthropic key — or clear the model to ride Crown-funded Grok.";
      root.querySelector<HTMLDetailsElement>(".advanced")!.open = true;
      return;
    }
    if (remember) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);

    starting = true;
    errorNote.textContent = "";
    foundPanel.classList.add("starting");
    startSettlement(document.getElementById("app")!, { repoUrl, repoLabel, apiKey: key, model, firstOrder }).catch(
      (err) => {
        errorNote.textContent = String(err);
        starting = false;
        foundPanel.classList.remove("starting");
      },
    );
  }

  repoInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const typedUrl = repoInput.value.trim().replace(/\.git$/, "");
    if (!/^https:\/\/[\w.-]+\/[\w.~/-]+$/.test(typedUrl)) {
      errorNote.textContent = "Enter a public https git URL, or touch a world below.";
      return;
    }
    begin(typedUrl, typedUrl.split("/").slice(-2).join("/"));
  });

  const sampleList = root.querySelector<HTMLElement>("#sample-list")!;
  sampleList.innerHTML = TASKS.map(
    (t) => `
    <div class="task-card" data-id="${t.id}">
      <div class="t-title">${escapeHtml(t.title)}</div>
      <div class="t-flavor">${escapeHtml(t.flavor)}</div>
      <div class="t-go">⟡ wake this world</div>
    </div>`,
  ).join("");
  for (const card of sampleList.querySelectorAll<HTMLElement>(".task-card")) {
    card.onclick = () => {
      const t = TASKS.find((x) => x.id === card.dataset.id)!;
      begin(`sample:${t.id}`, t.title, t.description);
    };
  }

  const COMMON_REPOS: { label: string; url: string; note: string }[] = [
    { label: "2048", url: "https://github.com/gabrielecirulli/2048", note: "tiny puzzle" },
    { label: "hextris", url: "https://github.com/Hextris/hextris", note: "canvas game" },
    { label: "eleventy-base-blog", url: "https://github.com/11ty/eleventy-base-blog", note: "static blog" },
    { label: "chalk", url: "https://github.com/chalk/chalk", note: "node lib" },
    { label: "flask", url: "https://github.com/pallets/flask", note: "python lib" },
  ];
  const commonList = root.querySelector<HTMLElement>("#common-list")!;
  commonList.innerHTML = COMMON_REPOS.map(
    (r, i) => `<button class="common-chip" data-i="${i}">${escapeHtml(r.label)}<span>${escapeHtml(r.note)}</span></button>`,
  ).join("");
  for (const chip of commonList.querySelectorAll<HTMLElement>(".common-chip")) {
    chip.onclick = () => {
      const r = COMMON_REPOS[Number(chip.dataset.i)]!;
      begin(r.url, r.url.split("/").slice(-2).join("/"));
    };
  }

  root.querySelector<HTMLButtonElement>("#demo-btn")!.onclick = () => {
    startDemoMatch(document.getElementById("app")!).catch((err) => {
      errorNote.textContent = String(err);
    });
  };

  refreshMatches(root);
  const interval = setInterval(() => {
    if (!document.body.contains(root)) return clearInterval(interval);
    refreshMatches(root);
  }, 5000);
}

async function refreshMatches(root: HTMLElement) {
  try {
    const { live, finished } = await fetchMatches();
    const liveList = root.querySelector<HTMLElement>("#live-list");
    const finishedList = root.querySelector<HTMLElement>("#finished-list");
    if (!liveList || !finishedList) return;
    liveList.innerHTML = live.length
      ? live.map((m) => matchRow(m)).join("")
      : '<p class="empty-note">The ash is quiet. Found a settlement.</p>';
    finishedList.innerHTML = finished.length
      ? finished.map((m) => matchRow(m)).join("")
      : '<p class="empty-note">No records yet.</p>';
    for (const row of root.querySelectorAll<HTMLElement>(".match-row")) {
      row.onclick = () => (location.hash = `#/match/${row.dataset.id}`);
    }
    const hallList = root.querySelector<HTMLElement>("#hall-list");
    if (hallList) {
      const res = await fetch("/api/hall");
      const { entries } = (await res.json()) as { entries: HallEntry[] };
      if (entries.length > 0) {
        hallList.innerHTML = entries
          .slice(0, 10)
          .map(
            (h, i) => `<div class="hall-row">
              <span class="hall-rank">${i + 1}</span>
              <span class="hall-name">${escapeHtml(h.factionName ?? h.taskTitle)}<span class="hall-title">${escapeHtml(h.title)}</span></span>
              <span class="hall-stats">☨ ${h.renown} · ${h.bountiesCleared}/${h.bountiesPosted} bounties · ◆ ${h.goldSpent.toLocaleString()}</span>
            </div>`,
          )
          .join("");
      }
    }
  } catch {
    // relay unreachable; leave the lists as they are
  }
}

function matchRow(m: MatchSummary): string {
  const badge =
    m.status === "live"
      ? '<span class="badge live">LIVE</span>'
      : `<span class="badge ${m.result ?? "abandoned"}">${m.result ?? "over"}</span>`;
  return `
    <div class="match-row" data-id="${m.matchId}">
      <div>
        <div>${escapeHtml(m.taskTitle)}</div>
        <div class="m-id">${m.matchId} · ${m.spectators} watching · ${m.eventCount} events</div>
      </div>
      ${badge}
    </div>`;
}
