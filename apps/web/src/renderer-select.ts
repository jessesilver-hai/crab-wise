import type { Renderer } from "./match-view.js";

/**
 * Castle Era: one engine. The 3D castle renderer is the world; it loads as
 * its own lazy chunk so the lobby stays light. (The 2D sprite engine of the
 * city era is retired — its laws live on in git history.)
 */
export async function selectRenderer(mount: HTMLElement): Promise<Renderer> {
  const mod = await import("./game3d/renderer.js");
  return mod.attachGameRenderer(mount);
}
