import Anthropic from "@anthropic-ai/sdk";
import type { AgentRole } from "@agent-empires/protocol";
import { Emitter } from "./emitter.js";
import { executeTool, ToolContext, WORKER_TOOLS } from "./tools.js";

const MAX_TURNS = 28;
const TURN_TIMEOUT_MS = 120_000; // one communion attempt; the SDK retries transport faults inside this
const MAX_STUMBLES = 2; // consecutive failed communions before the shift ends
const CONTEXT_MAX_TOKENS = 200_000;
const COMPACTION_THRESHOLD_TOKENS = 60_000;
const FOLD_THRESHOLD_TOKENS = 80_000;

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
    private tools: Anthropic.Tool[] = WORKER_TOOLS,
    private maxTurns: number = MAX_TURNS,
  ) {
    this.matchTokens = matchTokens;
  }

  /** Run the tool-use loop until the agent stops calling tools or hits limits. */
  async run(systemPrompt: string, brief: string): Promise<string> {
    this.history.push({ role: "user", content: brief });
    let finalText = "";
    let stumbles = 0;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (this.signal?.aborted) throw new Error("match aborted");

      // Deliver queued inter-agent mail before thinking. Merge into a trailing
      // user message when present: some providers reject non-alternating roles.
      const mail = this.inbox.drain();
      if (mail.length > 0) {
        const mailText = mail.map((m) => `[Message from ${m.from}]: ${m.text}`).join("\n");
        const last = this.history[this.history.length - 1];
        if (last?.role === "user") {
          if (typeof last.content === "string") last.content += "\n" + mailText;
          else last.content.push({ type: "text", text: mailText });
        } else {
          this.history.push({ role: "user", content: mailText });
        }
      }

      this.emitter.emit("agent_status", { agentId: this.id, status: "thinking" });

      // The veil law: no communion may hang the realm. Every attempt is
      // bounded, a failure is a visible stumble, and repeated stumbles end
      // the shift — the spectator must never watch an eternal ponder.
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            tools: this.tools,
            messages: this.history,
          },
          { timeout: TURN_TIMEOUT_MS, signal: this.signal },
        );
        stumbles = 0;
      } catch (err) {
        if (this.signal?.aborted) throw new Error("match aborted");
        stumbles++;
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 120);
        if (stumbles >= MAX_STUMBLES) {
          this.emitter.emit("log", {
            agentId: this.id,
            level: "error",
            text: `${this.name} cannot reach beyond the veil (${reason}) — the shift ends.`,
          });
          break;
        }
        this.emitter.emit("log", {
          agentId: this.id,
          level: "info",
          text: `${this.name} loses the thread beyond the veil (${reason}) — steadies for another attempt.`,
        });
        this.emitter.emit("agent_status", { agentId: this.id, status: "resting", detail: "shakes off a trance" });
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }

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

      // Orchestrator histories accrete every worker report across the whole
      // session: fold them into a durable chronicle (one cheap sub-call).
      // Workers are short-lived; blanking old tool results is enough.
      if (this.role === "orchestrator" && inputTokens > FOLD_THRESHOLD_TOKENS) {
        await this.fold().catch(() => this.compact());
      } else if (inputTokens > COMPACTION_THRESHOLD_TOKENS) {
        this.compact();
      }
    }

    this.emitter.emit("agent_status", { agentId: this.id, status: "done" });
    return finalText;
  }

  /**
   * RLM-style context folding for the orchestrator: distill everything but the
   * recent turns into a durable chronicle via one summarization sub-call, then
   * replace the old history with it. Falls back to compact() on failure.
   */
  private async fold(): Promise<void> {
    // Keep the recent tail, starting on an assistant message so roles alternate.
    let keepFrom = Math.max(1, this.history.length - 8);
    while (keepFrom < this.history.length && this.history[keepFrom]!.role !== "assistant") keepFrom++;
    if (keepFrom >= this.history.length || keepFrom <= 1) return this.compact();

    const folded = this.history.slice(0, keepFrom);
    const digestSource = JSON.stringify(folded);
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 900,
        system:
          "You are the royal scribe. Distill this working-session transcript into the durable facts the project lead must retain: what the repository is, files explored and changed (exact paths), decisions made, worker assignments and their outcomes, current test/build state, and open threads. Under 300 words, plain prose, no preamble.",
        messages: [{ role: "user", content: digestSource.slice(0, 240_000) }],
      },
      { timeout: 90_000 },
    );
    this.matchTokens.total += res.usage.input_tokens + res.usage.output_tokens;
    this.emitter.emit("tokens", {
      agentId: this.id,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      matchTotalTokens: this.matchTokens.total,
    });
    const digest = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!digest) return this.compact();
    this.history = [
      { role: "user", content: `[The royal scribe's chronicle of the session so far — durable context]\n${digest}` },
      ...this.history.slice(keepFrom),
    ];
    this.emitter.emit("compaction", { agentId: this.id });
    this.emitter.emit("agent_status", { agentId: this.id, status: "resting" });
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
