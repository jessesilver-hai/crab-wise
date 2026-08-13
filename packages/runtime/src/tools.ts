import type Anthropic from "@anthropic-ai/sdk";
import { buildingKindFor, type CommandKind } from "@agent-empires/protocol";
import { Emitter } from "./emitter.js";
import { parseTestOutput } from "./testparse.js";
import { heraldBattleCry, heraldVictoryTests, heraldMessage, type HeraldLexicon } from "./herald.js";
import type { Executor } from "./executor.js";

export const WORKER_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a file from the repository. Returns the full contents (large files truncated).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to repo root" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given contents. Always write the complete file.",
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

export type ToolContext = {
  exec: Executor;
  emitter: Emitter;
  agentId: string;
  agentName: string;
  lexicon: () => HeraldLexicon | undefined;
  sendMessage: (from: string, to: string | undefined, text: string) => void;
  stats: {
    filesRead: Set<string>;
    filesWritten: Set<string>;
    maxFailuresSeen: number;
    lastFailedCount: number;
    lastTestGreen: boolean;
  };
};

const MAX_TOOL_RESULT_CHARS = 12_000;

function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : text;
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
      return clip(content);
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

      const { exitCode, output, timedOut } = await exec.exec(command);
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
      emitter.emit("log", { agentId, level: "tool", text: `${command} → exit ${exitCode} (${summary})` });
      return clip(`exit code: ${exitCode}${timedOut ? " (timed out)" : ""}\n${output}`);
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
