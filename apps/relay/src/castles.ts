import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Persistent castles — the only state that outlives a relay restart besides
 * the Hall of Legends. A castle is a record (name, ledger, chronicle counts)
 * plus an archived workspace bundle; each new commission founds upon both,
 * and the ledger law guarantees the old wings never move.
 */

export type CastleRecord = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** How many commissions have built upon this castle. */
  commissions: number;
  lastTitle: string;
  /** CastleLedger JSON, opaque to the relay. */
  ledger: unknown;
  hasBundle: boolean;
};

export const CASTLE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const MAX_CASTLES = 100;

/** Pure upsert + LRU evict; returns the new list and any evicted ids. */
export function upsertRecord(
  list: CastleRecord[],
  rec: CastleRecord,
  cap = MAX_CASTLES,
): { list: CastleRecord[]; evicted: string[] } {
  const rest = list.filter((c) => c.id !== rec.id);
  const prior = list.find((c) => c.id === rec.id);
  const merged: CastleRecord = prior
    ? {
        ...rec,
        createdAt: prior.createdAt,
        commissions: prior.commissions + 1,
        hasBundle: rec.hasBundle || prior.hasBundle,
      }
    : { ...rec, commissions: 1 };
  const next = [merged, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  const evicted = next.slice(cap).map((c) => c.id);
  return { list: next.slice(0, cap), evicted };
}

export class CastleStore {
  private records: CastleRecord[] = [];

  constructor(
    private dataPath: string,
    private bundlesDir: string,
  ) {
    try {
      this.records = JSON.parse(readFileSync(dataPath, "utf8")) as CastleRecord[];
    } catch {
      this.records = [];
    }
  }

  /** Summaries for the lobby door (no ledgers — they can be large). */
  list(): Omit<CastleRecord, "ledger">[] {
    return this.records.map(({ ledger: _l, ...rest }) => rest).slice(0, 50);
  }

  get(id: string): CastleRecord | null {
    return this.records.find((c) => c.id === id) ?? null;
  }

  save(rec: Omit<CastleRecord, "createdAt" | "updatedAt" | "commissions">): void {
    const now = Date.now();
    const { list, evicted } = upsertRecord(this.records, {
      ...rec,
      createdAt: now,
      updatedAt: now,
      commissions: 1,
    });
    this.records = list;
    for (const id of evicted) rmSync(this.bundlePath(id), { force: true });
    mkdirSync(path.dirname(this.dataPath), { recursive: true });
    writeFileSync(this.dataPath, JSON.stringify(this.records));
  }

  bundlePath(id: string): string {
    return path.join(this.bundlesDir, `${id}.bundle`);
  }

  hasBundle(id: string): boolean {
    return existsSync(this.bundlePath(id));
  }

  writeBundle(id: string, buf: Buffer): void {
    mkdirSync(this.bundlesDir, { recursive: true });
    writeFileSync(this.bundlePath(id), buf);
  }

  readBundle(id: string): Buffer | null {
    try {
      return readFileSync(this.bundlePath(id));
    } catch {
      return null;
    }
  }
}
