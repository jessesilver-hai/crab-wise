import type { Renderer } from "./match-view.js";

/**
 * Engine selection with code-splitting: the default 3D engine (three.js) and
 * the legacy 2D engine (Phaser) live in separate lazy chunks, so spectators
 * only ever download the one they use. `?r=2d` is the rollback lever.
 */
export async function selectRenderer(mount: HTMLElement): Promise<Renderer> {
  const use2d = new URLSearchParams(window.location.search).get("r") === "2d";
  const mod = use2d
    ? await import("./game/renderer.js")
    : await import("./game3d/renderer.js");
  return mod.attachGameRenderer(mount);
}
