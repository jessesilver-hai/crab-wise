import type { FileNode, SandboxExecResult } from "@agent-empires/protocol";

/** Where agent tools actually run. v1: a remote sandbox via the relay proxy. */
export interface Executor {
  clone(url: string): Promise<{ readme: string }>;
  tree(): Promise<FileNode>;
  read(path: string): Promise<{ content: string; lines: number; truncated: boolean }>;
  write(path: string, content: string): Promise<{ created: boolean; oldLines: number; newLines: number }>;
  list(path: string): Promise<string[]>;
  /** Hits formatted as "path:line: text". */
  search(query: string): Promise<string[]>;
  exec(command: string, timeoutMs?: number): Promise<SandboxExecResult>;
  diff(): Promise<{ patch: string; stat: string }>;
}

/**
 * Talks to sandboxd through the relay's host-authorized proxy. The visitor's
 * Anthropic key never travels this path — only tool calls do.
 */
export class SandboxExecutor implements Executor {
  constructor(
    private matchId: string,
    private hostToken: string,
  ) {}

  private async call<T>(op: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api/sandbox/${this.matchId}/${op}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.hostToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `sandbox ${op} failed (${res.status})`);
    return json;
  }

  async clone(url: string) {
    return this.call<{ readme: string }>("clone", { url });
  }
  async tree() {
    const { tree } = await this.call<{ tree: FileNode }>("tree");
    return tree;
  }
  async read(path: string) {
    return this.call<{ content: string; lines: number; truncated: boolean }>("read", { path });
  }
  async write(path: string, content: string) {
    return this.call<{ created: boolean; oldLines: number; newLines: number }>("write", { path, content });
  }
  async list(path: string) {
    const { entries } = await this.call<{ entries: string[] }>("list", { path });
    return entries;
  }
  async search(query: string) {
    const { hits } = await this.call<{ hits: string[] }>("search", { query });
    return hits;
  }
  async exec(command: string, timeoutMs?: number) {
    return this.call<SandboxExecResult>("exec", { command, timeoutMs });
  }
  async diff() {
    return this.call<{ patch: string; stat: string }>("diff");
  }
}
