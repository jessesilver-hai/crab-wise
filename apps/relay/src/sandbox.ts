import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SandboxHandle = {
  baseUrl: string;
  token: string;
  destroy(): Promise<void>;
};

export interface SandboxDriver {
  create(sessionId: string): Promise<SandboxHandle>;
}

const SANDBOXD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/sandboxd/sandboxd.mjs",
);
const SAMPLES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tasks/repos",
);

/**
 * Dev-only driver: sandboxd as a plain subprocess in a temp dir. No isolation
 * beyond a path jail — never enable in production for untrusted repos.
 */
export class ProcessDriver implements SandboxDriver {
  async create(sessionId: string): Promise<SandboxHandle> {
    const token = randomBytes(24).toString("hex");
    const port = 9800 + Math.floor(Math.random() * 400);
    const workDir = await mkdtemp(path.join(tmpdir(), `ae-sandbox-${sessionId}-`));
    const proc: ChildProcess = spawn("node", [SANDBOXD_PATH], {
      env: {
        ...process.env,
        PORT: String(port),
        SANDBOX_TOKEN: token,
        WORK_DIR: workDir,
        SAMPLES_DIR: SAMPLES_PATH,
      },
      stdio: "inherit",
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitHealthy(baseUrl, 10_000);
    return {
      baseUrl,
      token,
      destroy: async () => {
        proc.kill("SIGKILL");
        await rm(workDir, { recursive: true, force: true });
      },
    };
  }
}

/**
 * Production driver: one ephemeral Fly Machine per session, reached over
 * Fly private networking. Requires FLY_API_TOKEN, SANDBOX_APP, SANDBOX_IMAGE.
 */
export class FlyDriver implements SandboxDriver {
  constructor(
    private apiToken: string,
    private app: string,
    private image: string,
  ) {}

  private async api(method: string, urlPath: string, body?: unknown): Promise<any> {
    const res = await fetch(`https://api.machines.dev/v1/apps/${this.app}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`fly api ${method} ${urlPath}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async create(sessionId: string): Promise<SandboxHandle> {
    const token = randomBytes(24).toString("hex");
    const machine = await this.api("POST", "/machines", {
      name: `sb-${sessionId}`,
      config: {
        image: this.image,
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
        env: { SANDBOX_TOKEN: token, PORT: "9800", WORK_DIR: "/work" },
        auto_destroy: true,
        restart: { policy: "no" },
      },
    });
    const machineId: string = machine.id;
    const baseUrl = `http://${machineId}.vm.${this.app}.internal:9800`;
    try {
      await this.api("GET", `/machines/${machineId}/wait?state=started&timeout=60`);
      await waitHealthy(baseUrl, 30_000);
    } catch (err) {
      // Don't leak a machine we can't reach.
      await this.api("DELETE", `/machines/${machineId}?force=true`).catch(() => {});
      throw err;
    }
    return {
      baseUrl,
      token,
      destroy: async () => {
        try {
          await this.api("DELETE", `/machines/${machineId}?force=true`);
        } catch (err) {
          console.error(`failed to destroy machine ${machineId}:`, err);
        }
      },
    };
  }
}

async function waitHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("sandbox failed to become healthy");
}

// ---------------------------------------------------------------------------
// Session manager: caps, TTLs, host-token auth, proxying
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 60_000;
const HOST_DISCONNECT_GRACE_MS = 90_000;
const MAX_SANDBOXES = Number(process.env.MAX_SANDBOXES ?? 6);

type Session = {
  matchId: string;
  handle: SandboxHandle;
  hostToken: string;
  ip: string;
  killTimer: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
};

export class SandboxManager {
  private sessions = new Map<string, Session>();
  constructor(private driver: SandboxDriver) {}

  get count(): number {
    return this.sessions.size;
  }

  async provision(matchId: string, ip: string): Promise<{ hostToken: string }> {
    if (this.sessions.size >= MAX_SANDBOXES) {
      throw new Error("all sandboxes are busy; try again in a few minutes");
    }
    for (const s of this.sessions.values()) {
      if (s.ip === ip) throw new Error("one settlement per visitor at a time");
    }
    const handle = await this.driver.create(matchId);
    const hostToken = randomBytes(24).toString("hex");
    const session: Session = {
      matchId,
      handle,
      hostToken,
      ip,
      killTimer: setTimeout(() => void this.destroy(matchId), SESSION_TTL_MS),
    };
    this.sessions.set(matchId, session);
    return { hostToken };
  }

  /** Proxy one sandboxd call on behalf of an authorized host. */
  async proxy(
    matchId: string,
    hostToken: string,
    op: string,
    body: unknown,
  ): Promise<{ status: number; body: string }> {
    const session = this.sessions.get(matchId);
    if (!session || session.hostToken !== hostToken) {
      return { status: 403, body: JSON.stringify({ error: "not your settlement" }) };
    }
    const allowed = new Set(["clone", "tree", "read", "write", "list", "search", "exec", "diff"]);
    if (!allowed.has(op)) return { status: 404, body: JSON.stringify({ error: "unknown op" }) };
    const method = op === "tree" || op === "diff" ? "GET" : "POST";
    const res = await fetch(`${session.handle.baseUrl}/${op}`, {
      method,
      headers: {
        authorization: `Bearer ${session.handle.token}`,
        "content-type": "application/json",
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(320_000),
    });
    return { status: res.status, body: await res.text() };
  }

  /** Host socket dropped: destroy after a grace period (they may refresh). */
  hostDisconnected(matchId: string): void {
    const session = this.sessions.get(matchId);
    if (!session) return;
    session.graceTimer = setTimeout(() => void this.destroy(matchId), HOST_DISCONNECT_GRACE_MS);
  }

  hostReconnected(matchId: string): void {
    const session = this.sessions.get(matchId);
    if (session?.graceTimer) clearTimeout(session.graceTimer);
  }

  async destroy(matchId: string): Promise<void> {
    const session = this.sessions.get(matchId);
    if (!session) return;
    this.sessions.delete(matchId);
    clearTimeout(session.killTimer);
    if (session.graceTimer) clearTimeout(session.graceTimer);
    await session.handle.destroy();
  }
}

export function driverFromEnv(): SandboxDriver {
  if (process.env.FLY_API_TOKEN && process.env.SANDBOX_APP && process.env.SANDBOX_IMAGE) {
    console.log(`sandbox driver: fly (${process.env.SANDBOX_APP})`);
    return new FlyDriver(process.env.FLY_API_TOKEN, process.env.SANDBOX_APP, process.env.SANDBOX_IMAGE);
  }
  console.log("sandbox driver: process (DEV ONLY — no isolation)");
  return new ProcessDriver();
}
