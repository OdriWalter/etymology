# Voxel World Specification

## Chunk Topology

The voxel terrain is partitioned into fixed-size chunks that tile the world
bounds without overlap. Each chunk spans **32×32** columns on the X and Y axes
and extends vertically for **32 layers** (`H = 32`) along the Z axis. World
coordinates are measured in the same linear units used by the renderer; the
chunk grid is aligned to the world origin so that the south‑west corner of the
world resides at `(bounds.minX, bounds.minY, 0)`.

| Symbol | Meaning | Default |
| ------ | ------- | ------- |
| `S` | Chunk side length along X/Y | 32 columns |
| `H` | Chunk height in voxels | 32 layers |
| `cx, cy` | Chunk indices in the grid | `⌊(x - minX) / S⌋`, `⌊(y - minY) / S⌋` |
| `lx, ly` | Local column coordinates inside a chunk | `0 ≤ lx, ly < S` |
| `lz` | Local vertical coordinate | `0 ≤ lz < H` |

Each chunk owns a bounding box expressed in world coordinates:

```
minX = bounds.minX + cx * S
minY = bounds.minY + cy * S
maxX = min(minX + S, bounds.maxX)
maxY = min(minY + S, bounds.maxY)
```

The horizontal slice of a chunk therefore maps 1:1 to a 32×32 grid of voxel
columns.

## Coordinate Spaces

Three coordinate spaces are used when manipulating the voxel terrain:

1. **World space** – floating point values in renderer units. Input devices and
   cameras operate in this space. Conversion to chunk space is performed by
   subtracting the world origin and dividing by the chunk side length.
2. **Chunk space** – integer chunk indices `(cx, cy)` along with local column
   indices `(lx, ly)`. All persistence and batching logic operates on chunk
   records keyed by their integer coordinates.
3. **Voxel space** – the vertical stack inside a column. Voxels are indexed by
   `lz` where `0` is ground level and `H - 1` is the top of the column.

```
const cx = Math.floor((x - bounds.minX) / S);
const lx = Math.floor((x - bounds.minX) - cx * S);
const cy = Math.floor((y - bounds.minY) / S);
const ly = Math.floor((y - bounds.minY) - cy * S);
```

Out-of-bounds lookups are clamped to the world limits before converting to
chunk space.

## Column → Sprite Mapping

Each voxel column tracks its highest occupied layer. The column metadata stores:

- `top` – the voxel at the highest non-empty layer with `{ tileId, z }`.
- `spriteKey` – an optional atlas identifier for the pixel-art sprite that
  should be used to render the column.
- `variant` – free-form metadata (e.g. biome tint, animation frame).

When the renderer queries visible chunks via `iterateVisibleChunks`, it receives
an immutable snapshot of chunk payloads including column metadata. The renderer
can derive draw calls by iterating over the 32×32 column grid and selecting the
sprite for each column using `spriteKey`. If `spriteKey` is omitted, the tile id
is resolved against the palette to obtain a fallback sprite.

## Persistence Model

Serialized chunk records capture both structural information and voxel content:

```json
{
  "type": "chunk",
  "id": "chunk:10,4",
  "chunkX": 10,
  "chunkY": 4,
  "bounds": { "minX": 320, "minY": 128, "maxX": 352, "maxY": 160 },
  "metadata": { "levelLabel": "chunk", "tags": [] },
  "payload": {
    "voxels": "base64…",
    "columns": [ { "top": { "tileId": 7, "z": 1 }, "spriteKey": "grass" }, … ]
  }
}
```

Voxel layers are packed into a `Uint32Array` prior to serialization and encoded
as base64 strings. Columns are emitted as JSON objects to preserve descriptive
metadata without extra decoding work on load.

## Public API Overview

`world/voxelWorld.js` exposes a light-weight facade used by `world.js` and the
renderer:

- `getChunk(cx, cy)` – returns the mutable chunk record at the given indices,
  creating it on demand.
- `setVoxel(worldX, worldY, worldZ, tileId, metadata)` – writes a voxel in world
  coordinates, updating the owning chunk and column metadata.
- `iterateVisibleChunks(viewBounds, callback)` – lazily traverses every chunk
  whose bounds intersect the camera frustum, invoking `callback(chunk)` for
  streaming scenarios or returning an array of chunks when no callback is
  supplied.

The helper also offers compatibility methods such as `getVisibleNodes` to ease
migration from the previous quadtree terrain system.
