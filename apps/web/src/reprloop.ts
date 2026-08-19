import Anthropic from "@anthropic-ai/sdk";
import { ALLOWED_FORMS } from "./game/castle.js";
import { componentBrief, type ComponentGraph } from "./game/components.js";
import {
  DOOR_STYLES,
  FOGS,
  FOOTPRINTS,
  GROUND_TONES,
  MATERIAL_FAMILIES,
  NATURE_SETS,
  PROP_SETS,
  ROOF_CAPS,
  ROOF_FORMS,
  ROOF_OVERHANGS,
  ROOF_PITCHES,
  TAPERS,
  TRIMS,
  validateStyleGenome,
  WALL_STYLES,
  WINDOW_STYLES,
  type StyleGenome,
} from "./game/genome.js";

/**
 * The representation loop — the Master Builder, second charter.
 *
 * Once the castle stands in its lawful derived dress, one Grok call may
 * declare the castle's DESIGN LANGUAGE (a named, cited StyleGenome) and
 * re-dress components: a lawful form and/or a design genome per component,
 * every choice citing a measured fact. Validation is merciless and silent:
 * unlawful forms are dropped, unlawful genome fields fall to the derived
 * default (client-side, in the genome law), uncited styles do not exist.
 * The castle never waits on this call and never breaks on its absence.
 */

export type ReprChoice = {
  componentId: string;
  form: string;
  cited: string;
  /** Raw design genome — validated field-by-field by the genome law. */
  genome?: Record<string, unknown>;
};

export type BuilderDecree = { style: StyleGenome | null; choices: ReprChoice[] };

const BUILDER_CREED = `You are the MASTER BUILDER of a living castle that IS a codebase.
Each component of the software is one construction. The mapping is a law of isomorphism:
players must be able to point at any element and hear a measured reason it looks that way.

You are given the measured component ledger (files, lines, routes, tables, palette) and the
design vocabulary. You wield two instruments:

1. THE STYLE — one castle-wide design language. Name it (your coinage), choose its biases
   (materials, roofs, trims), its grounds, wall, nature and fog, and CITE the measured
   temperament that demands it ("a static hand-inlined page wants warm timberwork",
   "strict TypeScript and zero deps read as obsidian discipline"). Choose for the code's
   true character, never the prettiest option.

2. THE CHOICES — per component: a lawful form (from its allowed list) and/or a design
   genome (footprint, storeys, roof, material, openings, ornament, dressing) where the
   facts argue for something the derived default would miss. Each choice carries ONE vivid
   citation (<= 200 chars) naming a real measured fact ("14 tables feed the shafts",
   "the palette runs #e86a33 — a baker's crust").

Rules:
- form MUST come from the component's allowed forms; genome fields MUST come from the
  design vocabulary. Anything else is silently discarded by law.
- The style MUST be named and cited or it does not exist.
- Storeys and banners are law-banded to measured facts; your values clamp.
- Skip what you have nothing sharp to say about; silence keeps the lawful derivation.
- At most one choice per component.`;

/** JSON-schema enum from a vocabulary list. */
const en = (vocab: readonly string[]) => ({ type: "string", enum: [...vocab] });

const GENOME_SCHEMA = {
  type: "object",
  properties: {
    footprint: en(FOOTPRINTS),
    storeys: { type: "integer", minimum: 1, maximum: 6 },
    bays: { type: "integer", minimum: 1, maximum: 5 },
    taper: en(TAPERS),
    roof: {
      type: "object",
      properties: {
        form: en(ROOF_FORMS),
        pitch: en(ROOF_PITCHES),
        overhang: en(ROOF_OVERHANGS),
        cap: en(ROOF_CAPS),
      },
    },
    material: {
      type: "object",
      properties: { family: en(MATERIAL_FAMILIES), trim: en(TRIMS) },
    },
    openings: {
      type: "object",
      properties: { windows: en(WINDOW_STYLES), door: en(DOOR_STYLES) },
    },
    ornament: {
      type: "object",
      properties: {
        crenellated: { type: "boolean" },
        buttresses: { type: "integer", minimum: 0, maximum: 4 },
        banners: { type: "integer", minimum: 0, maximum: 4 },
        glow: { type: "boolean" },
        smoke: { type: "boolean" },
      },
    },
    dressing: {
      type: "object",
      properties: { propSet: en(PROP_SETS), density: { type: "integer", minimum: 0, maximum: 3 } },
    },
  },
} as const;

const STYLE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 48 },
    cited: { type: "string", maxLength: 240 },
    materialBias: { type: "array", items: en(MATERIAL_FAMILIES), maxItems: 3 },
    roofBias: { type: "array", items: en(ROOF_FORMS), maxItems: 3 },
    trimBias: { type: "array", items: en(TRIMS), maxItems: 3 },
    natureSet: en(NATURE_SETS),
    wallStyle: en(WALL_STYLES),
    groundTone: en(GROUND_TONES),
    fog: en(FOGS),
  },
  required: ["name", "cited"],
} as const;

export async function generateRepresentation(opts: {
  apiKey: string;
  model: string;
  llm?: { baseURL: string; headers?: Record<string, string> };
  graph: ComponentGraph;
}): Promise<BuilderDecree | null> {
  const { graph } = opts;
  const client = new Anthropic({
    apiKey: opts.apiKey || "crown-funded",
    dangerouslyAllowBrowser: true,
    baseURL: opts.llm?.baseURL,
    defaultHeaders: opts.llm?.headers,
    maxRetries: 1,
    timeout: 60_000, // a hung call must become the lawful null, not a stalled decree
  });

  const vocab = graph.components
    .map((c) => `- ${c.id} (${c.kind}) may stand as: ${ALLOWED_FORMS[c.kind].join(", ")}`)
    .join("\n");
  const prompt =
    `THE MEASURED LEDGER\n${componentBrief(graph)}\n\n` +
    `LAWFUL FORMS PER COMPONENT\n${vocab}\n\n` +
    `DESIGN VOCABULARY\n` +
    `footprints: ${FOOTPRINTS.join(", ")}\nroofs: ${ROOF_FORMS.join(", ")} (pitch ${ROOF_PITCHES.join("/")}, overhang ${ROOF_OVERHANGS.join("/")}, cap ${ROOF_CAPS.join("/")})\n` +
    `materials: ${MATERIAL_FAMILIES.join(", ")} (trim ${TRIMS.join("/")})\n` +
    `windows: ${WINDOW_STYLES.join(", ")}; doors: ${DOOR_STYLES.join(", ")}\n` +
    `prop sets: ${PROP_SETS.join(", ")}\n` +
    `style grounds: ${GROUND_TONES.join(", ")}; walls: ${WALL_STYLES.join(", ")}; nature: ${NATURE_SETS.join(", ")}; fog: ${FOGS.join(", ")}\n\n` +
    `Declare the style and submit your choices with the represent_castle tool.`;

  try {
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: 6000,
      system: BUILDER_CREED,
      tools: [
        {
          name: "represent_castle",
          description: "Deliver the Master Builder's style declaration and representation choices.",
          input_schema: {
            type: "object",
            properties: {
              style: STYLE_SCHEMA as unknown as Record<string, unknown>,
              choices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    componentId: { type: "string" },
                    form: { type: "string" },
                    cited: { type: "string" },
                    genome: GENOME_SCHEMA as unknown as Record<string, unknown>,
                  },
                  required: ["componentId", "cited"],
                },
              },
            },
            required: ["choices"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "represent_castle" },
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    const raw = block && block.type === "tool_use" ? (block.input as { style?: unknown; choices?: unknown }) : null;
    // { style: null, choices: [] } is a lawful answer; null means the call failed
    return {
      style: validateStyleGenome(raw?.style),
      choices: lawfulChoices(raw?.choices, graph),
    };
  } catch {
    return null;
  }
}

/** Drop everything unlawful; keep at most one choice per component. */
export function lawfulChoices(raw: unknown, graph: ComponentGraph): ReprChoice[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(graph.components.map((c) => [c.id, c]));
  const out: ReprChoice[] = [];
  const taken = new Set<string>();
  for (const item of raw) {
    if (out.length >= 24) break;
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const id = typeof c.componentId === "string" ? c.componentId : "";
    const cited = typeof c.cited === "string" ? c.cited.trim().slice(0, 240) : "";
    const comp = byId.get(id);
    if (!comp || taken.has(id) || !cited) continue;
    const allowed = ALLOWED_FORMS[comp.kind] as readonly string[];
    const genome =
      typeof c.genome === "object" && c.genome !== null && !Array.isArray(c.genome)
        ? (c.genome as Record<string, unknown>)
        : undefined;
    // a choice must carry a lawful form or a genome; a bare citation is noise.
    // form "" = genome-only: the publisher fills in the component's CURRENT
    // form so the decree never accidentally reverts an earlier re-dress.
    const form = typeof c.form === "string" && allowed.includes(c.form.trim()) ? c.form.trim() : "";
    if (!form && !genome) continue;
    taken.add(id);
    out.push({ componentId: id, form, cited, ...(genome ? { genome } : {}) });
  }
  return out;
}
