import { fetchMatches } from "./relay.js";
import { startSettlement } from "./host.js";
import { escapeHtml } from "./match-view.js";
import type { HallEntry, MatchSummary } from "@agent-empires/protocol";

type RepoChip = { label: string; url: string; note: string };
type Tier = { name: string; hint: string; repos: RepoChip[] };

// One door in: a public repo. Tiers are honest about how big a realm rises.
const TIERS: Tier[] = [
  {
    name: "Hamlets",
    hint: "a handful of huts — worlds in under a minute",
    repos: [
      { label: "2048", url: "https://github.com/gabrielecirulli/2048", note: "sliding-tile puzzle" },
      { label: "hextris", url: "https://github.com/Hextris/hextris", note: "canvas arcade" },
      { label: "chalk", url: "https://github.com/chalk/chalk", note: "terminal colors" },
      { label: "dotenv", url: "https://github.com/motdotla/dotenv", note: "env loader" },
      { label: "cors", url: "https://github.com/expressjs/cors", note: "express middleware" },
      { label: "ms", url: "https://github.com/vercel/ms", note: "time strings" },
      { label: "eleventy-base-blog", url: "https://github.com/11ty/eleventy-base-blog", note: "starter blog" },
      { label: "normalize.css", url: "https://github.com/necolas/normalize.css", note: "css reset" },
      { label: "slugify", url: "https://github.com/sindresorhus/slugify", note: "string lib" },
      { label: "underscore", url: "https://github.com/jashkenas/underscore", note: "classic utils" },
    ],
  },
  {
    name: "Villages",
    hint: "small libraries — a few walled quarters",
    repos: [
      { label: "express", url: "https://github.com/expressjs/express", note: "node web classic" },
      { label: "koa", url: "https://github.com/koajs/koa", note: "minimal web" },
      { label: "sinatra", url: "https://github.com/sinatra/sinatra", note: "ruby web" },
      { label: "click", url: "https://github.com/pallets/click", note: "python CLI kit" },
      { label: "dayjs", url: "https://github.com/iamkun/dayjs", note: "dates, 2kB" },
      { label: "zod", url: "https://github.com/colinhacks/zod", note: "schema validation" },
      { label: "axios", url: "https://github.com/axios/axios", note: "http client" },
      { label: "preact", url: "https://github.com/preactjs/preact", note: "3kB react" },
      { label: "htmx", url: "https://github.com/bigskysoftware/htmx", note: "hypermedia" },
      { label: "commander", url: "https://github.com/tj/commander.js", note: "CLI framework" },
    ],
  },
  {
    name: "Towns",
    hint: "working frameworks — proper districts",
    repos: [
      { label: "flask", url: "https://github.com/pallets/flask", note: "python web" },
      { label: "fastapi", url: "https://github.com/fastapi/fastapi", note: "async python api" },
      { label: "gin", url: "https://github.com/gin-gonic/gin", note: "go web" },
      { label: "cobra", url: "https://github.com/spf13/cobra", note: "go CLI" },
      { label: "hono", url: "https://github.com/honojs/hono", note: "edge web" },
      { label: "alpine", url: "https://github.com/alpinejs/alpine", note: "js sprinkles" },
      { label: "jekyll", url: "https://github.com/jekyll/jekyll", note: "ruby static sites" },
      { label: "eleventy", url: "https://github.com/11ty/eleventy", note: "static site engine" },
      { label: "date-fns", url: "https://github.com/date-fns/date-fns", note: "date toolkit" },
      { label: "requests", url: "https://github.com/psf/requests", note: "python http" },
    ],
  },
  {
    name: "Cities",
    hint: "serious codebases — dense quarters, long roads",
    repos: [
      { label: "django", url: "https://github.com/django/django", note: "batteries-included web" },
      { label: "rails", url: "https://github.com/rails/rails", note: "the ruby monolith" },
      { label: "redis", url: "https://github.com/redis/redis", note: "in-memory store, C" },
      { label: "ripgrep", url: "https://github.com/BurntSushi/ripgrep", note: "rust search" },
      { label: "clap", url: "https://github.com/clap-rs/clap", note: "rust CLI" },
      { label: "serde", url: "https://github.com/serde-rs/serde", note: "rust serialization" },
      { label: "vite", url: "https://github.com/vitejs/vite", note: "frontend tooling" },
      { label: "svelte", url: "https://github.com/sveltejs/svelte", note: "compiler framework" },
      { label: "bootstrap", url: "https://github.com/twbs/bootstrap", note: "css framework" },
      { label: "fastify", url: "https://github.com/fastify/fastify", note: "fast node web" },
    ],
  },
  {
    name: "Metropolises",
    hint: "vast realms — slower to raise, capped at 1200 buildings",
    repos: [
      { label: "cpython", url: "https://github.com/python/cpython", note: "the python interpreter" },
      { label: "typescript", url: "https://github.com/microsoft/TypeScript", note: "the type checker" },
      { label: "react", url: "https://github.com/facebook/react", note: "the ui library" },
      { label: "vue", url: "https://github.com/vuejs/core", note: "vue 3 core" },
      { label: "webpack", url: "https://github.com/webpack/webpack", note: "the old bundler" },
      { label: "tailwindcss", url: "https://github.com/tailwindlabs/tailwindcss", note: "utility css" },
      { label: "laravel", url: "https://github.com/laravel/framework", note: "php framework" },
      { label: "cargo", url: "https://github.com/rust-lang/cargo", note: "rust package manager" },
      { label: "elixir", url: "https://github.com/elixir-lang/elixir", note: "the language" },
      { label: "git", url: "https://github.com/git/git", note: "git itself" },
    ],
  },
];

export function renderLobby(root: HTMLElement): void {
  root.innerHTML = `
    <div class="lobby">
      <div class="hero">
        <h1>AGENT EMPIRES</h1>
        <p class="tagline">Paste a public repository. A civilization wakes upon the code —
        agents labor, specters rise from failing tests, and you rule it all by decree.</p>
        <div class="rule"></div>
      </div>
      <div class="lobby-grid">
        <div class="panel" id="found-panel">
          <h2>Paste a Public Repo</h2>
          <div class="form-row">
            <input id="repo-url" type="text" autofocus
              placeholder="https://github.com/owner/repo — press Enter" />
          </div>
          <div class="one-door">That is the only door in. The Crown funds the agents;
          the repository becomes the realm — every file a building, every directory a walled quarter.</div>
          <div class="error-note" id="start-error"></div>
          <div class="sample-label">— or choose a realm, by size —</div>
          <div id="tier-list"></div>
        </div>
        <div class="panel">
          <h2>The Chronicle</h2>
          <div id="finished-list"><p class="empty-note">No records yet.</p></div>
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

  function begin(repoUrl: string, repoLabel: string) {
    if (starting) return;
    starting = true;
    errorNote.textContent = "";
    foundPanel.classList.add("starting");
    startSettlement(document.getElementById("app")!, { repoUrl, repoLabel, apiKey: "", model: "" }).catch((err) => {
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
