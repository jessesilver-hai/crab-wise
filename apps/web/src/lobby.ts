import { TASKS } from "@agent-empires/tasks";
import { fetchMatches } from "./relay.js";
import { startHostedMatch } from "./host.js";
import { escapeHtml } from "./match-view.js";
import type { MatchSummary } from "@agent-empires/protocol";

const KEY_STORAGE = "agent-empires-api-key";

export function renderLobby(root: HTMLElement): void {
  const savedKey = localStorage.getItem(KEY_STORAGE) ?? "";
  root.innerHTML = `
    <div class="lobby">
      <div class="hero">
        <h1>Agent Empires</h1>
        <p class="tagline">Wherein AI agents labor upon real code, and the chronicle is told as a battle for the realm.</p>
        <div class="rule"></div>
      </div>
      <div class="lobby-grid">
        <div class="panel">
          <h2>Start a Match</h2>
          <div id="task-list"></div>
          <div class="form-row">
            <label>Anthropic API key</label>
            <input id="api-key" type="password" placeholder="sk-ant-…" value="${escapeHtml(savedKey)}" />
            <div class="key-note">
              <strong>Your key never leaves your browser.</strong> Agents call Anthropic directly from
              this page and run code in an in-browser sandbox (WebContainers). The server only ever
              receives game events. <label style="display:inline"><input id="remember-key" type="checkbox" style="width:auto" ${savedKey ? "checked" : ""}/> remember key in this browser</label>
            </div>
          </div>
          <div class="form-row">
            <label>Model</label>
            <select id="model">
              <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (recommended)</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5 (cheaper, scrappier villagers)</option>
            </select>
          </div>
          <button id="start-btn">⚔ Sound the Horns</button>
          <button id="demo-btn" style="margin-left:0.6rem">👁 Watch a Demo Skirmish (no key)</button>
          <div class="error-note" id="start-error"></div>
        </div>
        <div class="panel">
          <h2>Live Matches</h2>
          <div id="live-list"><p class="empty-note">Consulting the watchtower…</p></div>
          <h2 style="margin-top:1.5rem">Chronicles</h2>
          <div id="finished-list"><p class="empty-note">No matches recorded yet.</p></div>
        </div>
      </div>
      <p class="footer-note">
        A fun experiment: real software-engineering agents, rendered as a real-time-strategy chronicle.<br/>
        Open source · no AoE assets were harmed · your API key stays client-side.
      </p>
    </div>`;

  // Task cards
  const taskList = root.querySelector<HTMLElement>("#task-list")!;
  let selectedTask = TASKS[0]?.id ?? "";
  function renderTasks() {
    taskList.innerHTML = TASKS.map(
      (t) => `
      <div class="task-card ${t.id === selectedTask ? "selected" : ""}" data-id="${t.id}">
        <div class="t-title">${escapeHtml(t.title)}</div>
        <div class="t-flavor">${escapeHtml(t.flavor)}</div>
      </div>`,
    ).join("");
    for (const card of taskList.querySelectorAll<HTMLElement>(".task-card")) {
      card.onclick = () => {
        selectedTask = card.dataset.id!;
        renderTasks();
      };
    }
  }
  renderTasks();

  // Start button
  const startBtn = root.querySelector<HTMLButtonElement>("#start-btn")!;
  const errorNote = root.querySelector<HTMLElement>("#start-error")!;
  startBtn.onclick = () => {
    const key = root.querySelector<HTMLInputElement>("#api-key")!.value.trim();
    const model = root.querySelector<HTMLSelectElement>("#model")!.value;
    const remember = root.querySelector<HTMLInputElement>("#remember-key")!.checked;
    const task = TASKS.find((t) => t.id === selectedTask);
    if (!key.startsWith("sk-ant-")) {
      errorNote.textContent = "That does not look like an Anthropic API key (sk-ant-…).";
      return;
    }
    if (!task) {
      errorNote.textContent = "Choose a campaign first.";
      return;
    }
    if (remember) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
    startBtn.disabled = true;
    startHostedMatch(document.getElementById("app")!, { task, apiKey: key, model }).catch((err) => {
      errorNote.textContent = String(err);
      startBtn.disabled = false;
    });
  };

  // Match lists
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
      : '<p class="empty-note">The realm is quiet. Start a match!</p>';
    finishedList.innerHTML = finished.length
      ? finished.map((m) => matchRow(m)).join("")
      : '<p class="empty-note">No matches recorded yet.</p>';
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
