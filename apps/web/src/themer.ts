import Anthropic from "@anthropic-ai/sdk";
import { ThemePack } from "@agent-empires/protocol";

/**
 * One LLM call (visitor's key) turns a repository into a world skin:
 * faction, personas, herald liturgy, palette, and pixel sprite sheets.
 * Results are cached on the relay so a repo is themed at most once.
 */

export function repoKey(repoUrl: string): string {
  let h = 2166136261;
  for (let i = 0; i < repoUrl.length; i++) {
    h ^= repoUrl.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export async function getCachedTheme(key: string): Promise<ThemePack | null> {
  try {
    const res = await fetch(`/api/theme/${key}`);
    if (!res.ok) return null;
    const parsed = ThemePack.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function putCachedTheme(key: string, theme: ThemePack): Promise<void> {
  try {
    await fetch(`/api/theme/${key}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(theme),
    });
  } catch {
    /* cache is best-effort */
  }
}

const ART_DIRECTION = `You are the art director of "Agent Empires", a strategy-game skin for real
software repositories. House style — ANCIENT-FUTURE: the mythic dread of a Robert Eggers film
fused with the monumental science fiction of Denis Villeneuve. A civilization so old its
technology reads as ritual: monoliths and signal-arrays, ash steppes and bone banners,
liturgy and machine-hum. Never cute, never neon, never generic-medieval.

Adapt that register to THIS repository's domain. Examples of the move:
- a web server → a harbor-citadel where request-caravans cross the causeway
- an ML library → an oracle-engine tended by mathematic ascetics
- a CLI tool → a wandering order of blade-scribes
- a game engine → the foundry of worlds

Also set biome.archetype to whichever of "ash-steppe", "harbor-citadel", "oracle-forge",
"glacier-vault", "verdant-ruin", "dune-monolith" best fits this repository's domain — it
selects the world's terrain, props, and weather.

Rules for text: faction name ≤ 5 words; tagline one evocative sentence; the king is the
sovereign-figure title; enemyName is what failing tests are called (plural, ominous, domain-tied);
herald openers/closers are short liturgical fragments; personas are 4-6 workers with name,
title, and a one-line quirk that hints at an engineering specialty.

Rules for pixel sprites: top-down 3/4 view, chunky readable silhouettes, muted desaturated
palette (ash, bone, ochre, umber, one dim glow accent), "." = transparent, each row the same
length, subject centered with its base on the bottom row. Required keys and max sizes:
villager 18x18, hero 20x20, raider 18x18, tree 20x20 (a relic/monolith/flora of the realm),
house 26x26, barracks 26x26, market 26x26, monastery 26x26, mill 26x26, towncenter 32x32.
Palette maps single characters to #rrggbb.`;

export async function generateTheme(opts: {
  apiKey: string;
  model: string;
  llm?: { baseURL: string; headers?: Record<string, string> };
  repoLabel: string;
  readme: string;
  treeSummary: string;
}): Promise<ThemePack | null> {
  const client = new Anthropic({
    apiKey: opts.apiKey || "crown-funded",
    dangerouslyAllowBrowser: true,
    baseURL: opts.llm?.baseURL,
    defaultHeaders: opts.llm?.headers,
  });
  try {
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: 16_000,
      system: ART_DIRECTION,
      tools: [
        {
          name: "set_theme",
          description: "Deliver the complete world theme for this repository.",
          input_schema: {
            type: "object",
            properties: {
              factionName: { type: "string" },
              tagline: { type: "string" },
              kingName: { type: "string" },
              enemyName: { type: "string" },
              biome: {
                type: "object",
                properties: {
                  grassColors: { type: "array", items: { type: "string" }, description: "3-4 ground-tile hex colors" },
                  fogColor: { type: "string" },
                  accentColor: { type: "string" },
                },
                required: ["grassColors", "fogColor", "accentColor"],
              },
              heraldOpeners: { type: "array", items: { type: "string" } },
              heraldClosers: { type: "array", items: { type: "string" } },
              personas: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    title: { type: "string" },
                    quirk: { type: "string" },
                  },
                  required: ["name", "title", "quirk"],
                },
              },
              sprites: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    rows: { type: "array", items: { type: "string" } },
                    palette: { type: "object", additionalProperties: { type: "string" } },
                  },
                  required: ["key", "rows", "palette"],
                },
              },
            },
            required: [
              "factionName", "tagline", "kingName", "enemyName", "biome",
              "heraldOpeners", "heraldClosers", "personas", "sprites",
            ],
          },
        },
      ],
      tool_choice: { type: "tool", name: "set_theme" },
      messages: [
        {
          role: "user",
          content: `Repository: ${opts.repoLabel}

README (truncated):
${opts.readme.slice(0, 5000) || "(no readme)"}

File tree:
${opts.treeSummary.slice(0, 3000)}

Deliver the theme via set_theme.`,
        },
      ],
    });

    const call = response.content.find((b) => b.type === "tool_use");
    if (!call || call.type !== "tool_use") return null;
    const candidate = normalizeCandidate(call.input as Record<string, unknown>);
    const parsed = ThemePack.safeParse(candidate);
    if (!parsed.success) {
      console.warn("theme validation failed", parsed.error.issues.slice(0, 5));
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn("theme generation failed", err);
    return null;
  }
}

/** Repair common LLM slop before strict validation. */
function normalizeCandidate(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  if (Array.isArray(out.sprites)) {
    out.sprites = (out.sprites as Record<string, unknown>[])
      .map((s) => {
        const rows = Array.isArray(s.rows) ? (s.rows as string[]).map((r) => String(r).slice(0, 40)) : [];
        const width = Math.max(...rows.map((r) => r.length), 1);
        return {
          key: String(s.key ?? ""),
          // Pad ragged rows to rectangular.
          rows: rows.slice(0, 40).map((r) => r.padEnd(width, ".")),
          palette: Object.fromEntries(
            Object.entries((s.palette as Record<string, string>) ?? {})
              .filter(([k, v]) => k.length === 1 && /^#[0-9a-fA-F]{6}$/.test(String(v)))
              .map(([k, v]) => [k, String(v)]),
          ),
        };
      })
      .filter((s) => s.rows.length >= 4)
      .slice(0, 14);
  }
  return out;
}

export async function resolveTheme(opts: {
  apiKey: string;
  model: string;
  repoUrl: string;
  repoLabel: string;
  readme: string;
  treeSummary: string;
}): Promise<{ theme: ThemePack | null; fromCache: boolean }> {
  const key = repoKey(opts.repoUrl);
  const cached = await getCachedTheme(key);
  if (cached) return { theme: cached, fromCache: true };
  const theme = await generateTheme(opts);
  if (theme) await putCachedTheme(key, theme);
  return { theme, fromCache: false };
}
