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

/** One divination attempt: a theme, or the evidence needed to mend the next try. */
export type ThemeAttempt = {
  theme: ThemePack | null;
  /** "path: problem" lines from the first failing validation (or the transport error). */
  issues?: string;
  /** The failed candidate, so a mend pass can repair it instead of re-rolling. */
  candidate?: Record<string, unknown>;
};

export async function generateTheme(opts: {
  apiKey: string;
  model: string;
  llm?: { baseURL: string; headers?: Record<string, string> };
  repoLabel: string;
  readme: string;
  treeSummary: string;
  /** Measured code facts (censusBrief) — the Law of Isomorphism's evidence. */
  censusBrief?: string;
  /** A prior failed attempt; when present this call asks the model to repair it. */
  mend?: { candidate: Record<string, unknown>; issues: string };
}): Promise<ThemeAttempt> {
  const client = new Anthropic({
    apiKey: opts.apiKey || "crown-funded",
    dangerouslyAllowBrowser: true,
    baseURL: opts.llm?.baseURL,
    defaultHeaders: opts.llm?.headers,
    maxRetries: 1,
    timeout: 120_000, // a hung theme call must fall to the default pack, not stall founding
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
          content:
            `Repository: ${opts.repoLabel}

CODE CENSUS (measured — the land must express these facts):
${opts.censusBrief ?? "(census unavailable — derive temperament from the tree)"}

README (truncated):
${opts.readme.slice(0, 5000) || "(no readme)"}

File tree:
${opts.treeSummary.slice(0, 3000)}

Deliver the theme via set_theme.` +
            (opts.mend
              ? `

MEND PASS. Your previous set_theme answer failed validation. The failed answer (JSON):
${JSON.stringify(opts.mend.candidate).slice(0, 50_000)}

Exactly these issues (path: problem):
${opts.mend.issues}

Fix ONLY what the issues name, keep every other field identical, and deliver the complete corrected theme via set_theme.`
              : ""),
        },
      ],
    });

    const call = response.content.find((b) => b.type === "tool_use");
    if (!call || call.type !== "tool_use") return { theme: null, issues: "the model returned no set_theme call" };
    const candidate = normalizeCandidate(call.input as Record<string, unknown>);
    // Never fail the whole theme over optional garnish: strip world, then
    // worldSpec, then both, keeping the first shape that validates.
    const drop = (obj: Record<string, unknown>, keys: string[]) =>
      Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
    const attempts: [string, Record<string, unknown>][] = [
      ["full", candidate],
      ["world", drop(candidate, ["world"])],
      ["worldSpec", drop(candidate, ["worldSpec"])],
      ["world+worldSpec", drop(candidate, ["world", "worldSpec"])],
    ];
    let firstIssues: string | null = null;
    for (const [dropped, shape] of attempts) {
      const parsed = ThemePack.safeParse(shape);
      if (parsed.success) {
        if (dropped !== "full") console.warn(`theme validated after dropping ${dropped}`, firstIssues);
        return { theme: parsed.data };
      }
      if (firstIssues === null) {
        firstIssues = parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
      }
    }
    console.warn("theme validation failed", firstIssues);
    return { theme: null, issues: firstIssues ?? "unknown validation failure", candidate };
  } catch (err) {
    console.warn("theme generation failed", err);
    return { theme: null, issues: `the oracle was unreachable (${String((err as Error).message ?? err).slice(0, 120)})` };
  }
}

const ARCHETYPE_VALUES = ["ash-steppe", "harbor-citadel", "oracle-forge", "glacier-vault", "verdant-ruin", "dune-monolith"];

/** "#8a7" → "#88aa77", "8a7c5e" → "#8a7c5e", "#rrggbbaa" → "#rrggbb"; else null. */
export function fixHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + [...s.slice(1)].map((c) => c + c).join("");
  if (/^#[0-9a-f]{8}$/.test(s)) s = s.slice(0, 7);
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

const trimS = (v: unknown, max: number): unknown => (typeof v === "string" ? v.trim().slice(0, max) : v);
const clampN = (v: unknown, lo: number, hi: number): unknown =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : v;
/** Lowercase/kebab a near-miss enum value; alien values pass through to fail visibly. */
const coerceEnum = (v: unknown, allowed: readonly string[]): unknown => {
  if (typeof v !== "string") return v;
  const norm = v.toLowerCase().trim().replace(/[\s_]+/g, "-");
  return allowed.includes(norm) ? norm : v;
};

/** Repair common LLM slop before strict validation. The model's intent is
 *  kept wherever a lawful reading exists (trim, clamp, kebab, hex-mend);
 *  what cannot be read lawfully is dropped or left to fail visibly. */
export function normalizeCandidate(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  // Bounded prose: the schema's caps are hard, the model's drafts run long.
  out.factionName = trimS(out.factionName, 60);
  out.tagline = trimS(out.tagline, 160);
  out.kingName = trimS(out.kingName, 48);
  out.enemyName = trimS(out.enemyName, 32);
  for (const k of ["heraldOpeners", "heraldClosers"] as const) {
    if (Array.isArray(out[k])) {
      out[k] = (out[k] as unknown[])
        .map((s) => trimS(s, 60))
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .slice(0, 8);
    }
  }
  if (Array.isArray(out.personas)) {
    out.personas = (out.personas as unknown[])
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        return { name: trimS(o.name ?? "", 40), title: trimS(o.title ?? "", 48), quirk: trimS(o.quirk ?? "", 120) };
      })
      .filter((p) => p.name && p.title && p.quirk)
      .slice(0, 8);
  }
  // biome.archetype is load-bearing (it steers the world form): coerce close
  // misses ("Ash Steppe", "harbor_citadel") and drop inventions entirely.
  if (out.biome && typeof out.biome === "object") {
    const b = { ...(out.biome as Record<string, unknown>) };
    if (typeof b.archetype === "string") {
      const norm = coerceEnum(b.archetype, ARCHETYPE_VALUES);
      if (typeof norm === "string" && ARCHETYPE_VALUES.includes(norm)) b.archetype = norm;
      else delete b.archetype;
    } else if (b.archetype !== undefined) delete b.archetype;
    if (Array.isArray(b.grassColors)) {
      const fixed = (b.grassColors as unknown[]).map(fixHex).filter((c): c is string => c !== null);
      if (fixed.length >= 2) b.grassColors = fixed.slice(0, 6);
    }
    for (const k of ["fogColor", "accentColor"] as const) {
      const fixed = fixHex(b[k]);
      if (fixed) b[k] = fixed;
    }
    out.biome = b;
  }
  // world block: keep only what validates; a hopeless block is dropped, never fatal.
  if (out.world && typeof out.world === "object" && !Array.isArray(out.world)) {
    const w = { ...(out.world as Record<string, unknown>) };
    w.timeOfDay = coerceEnum(w.timeOfDay, ["dawn", "noon", "dusk", "night"]);
    w.vegetation = coerceEnum(w.vegetation, ["barren", "sparse", "wooded", "lush"]);
    if (!["dawn", "noon", "dusk", "night"].includes(w.timeOfDay as string)) delete w.timeOfDay;
    if (!["barren", "sparse", "wooded", "lush"].includes(w.vegetation as string)) delete w.vegetation;
    if (Array.isArray(w.worldLore)) {
      const lore = (w.worldLore as unknown[])
        .map((item) => {
          const o = (item ?? {}) as Record<string, unknown>;
          return { subject: String(o.subject ?? "").slice(0, 40), line: String(o.line ?? "").slice(0, 200) };
        })
        .filter((l) => l.subject.length > 0 && l.line.length > 0)
        .slice(0, 10);
      if (lore.length > 0) w.worldLore = lore;
      else delete w.worldLore;
    } else if (w.worldLore !== undefined) delete w.worldLore;
    for (const k of Object.keys(w)) {
      if (!["timeOfDay", "vegetation", "worldLore"].includes(k)) delete w[k];
    }
    out.world = w;
  } else if (out.world !== undefined) {
    delete out.world;
  }
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
              .map(([k, v]) => [k, fixHex(v)] as const)
              .filter((e): e is readonly [string, string] => e[0].length === 1 && e[1] !== null),
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

const PRIMITIVE_SHAPES = ["slab", "obelisk", "arch", "mast", "orb", "shard", "frond", "coil", "ring", "beam"];

/**
 * Mend the whole worldSpec before strict validation — models emit floats,
 * out-of-range numerics, shorthand hex, and Title Case enums far more often
 * than bad structure. Unsalvageable pieces (a prop, a building) are dropped
 * so one bad limb never costs the whole spec.
 */
export function normalizeWorldSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const fixPrimitive = (p: unknown): Record<string, unknown> | null => {
    if (!p || typeof p !== "object") return null;
    const prim = { ...(p as Record<string, unknown>) };
    prim.shape = coerceEnum(prim.shape, PRIMITIVE_SHAPES);
    if (!PRIMITIVE_SHAPES.includes(prim.shape as string)) return null;
    const color = fixHex(prim.color);
    if (!color) return null;
    prim.color = color;
    if (typeof prim.w !== "number" || typeof prim.h !== "number") return null;
    prim.w = clampN(Math.round(prim.w), 2, 48);
    prim.h = clampN(Math.round(prim.h), 2, 72);
    prim.tilt = typeof prim.tilt === "number" ? clampN(prim.tilt, -30, 30) : 0;
    return prim;
  };
  const fixGlow = (g: unknown): Record<string, unknown> | undefined => {
    if (!g || typeof g !== "object") return undefined;
    const glow = { ...(g as Record<string, unknown>) };
    const color = fixHex(glow.color);
    if (!color) return undefined;
    glow.color = color;
    glow.pulseSec = clampN(glow.pulseSec, 2, 20);
    return glow;
  };
  const out = { ...spec };
  if (out.version === "1") out.version = 1;
  if (out.lore && typeof out.lore === "object") {
    const l = { ...(out.lore as Record<string, unknown>) };
    l.placeName = trimS(l.placeName, 60);
    l.epithet = trimS(l.epithet, 200);
    if (Array.isArray(l.loadingLines)) {
      l.loadingLines = (l.loadingLines as unknown[])
        .map((s) => trimS(s, 160))
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .slice(0, 6);
    }
    out.lore = l;
  }
  if (out.sky && typeof out.sky === "object") {
    const s = { ...(out.sky as Record<string, unknown>) };
    for (const k of ["top", "horizon"] as const) {
      const fixed = fixHex(s[k]);
      if (fixed) s[k] = fixed;
    }
    s.hazeAlpha = clampN(s.hazeAlpha, 0, 0.5);
    out.sky = s;
  }
  if (out.terrain && typeof out.terrain === "object") {
    const t = { ...(out.terrain as Record<string, unknown>) };
    if (Array.isArray(t.base)) {
      const fixed = (t.base as unknown[]).map(fixHex).filter((c): c is string => c !== null);
      if (fixed.length >= 3) t.base = fixed.slice(0, 6);
    }
    t.pattern = coerceEnum(t.pattern, ["plates", "dunes", "floes", "moss", "tessellae", "shale"]);
    t.reliefIntensity = clampN(t.reliefIntensity, 0, 1);
    if (t.waterline && typeof t.waterline === "object") {
      const w = { ...(t.waterline as Record<string, unknown>) };
      const color = fixHex(w.color);
      if (color) {
        w.color = color;
        w.coverage = clampN(w.coverage, 0, 0.35);
        t.waterline = w;
      } else delete t.waterline;
    }
    out.terrain = t;
  }
  if (Array.isArray(out.props)) {
    out.props = (out.props as unknown[])
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        const prop = { ...(p as Record<string, unknown>) };
        const sil = Array.isArray(prop.silhouette)
          ? (prop.silhouette as unknown[]).map(fixPrimitive).filter((x): x is Record<string, unknown> => x !== null).slice(0, 6)
          : [];
        if (sil.length === 0) return null;
        prop.silhouette = sil;
        prop.density = clampN(prop.density, 0, 1);
        prop.placement = coerceEnum(prop.placement, ["ridges", "edges", "scatter", "districts"]);
        const glow = fixGlow(prop.glow);
        if (glow) prop.glow = glow;
        else delete prop.glow;
        return prop;
      })
      .filter((p): p is Record<string, unknown> => p !== null)
      .slice(0, 12);
  }
  if (out.architecture && typeof out.architecture === "object") {
    const kinds = ["house", "barracks", "market", "monastery", "mill", "towncenter"];
    const arch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.architecture as Record<string, unknown>)) {
      if (!kinds.includes(k) || !v || typeof v !== "object") continue;
      const piece = { ...(v as Record<string, unknown>) };
      const sil = Array.isArray(piece.silhouette)
        ? (piece.silhouette as unknown[]).map(fixPrimitive).filter((x): x is Record<string, unknown> => x !== null).slice(0, 5)
        : [];
      const roof = fixHex(piece.roofColor);
      const wall = fixHex(piece.wallColor);
      if (sil.length === 0 || !roof || !wall) continue;
      piece.silhouette = sil;
      piece.roofColor = roof;
      piece.wallColor = wall;
      const emissive = fixHex(piece.emissive);
      if (emissive) piece.emissive = emissive;
      else delete piece.emissive;
      arch[k] = piece;
    }
    out.architecture = arch;
  }
  if (out.ambience && typeof out.ambience === "object") {
    const a = { ...(out.ambience as Record<string, unknown>) };
    a.particles = coerceEnum(a.particles, ["embers", "mist", "snow", "spores", "dust", "rain", "none"]);
    const tint = fixHex(a.tint);
    if (tint) a.tint = tint;
    a.rate = clampN(a.rate, 0, 1);
    if (a.skyEvents && typeof a.skyEvents === "object") {
      const se = { ...(a.skyEvents as Record<string, unknown>) };
      se.kind = coerceEnum(se.kind, ["flare", "drift", "aurora", "birds"]);
      se.everySec = clampN(se.everySec, 20, 120);
      if (["flare", "drift", "aurora", "birds"].includes(se.kind as string)) a.skyEvents = se;
      else delete a.skyEvents;
    }
    out.ambience = a;
  }
  if (out.units && typeof out.units === "object") {
    const u = { ...(out.units as Record<string, unknown>) };
    for (const k of ["villagerTint", "heroTint", "raiderTint"] as const) {
      const fixed = fixHex(u[k]);
      if (fixed) u[k] = fixed;
    }
    u.gaitBounce = clampN(u.gaitBounce, 0, 1);
    out.units = u;
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
  const attempt = await generateTheme(opts);
  if (attempt.theme) await putCachedTheme(key, attempt.theme);
  return { theme: attempt.theme, fromCache: false };
}
