import type Anthropic from "@anthropic-ai/sdk";
import { buildingKindFor, FLOURISH_MARKS, type CommandKind, type FileNode } from "@agent-empires/protocol";
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
      "Send a short message to a fellow agent (by name), to The Crown (the human ruler — use to: \"The Crown\" when answering something the Crown asked you directly), or to everyone (omit `to`). Use it to coordinate: announce what you're starting, share discoveries, warn about conflicts.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient agent name, or \"The Crown\"; omit to broadcast" },
        text: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "sign_work",
    description:
      "Leave your maker's mark on the castle: a small cited flourish on the wing that holds a file you truly worked in this shift. Use it once your real work has landed and been verified — one mark, one line naming what you did there. The law refuses marks on files you never read or wrote.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "A file you read or wrote in that wing" },
        mark: { type: "string", enum: [...FLOURISH_MARKS] },
        cited: { type: "string", description: "One line naming the work you did there (<= 200 chars)" },
      },
      required: ["path", "mark", "cited"],
    },
  },
  {
    name: "inscribe_scroll",
    description:
      "Inscribe a presentable artifact — a report, summary, table, diagram, or chart — and deliver it to The Crown's satchel as a collectible scroll. Use format \"markdown\" for prose/tables/lists, or \"svg\" for charts and diagrams (one self-contained <svg viewBox=\"…\"> using only shapes and <text>; no scripts, no external refs). Use this whenever The Crown asks to SEE something rather than just hear about it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short scroll title (max 80 chars)" },
        format: { type: "string", enum: ["markdown", "svg"] },
        content: { type: "string", description: "Markdown text, or a single self-contained <svg> element" },
      },
      required: ["title", "format", "content"],
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
  /** THIS agent's touched paths — the measured provenance behind sign_work. */
  touched: Set<string>;
  /** Every path the realm has ever counted (seeded from the founding tree,
   *  shared across agents). The sighting law diffs the tree against this
   *  after each command, so shell-born files still raise their stone. */
  knownPaths: Set<string>;
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
      emitter.emit("agent_status", { agentId, status: "scouting", detail: `reads ${path}`.slice(0, 160) });
      const { content, lines } = await exec.read(path);
      ctx.stats.filesRead.add(path);
      ctx.touched.add(path);
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
      emitter.emit("agent_status", { agentId, status: "building", detail: `reforges ${path}`.slice(0, 160) });
      // Function replacer: a literal string here would interpret $-patterns ($&, $1…).
      const { newLines } = await exec.write(path, content.replace(oldText, () => newText));
      const added = newText ? newText.split("\n").length : 0;
      const removed = oldText.split("\n").length;
      ctx.stats.filesWritten.add(path);
      ctx.touched.add(path);
      ctx.knownPaths.add(path);
      emitter.emit("file_write", {
        agentId,
        path,
        created: false,
        linesAdded: added,
        linesRemoved: removed,
        buildingKind: buildingKindFor(path),
        diffSnippet: snippetOf(oldText, newText),
        lines: newLines,
      });
      emitter.emit("log", { agentId, level: "tool", text: `edit_file ${path} (~+${added}/−${removed})` });
      return `Edited ${path}: replaced ${removed} line(s) with ${added} (file now ${newLines} lines).`;
    }

    case "write_file": {
      const path = String(input.path ?? "");
      const content = String(input.content ?? "");
      emitter.emit("agent_moved", { agentId, path });
      emitter.emit("agent_status", { agentId, status: "building", detail: `raises ${path}`.slice(0, 160) });
      const { created, oldLines, newLines } = await exec.write(path, content);
      // Line-count approximation: the true diff lives in the sandbox's git.
      const added = created ? newLines : Math.max(newLines - oldLines, 1);
      const removed = created ? 0 : Math.max(oldLines - newLines, newLines === oldLines ? 1 : 0);
      ctx.stats.filesWritten.add(path);
      ctx.touched.add(path);
      ctx.knownPaths.add(path);
      emitter.emit("file_write", {
        agentId,
        path,
        created,
        linesAdded: added,
        linesRemoved: removed,
        buildingKind: buildingKindFor(path),
        diffSnippet: created ? snippetOf("", content.split("\n").slice(0, 24).join("\n")) : undefined,
        lines: newLines,
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
      emitter.emit("agent_status", { agentId, status: "scouting", detail: `hunts «${query.slice(0, 60)}»` });
      const hits = await exec.search(query);
      const paths = [...new Set(hits.map((h) => h.split(":")[0]!))].slice(0, 20);
      emitter.emit("search", { agentId, query, matchCount: hits.length, paths });
      emitter.emit("log", { agentId, level: "tool", text: `search "${query}" → ${hits.length} hits` });
      return hits.length ? clip(hits.join("\n")) : "No matches.";
    }

    case "run_command": {
      const command = String(input.command ?? "").trim();
      const kind = commandKind(command);
      emitter.emit("agent_status", {
        agentId,
        status: kind === "test" ? "fighting" : "building",
        detail: `wields \`${command.slice(0, 80)}\``.slice(0, 160),
      });
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

      // Sighting law: files born through the shell speak no file_write — walk
      // the tree after every command and raise the newborn stones. A blast of
      // >50 newcomers is generated output, not architecture: count it in
      // silence. At most 12 sightings are heralded per command.
      try {
        const tree = await exec.tree();
        const born: { path: string; lines: number }[] = [];
        const walk = (n: FileNode): void => {
          if (n.kind === "file") {
            if (!ctx.knownPaths.has(n.path)) born.push({ path: n.path, lines: (n as FileNode & { lines?: number }).lines ?? 1 });
            return;
          }
          for (const c of n.children ?? []) walk(c);
        };
        walk(tree);
        for (const f of born) ctx.knownPaths.add(f.path);
        if (born.length > 0 && born.length <= 50) {
          for (const f of born.slice(0, 12)) {
            ctx.stats.filesWritten.add(f.path);
            ctx.touched.add(f.path);
            emitter.emit("file_write", {
              agentId,
              path: f.path,
              created: true,
              linesAdded: f.lines,
              linesRemoved: 0,
              buildingKind: buildingKindFor(f.path),
              lines: f.lines,
            });
          }
          if (born.length > 12) {
            emitter.emit("log", { agentId, level: "tool", text: `${born.length} files sighted after the command — 12 raised, the rest counted` });
          }
        }
      } catch {
        // the surveyors came home empty-handed; the next command may sight them
      }
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
      if (to && /\bcrown\b/i.test(to)) {
        emitter.emit("dialogue", {
          agentId,
          agentName: ctx.agentName,
          from: "agent",
          text: text.slice(0, 2000),
        });
        return "Your words reach The Crown.";
      }
      ctx.sendMessage(ctx.agentName, to, text);
      emitter.emit("message", {
        fromId: agentId,
        toId: to,
        text,
        herald: heraldMessage(ctx.agentName, to, text, ctx.lexicon()),
      });
      return to ? `Message delivered to ${to}.` : "Message broadcast to all agents.";
    }

    case "sign_work": {
      const path = String(input.path ?? "").trim();
      const mark = String(input.mark ?? "").trim();
      const cited = String(input.cited ?? "").trim().slice(0, 240);
      if (!path || !cited) return "Tool error: path and cited are required.";
      if (!(FLOURISH_MARKS as readonly string[]).includes(mark)) {
        return `Tool error: unknown mark "${mark}" — lawful marks: ${FLOURISH_MARKS.join(", ")}.`;
      }
      // measured provenance: only wings this agent truly entered may be signed
      if (!ctx.touched.has(path)) {
        return `Tool error: you have not worked in ${path} this shift — read or write it before signing.`;
      }
      emitter.emit("castle_flourish", {
        agentId,
        author: ctx.agentName.slice(0, 60),
        path,
        mark,
        cited,
      });
      emitter.emit("log", {
        agentId,
        level: "info",
        text: `✍ ${ctx.agentName} signs the work at ${path} — a ${mark}: ${cited}`,
      });
      return `Your ${mark} is set upon the wing that holds ${path}.`;
    }

    case "inscribe_scroll": {
      const title = String(input.title ?? "").trim().slice(0, 80);
      const format = input.format === "svg" ? ("svg" as const) : ("markdown" as const);
      const content = String(input.content ?? "").slice(0, 24_000);
      if (!title || !content) return "Tool error: title and content are required.";
      if (format === "svg" && !/^\s*<svg[\s>]/i.test(content)) {
        return "Tool error: svg scrolls must be a single self-contained <svg> element.";
      }
      const scrollId = `scroll-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`;
      emitter.emit("scroll", { scrollId, authorId: agentId, authorName: ctx.agentName.slice(0, 60), title, format, content });
      emitter.emit("log", { agentId, level: "info", text: `${ctx.agentName} inscribes a scroll — “${title}”` });
      return `Scroll "${title}" inscribed and delivered to The Crown's satchel.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
