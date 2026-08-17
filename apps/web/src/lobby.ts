import { fetchMatches } from "./relay.js";
import { startSettlement } from "./host.js";
import { escapeHtml } from "./match-view.js";
import type { HallEntry, MatchSummary } from "@agent-empires/protocol";

type RepoChip = { label: string; url: string; note: string };
type Tier = { name: string; hint: string; repos: RepoChip[] };

// Two doors in: a public repo to rule, or a commission to build from nothing.
// Fun-first curation: every playable pick is Node or Python (the only
// toolchains in the sandbox), so decrees like "run the tests" spawn real
// specters. Ruins & Relics is honestly labeled lore.
type Quest = { label: string; icon: string; slug: string; what: string };

// Single self-contained index.html keeps ⌂ Behold the Work honest: the built
// page runs alone in a sealed iframe, no server or bundler required.
const QUEST_CHARGE = (what: string) =>
  `Your commission from the Crown: build ${what}. Create index.html as a single self-contained page — ` +
  `inline CSS and JS, no external dependencies, no build step; it must run alone when opened. ` +
  `You may add a README or supporting files. When it works, read your own code end to end and polish it until it is genuinely good.`;

const QUESTS: Quest[] = [
  { label: "Snake", icon: "🐍", slug: "snake", what: "the classic Snake game: keyboard controls, score, gentle speed-up, game-over and restart" },
  { label: "Pong", icon: "🏓", slug: "pong", what: "Pong against a simple computer opponent: mouse or keys, score to 7, satisfying ball physics" },
  { label: "Pomodoro", icon: "⏱", slug: "pomodoro", what: "a beautiful pomodoro timer: 25/5 work-break cycles, big readable countdown, chime, session tally" },
  { label: "Todo", icon: "☑", slug: "todo", what: "a polished todo list: add, complete, delete, filter, localStorage persistence, pleasing design" },
  { label: "Particle toy", icon: "✦", slug: "particles", what: "an interactive particle fireworks toy: particles chase and burst around the mouse, color cycling, sliders for count and gravity" },
  { label: "Bakery page", icon: "🥖", slug: "bakery", what: "a gorgeous landing page for an imaginary bakery: hero, menu cards, hours, tasteful typography, no frameworks" },
];

const TIERS: Tier[] = [
  {
    name: "Hamlets",
    hint: "a handful of huts — worlds in under a minute",
    repos: [
      { label: "2048", url: "https://github.com/gabrielecirulli/2048", note: "sliding-tile puzzle" },
      { label: "hextris", url: "https://github.com/Hextris/hextris", note: "canvas arcade" },
      { label: "chalk", url: "https://github.com/chalk/chalk", note: "terminal colors" },
      { label: "dotenv", url: "https://github.com/motdotla/dotenv", note: "env loader" },
      { label: "ms", url: "https://github.com/vercel/ms", note: "time strings" },
      { label: "minimist", url: "https://github.com/minimistjs/minimist", note: "arg parser" },
      { label: "left-pad", url: "https://github.com/left-pad/left-pad", note: "the npm apocalypse" },
      { label: "nanoid", url: "https://github.com/ai/nanoid", note: "tiny id forge" },
      { label: "debug", url: "https://github.com/debug-js/debug", note: "the everywhere logger" },
      { label: "eleventy-base-blog", url: "https://github.com/11ty/eleventy-base-blog", note: "starter blog" },
    ],
  },
  {
    name: "Villages",
    hint: "small libraries with real test suites — specters guaranteed",
    repos: [
      { label: "express", url: "https://github.com/expressjs/express", note: "node web classic" },
      { label: "chess.js", url: "https://github.com/jhlywa/chess.js", note: "the royal game, tested" },
      { label: "dayjs", url: "https://github.com/iamkun/dayjs", note: "dates, 2kB" },
      { label: "zod", url: "https://github.com/colinhacks/zod", note: "schema validation" },
      { label: "commander", url: "https://github.com/tj/commander.js", note: "CLI framework" },
      { label: "click", url: "https://github.com/pallets/click", note: "python CLI kit" },
      { label: "preact", url: "https://github.com/preactjs/preact", note: "3kB react" },
      { label: "htmx", url: "https://github.com/bigskysoftware/htmx", note: "hypermedia" },
      { label: "axios", url: "https://github.com/axios/axios", note: "http client" },
      { label: "validator.js", url: "https://github.com/validatorjs/validator.js", note: "string sentry" },
    ],
  },
  {
    name: "Towns",
    hint: "frameworks with big pytest garrisons — the richest battles",
    repos: [
      { label: "rich", url: "https://github.com/Textualize/rich", note: "terminal splendor ✓ battle-tested" },
      { label: "textual", url: "https://github.com/Textualize/textual", note: "TUI sorcery" },
      { label: "flask", url: "https://github.com/pallets/flask", note: "python web" },
      { label: "fastapi", url: "https://github.com/fastapi/fastapi", note: "async python api" },
      { label: "black", url: "https://github.com/psf/black", note: "the uncompromising formatter" },
      { label: "httpie", url: "https://github.com/httpie/cli", note: "the http bard" },
      { label: "pydantic", url: "https://github.com/pydantic/pydantic", note: "validation keep" },
      { label: "thefuck", url: "https://github.com/nvbn/thefuck", note: "the console-corrector" },
      { label: "requests", url: "https://github.com/psf/requests", note: "python http" },
      { label: "fastify", url: "https://github.com/fastify/fastify", note: "fast node web" },
    ],
  },
  {
    name: "Cities",
    hint: "serious codebases — garrisons dispatched by district",
    repos: [
      { label: "django", url: "https://github.com/django/django", note: "web metropolis ✓ battle-tested" },
      { label: "TheAlgorithms", url: "https://github.com/TheAlgorithms/Python", note: "every quarter an algorithm" },
      { label: "jest", url: "https://github.com/jestjs/jest", note: "the test realm, testing itself" },
      { label: "pytest", url: "https://github.com/pytest-dev/pytest", note: "the trial-master on trial" },
      { label: "eleventy", url: "https://github.com/11ty/eleventy", note: "static site engine" },
      { label: "date-fns", url: "https://github.com/date-fns/date-fns", note: "two hundred date quarters" },
      { label: "vite", url: "https://github.com/vitejs/vite", note: "frontend tooling" },
      { label: "svelte", url: "https://github.com/sveltejs/svelte", note: "compiler framework" },
      { label: "tailwindcss", url: "https://github.com/tailwindlabs/tailwindcss", note: "utility css" },
      { label: "typescript", url: "https://github.com/microsoft/TypeScript", note: "the type checker" },
    ],
  },
  {
    name: "Ruins & Relics",
    hint: "lore realms — explore and inscribe, no war to wage",
    repos: [
      { label: "DOOM", url: "https://github.com/id-Software/DOOM", note: "the demon fortress, 1993" },
      { label: "you-dont-know-js", url: "https://github.com/getify/You-Dont-Know-JS", note: "a city of pure scripture" },
      { label: "nanoGPT", url: "https://github.com/karpathy/nanoGPT", note: "the oracle's mind" },
      { label: "pytudes", url: "https://github.com/norvig/pytudes", note: "norvig's études" },
      { label: "gitignore", url: "https://github.com/github/gitignore", note: "hall of ten thousand banners" },
      { label: "nocode", url: "https://github.com/kelseyhightower/nocode", note: "the empty realm" },
    ],
  },
];

export function renderLobby(root: HTMLElement): void {
  root.innerHTML = `
    <div class="lobby">
      <div class="hero">
        <h1>AGENT EMPIRES</h1>
        <p class="tagline">Paste a public repository — or commission new software from bare earth.
        A civilization wakes upon the code: agents labor, specters rise from failing tests,
        and you rule it all by decree.</p>
        <div class="rule"></div>
      </div>
      <div class="lobby-grid">
        <div class="panel" id="found-panel">
          <h2>Paste a Public Repo</h2>
          <div class="form-row">
            <input id="repo-url" type="text" autofocus
              placeholder="https://github.com/owner/repo — press Enter" />
          </div>
          <div class="one-door">The Crown funds the agents; the repository becomes the realm —
          every file a building, every directory a walled quarter.</div>
          <div class="error-note" id="start-error"></div>
          <div class="sample-label">— or commission a new realm, built from nothing —</div>
          <div class="form-row commission-row">
            <input id="brief-input" type="text" placeholder="describe what to build — e.g. a tiny drum machine" />
            <button id="brief-btn" title="Found a bare realm and set the agents building">⚒ Found</button>
          </div>
          <div class="one-door">The realm begins as bare earth. Watch the city rise file by file,
          then press <strong>⌂ Behold the Work</strong> to run what they built.</div>
          <div class="quest-grid" id="quest-grid">${QUESTS.map(
            (q, i) => `<button class="quest-chip" data-q="${i}"><span class="q-icon">${q.icon}</span>${escapeHtml(q.label)}</button>`,
          ).join("")}</div>
          <div class="sample-label">— or choose an existing realm, by size —</div>
          <div id="tier-list"></div>
        </div>
        <div class="panel">
          <h2>☾ Prior Worlds</h2>
          <p class="panel-sub">Worlds saved at departure — click one to replay its chronicle.</p>
          <div id="finished-list"><p class="empty-note">None yet. When you depart a settlement, choose to save it and it will rest here.</p></div>
          <h2 style="margin-top:1.5rem">☨ Hall of Legends</h2>
          <div id="hall-list"><p class="empty-note">No legends yet. Clear bounties — fix failing tests — and be remembered.</p></div>
        </div>
      </div>
      <p class="footer-note">
        Real software-engineering agents, rendered as an ancient-future strategy chronicle.<br/>
        Sessions run in isolated sandboxes · themes are divined per repository ·
        <a href="/assets/3d/LICENSES.md" target="_blank" rel="noopener">3D art credits (KayKit, CC0)</a> · <a href="/assets/iso/LICENSES.md" target="_blank" rel="noopener">pixel art credits</a>
      </p>
    </div>`;

  const errorNote = root.querySelector<HTMLElement>("#start-error")!;
  const repoInput = root.querySelector<HTMLInputElement>("#repo-url")!;
  const foundPanel = root.querySelector<HTMLElement>("#found-panel")!;
  let starting = false;

  function begin(repoUrl: string, repoLabel: string, firstOrder?: string) {
    if (starting) return;
    starting = true;
    errorNote.textContent = "";
    foundPanel.classList.add("starting");
    startSettlement(document.getElementById("app")!, { repoUrl, repoLabel, apiKey: "", model: "", firstOrder }).catch((err) => {
      errorNote.textContent = String(err);
      starting = false;
      foundPanel.classList.remove("starting");
    });
  }

  repoInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const typedUrl = repoInput.value.trim().replace(/\.git$/, "");
    if (!/^https:\/\/[\w.-]+\/[\w.~/-]+$/.test(typedUrl)) {
      errorNote.textContent = "Enter a public https git URL — or pick a realm below.";
      return;
    }
    begin(typedUrl, typedUrl.split("/").slice(-2).join("/"));
  });

  const briefInput = root.querySelector<HTMLInputElement>("#brief-input")!;
  const commission = () => {
    const what = briefInput.value.trim();
    if (what.length < 8) {
      errorNote.textContent = "Describe the commission in a few words — e.g. “a tiny drum machine”.";
      return;
    }
    // Slug keeps the realm's seed, README title, and divined theme distinct per brief.
    const slug = what.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "commission";
    begin(`new:${slug}`, `New Realm — ${what.slice(0, 40)}`, QUEST_CHARGE(what));
  };
  root.querySelector<HTMLButtonElement>("#brief-btn")!.onclick = commission;
  briefInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commission();
  });
  for (const chip of root.querySelectorAll<HTMLElement>(".quest-chip")) {
    chip.onclick = () => {
      const q = QUESTS[Number(chip.dataset.q)]!;
      begin(`new:${q.slug}`, `New Realm — ${q.label}`, QUEST_CHARGE(q.what));
    };
  }

  const tierList = root.querySelector<HTMLElement>("#tier-list")!;
  tierList.innerHTML = TIERS.map(
    (tier, ti) => `
    <div class="tier">
      <div class="tier-label">${escapeHtml(tier.name)} <span>· ${escapeHtml(tier.hint)}</span></div>
      <div class="chip-grid">${tier.repos
        .map(
          (r, ri) =>
            `<button class="common-chip" data-t="${ti}" data-r="${ri}">${escapeHtml(r.label)}<span>${escapeHtml(r.note)}</span></button>`,
        )
        .join("")}</div>
    </div>`,
  ).join("");
  for (const chip of tierList.querySelectorAll<HTMLElement>(".common-chip")) {
    chip.onclick = () => {
      const r = TIERS[Number(chip.dataset.t)]!.repos[Number(chip.dataset.r)]!;
      begin(r.url, r.url.split("/").slice(-2).join("/"));
    };
  }

  refreshMatches(root);
  const interval = setInterval(() => {
    if (!document.body.contains(root)) return clearInterval(interval);
    refreshMatches(root);
  }, 5000);
}

async function refreshMatches(root: HTMLElement) {
  try {
    const { finished } = await fetchMatches();
    const finishedList = root.querySelector<HTMLElement>("#finished-list");
    if (!finishedList) return;
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
  // A quit-and-saved world reads "saved", not "abandoned" — saving was chosen.
  const label = m.result === "abandoned" ? "saved" : m.result ?? "over";
  const badge =
    m.status === "live"
      ? '<span class="badge live">LIVE</span>'
      : `<span class="badge ${m.result ?? "abandoned"}">${label}</span>`;
  return `
    <div class="match-row" data-id="${m.matchId}">
      <div>
        <div>${escapeHtml(m.taskTitle)}</div>
        <div class="m-id">${m.matchId} · ${m.spectators} watching · ${m.eventCount} events</div>
      </div>
      ${badge}
    </div>`;
}
