import type { FileSystemTree } from "@webcontainer/api";
import type { GameEvent } from "@agent-empires/protocol";

export type TaskDefinition = {
  id: string;
  title: string;
  /** Real engineering brief given to the agents. */
  description: string;
  /** AoE-style blurb for the loading screen. */
  flavor: string;
  /** WebContainer mount tree containing the repo. */
  files: FileSystemTree;
  /** Command that decides victory (exit 0) vs defeat. */
  acceptCommand: string[];
  /** Suggested number of worker villagers. */
  workerCount: number;
};

export type RuntimeOptions = {
  apiKey: string;
  model: string;
  task: TaskDefinition;
  onEvent: (event: GameEvent) => void;
  /** Abort to end the match early. */
  signal?: AbortSignal;
};

export type MatchOutcome = {
  result: "victory" | "defeat";
  stats: {
    goldSpent: number;
    buildingsRaised: number;
    raidersSlain: number;
    tilesExplored: number;
    durationMs: number;
  };
};
