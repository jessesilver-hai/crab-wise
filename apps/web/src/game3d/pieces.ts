// Kit-piece resolution shared by the construction composer and the genome
// compiler: a missing GLB never crashes a build — it becomes a warned-once
// box stand-in so the castle always stands.
import * as THREE from "three";
import type { Assets, StaticModel } from "./assets.js";
import { hashStr } from "./util.js";

const boxModels = new Map<string, StaticModel>();
const warnedMissing = new Set<string>();

export function missingPieces(): string[] {
  return [...warnedMissing].sort();
}

export function modelOrBox(assets: Assets, key: string): StaticModel {
  const m = assets.statics.get(key);
  if (m) return m;
  let box = boxModels.get(key);
  if (!box) {
    if (!warnedMissing.has(key)) {
      warnedMissing.add(key);
      console.warn(`[castle3d] kit piece missing: ${key} — box fallback`);
    }
    const geo = new THREE.BoxGeometry(0.9, 0.8, 0.9).translate(0, 0.4, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9f8f78 + ((hashStr(key) % 0x30) << 8),
      roughness: 0.9,
    });
    box = { parts: [{ geometry: geo, material: mat }], size: new THREE.Vector3(0.9, 0.8, 0.9) };
    boxModels.set(key, box);
  }
  return box;
}

export function disposeBoxModels(): void {
  for (const box of boxModels.values()) {
    for (const p of box.parts) {
      p.geometry.dispose();
      p.material.dispose();
    }
  }
  boxModels.clear();
}
