import Anthropic from "@anthropic-ai/sdk";
import type { AgentRole } from "@agent-empires/protocol";
import { Emitter } from "./emitter.js";
import { executeTool, ToolContext, WORKER_TOOLS } from "./tools.js";

const MAX_TURNS = 28;
const CONTEXT_MAX_TOKENS = 200_000;
const COMPACTION_THRESHOLD_TOKENS = 60_000;

export type Inbox = { drain(): { from: string; text: string }[] };

export class Agent {
  private history: Anthropic.MessageParam[] = [];
  private matchTokens: { total: number };

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly role: AgentRole,
    private client: Anthropic,
    private model: string,
    private emitter: Emitter,
    private toolCtx: ToolContext,
    private inbox: Inbox,
    matchTokens: { total: number },
    private signal?: AbortSignal,
  ) {
    this.matchTokens = matchTokens;
  }

  /** Run the tool-use loop until the agent stops calling tools or hits limits. */
  async run(systemPrompt: string, brief: string): Promise<string> {
    this.history.push({ role: "user", content: brief });
    let finalText = "";

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.signal?.aborted) throw new Error("match aborted");

      // Deliver queued inter-agent mail before thinking.
      const mail = this.inbox.drain();
      if (mail.length > 0) {
        this.history.push({
          role: "user",
          content: mail.map((m) => `[Message from ${m.from}]: ${m.text}`).join("\n"),
        });
      }

      this.emitter.emit("agent_status", { agentId: this.id, status: "thinking" });

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: WORKER_TOOLS,
        messages: this.history,
      });

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      this.matchTokens.total += inputTokens + outputTokens;
      this.emitter.emit("tokens", {
        agentId: this.id,
        inputTokens,
        outputTokens,
        matchTotalTokens: this.matchTokens.total,
      });
      this.emitter.emit("context", {
        agentId: this.id,
        usedTokens: inputTokens,
        maxTokens: CONTEXT_MAX_TOKENS,
      });

      this.history.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const texts = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      for (const t of texts) {
        if (t.text.trim()) {
          finalText = t.text;
          this.emitter.emit("log", {
            agentId: this.id,
            level: "info",
            text: `${this.name}: ${t.text.slice(0, 400)}`,
          });
        }
      }

      if (toolUses.length === 0) break; // end_turn: agent considers itself done

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        let result: string;
        try {
          result = await executeTool(this.toolCtx, call.name, call.input as Record<string, unknown>);
        } catch (err) {
          result = `Tool error: ${String(err)}`;
          this.emitter.emit("log", { agentId: this.id, level: "error", text: result });
        }
        results.push({ type: "tool_result", tool_use_id: call.id, content: result });
      }
      this.history.push({ role: "user", content: results });

      if (inputTokens > COMPACTION_THRESHOLD_TOKENS) this.compact();
    }

    this.emitter.emit("agent_status", { agentId: this.id, status: "done" });
    return finalText;
  }

  /**
   * Blank out old tool results to shed context weight. The villager walks
   * back to the Town Center for a meal while the scribe archives the scrolls.
   */
  private compact(): void {
    const keepRecent = 6;
    let compacted = false;
    const cutoff = Math.max(0, this.history.length - keepRecent);
    for (let i = 0; i < cutoff; i++) {
      const msg = this.history[i]!;
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (
          typeof block === "object" &&
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > 200
        ) {
          block.content = "[archived by the royal scribe to save parchment]";
          compacted = true;
        }
      }
    }
    if (compacted) {
      this.emitter.emit("compaction", { agentId: this.id });
      this.emitter.emit("agent_status", { agentId: this.id, status: "resting" });
    }
  }
}
