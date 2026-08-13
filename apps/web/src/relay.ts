import {
  GameEvent,
  HostMessage,
  RelayMessage,
  PROTOCOL_VERSION,
  type MatchSummary,
} from "@agent-empires/protocol";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export async function fetchMatches(): Promise<{ live: MatchSummary[]; finished: MatchSummary[] }> {
  const res = await fetch("/api/matches");
  return res.json();
}

/** Host side: opens the relay socket, returns the assigned match id and a publish fn. */
export function hostMatch(
  taskId: string,
  taskTitle: string,
): Promise<{ matchId: string; publish: (e: GameEvent) => void; end: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const send = (msg: HostMessage) => ws.send(JSON.stringify(msg));
    const pending: GameEvent[] = [];
    let hosted = false;

    ws.onopen = () => send({ type: "host", protocolVersion: PROTOCOL_VERSION, taskId, taskTitle });
    ws.onerror = () => reject(new Error("relay connection failed"));
    ws.onmessage = (raw) => {
      const msg = RelayMessage.parse(JSON.parse(raw.data));
      if (msg.type === "hosted") {
        hosted = true;
        for (const e of pending) send({ type: "publish", event: e });
        pending.length = 0;
        resolve({
          matchId: msg.matchId,
          publish: (event) => {
            if (!hosted || ws.readyState !== WebSocket.OPEN) {
              pending.push(event);
              return;
            }
            send({ type: "publish", event });
          },
          end: () => {
            if (ws.readyState === WebSocket.OPEN) send({ type: "end" });
            ws.close();
          },
        });
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
      }
    };
  });
}

/** Spectator side: history replays first, then live events. */
export function spectateMatch(
  matchId: string,
  onEvent: (e: GameEvent, historical: boolean) => void,
  onOver: () => void,
  onError: (message: string) => void,
): () => void {
  const ws = new WebSocket(wsUrl());
  ws.onopen = () => ws.send(JSON.stringify({ type: "watch", matchId }));
  ws.onmessage = (raw) => {
    const msg = RelayMessage.parse(JSON.parse(raw.data));
    if (msg.type === "history") {
      for (const e of msg.events) onEvent(e, true);
    } else if (msg.type === "event") {
      onEvent(msg.event, false);
    } else if (msg.type === "match_over") {
      onOver();
    } else if (msg.type === "error") {
      onError(msg.message);
    }
  };
  ws.onclose = () => onOver();
  return () => ws.close();
}
