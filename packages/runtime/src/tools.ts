import type Anthropic from "@anthropic-ai/sdk";
import { buildingKindFor, type CommandKind } from "@agent-empires/protocol";
import { Emitter } from "./emitter.js";
import { parseTestOutput } from "./testparse.js";
import { heraldBattleCry, heraldVictoryTests, heraldMessage, type HeraldLexicon } from "./herald.js";
import type { Executor } from "./executor.js";

export const WORKER_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read a file from the repository. Optionally pass start_line/end_line to read a range (1-based, inclusive). Large output is truncated head+tail.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to repo root" },
        start_line: { type: "number", description: "First line to read (1-based)" },
        end_line: { type: "number", description: "Last line to read (inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact snippet in a file. old_text must match the file contents exactly and appear exactly once — include enough surrounding lines to make it unique. Preferred over write_file for changes to existing files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string", description: "Exact existing text to replace (must be unique in the file)" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file, or fully overwrite an existing one, with the given contents. Always write the complete file. For partial changes to existing files use edit_file instead.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List files and directories at a path. Use '.' for repo root.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "search",
    description: "Search all repository files for a literal string. Returns path:line matches.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the repo root (bash). Use it to install dependencies, run tests, builds, linters. Long output is truncated; commands time out after 3 minutes.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "delegate",
    description:
      "Dispatch a scout: a read-only sub-agent that explores the repository (read/list/search only) and answers one question, so large investigations don't fill your own memory. Use for questions like 'how does X work / where is Y handled / summarize module Z'. Budget: 3 per assignment.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "One self-contained question about the codebase" },
      },
      required: ["question"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a short message to a fellow agent (by name) or to everyone (omit `to`). Use it to coordinate: announce what you're starting, share discoveries, warn about conflicts.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent name; omit to broadcast" },
        text: { type: "string" },
      },
      required: ["text"],
    },
  },
];

/** Read-only exploration subset given to delegated scouts. */
export const SCOUT_TOOLS: Anthropic.Tool[] = WORKER_TOOLS.filter((t) =>
  ["read_file", "list_dir", "search"].includes(t.name),
);

export type ToolContext = {
  exec: Executor;
  emitter: Emitter;
  agentId: string;
  agentName: string;
  lexicon: () => HeraldLexicon | undefined;
  sendMessage: (from: string, to: string | undefined, text: string) => void;
  /** Spawn a read-only scout sub-agent; absent for scouts themselves (depth cap 1). */
  delegate?: (question: string, parentName: string) => Promise<string>;
  delegatesUsed: { count: number };
  stats: {
    filesRead: Set<string>;
    filesWritten: Set<string>;
    maxFailuresSeen: number;
    lastFailedCount: number;
    lastTestGreen: boolean;
  };
};

const MAX_TOOL_RESULT_CHARS = 12_000;

/** Truncate preserving head and tail — errors and summaries cluster at the ends. */
function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return (
    text.slice(0, head) +
    `\n…[${(text.length - max).toLocaleString()} chars omitted — use read_file with start_line/end_line for the middle]…\n` +
    text.slice(text.length - tail)
  );
}

/** ±-prefixed excerpt of a change, capped for the event stream. */
function snippetOf(oldText: string, newText: string, cap = 1800): string {
  const del = oldText ? oldText.split("\n").map((l) => "- " + l) : [];
  const add = newText ? newText.split("\n").map((l) => "+ " + l) : [];
  let s = [...del, ...add].join("\n");
  if (s.length > cap) s = s.slice(0, cap) + "\n…";
  return s;
}

export function commandKind(command: string): CommandKind {
  if (/\b(pytest|jest|vitest|mocha|--test|go test|cargo test|rspec|phpunit|npm (run )?test|yarn test|pnpm test|make test|tox)\b/.test(command)) {
    return "test";
  }
  if (/\b(npm (ci|i|install)|yarn( install)?$|pnpm (i|install)|pip3? install|poetry install|bundle install|cargo build|go mod|uv (sync|pip))\b/.test(command)) {
    return "install";
  }
  return "other";
}

/** Executes one tool call, emits the matching game events, returns the tool result text. */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const { exec, emitter, agentId } = ctx;

  switch (name) {
    case "read_file": {
      const path = String(input.path ?? "");
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("agent_status", { agentId, status: "scouting" });
      const { content, lines } = await exec.read(path);
      ctx.stats.filesRead.add(path);
      emitter.emit("file_read", { agentId, path, lines });
      emitter.emit("log", { agentId, level: "tool", text: `read_file ${path} (${lines} lines)` });
      const start = input.start_line ? Math.max(1, Math.floor(Number(input.start_line))) : undefined;
      const end = input.end_line ? Math.floor(Number(input.end_line)) : undefined;
      if (start !== undefined || end !== undefined) {
        const all = content.split("\n");
        const s = (start ?? 1) - 1;
        const e = Math.min(end ?? all.length, all.length);
        if (s >= all.length) return `Tool error: start_line ${start} is past the end (${all.length} lines).`;
        return clip(`[lines ${s + 1}-${e} of ${all.length}]\n` + all.slice(s, e).join("\n"));
      }
      return clip(content);
    }

    case "edit_file": {
      const path = String(input.path ?? "");
      const oldText = String(input.old_text ?? "");
      const newText = String(input.new_text ?? "");
      if (!oldText) return "Tool error: old_text must not be empty (use write_file to create files).";
      const { content } = await exec.read(path);
      const count = content.split(oldText).length - 1;
      if (count === 0) {
        return `Tool error: old_text not found in ${path}. Read the file and copy the snippet exactly (whitespace matters).`;
      }
      if (count > 1) {
        return `Tool error: old_text appears ${count} times in ${path}; include more surrounding lines to make it unique.`;
      }
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("agent_status", { agentId, status: "building" });
      const { newLines } = await exec.write(path, content.replace(oldText, newText));
      const added = newText ? newText.split("\n").length : 0;
      const removed = oldText.split("\n").length;
      ctx.stats.filesWritten.add(path);
      emitter.emit("file_write", {
        agentId,
        path,
        created: false,
        linesAdded: added,
        linesRemoved: removed,
        buildingKind: buildingKindFor(path),
        diffSnippet: snippetOf(oldText, newText),
      });
      emitter.emit("log", { agentId, level: "tool", text: `edit_file ${path} (~+${added}/−${removed})` });
      return `Edited ${path}: replaced ${removed} line(s) with ${added} (file now ${newLines} lines).`;
    }

    case "write_file": {
      const path = String(input.path ?? "");
      const content = String(input.content ?? "");
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("agent_status", { agentId, status: "building" });
      const { created, oldLines, newLines } = await exec.write(path, content);
      // Line-count approximation: the true diff lives in the sandbox's git.
      const added = created ? newLines : Math.max(newLines - oldLines, 1);
      const removed = created ? 0 : Math.max(oldLines - newLines, newLines === oldLines ? 1 : 0);
      ctx.stats.filesWritten.add(path);
      emitter.emit("file_write", {
        agentId,
        path,
        created,
        linesAdded: added,
        linesRemoved: removed,
        buildingKind: buildingKindFor(path),
        diffSnippet: created ? snippetOf("", content.split("\n").slice(0, 24).join("\n")) : undefined,
      });
      emitter.emit("log", {
        agentId,
        level: "tool",
        text: `write_file ${path} (${newLines} lines${created ? ", new" : ""})`,
      });
      return `Wrote ${path} (${newLines} lines).`;
    }

    case "list_dir": {
      const path = String(input.path ?? ".");
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("list_dir", { agentId, path });
      const entries = await exec.list(path);
      emitter.emit("log", { agentId, level: "tool", text: `list_dir ${path}` });
      return entries.join("\n") || "(empty)";
    }

    case "search": {
      const query = String(input.query ?? "");
      emitter.emit("agent_status", { agentId, status: "scouting" });
      const hits = await exec.search(query);
      const paths = [...new Set(hits.map((h) => h.split(":")[0]!))].slice(0, 20);
      emitter.emit("search", { agentId, query, matchCount: hits.length, paths });
      emitter.emit("log", { agentId, level: "tool", text: `search "${query}" → ${hits.length} hits` });
      return hits.length ? clip(hits.join("\n")) : "No matches.";
    }

    case "run_command": {
      const command = String(input.command ?? "").trim();
      const kind = commandKind(command);
      emitter.emit("agent_status", { agentId, status: kind === "test" ? "fighting" : "building" });
      emitter.emit("command_run", { agentId, command, kind });

      const startedAt = Date.now();
      const { exitCode, output, timedOut } = await exec.exec(command);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      let summary = timedOut ? "timed out" : exitCode === 0 ? "succeeded" : `exited ${exitCode}`;
      let testsFailed: number | undefined;
      let testsPassed: number | undefined;
      let failures: { name: string; path?: string }[] | undefined;

      if (kind === "test") {
        const result = parseTestOutput(output, exitCode);
        testsFailed = result.failed;
        testsPassed = result.passed;
        failures = result.failures;
        summary = `${result.failed} failed, ${result.passed} passed`;
        ctx.stats.maxFailuresSeen = Math.max(ctx.stats.maxFailuresSeen, result.failed);
        ctx.stats.lastFailedCount = result.failed;
        ctx.stats.lastTestGreen = exitCode === 0;
        emitter.emit("log", {
          agentId,
          level: "info",
          text:
            result.failed > 0
              ? heraldBattleCry(result.failed, ctx.lexicon())
              : heraldVictoryTests(result.passed, ctx.lexicon()),
        });
      }
      emitter.emit("command_result", {
        agentId,
        command,
        kind,
        exitCode,
        summary,
        testsFailed,
        testsPassed,
        failures,
      });
      emitter.emit("log", { agentId, level: "tool", text: `${command} → exit ${exitCode} (${summary}, ${secs}s)` });
      return clip(`exit code: ${exitCode}${timedOut ? " (timed out)" : ""} · ${secs}s\n${output}`);
    }

    case "delegate": {
      const question = String(input.question ?? "").trim();
      if (!question) return "Tool error: question is required.";
      if (!ctx.delegate) return "Tool error: scouts cannot delegate further (depth limit).";
      if (ctx.delegatesUsed.count >= 3) return "Tool error: delegation budget exhausted (3 per assignment).";
      ctx.delegatesUsed.count++;
      emitter.emit("log", { agentId, level: "tool", text: `delegate → "${question.slice(0, 140)}"` });
      const answer = await ctx.delegate(question, ctx.agentName);
      return clip(answer);
    }

    case "send_message": {
      const to = input.to ? String(input.to) : undefined;
      const text = String(input.text ?? "");
      ctx.sendMessage(ctx.agentName, to, text);
      emitter.emit("message", {
        fromId: agentId,
        toId: to,
        text,
        herald: heraldMessage(ctx.agentName, to, text, ctx.lexicon()),
      });
      return to ? `Message delivered to ${to}.` : "Message broadcast to all agents.";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
