# Etymology — Engine Brief for Codex

## One-paragraph directive (for the assistant)

Build a web-native, dependency-free, deterministic **map/simulation engine** that renders a stylized historical Europe with **no binary assets in the repo**. All visuals (terrain, borders, roads, cities, trees, carts, clouds) are **computed at runtime** from **text-based definitions**: JSON schemas, ASCII/pixel glyphs, palettes, and compact encodings (RLE/base-n). Use a single HTML page with vanilla JS (Canvas2D) and modular files. Include pan/zoom, level-of-detail gating, simple agents (“carts”) moving along paths, and save/load world state as JSON. Prioritize clarity, small code, and determinism.

---

## Meta-goal / Why this exists

Create a self-hosted historical/linguistic atlas for Europe that can:

* Visualize borders, routes, settlements, and animated motifs (carts, flags, clouds) over time.
* Run entirely in the browser, offline, and reproducibly.
* Be embedded into pages of the “etymology” site without external tile/CDN dependencies.
* Keep the repo text-only (no PNGs/TTFs); the runtime synthesizes pixels procedurally.

## Scope (v1)

* **Rendering:** Canvas2D single-canvas renderer with pan/zoom; culling; zoom-based LOD.
* **Assets:** All shapes defined as **procedural pixels** or **vector paths** encoded in JSON/ASCII.
* **Simulation:** Simple agent system (carts following polylines; constant speed; looping).
* **State:** Single JSON world document: meta, palette, layers (terrain grid or generator params), vectors (borders/roads), sprites (glyph refs), agents.
* **Export:** Save/load JSON; optional in-browser WebM capture later (no binaries in repo).

Non-goals (for now)

* No third-party map tiles; no WebGL; no heavy font engines; no server code.

---

## Architectural sketch

* **Core modules**

  * `camera.ts|js`: world↔screen transforms; pan/zoom; view bounds.
  * `renderer.ts|js`: tile pass → vector pass → sprite/effects pass; LOD gates.
  * `world.ts|js`: data model; layers; update loop; serialization.
  * `assets.ts|js`: palette registry; glyph registry; encoders/decoders (RLE/base-64-like).
  * `agents.ts|js`: path following; arc-length stepping; selection.
  * `ui.ts|js`: minimal toolbar; save/load; dev toggles.
* **Determinism**

  * Fixed step (`1/60`); seeded PRNG for noise fields (clouds/wind).
  * All time-varying effects derive from `(seed, t)`.

---

## Data formats (text-only)

### Palette

```json
{
  "palette": {
    "grass": "#7ca75b",
    "forest": "#3f7c4a",
    "water": "#2b5eac",
    "mountain": "#6a6d73",
    "road": "#a07a52",
    "city": "#c24b3a",
    "cloud": "#ffffff"
  }
}
```

### Pixel glyphs (for trees, carts, city icons)

Glyphs are tiny bitmaps described as rows with run-length encoding. Colors reference the palette keys.

```json
{
  "glyphs": {
    "tree_7x7_v1": {
      "w": 7,
      "h": 7,
      "rle": [
        ["0",7],                 // 0 = transparent
        ["0",3,"forest",1,"0",3],
        ["0",2,"forest",3,"0",2],
        ["0",1,"forest",5,"0",1],
        ["0",3,"forest",1,"0",3],
        ["0",3,"forest",1,"0",3],
        ["0",3,"forest",1,"0",3]
      ]
    },
    "cart_5x3_v1": {
      "w": 5,"h": 3,
      "rle": [
        ["0",5],
        ["road",1,"city",3,"road",1],
        ["0",5]
      ]
    }
  }
}
```

Encoder/decoder lives in `assets.ts|js`; at load time, RLE expands to Uint8 indices into a small `colorLUT`.

### Vector layers (borders, roads)

```json
{
  "vectors": {
    "borders": { "zoomMin": 3, "zoomMax": 12, "features": [
      { "name":"Kingdom A", "poly":[[0.12,0.34],[0.18,0.35], ...] }  // normalized 0..1 coords
    ]},
    "roads": { "zoomMin": 5, "zoomMax": 12, "features": [
      { "name":"Route 1", "line":[[0.15,0.36],[0.2,0.4], ...] }
    ]}
  }
}
```

Coordinates normalized to the world bbox `[0..1]×[0..1]` so we avoid geodesy and keep math fast.

### Terrain / background

Two options, both text-only:

* **Generated**: store noise parameters and color bands; renderer samples per visible tile.
* **Sparse painted grid**: store only non-default cells `{ "x": i, "y": j, "type": "forest" }`; the rest default to “grass”.

### Agents

```json
{
  "agents": [
    {"type":"cart","glyph":"cart_5x3_v1","speed":0.12,
     "path":[[0.41,0.52],[0.46,0.52],[0.49,0.55]]}
  ]
}
```

Speed in world-units per second on normalized coordinates.

---

## Rendering strategy

* **Pass order**: terrain → vectors (fills, then strokes) → sprites → effects.
* **Level-of-detail**:

  * `zoom < 3`: landmass only, faint clouds, no sprites.
  * `3 ≤ zoom < 6`: borders/major roads, carts on trunk paths.
  * `6 ≤ zoom`: cities, trees with subtle wind jitter; thicker road strokes.
* **Culling budgets**: cap animated sprites in view (e.g., 200). Overflow: render static or skip.

## Animations

* **Carts**: arc-length reparameterization along polyline; loop or ping-pong.
* **Clouds**: tileable alpha canvas synthesized from seeded noise; drift vector tied to `zoom`.
* **Tree sway**: per-sprite phase offset; sinusoidal or noise-driven ±1–2 px at high zoom.

---

## Repository structure (proposed)

```
/public
  index.html
  /js
    camera.js
    renderer.js
    world.js
    assets.js
    agents.js
    ui.js
  /data
    palette.json
    glyphs.json
    world.sample.json
/README.md
```

A single `index.html` references the modules; for local file usage you may also ship a `bundle.js` build (no imports) generated by a tiny concatenation script kept in the repo (text only).

---

## Coding standards

* Vanilla JS with ES modules, or a pre-built bundle for file:// testing.
* No external libs. No binary assets committed.
* Pure functions for geometry/pixel ops; single source of truth for `seed`, `time`.
* Avoid floating error accumulation in path traversal; use normalized `t` with segment caching.

---

## Milestones with acceptance criteria

**M0 — Boot + Camera**

* Canvas fills window; pan (RMB-drag), zoom (wheel) with world↔screen transforms.
* Show checkerboard background generated procedurally.
* Deterministic tick (`1/60`), pause/play.

**M1 — Palette + Glyph registry**

* Load `palette.json`, `glyphs.json`.
* RLE decode to off-screen canvases; draw a small gallery for sanity.

**M2 — Terrain layer**

* Procedural terrain pass using seeded noise bands (water/grass/forest/mountain).
* Alternatively, sparse painted grid from JSON.
* Culling by view bounds; ~60 FPS on a typical laptop.

**M3 — Vectors**

* Load `vectors` object; draw fills and strokes with widths/alphas keyed to zoom.
* LOD gates respected (`zoomMin/zoomMax`).

**M4 — Sprites + Agents**

* Place tree/city sprites from JSON using glyphs; cull by view.
* Carts follow `path` polylines at constant speed; optional click-to-add waypoint (editor mode toggle).

**M5 — Effects**

* Clouds synthesized in code; drift over time with parallax vs. zoom.
* Tree sway at high zoom only.

**M6 — State IO**

* Export full world JSON; reload and reproduce same frame given the same seed.
* Optional MediaRecorder export (kept off by default to respect text-only repo constraint).

**M7 — Hygiene**

* Tests for RLE encode/decode, arc-length stepping, LOD gates.
* README updated with data schemas.

---

## Implementation notes for Codex

1. **RLE decode/encode**

```js
// tokens like ["forest",3,"0",2] where "0" means transparent
function rleDecode(tokens, w, h, lut){
  const out = new Uint32Array(w*h);
  let i = 0;
  for (let t = 0; t < tokens.length; t += 2){
    const key = tokens[t], run = tokens[t+1]|0;
    const color = key === "0" ? 0 : lut[key]; // 0 = transparent
    out.fill(color, i, i + run);
    i += run;
  }
  return out; // caller blits to canvas ImageData
}
```

2. **Polyline motion (arc-length)**

```js
function parameterize(path){
  const cum=[0]; for(let i=1;i<path.length;i++){
    cum[i]=cum[i-1]+Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y);
  } return {cum, L:cum[cum.length-1]};
}
function atDistance(path, param, d){
  d = ((d % param.L)+param.L)%param.L;
  let i = 1; while (i<param.cum.length && param.cum[i]<d) i++;
  const a = path[i-1], b = path[i], seg = param.cum[i]-param.cum[i-1];
  const t = (d - param.cum[i-1]) / (seg||1);
  return { x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t };
}
```

3. **LOD gating**

```js
function visible(layer, zoom){ return zoom>=layer.zoomMin && zoom<=layer.zoomMax; }
```

---

## “Definition of Done” for v1

* Open `index.html` in a browser → interactive canvas appears.
* Pan/zoom is smooth; FPS stable with default data.
* Toggling layers is instantaneous; LOD thresholds respected.
* “Save” exports a single JSON document; “Load” restores it exactly.
* Reopening with the same JSON + seed reproduces the same animation.

---

## Getting started

* Place `index.html`, JS modules, and sample JSONs in `/public`.
* Open locally with a small HTTP server (or bundle to `bundle.js` to allow `file://`).
* Implement milestones in order; commit small, testable steps.
* Keep all visuals defined in JSON/ASCII; avoid adding binaries to the repo.

---

### What to build next (immediately actionable)

* M0 and M1 straight away. Codex should scaffold `assets.js` with RLE decode, palette LUT, and glyph instantiation to off-screen canvases; `renderer.js` should draw a tiled background and a glyph gallery at the top-left; `camera.js` should support pan/zoom; `world.js` should hold the seed, zoom, and layer toggles.
* After that, implement the procedural terrain pass (noise bands) and wire the LOD switch.

---

If you want, I can also draft the initial `index.html` and the base module skeletons (camera, renderer, assets, world) in the exact file layout above, with stubbed functions and TODOs aligned to the milestones.
