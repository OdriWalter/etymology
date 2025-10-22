const DEFAULT_BASE_URL = './data/voxel/';
const INDEX_PATH = 'index.json';

function normalizeBaseUrl(url) {
  if (!url) return DEFAULT_BASE_URL;
  return url.endsWith('/') ? url : `${url}/`;
}

function decodeBase64(base64) {
  if (typeof base64 !== 'string') {
    throw new Error('Chunk payload must be a base64 string');
  }
  const normalized = base64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const decoded = atob(normalized);
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      out[i] = decoded.charCodeAt(i);
    }
    return out;
  }
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(normalized, 'base64'));
  }
  throw new Error('No base64 decoder available in this environment');
}

export class VoxelLoader {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    palette,
    glyphs,
    worldSeed = 0,
    VoxelWorldImpl
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.palette = palette || null;
    this.glyphs = glyphs || null;
    this.worldSeed = worldSeed >>> 0;
    this.index = null;
    this.world = null;
    this.inFlight = new Map();
    this.VoxelWorldImpl = VoxelWorldImpl;
  }

  async bootstrap() {
    if (this.index) {
      return this.index;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${INDEX_PATH}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch voxel index: ${response.status} ${response.statusText}`);
    }
    this.index = await response.json();
    if (!this.VoxelWorldImpl) {
      const module = await import('../world/voxelWorld.js');
      this.VoxelWorldImpl = module.VoxelWorld;
    }
    this.world = new this.VoxelWorldImpl({
      index: this.index,
      palette: this.palette,
      glyphs: this.glyphs,
      seed: this.worldSeed
    });
    return this.index;
  }

  getWorld() {
    return this.world;
  }

  hasWorld() {
    return this.world != null;
  }

  async loadChunk(x, y) {
    await this.bootstrap();
    const key = this._chunkKey(x, y);
    if (this.world && this.world.hasChunk(key)) {
      return this.world.getChunk(key);
    }
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }
    const promise = this._fetchChunk(x, y)
      .then(({ payload, metadata }) => {
        const binary = decodeBase64(payload);
        this.world.ingestChunk({ x, y }, binary, metadata);
        return this.world.getChunk(key);
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  async loadAllChunks() {
    const index = await this.bootstrap();
    const grid = index?.chunkGrid || { width: 0, height: 0 };
    const tasks = [];
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        tasks.push(this.loadChunk(x, y));
      }
    }
    await Promise.all(tasks);
    return this.world;
  }

  _chunkKey(x, y) {
    return `${x}_${y}`;
  }

  async _fetchChunk(x, y) {
    const template = this.index?.chunkTemplate || 'chunks/{x}_{y}';
    const relative = template.replace('{x}', x).replace('{y}', y);
    const [binRes, metaRes] = await Promise.all([
      this.fetchImpl(`${this.baseUrl}${relative}.bin`),
      this.fetchImpl(`${this.baseUrl}${relative}.json`)
    ]);
    if (!binRes.ok) {
      throw new Error(`Failed to fetch voxel chunk ${x}_${y}: ${binRes.status}`);
    }
    const payload = (await binRes.text()).trim();
    let metadata = { version: 1, chunk: { x, y }, sprites: [] };
    if (metaRes.ok) {
      try {
        metadata = await metaRes.json();
      } catch (err) {
        console.warn(`[voxel] Failed to parse metadata for chunk ${x}_${y}`, err);
      }
    }
    return { payload, metadata };
  }
}

export function createVoxelLoader(options) {
  return new VoxelLoader(options);
}
