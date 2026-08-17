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

THE LAW OF ISOMORPHISM. You will receive a CODE CENSUS: measured facts about this
repository (language shares, test/docs/config ratios, nesting depth, monorepo-ness,
giant-file share). The land must EXPRESS those facts so plainly that a visitor could
guess the census from the terrain alone:
- choose biome.archetype for the code's true temperament, not the prettiest option;
- set world.timeOfDay and world.vegetation only to sharpen that expression
  (e.g. a barren dusk for a dying C relic, a lush dawn for a well-tended garden repo);
- write 3-6 world.worldLore entries that CITE the numbers — e.g.
  { "subject": "walls", "line": "The walls stand triple-ringed — trials guard 31% of all lines." }
  These become examine-text in the world; they are the visitor's Rosetta stone.
- never default to a temperate green field unless the census truly reads garden;
  two different repositories must never feel like the same land.

Rules for text: faction name ≤ 5 words; tagline one evocative sentence; the king is the
sovereign-figure title; enemyName is what failing tests are called (plural, ominous, domain-tied);
herald openers/closers are short liturgical fragments; personas are 4-6 workers with name,
title, and a one-line quirk that hints at an engineering specialty.

Rules for pixel sprites: top-down 3/4 view, chunky readable silhouettes, muted desaturated
palette (ash, bone, ochre, umber, one dim glow accent), "." = transparent, each row the same
length, subject centered with its base on the bottom row. Required keys and max sizes:
villager 18x18, hero 20x20, raider 18x18, tree 20x20 (a relic/monolith/flora of the realm),
house 26x26, barracks 26x26, market 26x26, monastery 26x26, mill 26x26, towncenter 32x32.
Palette maps single characters to #rrggbb.

Also author worldSpec — the composed geometry of this world, which the engine renders.
You do not draw here; you PARAMETERIZE a fixed vocabulary. All colors are "#rrggbb".
- lore: placeName; epithet (one sentence); loadingLines: 3-6 short in-fiction lines that
  reference THIS repository's actual domain (its real modules, purpose, rituals of its
  craft) as if chroniclers were reading its record aloud while the world forms. Each ≤160
  chars.
- sky: { top, horizon, hazeAlpha 0-0.5 } — vertical gradient plus haze.
- terrain: { base: 3-6 ground hex colors dark→light, pattern: one of
  plates|dunes|floes|moss|tessellae|shale, reliefIntensity 0-1,
  optional waterline { color, coverage 0-0.35 } for harbor/glacier worlds }.
- props: up to 12 scatter objects. Each has silhouette: 1-6 primitives, density 0-1,
  placement: ridges|edges|scatter|districts, optional glow { color, pulseSec 2-20 }.
- Primitive vocabulary (the ONLY shapes that exist): slab (block), obelisk (tapered
  pillar), arch (legs + curve), mast (thin pole + yard), orb (sphere), shard (spike
  triangle), frond (fanned fibers), coil (sinuous column), ring (hoop), beam (light
  column). Each: { shape, w 2-48, h 2-72 (integers), color, tilt -30..30 degrees }.
  Props compose primitives side-by-side at the ground; buildings STACK them bottom→top.
- architecture: for each of house, barracks, market, monastery, mill, towncenter:
  { silhouette: 1-5 stacked primitives, roofColor, wallColor, optional emissive } —
  make the towncenter monumental and the six kinds distinguishable at a glance.
- ambience: { particles: embers|mist|snow|spores|dust|rain|none, tint, rate 0-1,
  optional skyEvents { kind: flare|drift|aurora|birds, everySec 20-120 } }.
- units: { villagerTint, heroTint, raiderTint, gaitBounce 0-1 } — tints multiply the
  figure sprites, so keep them bright-ish; gaitBounce is how springy the walk is.
- version must be the number 1.
When worldSpec is present it supplies terrain, props, and building geometry, so the
tree and building pixel sprites become optional — but villager/hero/raider sprites are
still required.`;

export async function generateTheme(opts: {
  apiKey: string;
  model: string;
  llm?: { baseURL: string; headers?: Record<string, string> };
  repoLabel: string;
  readme: string;
  treeSummary: string;
  /** Measured code facts (censusBrief) — the Law of Isomorphism's evidence. */
  censusBrief?: string;
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
                  archetype: {
                    type: "string",
                    enum: ["ash-steppe", "harbor-citadel", "oracle-forge", "glacier-vault", "verdant-ruin", "dune-monolith"],
                  },
                },
                required: ["grassColors", "fogColor", "accentColor", "archetype"],
              },
              world: {
                type: "object",
                description: "Isomorphism sharpeners; every choice must express a census fact.",
                properties: {
                  timeOfDay: { type: "string", enum: ["dawn", "noon", "dusk", "night"] },
                  vegetation: { type: "string", enum: ["barren", "sparse", "wooded", "lush"] },
                  worldLore: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { subject: { type: "string" }, line: { type: "string" } },
                      required: ["subject", "line"],
                    },
                    description: "3-6 examine-lore lines that cite census numbers",
                  },
                },
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
              worldSpec: {
                type: "object",
                description:
                  "Composed world geometry per the worldSpec rules in the system prompt (version, lore, sky, terrain, props, architecture, ambience, units).",
                properties: {
                  version: { type: "number", enum: [1] },
                  lore: {
                    type: "object",
                    properties: {
                      placeName: { type: "string" },
                      epithet: { type: "string" },
                      loadingLines: { type: "array", items: { type: "string" } },
                    },
                    required: ["placeName", "epithet", "loadingLines"],
                  },
                  sky: {
                    type: "object",
                    properties: {
                      top: { type: "string" },
                      horizon: { type: "string" },
                      hazeAlpha: { type: "number" },
                    },
                    required: ["top", "horizon", "hazeAlpha"],
                  },
                  terrain: {
                    type: "object",
                    properties: {
                      base: { type: "array", items: { type: "string" } },
                      pattern: { type: "string", enum: ["plates", "dunes", "floes", "moss", "tessellae", "shale"] },
                      reliefIntensity: { type: "number" },
                      waterline: {
                        type: "object",
                        properties: { color: { type: "string" }, coverage: { type: "number" } },
                        required: ["color", "coverage"],
                      },
                    },
                    required: ["base", "pattern", "reliefIntensity"],
                  },
                  props: { type: "array", items: { type: "object" } },
                  architecture: { type: "object" },
                  ambience: { type: "object" },
                  units: { type: "object" },
                },
                required: ["version", "lore", "sky", "terrain", "props", "architecture", "ambience", "units"],
              },
            },
            required: [
              "factionName", "tagline", "kingName", "enemyName", "biome",
              "heraldOpeners", "heraldClosers", "personas", "sprites", "worldSpec",
            ],
          },
        },
      ],
      tool_choice: { type: "tool", name: "set_theme" },
      messages: [
        {
          role: "user",
          content: `Repository: ${opts.repoLabel}

CODE CENSUS (measured — the land must express these facts):
${opts.censusBrief ?? "(census unavailable — derive temperament from the tree)"}

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
    if (parsed.success) return parsed.data;
    // Never fail the whole theme because the worldSpec was bad: strip it and retry.
    if ("worldSpec" in candidate) {
      const { worldSpec: _dropped, ...rest } = candidate;
      const retry = ThemePack.safeParse(rest);
      if (retry.success) {
        console.warn("worldSpec validation failed; keeping theme without it", parsed.error.issues.slice(0, 5));
        return retry.data;
      }
    }
    console.warn("theme validation failed", parsed.error.issues.slice(0, 5));
    return null;
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
  if (out.worldSpec && typeof out.worldSpec === "object") {
    out.worldSpec = normalizeWorldSpec(out.worldSpec as Record<string, unknown>);
  }
  return out;
}

/**
 * Round/clamp primitive numerics before strict validation — models emit
 * floats and slightly-out-of-range tilts far more often than bad structure.
 */
function normalizeWorldSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const fixPrimitive = (p: unknown): unknown => {
    if (!p || typeof p !== "object") return p;
    const prim = { ...(p as Record<string, unknown>) };
    if (typeof prim.w === "number") prim.w = clamp(Math.round(prim.w), 2, 48);
    if (typeof prim.h === "number") prim.h = clamp(Math.round(prim.h), 2, 72);
    if (typeof prim.tilt === "number") prim.tilt = clamp(prim.tilt, -30, 30);
    return prim;
  };
  const fixSilhouette = (o: unknown): unknown => {
    if (!o || typeof o !== "object") return o;
    const rec = { ...(o as Record<string, unknown>) };
    if (Array.isArray(rec.silhouette)) rec.silhouette = rec.silhouette.map(fixPrimitive);
    return rec;
  };
  const out = { ...spec };
  if (Array.isArray(out.props)) out.props = out.props.map(fixSilhouette);
  if (out.architecture && typeof out.architecture === "object") {
    out.architecture = Object.fromEntries(
      Object.entries(out.architecture as Record<string, unknown>).map(([k, v]) => [k, fixSilhouette(v)]),
    );
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
