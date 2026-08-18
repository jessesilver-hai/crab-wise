import Anthropic from "@anthropic-ai/sdk";
import { ALLOWED_FORMS } from "./game/castle.js";
import { componentBrief, type ComponentGraph } from "./game/components.js";

/**
 * The representation loop — the Master Builder.
 *
 * Once the castle stands in its lawful default forms, one Grok call may
 * re-dress components creatively: every choice must come from the kind's
 * ALLOWED_FORMS and carry a one-line citation grounded in measured facts.
 * Unlawful or uncited choices are dropped — the default form already
 * standing IS the fallback. No retry loops beyond one re-ask; the castle
 * never waits on this.
 */

export type ReprChoice = { componentId: string; form: string; cited: string };

const BUILDER_CREED = `You are the MASTER BUILDER of a living castle that IS a codebase.
Each component of the software is one construction. The mapping is a law of isomorphism:
players must be able to point at any element and hear a measured reason it looks that way.

You are given the measured component ledger (files, lines, routes, tables, palette) and each
component's lawful form list. For each component where a non-default form (or a sharper reason
for the default) genuinely fits the facts, submit a choice with a ONE-LINE citation that names
a real measured fact ("14 tables feed 3 shafts", "the palette runs #e86a33").

Rules:
- form MUST be one of the component's allowed forms. Anything else is discarded.
- cited MUST be one vivid line (<= 200 chars) grounded in the ledger. No inventions.
- Skip components you have nothing sharp to say about; silence keeps the lawful default.
- At most one choice per component.`;

export async function generateRepresentation(opts: {
  apiKey: string;
  model: string;
  llm?: { baseURL: string; headers?: Record<string, string> };
  graph: ComponentGraph;
}): Promise<ReprChoice[] | null> {
  const { graph } = opts;
  const client = new Anthropic({
    apiKey: opts.apiKey || "crown-funded",
    dangerouslyAllowBrowser: true,
    baseURL: opts.llm?.baseURL,
    defaultHeaders: opts.llm?.headers,
  });

  const vocab = graph.components
    .map((c) => `- ${c.id} (${c.kind}) may stand as: ${ALLOWED_FORMS[c.kind].join(", ")}`)
    .join("\n");
  const prompt =
    `THE MEASURED LEDGER\n${componentBrief(graph)}\n\n` +
    `LAWFUL FORMS PER COMPONENT\n${vocab}\n\n` +
    `Submit your choices with the represent_castle tool.`;

  try {
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: 4000,
      system: BUILDER_CREED,
      tools: [
        {
          name: "represent_castle",
          description: "Deliver the Master Builder's representation choices.",
          input_schema: {
            type: "object",
            properties: {
              choices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    componentId: { type: "string" },
                    form: { type: "string" },
                    cited: { type: "string" },
                  },
                  required: ["componentId", "form", "cited"],
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
    const raw = block && block.type === "tool_use" ? (block.input as { choices?: unknown }) : null;
    // [] is a lawful answer (silence keeps defaults); null means the call failed
    return lawfulChoices(raw?.choices, graph);
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
    const form = typeof c.form === "string" ? c.form.trim() : "";
    const cited = typeof c.cited === "string" ? c.cited.trim().slice(0, 240) : "";
    const comp = byId.get(id);
    if (!comp || taken.has(id) || !cited) continue;
    const allowed = ALLOWED_FORMS[comp.kind] as readonly string[];
    if (!allowed.includes(form)) continue;
    taken.add(id);
    out.push({ componentId: id, form, cited });
  }
  return out;
}
