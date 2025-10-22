import { VoxelWorld } from './world/voxelWorld.js';
import { WorldEditor } from './world/editor.js';

const DEFAULT_ZOOM_MIN = Number.NEGATIVE_INFINITY;
const DEFAULT_ZOOM_MAX = null;

export const DEFAULT_WORLD_SEED = 0x3d3d3d3d;

function normaliseSeed(seed) {
  if (seed == null) {
    return DEFAULT_WORLD_SEED;
  }
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return seed >>> 0;
  }
  if (typeof seed === 'bigint') {
    const masked = seed & BigInt(0xffffffff);
    return Number(masked);
  }
  if (typeof seed === 'string') {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  return DEFAULT_WORLD_SEED;
}

function createMulberry32(seed) {
  let t = seed >>> 0;
  return function mulberry32() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clonePoint(pt) {
  return { x: pt.x, y: pt.y };
}

function resolveTile(palette, defaultTileId, tileId) {
  if (!palette) return null;
  const resolved = palette.byId?.[tileId];
  if (resolved) return resolved;
  return palette.byId?.[defaultTileId] ?? null;
}

function cloneFeature(feature) {
  if (!feature) return null;
  const cloned = { ...feature };
  if (Array.isArray(feature.line)) {
    cloned.line = feature.line.map(clonePoint);
  }
  if (Array.isArray(feature.poly)) {
    cloned.poly = feature.poly.map(clonePoint);
  }
  return cloned;
}

function clonePlacement(placement) {
  if (!placement) return null;
  const cloned = { ...placement };
  if (placement.position) {
    cloned.position = clonePoint(placement.position);
  }
  return cloned;
}

function cloneTerrainPatch(patch) {
  if (!patch) return null;
  const cloned = { ...patch };
  if (Array.isArray(patch.polygon)) {
    cloned.polygon = patch.polygon.map(clonePoint);
  }
  if (Array.isArray(patch.polygons)) {
    cloned.polygons = patch.polygons
      .map((ring) => Array.isArray(ring) ? ring.map(clonePoint) : [])
      .filter((ring) => ring.length > 0);
  }
  return cloned;
}

function cloneTerrainPatchArray(patches) {
  if (!Array.isArray(patches)) {
    return [];
  }
  return patches.map((patch) => cloneTerrainPatch(patch)).filter(Boolean);
}

function pointWithinBounds(bounds, point) {
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, point.x)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, point.y))
  };
}

export class Cart {
  constructor(id) {
    this.id = id;
    this.type = 'cart';
    this.path = [];
    this.position = { x: 0, y: 0 };
    this.speed = 0.1;
    this.progress = 0;
    this.loop = true;
    this.selected = false;
    this.segments = null;
    this.totalLength = 0;
    this.spriteKey = 'cart';
    this.spriteScale = null;
    this.spriteAnchor = null;
    this.spriteRotation = 0;
    this.zoomMin = DEFAULT_ZOOM_MIN;
    this.zoomMax = DEFAULT_ZOOM_MAX;
    this.pathZoomMin = DEFAULT_ZOOM_MIN;
    this.pathZoomMax = DEFAULT_ZOOM_MAX;
    this.pathColor = 'rgba(0,0,0,0.6)';
    this.pathWidth = null;
    this.effect = null;
    this.phase = 0;
  }

  computeSegments() {
    this.segments = [];
    let total = 0;
    for (let i = 0; i < this.path.length - 1; i++) {
      const start = this.path[i];
      const end = this.path[i + 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      this.segments.push({ start, end, length });
      total += length;
    }
    this.totalLength = total;
  }

  update(dt) {
    if (this.path.length < 2 || this.segments === null) return;
    this.progress += this.speed * dt;
    const total = this.totalLength;
    if (total <= 0) return;
    if (this.progress >= total) {
      if (this.loop) {
        this.progress = this.progress % total;
        if (Math.abs(this.progress) < 1e-9) {
          this.progress = 0;
        }
      } else {
        this.progress = total - 0.0001;
      }
    }
    let dist = this.progress;
    for (const seg of this.segments) {
      if (dist <= seg.length) {
        const t = seg.length > 0 ? dist / seg.length : 0;
        this.position.x = seg.start.x + (seg.end.x - seg.start.x) * t;
        this.position.y = seg.start.y + (seg.end.y - seg.start.y) * t;
        break;
      }
      dist -= seg.length;
    }
  }
}

function normaliseBounds(bounds) {
  if (!bounds) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  const { minX, minY, maxX, maxY } = bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }
  return { minX, minY, maxX, maxY };
}

export class World {
  constructor(palette, { bounds, seed, maxLod = 5, zoomThresholds, autoSeed = true } = {}) {
    if (!palette) {
      throw new Error('Palette is required to create a World');
    }
    this.palette = palette;
    this.defaultTileId = palette.defaultTileId;
    this.bounds = normaliseBounds(bounds);
    this.seed = normaliseSeed(seed);
    this._rng = createMulberry32(this.seed);
    this.autoSeed = autoSeed !== false;

    this.terrain = new VoxelWorld({
      bounds: this.bounds,
      chunkSize: 32,
      chunkHeight: 32,
      zoomThresholds
    });
    this.editor = new WorldEditor();
    this._editedNodes = new Set();

    this.layers = {
      terrain: {
        zoomMin: DEFAULT_ZOOM_MIN,
        zoomMax: DEFAULT_ZOOM_MAX,
        voxelWorld: this.terrain
      },
      vector: {
        zoomMin: DEFAULT_ZOOM_MIN,
        zoomMax: DEFAULT_ZOOM_MAX,
        features: []
      },
      sprite: {
        zoomMin: DEFAULT_ZOOM_MIN,
        zoomMax: DEFAULT_ZOOM_MAX,
        placements: []
      },
      effect: {
        zoomMin: DEFAULT_ZOOM_MIN,
        zoomMax: DEFAULT_ZOOM_MAX,
        agents: []
      }
    };

    this.cartAgents = [];
    this.carts = this.cartAgents;
    this.nextCartId = 1;

    if (this.autoSeed) {
      this._seedTerrain();
    }
  }

  _seedTerrain() {
    const availableTiles = this.palette?.tiles?.map(tile => tile.id) || [];
    for (let cx = 0; cx < this.terrain.chunkCountX; cx++) {
      for (let cy = 0; cy < this.terrain.chunkCountY; cy++) {
        const chunk = this.terrain.getChunk(cx, cy);
        if (!chunk) continue;
        this._assignTileId(chunk.id, this._randomTileId(availableTiles));
      }
    }
  }

  _randomTileId(availableTiles) {
    if (!availableTiles.length) {
      return this.defaultTileId;
    }
    const index = Math.floor(this._rng() * availableTiles.length);
    return availableTiles[Math.max(0, Math.min(availableTiles.length - 1, index))];
  }

  _assignTileId(nodeId, tileId) {
    this.terrain.setNodePayload(nodeId, { terrain: tileId ?? this.defaultTileId });
  }

  random() {
    return this._rng();
  }

  setSeed(seed) {
    const nextSeed = normaliseSeed(seed);
    if (nextSeed === this.seed) {
      return;
    }
    this.seed = nextSeed;
    this._rng = createMulberry32(this.seed);
    const maxLod = this.terrain.maxLod;
    const zoomThresholds = this.terrain.zoomThresholds;
    this.terrain = new VoxelWorld({ bounds: this.bounds, chunkSize: 32, chunkHeight: 32, zoomThresholds });
    this.layers.terrain.voxelWorld = this.terrain;
    if (this.editor) {
      this.editor.clearAll();
    }
    this._editedNodes.clear();
    if (this.autoSeed) {
      this._seedTerrain();
    }
  }

  get width() {
    return this.bounds.maxX - this.bounds.minX;
  }

  get height() {
    return this.bounds.maxY - this.bounds.minY;
  }

  clampToBounds(x, y) {
    return pointWithinBounds(this.bounds, { x, y });
  }

  getVisibleNodes(viewBounds, zoom) {
    return this.terrain.getVisibleNodes(viewBounds, zoom);
  }

  subdivideNode(nodeId) {
    const children = this.terrain.subdivideNode(nodeId);
    if (children && children.length) {
      const tiles = this.palette?.tiles?.map(tile => tile.id) || [];
      for (const child of children) {
        this._assignTileId(child.id, this._randomTileId(tiles));
      }
    }
    return children;
  }

  sampleFeatureAt(point, zoom) {
    const node = this.terrain.sampleFeatureAt(point, zoom);
    if (!node) return null;
    return {
      node,
      tile: this.getTileDescriptor(node.payloadRefs.terrain),
      payload: node.payloadRefs
    };
  }

  assignTileAt(point, zoom, tileId) {
    if (!this.palette?.byId?.[tileId]) {
      return null;
    }
    const node = this.terrain.sampleFeatureAt(point, zoom);
    if (!node) return null;
    this._assignTileId(node.id, tileId);
    return node;
  }

  assignTileToAll(tileId) {
    if (!this.palette?.byId?.[tileId]) return;
    for (const node of this.terrain.nodes.values()) {
      if (!node || node.id === this.terrain.rootId) continue;
      this.terrain.setNodePayload(node.id, { terrain: tileId });
    }
  }

  addCart() {
    const cart = new Cart(this.nextCartId++);
    cart.position = {
      x: this.bounds.minX + this.width / 2,
      y: this.bounds.minY + this.height / 2
    };
    cart.speed = this.width / 200;
    cart.phase = cart.id * 0.37;
    this.cartAgents.push(cart);
    return cart;
  }

  selectCartAt(wx, wy) {
    let selected = null;
    const selectionRadius = Math.max(this.width, this.height) * 0.01;
    let minDistSq = selectionRadius * selectionRadius;
    for (const cart of this.cartAgents) {
      const dx = cart.position.x - wx;
      const dy = cart.position.y - wy;
      const d = dx * dx + dy * dy;
      if (d < minDistSq) {
        selected = cart;
        minDistSq = d;
      }
    }
    if (selected) {
      this.cartAgents.forEach(c => c.selected = false);
      selected.selected = true;
      return selected;
    }
    return null;
  }

  get selectedCart() {
    return this.cartAgents.find(c => c.selected) || null;
  }

  update(dt) {
    for (const cart of this.cartAgents) {
      cart.update(dt);
    }
  }

  getTileDescriptor(tileId) {
    return resolveTile(this.palette, this.defaultTileId, tileId);
  }

  getTerrainLayer() {
    return this.layers.terrain;
  }

  getVectorLayer() {
    return this.layers.vector;
  }

  getSpriteLayer() {
    return this.layers.sprite;
  }

  getEffectLayer() {
    return this.layers.effect;
  }

  addTerrainPatch(nodeId, patch = {}) {
    return this._addNodeFeature('terrain', nodeId, { ...patch });
  }

  updateTerrainPatch(nodeId, patchId, updates = {}) {
    return this._updateNodeFeature('terrain', nodeId, patchId, updates);
  }

  removeTerrainPatch(nodeId, patchId) {
    return this._removeNodeFeature('terrain', nodeId, patchId);
  }

  addVectorFeature(nodeId, geometry = {}, metadata = {}) {
    const feature = this._composeFeatureData(geometry, metadata);
    return this._addNodeFeature('vector', nodeId, feature);
  }

  updateVectorFeature(nodeId, featureId, updates = {}) {
    return this._updateNodeFeature('vector', nodeId, featureId, updates);
  }

  removeVectorFeature(nodeId, featureId) {
    return this._removeNodeFeature('vector', nodeId, featureId);
  }

  addParcelFeature(nodeId, geometry = {}, metadata = {}) {
    const feature = this._composeFeatureData(geometry, metadata);
    return this._addNodeFeature('parcels', nodeId, feature);
  }

  updateParcelFeature(nodeId, featureId, updates = {}) {
    return this._updateNodeFeature('parcels', nodeId, featureId, updates);
  }

  removeParcelFeature(nodeId, featureId) {
    return this._removeNodeFeature('parcels', nodeId, featureId);
  }

  addBuildingFeature(nodeId, geometry = {}, metadata = {}) {
    const feature = this._composeFeatureData(geometry, metadata);
    return this._addNodeFeature('buildings', nodeId, feature);
  }

  updateBuildingFeature(nodeId, featureId, updates = {}) {
    return this._updateNodeFeature('buildings', nodeId, featureId, updates);
  }

  removeBuildingFeature(nodeId, featureId) {
    return this._removeNodeFeature('buildings', nodeId, featureId);
  }

  clearNodeEdits(nodeId) {
    if (!this.editor || !nodeId) {
      return false;
    }
    const cleared = this.editor.clearEdits(nodeId);
    if (cleared) {
      this._syncEditorPayload(nodeId);
    }
    return cleared;
  }

  getEditorSummary() {
    if (!this.editor) {
      return [];
    }
    return this.editor.listEditedNodes();
  }

  hasUnsavedEdits(nodeId = null) {
    if (!this.editor) {
      return false;
    }
    if (nodeId) {
      return this.editor.hasEdits(nodeId);
    }
    const summary = this.editor.listEditedNodes();
    return summary.length > 0;
  }

  exportEditorPatch() {
    if (!this.editor) {
      return '';
    }
    return this.editor.serializePatches();
  }

  applyEditorPatch(serialized) {
    if (!this.editor) {
      return [];
    }
    const touchedNodes = this.editor.importPatches(serialized);
    for (const nodeId of touchedNodes) {
      this._syncEditorPayload(nodeId);
    }
    return touchedNodes;
  }

  updateNodeMetadata(nodeId, updates = {}) {
    if (!nodeId) {
      return null;
    }
    const node = this.terrain.getNode(nodeId);
    if (!node) {
      return null;
    }
    let metadataEdit = null;
    if (this.editor) {
      metadataEdit = this.editor.updateNodeMetadata(nodeId, updates);
    }
    const baseMetadata = this.editor?.getMetadataSource(nodeId) || node.metadata || {};
    const merged = { ...baseMetadata };
    if (metadataEdit) {
      for (const [key, value] of Object.entries(metadataEdit)) {
        if (key === 'tags') {
          merged.tags = Array.isArray(value) ? [...value] : [];
        } else if (value === null) {
          merged[key] = null;
        } else if (Array.isArray(value)) {
          merged[key] = [...value];
        } else if (value && typeof value === 'object') {
          merged[key] = { ...value };
        } else {
          merged[key] = value;
        }
      }
    }
    this.terrain.setMetadata(nodeId, merged);
    this._flagNodeEdited(nodeId);
    return merged;
  }

  consumeEditedNodes() {
    const edited = Array.from(this._editedNodes);
    this._editedNodes.clear();
    return edited;
  }

  _composeFeatureData(geometry, metadata) {
    const base = {};
    if (geometry && typeof geometry === 'object') {
      Object.assign(base, geometry);
    }
    if (metadata && typeof metadata === 'object') {
      Object.assign(base, metadata);
    }
    return base;
  }

  _addNodeFeature(type, nodeId, feature) {
    if (!this.editor || !nodeId) {
      return null;
    }
    const node = this.terrain.getNode(nodeId);
    if (!node) {
      return null;
    }
    const stored = this.editor.addFeature(nodeId, type, feature);
    this._syncEditorPayload(nodeId);
    return stored;
  }

  _updateNodeFeature(type, nodeId, featureId, updates) {
    if (!this.editor || !nodeId || !featureId) {
      return null;
    }
    const node = this.terrain.getNode(nodeId);
    if (!node) {
      return null;
    }
    const updated = this.editor.updateFeature(nodeId, type, featureId, updates);
    if (updated) {
      this._syncEditorPayload(nodeId);
    }
    return updated;
  }

  _removeNodeFeature(type, nodeId, featureId) {
    if (!this.editor || !nodeId || !featureId) {
      return false;
    }
    const node = this.terrain.getNode(nodeId);
    if (!node) {
      return false;
    }
    const removed = this.editor.removeFeature(nodeId, type, featureId);
    if (removed) {
      this._syncEditorPayload(nodeId);
    }
    return removed;
  }

  _syncEditorPayload(nodeId) {
    if (!this.editor) {
      return null;
    }
    const combined = this.editor.getCombinedPayload(nodeId);
    this.terrain.setNodePayload(nodeId, {
      terrainPatches: combined.terrainPatches,
      vector: combined.vector,
      parcels: combined.parcels,
      buildings: combined.buildings
    });
    this.terrain.updateNode(nodeId, (node) => {
      const layers = { ...(node.metadata.layers || {}) };
      const terrainLayer = { ...(layers.terrain || {}) };
      terrainLayer.patches = combined.terrainPatches.map(cloneTerrainPatch);
      layers.terrain = terrainLayer;
      node.metadata.layers = layers;
    });
    const metadataSource = this.editor.getMetadataSource(nodeId);
    const metadataEdit = this.editor.getNodeMetadataEdit(nodeId);
    if (metadataSource || metadataEdit) {
      const base = metadataSource || this.terrain.getNode(nodeId)?.metadata || {};
      const merged = { ...base };
      if (metadataEdit) {
        for (const [key, value] of Object.entries(metadataEdit)) {
          if (key === 'tags') {
            merged.tags = Array.isArray(value) ? [...value] : [];
          } else if (value === null) {
            merged[key] = null;
          } else if (Array.isArray(value)) {
            merged[key] = [...value];
          } else if (value && typeof value === 'object') {
            merged[key] = { ...value };
          } else {
            merged[key] = value;
          }
        }
      }
      this.terrain.setMetadata(nodeId, merged);
    }
    this._flagNodeEdited(nodeId);
    return combined;
  }

  _flagNodeEdited(nodeId) {
    if (!nodeId) {
      return;
    }
    this._editedNodes.add(nodeId);
  }

  serialize() {
    const records = [];
    records.push({
      type: 'world',
      version: 2,
      seed: this.seed,
      bounds: { ...this.bounds },
      paletteDefaultTileId: this.defaultTileId,
      zoomThresholds: [...this.terrain.zoomThresholds],
      carts: this.cartAgents.map((cart) => ({
        id: cart.id,
        path: cart.path.map(clonePoint),
        position: clonePoint(cart.position),
        speed: cart.speed,
        progress: cart.progress,
        loop: cart.loop
      })),
      vectorFeatures: this.layers.vector.features.map(cloneFeature).filter(Boolean),
      spritePlacements: this.layers.sprite.placements.map(clonePlacement).filter(Boolean),
      effectAgents: this.layers.effect.agents.map(agent => ({ ...agent }))
    });
    for (const record of this.terrain.streamChunks()) {
      records.push(record);
    }
    return records.map(record => JSON.stringify(record)).join('\n');
  }

  deserialize(serialized) {
    const records = typeof serialized === 'string'
      ? serialized.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line))
      : Array.isArray(serialized)
        ? serialized
        : [];
    if (!records.length) {
      return;
    }
    const [worldRecord, ...nodeRecords] = records;
    if (worldRecord.type !== 'world') {
      throw new Error('First record must contain world header');
    }
    this.bounds = normaliseBounds(worldRecord.bounds);
    this.seed = normaliseSeed(worldRecord.seed);
    this._rng = createMulberry32(this.seed);
    this.defaultTileId = worldRecord.paletteDefaultTileId ?? this.defaultTileId;
    const zoomThresholds = Array.isArray(worldRecord.zoomThresholds)
      ? worldRecord.zoomThresholds
      : this.terrain.zoomThresholds;
    const previousMaxLod = this.terrain?.maxLod ?? 5;
    this.terrain = new VoxelWorld({
      bounds: this.bounds,
      chunkSize: 32,
      chunkHeight: 32,
      zoomThresholds
    });
    this.layers.terrain.voxelWorld = this.terrain;
    this.terrain.loadFromStream(nodeRecords);
    if (this.editor) {
      this.editor.clearAll();
    }
    this._editedNodes.clear();

    if (this.editor) {
      for (const node of this.terrain.nodes.values()) {
        if (!node) continue;
        const payload = {
          terrainPatches: cloneTerrainPatchArray(node.payloadRefs?.terrainPatches),
          vector: Array.isArray(node.payloadRefs?.vector) ? node.payloadRefs.vector.map(cloneFeature) : [],
          parcels: Array.isArray(node.payloadRefs?.parcels) ? node.payloadRefs.parcels.map(cloneFeature) : [],
          buildings: Array.isArray(node.payloadRefs?.buildings) ? node.payloadRefs.buildings.map(cloneFeature) : []
        };
        this.editor.setSource(node.id, payload);
        this.editor.setMetadataSource(node.id, node.metadata);
      }
    }

    this.layers.vector.features = Array.isArray(worldRecord.vectorFeatures)
      ? worldRecord.vectorFeatures.map(cloneFeature).filter(Boolean)
      : [];
    this.layers.sprite.placements = Array.isArray(worldRecord.spritePlacements)
      ? worldRecord.spritePlacements.map(clonePlacement).filter(Boolean)
      : [];

    this.cartAgents = [];
    this.carts = this.cartAgents;
    this.nextCartId = 1;
    if (Array.isArray(worldRecord.carts)) {
      for (const cd of worldRecord.carts) {
        const cart = new Cart(cd.id ?? this.nextCartId++);
        cart.path = Array.isArray(cd.path) ? cd.path.map(clonePoint) : [];
        cart.position = cd.position ? clonePoint(cd.position) : { x: this.bounds.minX, y: this.bounds.minY };
        cart.speed = Number.isFinite(cd.speed) ? cd.speed : this.width / 200;
        cart.progress = Number.isFinite(cd.progress) ? cd.progress : 0;
        cart.loop = cd.loop !== false;
        cart.computeSegments();
        this.cartAgents.push(cart);
        this.nextCartId = Math.max(this.nextCartId, cart.id + 1);
      }
    }

    this.layers.effect.agents = Array.isArray(worldRecord.effectAgents)
      ? worldRecord.effectAgents.map(agent => ({ ...agent }))
      : [];
  }
}
