const DEFAULT_BASE_URL = './data';
const INDEX_PATH = 'quadtree/index.json';

function hashString(seed, value) {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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

function cloneFeature(feature) {
  if (!feature) return null;
  const cloned = { ...feature };
  if (feature.properties && typeof feature.properties === 'object') {
    cloned.properties = cloneProperties(feature.properties);
  }
  if (Array.isArray(feature.line)) {
    cloned.line = feature.line.map(point => ({ x: point.x, y: point.y }));
  }
  if (Array.isArray(feature.poly)) {
    cloned.poly = feature.poly.map(point => ({ x: point.x, y: point.y }));
  }
  if (Array.isArray(feature.polygon)) {
    cloned.polygon = feature.polygon.map(point => ({ x: point.x, y: point.y }));
  }
  return cloned;
}

function cloneProperties(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneProperties(item));
  }
  const result = {};
  for (const key of Object.keys(value)) {
    result[key] = cloneProperties(value[key]);
  }
  return result;
}

function cloneTerrainLayer(layer) {
  if (!layer) return null;
  const cloned = { ...layer };
  if (Array.isArray(layer.patches)) {
    cloned.patches = layer.patches.map(patch => ({
      ...patch,
      polygon: Array.isArray(patch.polygon)
        ? patch.polygon.map(point => ({ x: point.x, y: point.y }))
        : null
    }));
  }
  return cloned;
}

export class TilesetLoader {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    palette,
    voxelWorld,
    worldSeed = 0,
    onTileHydrated = null,
    editor = null
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/?$/, '/');
    this.fetchImpl = fetchImpl;
    this.palette = palette || null;
    this.voxelWorld = voxelWorld || null;
    this.worldSeed = worldSeed >>> 0;
    this.onTileHydrated = typeof onTileHydrated === 'function' ? onTileHydrated : null;
    this.editor = editor || null;

    this.index = null;
    this.cache = new Map();
    this.inFlight = new Map();
    this.defaultTerrainKey = null;
  }

  async bootstrap() {
    if (this.index) {
      return this.index;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${INDEX_PATH}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch tileset index: ${response.status} ${response.statusText}`);
    }
    this.index = await response.json();
    this.defaultTerrainKey = this.index?.layers?.terrain?.default || this.palette?.defaultTileKey || null;
    if (this.voxelWorld && this.index?.root) {
      await this.ensureTile(this.index.root.lod, this.index.root.x, this.index.root.y);
    }
    return this.index;
  }

  setWorldSeed(seed) {
    this.worldSeed = (seed ?? 0) >>> 0;
  }

  attachVoxelWorld(voxelWorld, { rehydrate = true } = {}) {
    this.voxelWorld = voxelWorld || null;
    if (!this.voxelWorld || !rehydrate) {
      return;
    }
    for (const tile of this.cache.values()) {
      this._hydrateVoxelChunk(tile);
    }
  }

  attachQuadtree(quadtree, options = {}) {
    console.warn('[tilesetLoader] attachQuadtree is deprecated; use attachVoxelWorld instead.');
    this.attachVoxelWorld(quadtree, options);
  }

  async ensureTile(lod, x, y, { hydrate = true } = {}) {
    const tile = await this.loadTile(lod, x, y, { hydrate });
    return tile;
  }

  async loadTile(lod, x, y, { hydrate = true } = {}) {
    const key = this._tileKey(lod, x, y);
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      if (hydrate) {
        await this._hydrateTile(cached);
      }
      return cached;
    }
    if (this.inFlight.has(key)) {
      const pending = await this.inFlight.get(key);
      if (hydrate) {
        await this._hydrateTile(pending);
      }
      return pending;
    }
    const promise = this._fetchTile(lod, x, y)
      .catch(() => this._generateProceduralTile(lod, x, y))
      .then(async (tile) => {
        this.cache.set(key, tile);
        if (hydrate) {
          await this._hydrateTile(tile);
        }
        return tile;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  async _fetchTile(lod, x, y) {
    const template = this.index?.tileTemplate || 'tiles/{lod}/{x}_{y}.json';
    const relativePath = template
      .replace('{lod}', lod)
      .replace('{x}', x)
      .replace('{y}', y);
    const url = `${this.baseUrl}${relativePath}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch tile ${lod}/${x}/${y}: ${response.status}`);
    }
    const tile = await response.json();
    if (typeof tile.lod !== 'number') tile.lod = lod;
    if (typeof tile.x !== 'number') tile.x = x;
    if (typeof tile.y !== 'number') tile.y = y;
    return tile;
  }

  async _hydrateTile(tile) {
    if (!tile) return;
    if (this.voxelWorld) {
      this._hydrateVoxelChunk(tile);
    }
    if (this.onTileHydrated) {
      await this.onTileHydrated(tile);
    }
  }

  _hydrateVoxelChunk(tile) {
    const node = this.voxelWorld.ensureNodeForTile(tile.lod ?? 0, tile.x ?? 0, tile.y ?? 0);
    const terrainLayer = cloneTerrainLayer(tile.layers?.terrain);
    const terrainKey = terrainLayer?.tileKey || this._randomTerrainKey(tile);
    const terrainId = this._resolveTerrainId(terrainKey);
    const vectorFeatures = (tile.layers?.vectors?.features || []).map(cloneFeature).filter(Boolean);
    const parcelFeatures = (tile.layers?.parcels?.features || []).map(cloneFeature).filter(Boolean);
    const buildingFeatures = (tile.layers?.buildings?.features || []).map(cloneFeature).filter(Boolean);
    const terrainPatches = cloneTerrainLayer({ patches: terrainLayer?.patches || [] })?.patches || [];
    const sourcePayload = {
      terrainPatches,
      vector: vectorFeatures,
      parcels: parcelFeatures,
      buildings: buildingFeatures
    };
    const combined = this.editor
      ? this.editor.setSource(node.id, sourcePayload)
      : sourcePayload;

    this.voxelWorld.setNodePayload(node.id, {
      terrain: terrainId,
      terrainPatches: combined.terrainPatches,
      vector: combined.vector,
      parcels: combined.parcels,
      buildings: combined.buildings
    });

    const terrainMetadataSource = terrainLayer
      ? { ...terrainLayer, patches: combined.terrainPatches }
      : { tileKey: terrainKey, patches: combined.terrainPatches };
    const metadata = {
      ...tile.metadata,
      tileId: tile.id ?? null,
      lod: tile.lod,
      position: { lod: tile.lod, x: tile.x, y: tile.y },
      layers: {
        terrain: cloneTerrainLayer(terrainMetadataSource),
        vectors: tile.layers?.vectors ? { ...tile.layers.vectors } : null,
        parcels: tile.layers?.parcels ? { ...tile.layers.parcels } : null,
        buildings: tile.layers?.buildings ? { ...tile.layers.buildings } : null
      },
      statistics: tile.statistics ? { ...tile.statistics } : null,
      proceduralSeed: tile.proceduralSeed || this._tileSeed(tile.lod, tile.x, tile.y)
    };
    this.voxelWorld.setMetadata(node.id, metadata);
    if (this.editor) {
      this.editor.setMetadataSource(node.id, metadata);
    }
  }

  _randomTerrainKey(tile) {
    const paletteKeys = Array.isArray(this.index?.layers?.terrain?.paletteKeys)
      ? this.index.layers.terrain.paletteKeys
      : Array.from(this.palette?.tiles?.map(tile => tile.key) || []);
    if (!paletteKeys.length) {
      return this.defaultTerrainKey || null;
    }
    const rng = createMulberry32(this._tileSeed(tile.lod, tile.x, tile.y));
    const index = Math.floor(rng() * paletteKeys.length);
    return paletteKeys[Math.max(0, Math.min(paletteKeys.length - 1, index))];
  }

  _resolveTerrainId(tileKey) {
    if (!tileKey) {
      const fallbackKey = this.defaultTerrainKey || this.palette?.defaultTileKey;
      return this._resolveTerrainId(fallbackKey);
    }
    if (!this.palette?.byKey) {
      return null;
    }
    const resolved = this.palette.byKey[tileKey];
    if (resolved) {
      return resolved.id;
    }
    const fallbackKey = this.defaultTerrainKey || this.palette.defaultTileKey;
    return fallbackKey && this.palette.byKey[fallbackKey]
      ? this.palette.byKey[fallbackKey].id
      : null;
  }

  _tileKey(lod, x, y) {
    return `${lod}/${x}_${y}`;
  }

  _tileSeed(lod, x, y) {
    const base = hashString(this.worldSeed, `${lod}:${x}:${y}`);
    return hashString(base, this.index?.id || 'tileset');
  }

  _generateProceduralTile(lod, x, y) {
    const bounds = this._boundsForTile(lod, x, y);
    const terrainKey = this._randomTerrainKey({ lod, x, y });
    return {
      lod,
      x,
      y,
      id: null,
      bounds,
      layers: {
        terrain: { tileKey: terrainKey },
        vectors: { features: [] },
        parcels: { features: [] },
        buildings: { features: [] }
      },
      children: [],
      proceduralSeed: this._tileSeed(lod, x, y)
    };
  }

  _boundsForTile(lod, x, y) {
    const bounds = this.index?.bounds;
    if (!bounds) {
      return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    }
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const divisions = 1 << lod;
    const tileWidth = width / divisions;
    const tileHeight = height / divisions;
    const minX = bounds.minX + tileWidth * x;
    const maxX = minX + tileWidth;
    const maxY = bounds.maxY - tileHeight * y;
    const minY = maxY - tileHeight;
    return { minX, minY, maxX, maxY };
  }
}

export function createTilesetLoader(options) {
  return new TilesetLoader(options);
}
