# Quadtree World Specification

## Node Hierarchy

The world is partitioned as a quadtree where each level refines the previous
level into four rhombus-shaped diamonds. The root node spans the entire world
bounds and represents the **continent** level. Each child node alternates its
axis-aligned bounds into a diamond footprint to provide smoother LOD transitions
as zoom increases.

| LOD | Geographic layer | Footprint |
| --- | ---------------- | --------- |
| 0   | Continent        | Single bounding diamond covering the world |
| 1   | Region           | Four child diamonds representing macro landmasses |
| 2   | District         | Diamonds for civic districts/countryside |
| 3   | Parcel           | Property level subdivisions |
| 4+  | Building         | Individual buildings, props, and sub-parcels |

Each node stores:

- **`id`** – opaque identifier used for referencing in streams and lookups.
- **`lod`** – integer level-of-detail index (0 = continent).
- **`bounds`** – `{ minX, minY, maxX, maxY }` axis-aligned rectangle that wraps
  the diamond footprint. Rhombus vertices are derived from the rectangle.
- **`children`** – array of child ids (length 0 or 4).
- **`metadata`** – structural data describing the administrative layer, parent
  lineage, and last modification timestamp.
- **`payloadRefs`** – handles to resolved content such as terrain palette ids,
  vector feature ids, parcel geometry, building footprints, sprite batches, or
  deferred streaming resources.

## Coordinate System

All positions are in world coordinates measured in kilometers. The root node
starts at `(0, 0)` in the south-west corner and `(width, height)` in the
north-east corner. Child node bounds are computed by splitting the parent bounds
midpoint horizontally and vertically.

The renderer samples nodes through axis-aligned bounds while presenting the
inner diamond footprint. Sampling always clamps to the root bounds so pointer
input and camera movement remain consistent with legacy grid worlds.

## Subdivision Strategy

Nodes subdivide when any of the following triggers fire:

1. **Zoom threshold** – if the camera zoom reaches the `minZoom` stored on a
   node, it is replaced by its children.
2. **Content pressure** – payload attachments can request subdivision to reach a
   minimum parcel density before accepting new buildings.
3. **User interaction** – editing tools may call `subdivideNode(nodeId)` to
   force refinement at the pointer location.

Subdivision always creates four child nodes. Child metadata includes
`levelLabel` values of `region`, `district`, `parcel`, or `building` depending on
the parent level.

## Metadata Schema

Each node metadata object contains:

```json
{
  "levelLabel": "district",
  "name": "Old Town",
  "parentPath": ["continent:aurora", "region:central"],
  "createdAt": 1731806400000,
  "updatedAt": 1731806400000,
  "tags": ["port", "river"]
}
```

Metadata is lightweight and can be streamed independently from payloads. Payload
handles are used to pull detailed feature blobs from other services.

## Streaming Format

Nodes are serialized as newline-delimited JSON (NDJSON) records. The first
record is a header describing the quadtree. Subsequent records contain node
objects. Example:

```json
{"type":"header","version":1,"root":"root","bounds":{"minX":0,"minY":0,"maxX":1024,"maxY":1024}}
{"type":"node","id":"root","lod":0,"bounds":{"minX":0,"minY":0,"maxX":1024,"maxY":1024},"children":["root:0","root:1","root:2","root:3"],"metadata":{"levelLabel":"continent"},"payloadRefs":{"terrain":null}}
{"type":"node","id":"root:0","lod":1,"bounds":{...}}
```

Streaming supports lazy loading—clients can start rendering as soon as the
header and the first visible nodes arrive—and eviction by forgetting nodes whose
records are no longer needed.
