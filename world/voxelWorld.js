const DEFAULT_CHUNK_SIZE = 32;
const DEFAULT_CHUNK_HEIGHT = 32;
const DEFAULT_ZOOM_THRESHOLDS = [-Infinity];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normaliseBounds(bounds) {
  if (!bounds) {
    return { minX: 0, minY: 0, maxX: DEFAULT_CHUNK_SIZE, maxY: DEFAULT_CHUNK_SIZE };
  }
  const { minX, minY, maxX, maxY } = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error('Bounds must contain finite numbers.');
  }
  if (maxX <= minX || maxY <= minY) {
    throw new Error('Bounds must have positive area.');
  }
  return { minX, minY, maxX, maxY };
}

function encodeColumn(column) {
  if (!column) {
    return null;
  }
  const result = {};
  if (column.top) {
    result.top = { tileId: column.top.tileId, z: column.top.z };
  }
  if (column.spriteKey) {
    result.spriteKey = column.spriteKey;
  }
  if (column.variant != null) {
    result.variant = column.variant;
  }
  if (column.metadata && Object.keys(column.metadata).length > 0) {
    result.metadata = { ...column.metadata };
  }
  return result;
}

function decodeColumn(data) {
  if (!data || typeof data !== 'object') {
    return { top: null, spriteKey: null, variant: null, metadata: null };
  }
  const column = {
    top: data.top ? { tileId: data.top.tileId ?? null, z: data.top.z ?? 0 } : null,
    spriteKey: data.spriteKey ?? null,
    variant: data.variant ?? null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : null
  };
  return column;
}

function createEmptyColumn() {
  return { top: null, spriteKey: null, variant: null, metadata: null };
}

function cloneColumn(column) {
  if (!column) {
    return createEmptyColumn();
  }
  return {
    top: column.top ? { tileId: column.top.tileId, z: column.top.z } : null,
    spriteKey: column.spriteKey ?? null,
    variant: column.variant ?? null,
    metadata: column.metadata ? { ...column.metadata } : null
  };
}

function clonePayloadRefs(payloadRefs) {
  return {
    terrain: payloadRefs?.terrain ?? null,
    terrainPatches: Array.isArray(payloadRefs?.terrainPatches) ? payloadRefs.terrainPatches.map((patch) => ({ ...patch })) : [],
    vector: Array.isArray(payloadRefs?.vector) ? payloadRefs.vector.map((feature) => ({ ...feature })) : [],
    parcels: Array.isArray(payloadRefs?.parcels) ? payloadRefs.parcels.map((feature) => ({ ...feature })) : [],
    buildings: Array.isArray(payloadRefs?.buildings) ? payloadRefs.buildings.map((feature) => ({ ...feature })) : [],
    sprites: Array.isArray(payloadRefs?.sprites) ? payloadRefs.sprites.map((feature) => ({ ...feature })) : [],
    effects: Array.isArray(payloadRefs?.effects) ? payloadRefs.effects.map((feature) => ({ ...feature })) : []
  };
}

function encodeVoxels(typedArray) {
  if (!(typedArray instanceof Uint32Array)) {
    return '';
  }
  if (typeof Buffer === 'function') {
    return Buffer.from(typedArray.buffer).toString('base64');
  }
  const bytes = new Uint8Array(typedArray.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return binary;
}

function decodeVoxels(base64, length) {
  if (typeof base64 !== 'string' || base64.length === 0) {
    return new Uint32Array(length);
  }
  if (typeof Buffer === 'function') {
    const buffer = Buffer.from(base64, 'base64');
    const array = new Uint32Array(length);
    array.set(new Uint32Array(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, length * 4) / 4));
    return array;
  }
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      buffer[i] = binary.charCodeAt(i);
    }
    const array = new Uint32Array(length);
    array.set(new Uint32Array(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, length * 4) / 4));
    return array;
  }
  return new Uint32Array(length);
}

export class VoxelWorld {
  constructor({ bounds, chunkSize = DEFAULT_CHUNK_SIZE, chunkHeight = DEFAULT_CHUNK_HEIGHT, zoomThresholds = DEFAULT_ZOOM_THRESHOLDS } = {}) {
    this.bounds = normaliseBounds(bounds);
    this.chunkSize = Math.max(1, Math.floor(chunkSize));
    this.chunkHeight = Math.max(1, Math.floor(chunkHeight));
    this.zoomThresholds = Array.isArray(zoomThresholds) && zoomThresholds.length > 0
      ? zoomThresholds.map((value) => Number.isFinite(value) ? value : -Infinity)
      : DEFAULT_ZOOM_THRESHOLDS;
    this.chunkCountX = Math.ceil((this.bounds.maxX - this.bounds.minX) / this.chunkSize);
    this.chunkCountY = Math.ceil((this.bounds.maxY - this.bounds.minY) / this.chunkSize);
    this.nodes = new Map();
    this.rootId = 'root';
    this.maxLod = 0;
    this._createRoot();
  }

  _createRoot() {
    const node = {
      id: this.rootId,
      parentId: null,
      lod: 0,
      bounds: { ...this.bounds },
      children: [],
      metadata: {
        levelLabel: 'world',
        name: 'World Root',
        parentPath: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: []
      },
      payloadRefs: {
        terrain: null,
        terrainPatches: [],
        vector: [],
        parcels: [],
        buildings: [],
        sprites: [],
        effects: []
      },
      minZoom: this.zoomThresholds[0] ?? -Infinity,
      maxZoom: null
    };
    this.nodes.set(node.id, node);
  }

  _chunkKey(cx, cy) {
    return `chunk:${cx},${cy}`;
  }

  _voxelIndex(localX, localY, localZ) {
    return localZ * this.chunkSize * this.chunkSize + localY * this.chunkSize + localX;
  }

  _columnIndex(localX, localY) {
    return localY * this.chunkSize + localX;
  }

  _worldToChunk(x, y) {
    const clampedX = clamp(x, this.bounds.minX, this.bounds.maxX - 1e-9);
    const clampedY = clamp(y, this.bounds.minY, this.bounds.maxY - 1e-9);
    const relX = clampedX - this.bounds.minX;
    const relY = clampedY - this.bounds.minY;
    const chunkX = clamp(Math.floor(relX / this.chunkSize), 0, this.chunkCountX - 1);
    const chunkY = clamp(Math.floor(relY / this.chunkSize), 0, this.chunkCountY - 1);
    const localX = clamp(Math.floor(relX - chunkX * this.chunkSize), 0, this.chunkSize - 1);
    const localY = clamp(Math.floor(relY - chunkY * this.chunkSize), 0, this.chunkSize - 1);
    return { chunkX, chunkY, localX, localY };
  }

  _createChunk(cx, cy) {
    const key = this._chunkKey(cx, cy);
    if (this.nodes.has(key)) {
      return this.nodes.get(key);
    }
    const minX = this.bounds.minX + cx * this.chunkSize;
    const minY = this.bounds.minY + cy * this.chunkSize;
    const maxX = Math.min(minX + this.chunkSize, this.bounds.maxX);
    const maxY = Math.min(minY + this.chunkSize, this.bounds.maxY);
    const chunk = {
      id: key,
      parentId: this.rootId,
      lod: 0,
      chunkX: cx,
      chunkY: cy,
      bounds: { minX, minY, maxX, maxY },
      children: [],
      metadata: {
        levelLabel: 'chunk',
        name: `Chunk ${cx},${cy}`,
        parentPath: ['world:root'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tags: []
      },
      payloadRefs: {
        terrain: null,
        terrainPatches: [],
        vector: [],
        parcels: [],
        buildings: [],
        sprites: [],
        effects: []
      },
      minZoom: this.zoomThresholds[0] ?? -Infinity,
      maxZoom: null,
      voxels: new Uint32Array(this.chunkSize * this.chunkSize * this.chunkHeight),
      columns: Array.from({ length: this.chunkSize * this.chunkSize }, () => createEmptyColumn())
    };
    this.nodes.set(key, chunk);
    const root = this.nodes.get(this.rootId);
    if (root) {
      if (!root.children.includes(key)) {
        root.children.push(key);
        root.metadata.updatedAt = Date.now();
      }
    }
    return chunk;
  }

  getChunk(cx, cy) {
    if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
      return null;
    }
    if (cx < 0 || cy < 0 || cx >= this.chunkCountX || cy >= this.chunkCountY) {
      return null;
    }
    return this._createChunk(cx, cy);
  }

  getChunkById(id) {
    if (!id || typeof id !== 'string') {
      return null;
    }
    return this.nodes.get(id) || null;
  }

  getNode(id) {
    return this.nodes.get(id) || null;
  }

  ensureNodeForTile(lod, tileX, tileY) {
    const cx = clamp(Number.isFinite(tileX) ? Math.floor(tileX) : 0, 0, this.chunkCountX - 1);
    const cy = clamp(Number.isFinite(tileY) ? Math.floor(tileY) : 0, 0, this.chunkCountY - 1);
    return this.getChunk(cx, cy);
  }

  setNodePayload(nodeId, payloadRefs = {}) {
    const chunk = typeof nodeId === 'string' ? this.getChunkById(nodeId) : nodeId;
    if (!chunk) {
      return null;
    }
    const existing = chunk.payloadRefs;
    chunk.payloadRefs = {
      terrain: payloadRefs.terrain ?? existing.terrain ?? null,
      terrainPatches: Array.isArray(payloadRefs.terrainPatches)
        ? payloadRefs.terrainPatches.map((patch) => ({ ...patch }))
        : existing.terrainPatches.map((patch) => ({ ...patch })),
      vector: Array.isArray(payloadRefs.vector)
        ? payloadRefs.vector.map((feature) => ({ ...feature }))
        : existing.vector.map((feature) => ({ ...feature })),
      parcels: Array.isArray(payloadRefs.parcels)
        ? payloadRefs.parcels.map((feature) => ({ ...feature }))
        : existing.parcels.map((feature) => ({ ...feature })),
      buildings: Array.isArray(payloadRefs.buildings)
        ? payloadRefs.buildings.map((feature) => ({ ...feature }))
        : existing.buildings.map((feature) => ({ ...feature })),
      sprites: Array.isArray(payloadRefs.sprites)
        ? payloadRefs.sprites.map((feature) => ({ ...feature }))
        : existing.sprites.map((feature) => ({ ...feature })),
      effects: Array.isArray(payloadRefs.effects)
        ? payloadRefs.effects.map((feature) => ({ ...feature }))
        : existing.effects.map((feature) => ({ ...feature }))
    };
    chunk.metadata.updatedAt = Date.now();
    return chunk;
  }

  setMetadata(nodeId, metadata) {
    const chunk = typeof nodeId === 'string' ? this.getChunkById(nodeId) : nodeId;
    if (!chunk) {
      return null;
    }
    if (!metadata || typeof metadata !== 'object') {
      return chunk.metadata;
    }
    chunk.metadata = {
      ...chunk.metadata,
      ...metadata,
      parentPath: Array.isArray(metadata.parentPath) ? [...metadata.parentPath] : [...(chunk.metadata.parentPath || [])],
      tags: Array.isArray(metadata.tags) ? [...metadata.tags] : [...(chunk.metadata.tags || [])],
      updatedAt: Date.now()
    };
    return chunk.metadata;
  }

  setVoxel(worldX, worldY, worldZ, tileId, { spriteKey = null, variant = null, metadata = null } = {}) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) {
      return null;
    }
    const { chunkX, chunkY, localX, localY } = this._worldToChunk(worldX, worldY);
    const chunk = this.getChunk(chunkX, chunkY);
    if (!chunk) {
      return null;
    }
    const z = clamp(Number.isFinite(worldZ) ? Math.floor(worldZ) : 0, 0, this.chunkHeight - 1);
    const index = this._voxelIndex(localX, localY, z);
    chunk.voxels[index] = tileId >>> 0;
    const columnIndex = this._columnIndex(localX, localY);
    const column = chunk.columns[columnIndex] ?? createEmptyColumn();
    column.top = { tileId: tileId >>> 0, z };
    if (spriteKey != null) {
      column.spriteKey = spriteKey;
    }
    if (variant != null) {
      column.variant = variant;
    }
    if (metadata && typeof metadata === 'object') {
      column.metadata = { ...metadata };
    }
    chunk.columns[columnIndex] = column;
    if (chunk.payloadRefs.terrain == null) {
      chunk.payloadRefs.terrain = tileId >>> 0;
    }
    chunk.metadata.updatedAt = Date.now();
    return chunk;
  }

  _collectVisibleChunkIndices(viewBounds) {
    if (!viewBounds) {
      return { minCx: 0, maxCx: this.chunkCountX - 1, minCy: 0, maxCy: this.chunkCountY - 1 };
    }
    const left = viewBounds.left ?? viewBounds.minX ?? this.bounds.minX;
    const top = viewBounds.top ?? viewBounds.minY ?? this.bounds.minY;
    const right = viewBounds.right ?? (viewBounds.maxX ?? this.bounds.maxX);
    const bottom = viewBounds.bottom ?? (viewBounds.maxY ?? this.bounds.maxY);
    const minCx = clamp(Math.floor((left - this.bounds.minX) / this.chunkSize), 0, this.chunkCountX - 1);
    const maxCx = clamp(Math.floor((right - this.bounds.minX) / this.chunkSize), 0, this.chunkCountX - 1);
    const minCy = clamp(Math.floor((top - this.bounds.minY) / this.chunkSize), 0, this.chunkCountY - 1);
    const maxCy = clamp(Math.floor((bottom - this.bounds.minY) / this.chunkSize), 0, this.chunkCountY - 1);
    return { minCx, maxCx, minCy, maxCy };
  }

  iterateVisibleChunks(viewBounds, callback) {
    const { minCx, maxCx, minCy, maxCy } = this._collectVisibleChunkIndices(viewBounds);
    if (typeof callback === 'function') {
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const chunk = this.getChunk(cx, cy);
          if (chunk) {
            callback(chunk);
          }
        }
      }
      return;
    }
    const result = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const chunk = this.getChunk(cx, cy);
        if (chunk) {
          result.push(chunk);
        }
      }
    }
    return result;
  }

  getVisibleNodes(viewBounds) {
    return this.iterateVisibleChunks(viewBounds) || [];
  }

  sampleFeatureAt(point) {
    if (!point) {
      return null;
    }
    const { chunkX, chunkY } = this._worldToChunk(point.x, point.y);
    return this.getChunk(chunkX, chunkY);
  }

  subdivideNode(nodeId) {
    if (nodeId !== this.rootId) {
      return [];
    }
    const children = [];
    for (let cx = 0; cx < this.chunkCountX; cx++) {
      for (let cy = 0; cy < this.chunkCountY; cy++) {
        const chunk = this.getChunk(cx, cy);
        if (chunk) {
          children.push(chunk);
        }
      }
    }
    return children;
  }

  pruneSubtree() {
    // No-op for voxel world; chunks persist once created.
  }

  streamChunks() {
    const records = [];
    for (const node of this.nodes.values()) {
      if (node.id === this.rootId) {
        records.push({
          type: 'root',
          id: node.id,
          bounds: { ...node.bounds },
          metadata: { ...node.metadata },
          zoomThresholds: [...this.zoomThresholds]
        });
        continue;
      }
      records.push({
        type: 'chunk',
        id: node.id,
        chunkX: node.chunkX,
        chunkY: node.chunkY,
        bounds: { ...node.bounds },
        metadata: { ...node.metadata },
        payloadRefs: clonePayloadRefs(node.payloadRefs),
        voxels: encodeVoxels(node.voxels),
        columns: node.columns.map(encodeColumn)
      });
    }
    return records;
  }

  loadFromStream(records) {
    this.nodes = new Map();
    this._createRoot();
    if (!Array.isArray(records)) {
      return;
    }
    for (const record of records) {
      if (!record || typeof record !== 'object') {
        continue;
      }
      if (record.type === 'root') {
        const root = this.nodes.get(this.rootId);
        if (root) {
          root.metadata = record.metadata ? { ...record.metadata } : root.metadata;
          root.bounds = record.bounds ? { ...record.bounds } : root.bounds;
        }
        continue;
      }
      if (record.type !== 'chunk') {
        continue;
      }
      const { chunkX = 0, chunkY = 0 } = record;
      const chunk = this._createChunk(chunkX, chunkY);
      chunk.metadata = record.metadata ? { ...record.metadata } : chunk.metadata;
      chunk.payloadRefs = clonePayloadRefs(record.payloadRefs);
      const total = this.chunkSize * this.chunkSize * this.chunkHeight;
      chunk.voxels = decodeVoxels(record.voxels, total);
      chunk.columns = Array.isArray(record.columns)
        ? record.columns.map((column) => decodeColumn(column))
        : chunk.columns.map(() => createEmptyColumn());
    }
  }
}
