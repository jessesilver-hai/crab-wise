import { TASKS } from "@agent-empires/tasks";
import { fetchMatches } from "./relay.js";
import { startSettlement } from "./host.js";
import { startDemoMatch } from "./demo.js";
import { escapeHtml } from "./match-view.js";
import type { MatchSummary } from "@agent-empires/protocol";

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
        <div class="panel">
          <h2>Found a Settlement</h2>
          <div class="form-row">
            <label>Repository (public git URL)</label>
            <input id="repo-url" type="text" placeholder="https://github.com/you/your-repo" />
          </div>
          <div class="sample-label">— or wake one of the old worlds —</div>
          <div id="sample-list"></div>
          <div class="form-row">
            <label>Anthropic API key</label>
            <input id="api-key" type="password" placeholder="sk-ant-…" value="${escapeHtml(savedKey)}" />
            <div class="key-note">
              <strong>Your key never leaves your browser.</strong> Agents call Anthropic directly
              from this page; only tool calls (file edits, commands) travel to the sandbox. The
              server never sees the key. <label style="display:inline"><input id="remember-key" type="checkbox" style="width:auto" ${savedKey ? "checked" : ""}/> remember key in this browser</label>
            </div>
          </div>
          <div class="form-row">
            <label>Model</label>
            <select id="model">
              <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (recommended)</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5 (cheaper, scrappier workers)</option>
            </select>
          </div>
          <button id="start-btn">⟡ Light the Beacon</button>
          <button id="demo-btn" style="margin-left:0.6rem">◉ Watch a Demo (no key)</button>
          <div class="error-note" id="start-error"></div>
        </div>
        <div class="panel">
          <h2>Living Settlements</h2>
          <div id="live-list"><p class="empty-note">Consulting the watchtower…</p></div>
          <h2 style="margin-top:1.5rem">The Chronicle</h2>
          <div id="finished-list"><p class="empty-note">No records yet.</p></div>
        </div>
      </div>
      <p class="footer-note">
        Real software-engineering agents, rendered as an ancient-future strategy chronicle.<br/>
        Sessions run in isolated sandboxes · themes are divined per repository · your key stays client-side.
      </p>
    </div>`;

  // Sample world cards
  const sampleList = root.querySelector<HTMLElement>("#sample-list")!;
  let selectedSample: string | null = null;
  const repoInput = root.querySelector<HTMLInputElement>("#repo-url")!;
  function renderSamples() {
    sampleList.innerHTML = TASKS.map(
      (t) => `
      <div class="task-card ${t.id === selectedSample ? "selected" : ""}" data-id="${t.id}">
        <div class="t-title">${escapeHtml(t.title)}</div>
        <div class="t-flavor">${escapeHtml(t.flavor)}</div>
      </div>`,
    ).join("");
    for (const card of sampleList.querySelectorAll<HTMLElement>(".task-card")) {
      card.onclick = () => {
        selectedSample = card.dataset.id === selectedSample ? null : card.dataset.id!;
        if (selectedSample) repoInput.value = "";
        renderSamples();
      };
    }
  }
  renderSamples();
  repoInput.addEventListener("input", () => {
    if (repoInput.value.trim() && selectedSample) {
      selectedSample = null;
      renderSamples();
    }
  });

  const startBtn = root.querySelector<HTMLButtonElement>("#start-btn")!;
  const errorNote = root.querySelector<HTMLElement>("#start-error")!;
  startBtn.onclick = () => {
    const key = root.querySelector<HTMLInputElement>("#api-key")!.value.trim();
    const model = root.querySelector<HTMLSelectElement>("#model")!.value;
    const remember = root.querySelector<HTMLInputElement>("#remember-key")!.checked;
    const typedUrl = repoInput.value.trim();
    const sample = TASKS.find((t) => t.id === selectedSample);

    if (!key.startsWith("sk-ant-")) {
      errorNote.textContent = "That does not look like an Anthropic API key (sk-ant-…).";
      return;
    }
    let repoUrl: string;
    let repoLabel: string;
    let firstOrder: string | undefined;
    if (sample) {
      repoUrl = `sample:${sample.id}`;
      repoLabel = sample.title;
      firstOrder = sample.description;
    } else if (/^https:\/\/[\w.-]+\/[\w.~/-]+$/.test(typedUrl)) {
      repoUrl = typedUrl.replace(/\.git$/, "");
      repoLabel = repoUrl.split("/").slice(-2).join("/");
    } else {
      errorNote.textContent = "Enter a public https git URL, or choose an old world below.";
      return;
    }
    if (remember) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);

    startBtn.disabled = true;
    startSettlement(document.getElementById("app")!, { repoUrl, repoLabel, apiKey: key, model, firstOrder }).catch(
      (err) => {
        errorNote.textContent = String(err);
        startBtn.disabled = false;
      },
    );
  };

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
