function normaliseBounds(bounds) {
  if (!bounds) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  const { minX, minY, maxX, maxY } = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error('VoxelWorld bounds must contain finite numbers.');
  }
  if (maxX <= minX || maxY <= minY) {
    throw new Error('VoxelWorld bounds must have positive area.');
  }
  return { minX, minY, maxX, maxY };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intersects(a, b) {
  return !(
    a.maxX <= b.left ||
    a.minX >= b.right ||
    a.maxY <= b.top ||
    a.minY >= b.bottom
  );
}

function contains(bounds, point) {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

function cloneMetadata(base, overrides = {}) {
  return {
    levelLabel: base?.levelLabel || 'voxel',
    name: base?.name || overrides.name || null,
    parentPath: base?.parentPath ? [...base.parentPath] : [],
    tags: base?.tags ? [...base.tags] : [],
    ...overrides
  };
}

function chunkKey(x, y) {
  return `${x}_${y}`;
}

function resolvePaletteLookup(palette) {
  const byId = new Map();
  const byKey = new Map();
  for (const entry of palette || []) {
    if (entry == null) continue;
    if (entry.id != null) {
      byId.set(entry.id, entry);
    }
    if (entry.key) {
      byKey.set(entry.key, entry);
    }
  }
  return { byId, byKey };
}

function resolveSpriteLookup(spritePalette) {
  const byId = new Map();
  for (const entry of spritePalette || []) {
    if (!entry) continue;
    const key = entry.id || entry.key;
    if (!key) continue;
    byId.set(key, entry);
  }
  return byId;
}

function mergePaletteRemap(defaults, overrides) {
  const merged = { ...defaults };
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (value == null) continue;
      merged[key] = value;
    }
  }
  return merged;
}

export class VoxelWorld {
  constructor({ index, palette, glyphs, seed = 0 } = {}) {
    if (!index) {
      throw new Error('VoxelWorld index is required');
    }
    this.index = index;
    this.bounds = normaliseBounds(index.bounds);
    this.origin = { x: index.origin?.x || 0, y: index.origin?.y || 0, z: index.origin?.z || 0 };
    this.scale = {
      x: index.scale?.x || 1,
      y: index.scale?.y || 1,
      z: index.scale?.z || 1
    };
    this.chunkSize = {
      width: index.chunkSize?.width || 16,
      depth: index.chunkSize?.depth || 16,
      height: index.chunkSize?.height || 8
    };
    this.grid = {
      width: index.chunkGrid?.width || 0,
      height: index.chunkGrid?.height || 0
    };
    this.binaryLayout = index.binaryLayout || {
      heightfield: { offset: 0, length: this.chunkSize.width * this.chunkSize.depth },
      voxels: { offset: this.chunkSize.width * this.chunkSize.depth, length: this.chunkSize.width * this.chunkSize.depth * this.chunkSize.height }
    };
    this.spriteLayer = index.spriteLayer || { maxPerChunk: 0, defaultScale: 1 };
    this.palette = resolvePaletteLookup(index.palette?.voxels || []);
    this.spritePalette = resolveSpriteLookup(index.palette?.sprites || []);
    this.globalPalette = palette || null;
    this.glyphs = glyphs || null;
    this.seed = seed >>> 0;
    this.chunks = new Map();
    this._spritePlacements = [];
  }

  hasChunk(key) {
    return this.chunks.has(key);
  }

  getChunk(key) {
    return this.chunks.get(key) || null;
  }

  ingestChunk(position, binary, metadata = {}) {
    if (!position || !Number.isInteger(position.x) || !Number.isInteger(position.y)) {
      throw new Error('Chunk position must contain integer x and y');
    }
    if (!(binary instanceof Uint8Array)) {
      throw new Error('Chunk payload must be Uint8Array');
    }
    const width = this.chunkSize.width;
    const depth = this.chunkSize.depth;
    const height = this.chunkSize.height;
    const cells = width * depth;
    const layout = this.binaryLayout;
    const heightStart = layout.heightfield?.offset ?? 0;
    const heightLength = layout.heightfield?.length ?? cells;
    const voxelStart = layout.voxels?.offset ?? heightLength;
    const voxelLength = layout.voxels?.length ?? cells * height;
    if (binary.length < voxelStart + voxelLength) {
      throw new Error('Voxel chunk payload shorter than expected');
    }
    const heights = binary.subarray(heightStart, heightStart + heightLength);
    const voxels = binary.subarray(voxelStart, voxelStart + voxelLength);
    const surfaces = new Uint8Array(cells);
    const tileIds = new Array(cells);
    const chunkKeyValue = chunkKey(position.x, position.y);
    for (let index = 0; index < cells; index++) {
      const declaredHeight = heights[index] || 0;
      const columnOffset = index * height;
      let topId = 0;
      const limit = clamp(declaredHeight, 0, height);
      if (limit > 0) {
        for (let z = limit - 1; z >= 0; z--) {
          const candidate = voxels[columnOffset + z] || 0;
          if (candidate !== 0) {
            topId = candidate;
            break;
          }
        }
      }
      if (topId === 0) {
        for (let z = height - 1; z >= 0; z--) {
          const candidate = voxels[columnOffset + z] || 0;
          if (candidate !== 0) {
            topId = candidate;
            break;
          }
        }
      }
      surfaces[index] = topId;
      tileIds[index] = this._resolveTileId(topId);
    }

    const bounds = this._chunkBounds(position.x, position.y);
    const spriteEntries = this._composeSpritePlacements(position, bounds, metadata.sprites || []);

    const chunkRecord = {
      id: chunkKeyValue,
      position: { x: position.x, y: position.y },
      bounds,
      heights,
      voxels,
      surfaces,
      tileIds,
      metadata: cloneMetadata(metadata.metadata || null, {
        levelLabel: 'chunk',
        name: metadata?.name || `Chunk ${position.x},${position.y}`,
        position: { ...position }
      }),
      sprites: spriteEntries
    };

    this.chunks.set(chunkKeyValue, chunkRecord);
    this._refreshSpritePlacements();
    return chunkRecord;
  }

  _chunkBounds(cx, cy) {
    const width = this.chunkSize.width * this.scale.x;
    const height = this.chunkSize.depth * this.scale.y;
    const minX = this.origin.x + cx * width;
    const minY = this.origin.y + cy * height;
    return {
      minX,
      minY,
      maxX: minX + width,
      maxY: minY + height
    };
  }

  _composeSpritePlacements(position, bounds, sprites) {
    if (!Array.isArray(sprites) || sprites.length === 0) {
      return [];
    }
    const placements = [];
    const cellWidth = this.scale.x;
    const cellHeight = this.scale.y;
    const defaultScale = this.spriteLayer?.defaultScale || 1;
    sprites.forEach((entry, index) => {
      if (!entry) return;
      const spriteId = entry.spriteKey || entry.id || `sprite_${index}`;
      const spriteDef = this.spritePalette.get(entry.spriteKey || entry.id || spriteId) || {};
      const glyphKey = spriteDef.glyph || entry.glyph || entry.spriteKey || entry.id;
      if (!glyphKey) {
        return;
      }
      const pos = entry.position || { x: 0, y: 0, z: 0 };
      const worldX = bounds.minX + pos.x * cellWidth;
      const worldY = bounds.minY + pos.y * cellHeight;
      const mergedPalette = mergePaletteRemap(spriteDef.defaultPalette || {}, entry.paletteRemap || {});
      const glyphRecord = this.glyphs?.byKey?.[glyphKey] || null;
      placements.push({
        id: entry.id || `${chunkKey(position.x, position.y)}:sprite:${index}`,
        spriteKey: glyphKey,
        position: { x: worldX, y: worldY },
        anchor: entry.anchor || spriteDef.anchor || null,
        scale: entry.scale != null ? entry.scale : defaultScale,
        rotation: entry.rotation || 0,
        zoomMin: entry.zoomMin ?? null,
        zoomMax: entry.zoomMax ?? null,
        voxelId: entry.voxelId ?? null,
        paletteRemap: mergedPalette,
        canvas: glyphRecord?.canvas || null,
        metadata: {
          chunk: { x: position.x, y: position.y },
          sourceId: entry.id || null,
          altitude: pos.z != null ? pos.z * this.scale.z : null
        }
      });
    });
    return placements;
  }

  _refreshSpritePlacements() {
    this._spritePlacements = [];
    for (const chunk of this.chunks.values()) {
      if (!Array.isArray(chunk.sprites)) continue;
      this._spritePlacements.push(...chunk.sprites);
    }
  }

  getSpritePlacements() {
    return this._spritePlacements;
  }

  _resolveTileId(voxelId) {
    if (voxelId == null) {
      return this.globalPalette?.defaultTileId ?? null;
    }
    const descriptor = this.palette.byId.get(voxelId) || this.palette.byKey.get(voxelId);
    if (descriptor?.tileKey && this.globalPalette?.byKey?.[descriptor.tileKey]) {
      return this.globalPalette.byKey[descriptor.tileKey].id;
    }
    if (this.globalPalette?.defaultTileId != null) {
      return this.globalPalette.defaultTileId;
    }
    return null;
  }

  _nodeForCell(chunk, cellX, cellY) {
    const width = this.chunkSize.width;
    const height = this.chunkSize.height;
    if (cellX < 0 || cellY < 0 || cellX >= width || cellY >= this.chunkSize.depth) {
      return null;
    }
    const index = cellY * width + cellX;
    const cellWidth = this.scale.x;
    const cellHeight = this.scale.y;
    const bounds = {
      minX: chunk.bounds.minX + cellX * cellWidth,
      maxX: chunk.bounds.minX + (cellX + 1) * cellWidth,
      minY: chunk.bounds.minY + cellY * cellHeight,
      maxY: chunk.bounds.minY + (cellY + 1) * cellHeight
    };
    const voxelId = chunk.surfaces[index] || 0;
    const tileId = chunk.tileIds[index] ?? null;
    const declaredHeight = chunk.heights[index] || 0;
    const columnOffset = index * height;
    const column = chunk.voxels.subarray(columnOffset, columnOffset + height);
    return {
      id: `${chunk.id}:${cellX},${cellY}`,
      lod: 0,
      parentId: chunk.id,
      bounds,
      minZoom: Number.NEGATIVE_INFINITY,
      maxZoom: null,
      metadata: cloneMetadata(chunk.metadata, {
        levelLabel: 'voxel-cell',
        name: `Voxel ${chunk.position.x},${chunk.position.y} · (${cellX},${cellY})`,
        parentPath: [chunk.id]
      }),
      payloadRefs: {
        terrain: tileId,
        terrainPatches: [],
        vector: [],
        parcels: [],
        buildings: [],
        sprites: [],
        voxel: {
          id: voxelId,
          column,
          height: declaredHeight
        }
      }
    };
  }

  getVisibleNodes(view, zoom) {
    const nodes = [];
    if (!view) {
      return nodes;
    }
    for (const chunk of this.chunks.values()) {
      if (!intersects(chunk.bounds, view)) {
        continue;
      }
      const cellWidth = this.scale.x;
      const cellHeight = this.scale.y;
      const startX = clamp(Math.floor((view.left - chunk.bounds.minX) / cellWidth), 0, this.chunkSize.width);
      const endX = clamp(Math.ceil((view.right - chunk.bounds.minX) / cellWidth), 0, this.chunkSize.width);
      const startY = clamp(Math.floor((view.top - chunk.bounds.minY) / cellHeight), 0, this.chunkSize.depth);
      const endY = clamp(Math.ceil((view.bottom - chunk.bounds.minY) / cellHeight), 0, this.chunkSize.depth);
      for (let cy = startY; cy < endY; cy++) {
        for (let cx = startX; cx < endX; cx++) {
          const node = this._nodeForCell(chunk, cx, cy);
          if (node) {
            nodes.push(node);
          }
        }
      }
    }
    return nodes;
  }

  sampleCell(point) {
    if (!point) return null;
    for (const chunk of this.chunks.values()) {
      if (!contains(chunk.bounds, point)) {
        continue;
      }
      const cellWidth = this.scale.x;
      const cellHeight = this.scale.y;
      const localX = Math.floor((point.x - chunk.bounds.minX) / cellWidth);
      const localY = Math.floor((point.y - chunk.bounds.minY) / cellHeight);
      const node = this._nodeForCell(chunk, localX, localY);
      if (node) {
        return { node, chunk };
      }
    }
    return null;
  }

  getCellById(id) {
    if (!id || typeof id !== 'string') {
      return null;
    }
    const parts = id.split(':');
    if (parts.length < 2) {
      return null;
    }
    const chunkId = parts[0];
    const coords = parts[1].split(',').map(Number);
    if (coords.length < 2) {
      return null;
    }
    const [cx, cy] = coords;
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
      return null;
    }
    const chunk = this.chunks.get(chunkId);
    if (!chunk) {
      return null;
    }
    return this._nodeForCell(chunk, cx, cy);
  }

  *streamCells() {
    for (const chunk of this.chunks.values()) {
      for (let cy = 0; cy < this.chunkSize.depth; cy++) {
        for (let cx = 0; cx < this.chunkSize.width; cx++) {
          const node = this._nodeForCell(chunk, cx, cy);
          if (node) {
            yield node;
          }
        }
      }
    }
  }
}
