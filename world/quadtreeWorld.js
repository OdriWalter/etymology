const LEVEL_LABELS = ['continent', 'region', 'district', 'parcel', 'building'];

function normaliseBounds(bounds) {
  if (!bounds) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
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

function levelLabelForLod(lod) {
  if (lod < LEVEL_LABELS.length) {
    return LEVEL_LABELS[lod];
  }
  return LEVEL_LABELS[LEVEL_LABELS.length - 1];
}

function intersects(bounds, view) {
  return !(
    bounds.maxX <= view.left ||
    bounds.minX >= view.right ||
    bounds.maxY <= view.top ||
    bounds.minY >= view.bottom
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

function midpoint(a, b) {
  return (a + b) / 2;
}

function createChildBounds(parentBounds, index) {
  const { minX, minY, maxX, maxY } = parentBounds;
  const midX = midpoint(minX, maxX);
  const midY = midpoint(minY, maxY);
  switch (index) {
    case 0:
      return { minX, minY: midY, maxX: midX, maxY };
    case 1:
      return { minX: midX, minY: midY, maxX, maxY };
    case 2:
      return { minX, minY, maxX: midX, maxY: midY };
    case 3:
    default:
      return { minX: midX, minY, maxX, maxY: midY };
  }
}

function defaultMetadata(lod, parentMetadata) {
  const timestamp = Date.now();
  const levelLabel = levelLabelForLod(lod);
  const parentPath = parentMetadata?.parentPath || [];
  const parentLabel = parentMetadata?.levelLabel && parentMetadata?.name
    ? `${parentMetadata.levelLabel}:${parentMetadata.name}`
    : null;
  const lineage = parentLabel ? parentPath.concat(parentLabel) : parentPath;
  return {
    levelLabel,
    name: null,
    parentPath: lineage,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: []
  };
}

function cloneNode(node) {
  return {
    id: node.id,
    lod: node.lod,
    parentId: node.parentId,
    bounds: { ...node.bounds },
    children: [...node.children],
    metadata: { ...node.metadata, parentPath: [...node.metadata.parentPath], tags: [...node.metadata.tags] },
    payloadRefs: {
      terrain: node.payloadRefs.terrain,
      vector: [...node.payloadRefs.vector],
      parcels: [...node.payloadRefs.parcels],
      buildings: [...node.payloadRefs.buildings],
      sprites: [...node.payloadRefs.sprites],
      effects: [...node.payloadRefs.effects]
    },
    minZoom: node.minZoom,
    maxZoom: node.maxZoom
  };
}

export class QuadtreeWorld {
  constructor({ bounds, maxLod = 6, zoomThresholds } = {}) {
    this.bounds = normaliseBounds(bounds);
    this.maxLod = Math.max(1, Math.floor(maxLod));
    this.zoomThresholds = Array.isArray(zoomThresholds)
      ? zoomThresholds.map(v => Number.isFinite(v) ? v : -Infinity)
      : [-Infinity, -1, 0, 1, 2, 3];
    this.nodes = new Map();
    this.rootId = 'root';
    this._createRoot();
  }

  _createRoot() {
    const node = this._createNode(this.rootId, null, 0, this.bounds, null);
    this.nodes.set(node.id, node);
  }

  _createNode(id, parentId, lod, bounds, parentMetadata) {
    const metadata = defaultMetadata(lod, parentMetadata);
    return {
      id,
      parentId,
      lod,
      bounds,
      children: [],
      metadata,
      payloadRefs: {
        terrain: null,
        vector: [],
        parcels: [],
        buildings: [],
        sprites: [],
        effects: []
      },
      minZoom: this.zoomThresholds[Math.min(lod, this.zoomThresholds.length - 1)],
      maxZoom: null
    };
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId) || null;
  }

  updateNode(nodeId, updater) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    const next = cloneNode(node);
    const result = updater(next) || next;
    result.metadata.updatedAt = Date.now();
    this.nodes.set(nodeId, result);
    return result;
  }

  setNodePayload(nodeId, payloadRefs) {
    return this.updateNode(nodeId, (node) => {
      node.payloadRefs = {
        terrain: payloadRefs.terrain ?? node.payloadRefs.terrain ?? null,
        vector: payloadRefs.vector ? [...payloadRefs.vector] : [...node.payloadRefs.vector],
        parcels: payloadRefs.parcels ? [...payloadRefs.parcels] : [...node.payloadRefs.parcels],
        buildings: payloadRefs.buildings ? [...payloadRefs.buildings] : [...node.payloadRefs.buildings],
        sprites: payloadRefs.sprites ? [...payloadRefs.sprites] : [...node.payloadRefs.sprites],
        effects: payloadRefs.effects ? [...payloadRefs.effects] : [...node.payloadRefs.effects]
      };
    });
  }

  ensureNodeForTile(lod, tileX, tileY) {
    if (!Number.isInteger(lod) || lod < 0) {
      throw new Error('LOD must be a non-negative integer');
    }
    if (!Number.isInteger(tileX) || tileX < 0) {
      throw new Error('tileX must be a non-negative integer');
    }
    if (!Number.isInteger(tileY) || tileY < 0) {
      throw new Error('tileY must be a non-negative integer');
    }
    const tilesPerAxis = 1 << lod;
    if (tileX >= tilesPerAxis || tileY >= tilesPerAxis) {
      throw new Error(`Tile coordinates (${tileX}, ${tileY}) out of range for lod ${lod}`);
    }
    let node = this.nodes.get(this.rootId);
    if (!node) {
      throw new Error('Quadtree root node is missing');
    }
    if (lod === 0) {
      return node;
    }
    for (let depth = lod - 1; depth >= 0; depth--) {
      if (node.children.length !== 4) {
        this.subdivideNode(node.id);
        node = this.nodes.get(node.id);
      }
      const mask = 1 << depth;
      const column = (tileX & mask) !== 0 ? 1 : 0;
      const row = (tileY & mask) !== 0 ? 1 : 0;
      let childIndex = 0;
      if (row === 0 && column === 1) childIndex = 1;
      else if (row === 1 && column === 0) childIndex = 2;
      else if (row === 1 && column === 1) childIndex = 3;
      const childId = node.children[childIndex];
      const child = this.nodes.get(childId);
      if (!child) {
        throw new Error(`Failed to resolve child node for tile (${lod}, ${tileX}, ${tileY})`);
      }
      node = child;
    }
    return node;
  }

  setMetadata(nodeId, metadata) {
    return this.updateNode(nodeId, (node) => {
      node.metadata = {
        ...node.metadata,
        ...metadata,
        parentPath: Array.isArray(metadata?.parentPath) ? [...metadata.parentPath] : [...node.metadata.parentPath],
        tags: Array.isArray(metadata?.tags) ? [...metadata.tags] : [...node.metadata.tags]
      };
    });
  }

  subdivideNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return [];
    if (node.children.length === 4) {
      return node.children.map(id => this.nodes.get(id));
    }
    if (node.lod >= this.maxLod) {
      return [];
    }
    const children = [];
    for (let i = 0; i < 4; i++) {
      const childId = `${node.id}:${i}`;
      const bounds = createChildBounds(node.bounds, i);
      const child = this._createNode(childId, node.id, node.lod + 1, bounds, node.metadata);
      this.nodes.set(childId, child);
      children.push(childId);
    }
    node.children = children;
    node.metadata.updatedAt = Date.now();
    this.nodes.set(node.id, node);
    return children.map(id => this.nodes.get(id));
  }

  pruneSubtree(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    for (const childId of node.children) {
      this.pruneSubtree(childId);
    }
    if (node.id !== this.rootId) {
      this.nodes.delete(node.id);
    } else {
      node.children = [];
      this.nodes.set(node.id, node);
    }
  }

  getVisibleNodes(viewBounds, zoom) {
    if (!viewBounds) {
      throw new Error('viewBounds is required');
    }
    const stack = [];
    const results = [];
    const root = this.nodes.get(this.rootId);
    if (!root) return results;
    stack.push(root);
    while (stack.length > 0) {
      const node = stack.pop();
      if (!intersects(node.bounds, viewBounds)) {
        continue;
      }
      const nextLod = Math.min(node.lod + 1, this.zoomThresholds.length - 1);
      const threshold = this.zoomThresholds[nextLod];
      const shouldDrill = node.children.length === 4 && zoom >= threshold;
      if (shouldDrill) {
        for (const childId of node.children) {
          const child = this.nodes.get(childId);
          if (child) {
            stack.push(child);
          }
        }
        continue;
      }
      results.push(node);
    }
    return results;
  }

  sampleFeatureAt(point, zoom) {
    if (!point) return null;
    const root = this.nodes.get(this.rootId);
    if (!root) return null;
    let current = root;
    while (current) {
      if (!contains(current.bounds, point)) {
        return null;
      }
      const nextLod = Math.min(current.lod + 1, this.zoomThresholds.length - 1);
      const threshold = this.zoomThresholds[nextLod];
      const shouldDescend = current.children.length === 4 && zoom >= threshold;
      if (!shouldDescend) {
        return current;
      }
      let next = null;
      for (const childId of current.children) {
        const child = this.nodes.get(childId);
        if (child && contains(child.bounds, point)) {
          next = child;
          break;
        }
      }
      if (!next) {
        return current;
      }
      current = next;
    }
    return null;
  }

  *streamNodes() {
    yield {
      type: 'header',
      version: 1,
      root: this.rootId,
      bounds: { ...this.bounds },
      zoomThresholds: [...this.zoomThresholds]
    };
    for (const node of this.nodes.values()) {
      yield {
        type: 'node',
        id: node.id,
        parentId: node.parentId,
        lod: node.lod,
        bounds: { ...node.bounds },
        children: [...node.children],
        metadata: { ...node.metadata, parentPath: [...node.metadata.parentPath], tags: [...node.metadata.tags] },
        payloadRefs: {
          terrain: node.payloadRefs.terrain,
          vector: [...node.payloadRefs.vector],
          parcels: [...node.payloadRefs.parcels],
          buildings: [...node.payloadRefs.buildings],
          sprites: [...node.payloadRefs.sprites],
          effects: [...node.payloadRefs.effects]
        },
        minZoom: node.minZoom,
        maxZoom: node.maxZoom
      };
    }
  }

  serialize() {
    return Array.from(this.streamNodes());
  }

  serializeToNdjson() {
    return this.serialize().map(record => JSON.stringify(record)).join('\n');
  }

  loadFromStream(records) {
    const iterator = records[Symbol.iterator]();
    const first = iterator.next();
    if (first.done) {
      throw new Error('Stream is empty');
    }
    const header = first.value;
    if (header.type !== 'header') {
      throw new Error('First record must be header');
    }
    this.bounds = normaliseBounds(header.bounds);
    this.rootId = header.root || 'root';
    if (Array.isArray(header.zoomThresholds) && header.zoomThresholds.length > 0) {
      this.zoomThresholds = header.zoomThresholds.map(v => Number.isFinite(v) ? v : -Infinity);
    }
    this.nodes.clear();
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      const record = step.value;
      if (record.type !== 'node') continue;
      const node = {
        id: record.id,
        parentId: record.parentId ?? null,
        lod: record.lod ?? 0,
        bounds: normaliseBounds(record.bounds),
        children: Array.isArray(record.children) ? [...record.children] : [],
        metadata: {
          levelLabel: record.metadata?.levelLabel ?? levelLabelForLod(record.lod ?? 0),
          name: record.metadata?.name ?? null,
          parentPath: Array.isArray(record.metadata?.parentPath) ? [...record.metadata.parentPath] : [],
          createdAt: record.metadata?.createdAt ?? Date.now(),
          updatedAt: record.metadata?.updatedAt ?? Date.now(),
          tags: Array.isArray(record.metadata?.tags) ? [...record.metadata.tags] : []
        },
        payloadRefs: {
          terrain: record.payloadRefs?.terrain ?? null,
          vector: Array.isArray(record.payloadRefs?.vector) ? [...record.payloadRefs.vector] : [],
          parcels: Array.isArray(record.payloadRefs?.parcels) ? [...record.payloadRefs.parcels] : [],
          buildings: Array.isArray(record.payloadRefs?.buildings) ? [...record.payloadRefs.buildings] : [],
          sprites: Array.isArray(record.payloadRefs?.sprites) ? [...record.payloadRefs.sprites] : [],
          effects: Array.isArray(record.payloadRefs?.effects) ? [...record.payloadRefs.effects] : []
        },
        minZoom: record.minZoom ?? this.zoomThresholds[Math.min(record.lod ?? 0, this.zoomThresholds.length - 1)],
        maxZoom: record.maxZoom ?? null
      };
      this.nodes.set(node.id, node);
    }
    if (!this.nodes.has(this.rootId)) {
      const node = this._createNode(this.rootId, null, 0, this.bounds, null);
      this.nodes.set(node.id, node);
    }
  }
}
