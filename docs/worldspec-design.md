# WorldSpec: agentic per-repo worlds (Level 2)

Principle: **the engine is fixed code; a world is pure data.** One LLM call per
repo authors a WorldSpec. The renderer interprets it. A spec that fails zod
validation falls back to the nearest archetype — generated content can look
strange, never break.

## Schema sketch (packages/protocol, strict zod, everything bounded)

```
WorldSpec {
  version: 1
  lore: { placeName, epithet (one sentence), loadingLines: string[3..6] }   // narration
  sky: { top: hex, horizon: hex, hazeAlpha: 0..0.5 }
  terrain: {
    base: hex[3..6]            // ground ramp
    pattern: enum[plates|dunes|floes|moss|tessellae|shale]
    reliefIntensity: 0..1      // noise displacement of tile shading
    waterline?: { color: hex, coverage: 0..0.35 }   // harbor/glacier worlds
  }
  props: Prop[0..12] where Prop {
    silhouette: Primitive[1..6]  // composed from fixed vocabulary
    density: 0..1, placement: enum[ridges|edges|scatter|districts]
    glow?: { color: hex, pulseSec: 2..20 }
  }
  Primitive = { shape: enum[slab|obelisk|arch|mast|orb|shard|frond|coil|ring|beam],
                w,h: clamped, color: hex, tilt: -30..30 }
  architecture: {                       // per building kind: silhouette params
    [house|barracks|market|monastery|mill|towncenter]:
      { silhouette: Primitive[1..5], roofColor: hex, wallColor: hex, emissive?: hex }
  }
  ambience: {
    particles: enum[embers|mist|snow|spores|dust|rain|none], tint: hex, rate: 0..1
    skyEvents?: { kind: enum[flare|drift|aurora|birds], everySec: 20..120 }
  }
  units: { villagerTint: hex, heroTint: hex, raiderTint: hex, gaitBounce: 0..1 }
}
```

Sprites (PixelSprite grids) stay in ThemePack — WorldSpec composes geometry;
sprites remain the hand-drawn layer on top. Both ride the same generation call.

## Flow

1. Host starts settlement → sandbox provisions (existing overlay).
2. WorldSpec+Theme generation kicks off; overlay narrates `lore.loadingLines`
   one by one (fake-streamed ~6s apart), each also logged to the herald:
   "⟡ The chroniclers read the record of <repo>…" → line 1 → … → world morphs in.
3. Spec cached on relay under repoKey (same LRU as themes; PUT validates zod
   server-side too). Revisit = instant custom world.
4. Validation failure or timeout → archetype fallback + honest herald line.

## Guardrails

- Server-side zod validation on cache PUT (never trust cached blobs).
- All counts/sizes clamped; palette forced through hex regex; no strings reach
  the DOM unescaped; loadingLines length-capped.
- Renderer treats every spec field as optional with archetype defaults.
