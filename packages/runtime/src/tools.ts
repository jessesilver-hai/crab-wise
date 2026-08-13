import type { WebContainer } from "@webcontainer/api";
import type Anthropic from "@anthropic-ai/sdk";
import { buildingKindFor } from "@agent-empires/protocol";
import { Emitter } from "./emitter.js";
import { lineDiff } from "./diff.js";
import { parseTap } from "./tap.js";
import { heraldBattleCry, heraldVictoryTests, heraldMessage } from "./herald.js";

export const WORKER_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a file from the repository. Returns the full contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to repo root" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given contents.",
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
    description: "Search all repository files for a literal string. Returns matching paths with line numbers.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a command in the repo. Only `node` and `npm` are allowed. To run the tests use exactly: node --test --test-reporter=tap tests/*.test.js",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "e.g. `node --test --test-reporter=tap tests/*.test.js`" },
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
  wc: WebContainer;
  emitter: Emitter;
  agentId: string;
  agentName: string;
  sendMessage: (from: string, to: string | undefined, text: string) => void;
  stats: {
    filesRead: Set<string>;
    filesWritten: Set<string>;
    maxFailuresSeen: number;
    lastFailedCount: number;
  };
};

const COMMAND_ALLOWLIST = /^(node|npm)(\s|$)/;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_TOOL_RESULT_CHARS = 12_000;

function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length > max ? text.slice(0, max) + `\n…[truncated ${text.length - max} chars]` : text;
}

function normalize(path: string): string {
  const clean = path.replace(/^\.\//, "").replace(/^\/+/, "");
  if (clean.split("/").some((seg) => seg === "..")) throw new Error("path escapes repo root");
  return clean === "" ? "." : clean;
}

async function walkFiles(wc: WebContainer, dir: string, out: string[]): Promise<void> {
  const entries = await wc.fs.readdir(dir === "." ? "/" : "/" + dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walkFiles(wc, path, out);
    else out.push(path);
  }
}

/** Executes one tool call, emits the matching game events, returns the tool result text. */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const { wc, emitter, agentId } = ctx;

  switch (name) {
    case "read_file": {
      const path = normalize(String(input.path ?? ""));
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("agent_status", { agentId, status: "scouting" });
      const content = await wc.fs.readFile("/" + path, "utf-8");
      ctx.stats.filesRead.add(path);
      emitter.emit("file_read", { agentId, path, lines: content.split("\n").length });
      emitter.emit("log", { agentId, level: "tool", text: `read_file ${path} (${content.length} chars)` });
      return clip(content);
    }

    case "write_file": {
      const path = normalize(String(input.path ?? ""));
      const content = String(input.content ?? "");
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("agent_status", { agentId, status: "building" });
      let old = "";
      let created = true;
      try {
        old = await wc.fs.readFile("/" + path, "utf-8");
        created = false;
      } catch {
        // New file; ensure parent directories exist.
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir) await wc.fs.mkdir("/" + dir, { recursive: true });
      }
      await wc.fs.writeFile("/" + path, content);
      const { added, removed } = lineDiff(old, content);
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
        text: `write_file ${path} (+${added}/-${removed}${created ? ", new" : ""})`,
      });
      return `Wrote ${path} (+${added}/-${removed} lines).`;
    }

    case "list_dir": {
      const path = normalize(String(input.path ?? "."));
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("list_dir", { agentId, path });
      const entries = await wc.fs.readdir(path === "." ? "/" : "/" + path, { withFileTypes: true });
      const listing = entries
        .filter((e) => e.name !== "node_modules")
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .join("\n");
      emitter.emit("log", { agentId, level: "tool", text: `list_dir ${path}` });
      return listing || "(empty)";
    }

    case "search": {
      const query = String(input.query ?? "");
      emitter.emit("agent_status", { agentId, status: "scouting" });
      const files: string[] = [];
      await walkFiles(wc, ".", files);
      const hits: string[] = [];
      const hitPaths = new Set<string>();
      for (const file of files) {
        let content: string;
        try {
          content = await wc.fs.readFile("/" + file, "utf-8");
        } catch {
          continue;
        }
        content.split("\n").forEach((line, i) => {
          if (line.includes(query) && hits.length < 60) {
            hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
            hitPaths.add(file);
          }
        });
      }
      emitter.emit("search", { agentId, query, matchCount: hits.length, paths: [...hitPaths] });
      emitter.emit("log", { agentId, level: "tool", text: `search "${query}" → ${hits.length} hits` });
      return hits.length ? clip(hits.join("\n")) : "No matches.";
    }

    case "run_command": {
      const command = String(input.command ?? "").trim();
      if (!COMMAND_ALLOWLIST.test(command)) {
        return "Command rejected: only `node` and `npm` commands are allowed.";
      }
      const kind = /--test/.test(command) ? "test" : /^npm (install|ci|i)\b/.test(command) ? "install" : "other";
      emitter.emit("agent_status", { agentId, status: kind === "test" ? "fighting" : "building" });
      emitter.emit("command_run", { agentId, command, kind });

      const [bin, ...args] = command.split(/\s+/) as [string, ...string[]];
      const proc = await wc.spawn(bin, args);
      let output = "";
      proc.output.pipeTo(
        new WritableStream({
          write(chunk) {
            output += chunk;
          },
        }),
      );
      const exitCode = await Promise.race([
        proc.exit,
        new Promise<number>((resolve) =>
          setTimeout(() => {
            proc.kill();
            resolve(124);
          }, COMMAND_TIMEOUT_MS),
        ),
      ]);
      // Strip ANSI escapes for parsing and logs.
      const cleanOutput = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

      let summary = exitCode === 0 ? "succeeded" : `exited ${exitCode}`;
      let testsFailed: number | undefined;
      let testsPassed: number | undefined;
      let failures: { name: string; path?: string }[] | undefined;
      if (kind === "test") {
        const tap = parseTap(cleanOutput);
        testsFailed = tap.failed;
        testsPassed = tap.passed;
        failures = tap.failures;
        summary = `${tap.failed} failed, ${tap.passed} passed`;
        ctx.stats.maxFailuresSeen = Math.max(ctx.stats.maxFailuresSeen, tap.failed);
        ctx.stats.lastFailedCount = tap.failed;
        emitter.emit("log", {
          agentId,
          level: "info",
          text: tap.failed > 0 ? heraldBattleCry(tap.failed) : heraldVictoryTests(tap.passed),
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
      return clip(`exit code: ${exitCode}\n${cleanOutput}`);
    }

    case "send_message": {
      const to = input.to ? String(input.to) : undefined;
      const text = String(input.text ?? "");
      ctx.sendMessage(ctx.agentName, to, text);
      emitter.emit("message", {
        fromId: agentId,
        toId: to,
        text,
        herald: heraldMessage(ctx.agentName, to, text),
      });
      return to ? `Message delivered to ${to}.` : "Message broadcast to all agents.";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
