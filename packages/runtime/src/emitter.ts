import type { GameEvent } from "@agent-empires/protocol";

/** Sequences events and forwards them to the sink (renderer + relay). */
export class Emitter {
  private seq = 0;
  constructor(private sink: (event: GameEvent) => void) {}

  emit<T extends GameEvent["type"]>(
    type: T,
    fields: Omit<Extract<GameEvent, { type: T }>, "type" | "seq" | "ts">,
  ): void {
    // TS cannot prove the generic spread matches the union member; the
    // per-call-site Omit<Extract<...>> constraint already guarantees it.
    const event = {
      type,
      seq: this.seq++,
      ts: Date.now(),
      ...fields,
    } as unknown as GameEvent;
    this.sink(event);
  }
}
