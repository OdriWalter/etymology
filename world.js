// world.js - defines the world grid, tile descriptors from the palette and carts

const DEFAULT_ZOOM_MIN = 0;
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

function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function resolveTile(palette, defaultTileId, tileId) {
  if (!palette) return null;
  const resolved = palette.byId[tileId];
  if (resolved) return resolved;
  return palette.byId[defaultTileId];
}

function toZoomMin(value) {
  return Number.isFinite(value) ? value : DEFAULT_ZOOM_MIN;
}

function toZoomMax(value) {
  return Number.isFinite(value) ? value : DEFAULT_ZOOM_MAX;
}

function clonePoint(pt) {
  return { x: pt.x, y: pt.y };
}

function normalisePoint(point, clamp, convertLegacy) {
  if (!point) {
    return clamp(convertLegacy({ x: 0.5, y: 0.5 }));
  }
  if (Array.isArray(point) && point.length >= 2) {
    return clamp(convertLegacy({ x: Number(point[0]), y: Number(point[1]) }));
  }
  if (typeof point === 'object') {
    return clamp(convertLegacy({ x: Number(point.x), y: Number(point.y) }));
  }
  return clamp(convertLegacy({ x: 0.5, y: 0.5 }));
}

function mapPolyline(points, clamp, convertLegacy, minPoints = 2) {
  if (!Array.isArray(points)) return null;
  const out = [];
  for (const pt of points) {
    const converted = normalisePoint(pt, clamp, convertLegacy);
    out.push(converted);
  }
  return out.length >= minPoints ? out : null;
}

function cloneGrid(grid) {
  return grid.map(row => row.slice());
}

const CARDINAL_NEIGHBOURS = [
  { direction: 'north', dr: -1, dc: 0 },
  { direction: 'south', dr: 1, dc: 0 },
  { direction: 'west', dr: 0, dc: -1 },
  { direction: 'east', dr: 0, dc: 1 }
];

// Cart class with a polyline path and simple linear motion
export class Cart {
  constructor(id) {
    this.id = id;
    this.type = 'cart';
    this.path = [];
    this.position = { x: 0, y: 0 }; // world coordinates
    this.speed = 0.1; // world units per second
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

function serialiseZoom(value) {
  return value == null || value === DEFAULT_ZOOM_MAX ? null : value;
}

function normaliseScale(scale) {
  if (scale == null) return null;
  if (typeof scale === 'number' && Number.isFinite(scale)) {
    return scale;
  }
  if (typeof scale === 'object') {
    const sx = Number(scale.x);
    const sy = Number(scale.y);
    return {
      x: Number.isFinite(sx) ? sx : undefined,
      y: Number.isFinite(sy) ? sy : undefined
    };
  }
  return null;
}

function normaliseAnchor(anchor) {
  if (!anchor) return null;
  const ax = Number(anchor.x);
  const ay = Number(anchor.y);
  return {
    x: Number.isFinite(ax) ? ax : 0.5,
    y: Number.isFinite(ay) ? ay : 0.5
  };
}

function pointWithinBounds(bounds, point) {
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, point.x)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, point.y))
  };
}

// World class to hold tiles and carts
export class World {
  constructor(cols, rows, palette, bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }, seed = DEFAULT_WORLD_SEED) {
    this.gridCols = cols;
    this.gridRows = rows;
    this.bounds = { ...bounds };
    this.grid = [];
    this.terrainAdjacency = [];
    this._agents = [];
    this.cartAgents = [];
    this.carts = this.cartAgents;
    this.nextCartId = 1;
    this.seed = normaliseSeed(seed);
    this._rng = createMulberry32(this.seed);
    this.setPalette(palette);
    this.layers = {
      terrain: {
        zoomMin: DEFAULT_ZOOM_MIN,
        zoomMax: DEFAULT_ZOOM_MAX,
        params: {
          gridCols: cols,
          gridRows: rows,
          defaultTileId: this.defaultTileId,
          seed: this.seed
        },
        grid: [],
        adjacency: []
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
        agents: this._agents
      }
    };
    this.layers.terrain.grid = this.grid;
    this.layers.terrain.adjacency = this.terrainAdjacency;
    this.regenerateTerrain();
  }

  _setSeedInternal(seed) {
    this.seed = normaliseSeed(seed);
    this._rng = createMulberry32(this.seed);
    this._syncTerrainParams();
  }

  random() {
    return this._rng();
  }

  setSeed(seed) {
    const nextSeed = normaliseSeed(seed);
    if (nextSeed === this.seed) {
      return;
    }
    this._setSeedInternal(nextSeed);
    this.regenerateTerrain();
  }

  regenerateTerrain() {
    this._rng = createMulberry32(this.seed);
    const paletteIds = this.palette?.tiles?.map(tile => tile.id) || [];
    if (!paletteIds.includes(this.defaultTileId)) {
      paletteIds.unshift(this.defaultTileId);
    }
    if (paletteIds.length === 0) {
      this.grid = [];
      this.layers.terrain.grid = this.grid;
      this.terrainAdjacency = [];
      this.layers.terrain.adjacency = this.terrainAdjacency;
      this._syncTerrainParams();
      return;
    }

    const rng = createMulberry32(this.seed ^ 0x9E3779B9);
    const changeChanceBase = 0.05 + rng() * 0.15;
    const jitterChance = 0.15 + rng() * 0.2;
    const largeShiftChance = 0.02 + rng() * 0.05;
    const gradientInfluence = 0.35 + rng() * 0.25;
    const colInfluence = 0.2 + rng() * 0.3;

    const rows = [];
    const rowDenom = Math.max(1, this.gridRows - 1);
    const colDenom = Math.max(1, this.gridCols - 1);

    for (let r = 0; r < this.gridRows; r++) {
      const rowGradient = r / rowDenom;
      const rowBias = rng() * 0.5;
      let currentIndex = Math.min(paletteIds.length - 1, Math.floor(clamp01(rowGradient * gradientInfluence + rowBias * (1 - gradientInfluence)) * paletteIds.length));
      const row = [];
      for (let c = 0; c < this.gridCols; c++) {
        const columnGradient = c / colDenom;
        if (rng() < changeChanceBase) {
          const direction = rng() < 0.5 ? -1 : 1;
          currentIndex = Math.min(paletteIds.length - 1, Math.max(0, currentIndex + direction));
        } else if (rng() < largeShiftChance) {
          currentIndex = Math.floor(rng() * paletteIds.length);
        }

        if (rng() < jitterChance) {
          const targetIndex = Math.floor(clamp01(rowGradient * gradientInfluence + columnGradient * colInfluence) * paletteIds.length);
          const blended = (currentIndex + targetIndex) / 2;
          currentIndex = Math.min(paletteIds.length - 1, Math.max(0, Math.round(blended)));
        }

        row.push(paletteIds[currentIndex]);
      }
      rows.push(row);
    }

    this.grid = rows;
    this.layers.terrain.grid = this.grid;
    this._recalculateAllAdjacency();
    this._syncTerrainParams();
  }

  setPalette(palette) {
    if (!palette) {
      throw new Error('Palette is required to create a World');
    }
    this.palette = palette;
    this.defaultTileId = palette.defaultTileId;
    this._syncTerrainParams();
    this._recalculateAllAdjacency();
  }

  get width() {
    return this.bounds.maxX - this.bounds.minX;
  }

  get height() {
    return this.bounds.maxY - this.bounds.minY;
  }

  get cellWidth() {
    return this.width / this.gridCols;
  }

  get cellHeight() {
    return this.height / this.gridRows;
  }

  clampToBounds(x, y) {
    return pointWithinBounds(this.bounds, { x, y });
  }

  paintTile(nx, ny, tileId) {
    if (nx < this.bounds.minX || nx > this.bounds.maxX || ny < this.bounds.minY || ny > this.bounds.maxY) return;
    if (!this.palette.byId[tileId]) return;
    const col = Math.floor((nx - this.bounds.minX) / this.cellWidth);
    const row = Math.floor((ny - this.bounds.minY) / this.cellHeight);
    if (col < 0 || col >= this.gridCols || row < 0 || row >= this.gridRows) return;
    this.grid[row][col] = tileId;
    this._recalculateAdjacencyAround(row, col);
  }

  addCart() {
    const cart = new Cart(this.nextCartId++);
    cart.position = {
      x: this.bounds.minX + this.width / 2,
      y: this.bounds.minY + this.height / 2
    };
    cart.speed = 5 / this.gridCols;
    cart.phase = cart.id * 0.37;
    this.cartAgents.push(cart);
    this._agents.push(cart);
    return cart;
  }

  selectCartAt(wx, wy) {
    let selected = null;
    const selectionRadius = Math.min(this.cellWidth, this.cellHeight) * 0.75;
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
    return this.cartAgents.find(c => c.selected);
  }

  update(dt) {
    for (const cart of this.cartAgents) {
      cart.update(dt);
    }
  }

  getTileDescriptor(tileId) {
    return resolveTile(this.palette, this.defaultTileId, tileId);
  }

  _normaliseZoomMin(value) {
    return toZoomMin(value);
  }

  _normaliseZoomMax(value) {
    return toZoomMax(value);
  }

  _syncTerrainParams() {
    if (!this.layers || !this.layers.terrain) {
      return;
    }
    this.layers.terrain.params = {
      gridCols: this.gridCols,
      gridRows: this.gridRows,
      defaultTileId: this.defaultTileId,
      seed: this.seed
    };
  }

  _ensureAdjacencyGrid() {
    const needsRebuild = !Array.isArray(this.terrainAdjacency)
      || this.terrainAdjacency.length !== this.gridRows
      || this.terrainAdjacency.some(row => !Array.isArray(row) || row.length !== this.gridCols);
    if (needsRebuild) {
      this.terrainAdjacency = Array.from({ length: this.gridRows }, () => new Array(this.gridCols).fill(null));
      if (this.layers?.terrain) {
        this.layers.terrain.adjacency = this.terrainAdjacency;
      }
    }
  }

  _recalculateAdjacencyAt(row, col) {
    if (row < 0 || row >= this.gridRows || col < 0 || col >= this.gridCols) {
      return;
    }
    this._ensureAdjacencyGrid();
    const tileId = this.grid[row]?.[col];
    if (tileId == null) {
      this.terrainAdjacency[row][col] = null;
      return;
    }
    const tile = this.getTileDescriptor(tileId);
    const transitions = tile?.edgeTransitions;
    if (!transitions) {
      this.terrainAdjacency[row][col] = null;
      return;
    }
    const overlays = [];
    for (const neighbour of CARDINAL_NEIGHBOURS) {
      const nRow = row + neighbour.dr;
      const nCol = col + neighbour.dc;
      if (nRow < 0 || nRow >= this.gridRows || nCol < 0 || nCol >= this.gridCols) {
        continue;
      }
      const neighbourId = this.grid[nRow]?.[nCol];
      if (neighbourId == null) {
        continue;
      }
      const mapping = transitions[neighbourId];
      if (!mapping) {
        continue;
      }
      const glyphKey = mapping[neighbour.direction];
      if (typeof glyphKey === 'string' && glyphKey.length > 0) {
        overlays.push({ direction: neighbour.direction, glyph: glyphKey });
      }
    }
    this.terrainAdjacency[row][col] = overlays.length > 0 ? overlays : null;
  }

  _recalculateAdjacencyAround(row, col) {
    this._recalculateAdjacencyAt(row, col);
    for (const neighbour of CARDINAL_NEIGHBOURS) {
      this._recalculateAdjacencyAt(row + neighbour.dr, col + neighbour.dc);
    }
  }

  _recalculateAllAdjacency() {
    this._ensureAdjacencyGrid();
    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        this._recalculateAdjacencyAt(r, c);
      }
    }
  }

  _resetAgents() {
    this._agents = [];
    this.layers.effect.agents = this._agents;
    this.cartAgents = [];
    this.carts = this.cartAgents;
    this.nextCartId = 1;
  }

  _applyCartData(cart, data, convertPoint, isLegacy) {
    const path = Array.isArray(data.path) ? mapPolyline(data.path, p => this.clampToBounds(p.x, p.y), convertPoint) : null;
    cart.path = path ? path : [];
    cart.position = normalisePoint(data.position, (p) => this.clampToBounds(p.x, p.y), convertPoint);
    cart.speed = isLegacy && typeof data.speed === 'number'
      ? data.speed / this.gridCols
      : (typeof data.speed === 'number' ? data.speed : cart.speed);
    cart.progress = isLegacy ? 0 : (typeof data.progress === 'number' ? data.progress : 0);
    cart.loop = data.loop !== undefined ? data.loop : cart.loop;
    cart.spriteKey = data.spriteKey || data.glyph || cart.spriteKey;
    cart.spriteScale = normaliseScale(data.spriteScale ?? data.spriteSize ?? data.scale);
    cart.spriteAnchor = normaliseAnchor(data.spriteAnchor);
    cart.spriteRotation = Number.isFinite(data.spriteRotation) ? data.spriteRotation : cart.spriteRotation;
    cart.zoomMin = this._normaliseZoomMin(data.zoomMin);
    cart.zoomMax = this._normaliseZoomMax(data.zoomMax);
    cart.pathZoomMin = this._normaliseZoomMin(data.pathZoomMin ?? data.zoomMin);
    cart.pathZoomMax = this._normaliseZoomMax(data.pathZoomMax ?? data.zoomMax);
    cart.pathColor = typeof data.pathColor === 'string' ? data.pathColor : cart.pathColor;
    cart.pathWidth = Number.isFinite(data.pathWidth) ? data.pathWidth : cart.pathWidth;
    cart.effect = data.effect || cart.effect;
    cart.phase = Number.isFinite(data.phase) ? data.phase : cart.phase;
    if (cart.path.length >= 2) {
      cart.computeSegments();
      if (!isLegacy && cart.progress > 0) {
        cart.progress = Math.min(cart.totalLength, cart.progress);
        cart.update(0);
      } else {
        cart.progress = 0;
        cart.update(0);
      }
    }
  }

  _createEffectAgent(def, convertPoint) {
    const agent = {
      id: def.id,
      type: def.type || 'effect',
      effect: def.effect || def.type || 'cloudNoise',
      position: normalisePoint(def.position, (p) => this.clampToBounds(p.x, p.y), convertPoint),
      zoomMin: this._normaliseZoomMin(def.zoomMin),
      zoomMax: this._normaliseZoomMax(def.zoomMax),
      radius: Number.isFinite(def.radius) ? def.radius : Math.min(this.width, this.height) * 0.1,
      amplitude: Number.isFinite(def.amplitude) ? def.amplitude : Math.min(this.cellWidth, this.cellHeight),
      spriteKey: def.spriteKey || null,
      spriteScale: normaliseScale(def.spriteScale),
      spriteAnchor: normaliseAnchor(def.spriteAnchor),
      spriteRotation: Number.isFinite(def.spriteRotation) ? def.spriteRotation : 0,
      phase: Number.isFinite(def.phase) ? def.phase : 0,
      speed: Number.isFinite(def.speed) ? def.speed : 1,
      seed: Number.isFinite(def.seed) ? def.seed : undefined,
      opacity: Number.isFinite(def.opacity) ? def.opacity : undefined
    };
    this._agents.push(agent);
    return agent;
  }

  serialize() {
    const terrainGrid = cloneGrid(this.grid);
    const serializeFeatures = (features) => features.map((feature) => {
      const payload = { ...feature };
      if (feature.line) {
        payload.line = feature.line.map(clonePoint);
      }
      if (feature.poly) {
        payload.poly = feature.poly.map(clonePoint);
      }
      payload.zoomMin = feature.zoomMin ?? DEFAULT_ZOOM_MIN;
      payload.zoomMax = serialiseZoom(feature.zoomMax);
      if (feature.style) {
        payload.style = { ...feature.style };
      }
      return payload;
    });
    const serializePlacements = (placements) => placements.map((placement) => {
      const payload = { ...placement };
      payload.position = clonePoint(placement.position);
      payload.zoomMin = placement.zoomMin ?? DEFAULT_ZOOM_MIN;
      payload.zoomMax = serialiseZoom(placement.zoomMax);
      if (placement.scale && typeof placement.scale === 'object') {
        payload.scale = { ...placement.scale };
      }
      if (placement.anchor) {
        payload.anchor = { ...placement.anchor };
      }
      return payload;
    });
    const serializeAgents = () => this._agents.map((agent) => {
      if (agent.type === 'cart' || agent instanceof Cart) {
        return {
          type: 'cart',
          id: agent.id,
          path: agent.path.map(clonePoint),
          position: clonePoint(agent.position),
          speed: agent.speed,
          progress: agent.progress,
          loop: agent.loop,
          spriteKey: agent.spriteKey,
          spriteScale: agent.spriteScale,
          spriteAnchor: agent.spriteAnchor,
          spriteRotation: agent.spriteRotation,
          zoomMin: agent.zoomMin ?? DEFAULT_ZOOM_MIN,
          zoomMax: serialiseZoom(agent.zoomMax),
          pathZoomMin: agent.pathZoomMin ?? DEFAULT_ZOOM_MIN,
          pathZoomMax: serialiseZoom(agent.pathZoomMax),
          pathColor: agent.pathColor,
          pathWidth: agent.pathWidth,
          effect: agent.effect,
          phase: agent.phase
        };
      }
      const payload = { ...agent };
      payload.position = clonePoint(agent.position);
      payload.zoomMin = agent.zoomMin ?? DEFAULT_ZOOM_MIN;
      payload.zoomMax = serialiseZoom(agent.zoomMax);
      payload.radius = Number.isFinite(agent.radius) ? agent.radius : undefined;
      payload.amplitude = Number.isFinite(agent.amplitude) ? agent.amplitude : undefined;
      if (payload.spriteScale && typeof payload.spriteScale === 'object') {
        payload.spriteScale = { ...payload.spriteScale };
      }
      if (payload.spriteAnchor) {
        payload.spriteAnchor = { ...payload.spriteAnchor };
      }
      return payload;
    });

    return {
      seed: this.seed,
      bounds: { ...this.bounds },
      gridCols: this.gridCols,
      gridRows: this.gridRows,
      cols: this.gridCols,
      rows: this.gridRows,
      grid: terrainGrid,
      carts: this.cartAgents.map((cart) => ({
        id: cart.id,
        path: cart.path.map(clonePoint),
        position: clonePoint(cart.position),
        speed: cart.speed,
        progress: cart.progress,
        loop: cart.loop
      })),
      layers: {
        terrain: {
          zoomMin: this.layers.terrain.zoomMin ?? DEFAULT_ZOOM_MIN,
          zoomMax: serialiseZoom(this.layers.terrain.zoomMax),
          params: {
            gridCols: this.gridCols,
            gridRows: this.gridRows,
            defaultTileId: this.defaultTileId,
            seed: this.seed
          },
          grid: terrainGrid
        },
        vector: {
          zoomMin: this.layers.vector.zoomMin ?? DEFAULT_ZOOM_MIN,
          zoomMax: serialiseZoom(this.layers.vector.zoomMax),
          features: serializeFeatures(this.layers.vector.features)
        },
        sprite: {
          zoomMin: this.layers.sprite.zoomMin ?? DEFAULT_ZOOM_MIN,
          zoomMax: serialiseZoom(this.layers.sprite.zoomMax),
          placements: serializePlacements(this.layers.sprite.placements)
        },
        effect: {
          zoomMin: this.layers.effect.zoomMin ?? DEFAULT_ZOOM_MIN,
          zoomMax: serialiseZoom(this.layers.effect.zoomMax),
          agents: serializeAgents()
        }
      }
    };
  }

  deserialize(data) {
    const cols = data.layers?.terrain?.params?.gridCols ?? data.gridCols ?? data.cols ?? this.gridCols;
    const rows = data.layers?.terrain?.params?.gridRows ?? data.gridRows ?? data.rows ?? this.gridRows;
    this.gridCols = cols;
    this.gridRows = rows;
    this.bounds = data.bounds ? { ...data.bounds } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };

    const legacyTileSize = data.tileSize;
    const isLegacy = legacyTileSize !== undefined && !data.bounds;

    const terrainLayer = data.layers?.terrain ?? {};
    this.layers.terrain.zoomMin = this._normaliseZoomMin(terrainLayer.zoomMin);
    this.layers.terrain.zoomMax = this._normaliseZoomMax(terrainLayer.zoomMax);

    const incomingGrid = Array.isArray(terrainLayer.grid) ? terrainLayer.grid : (Array.isArray(data.grid) ? data.grid : []);
    const hasIncomingGrid = Array.isArray(incomingGrid) && incomingGrid.length > 0;
    const incomingSeed = data.seed ?? terrainLayer.params?.seed;
    if (incomingSeed != null) {
      this._setSeedInternal(incomingSeed);
    }
    if (!hasIncomingGrid) {
      this.regenerateTerrain();
    } else {
      this.grid = [];
      for (let r = 0; r < this.gridRows; r++) {
        const sourceRow = incomingGrid[r] || [];
        const row = [];
        for (let c = 0; c < this.gridCols; c++) {
          const tileId = sourceRow[c];
          row.push(this.palette.byId[tileId] ? tileId : this.defaultTileId);
        }
        this.grid.push(row);
      }
      this.layers.terrain.grid = this.grid;
      this._syncTerrainParams();
      this._recalculateAllAdjacency();
    }

    const convertPoint = (pt) => {
      if (!pt) {
        return {
          x: this.bounds.minX + this.width / 2,
          y: this.bounds.minY + this.height / 2
        };
      }
      let point;
      if (Array.isArray(pt) && pt.length >= 2) {
        point = { x: Number(pt[0]), y: Number(pt[1]) };
      } else if (typeof pt === 'object') {
        point = { x: Number(pt.x), y: Number(pt.y) };
      } else {
        point = { x: 0.5, y: 0.5 };
      }
      if (isLegacy) {
        return {
          x: this.bounds.minX + (point.x / this.gridCols) * this.width,
          y: this.bounds.minY + (point.y / this.gridRows) * this.height
        };
      }
      return point;
    };

    const vectorLayer = data.layers?.vector ?? {};
    this.layers.vector.zoomMin = this._normaliseZoomMin(vectorLayer.zoomMin);
    this.layers.vector.zoomMax = this._normaliseZoomMax(vectorLayer.zoomMax);
    const parsedFeatures = [];
    if (Array.isArray(vectorLayer.features)) {
      for (const feature of vectorLayer.features) {
        const type = feature?.type || (feature?.poly ? 'polygon' : 'polyline');
        const rawPoints = feature?.line || feature?.poly || feature?.points || feature?.path;
        const requiredPoints = type === 'polygon' ? 3 : 2;
        const mapped = mapPolyline(rawPoints, (p) => this.clampToBounds(p.x, p.y), convertPoint, requiredPoints);
        if (!mapped) continue;
        const stored = { ...feature };
        if (type === 'polygon') {
          stored.poly = mapped;
          delete stored.line;
        } else {
          stored.line = mapped;
          delete stored.poly;
        }
        stored.zoomMin = this._normaliseZoomMin(feature.zoomMin);
        stored.zoomMax = this._normaliseZoomMax(feature.zoomMax);
        if (feature.style) {
          stored.style = { ...feature.style };
        }
        parsedFeatures.push(stored);
      }
    }
    this.layers.vector.features = parsedFeatures;

    const spriteLayer = data.layers?.sprite ?? {};
    this.layers.sprite.zoomMin = this._normaliseZoomMin(spriteLayer.zoomMin);
    this.layers.sprite.zoomMax = this._normaliseZoomMax(spriteLayer.zoomMax);
    const parsedPlacements = [];
    if (Array.isArray(spriteLayer.placements)) {
      for (const placement of spriteLayer.placements) {
        if (!placement || !placement.glyph) continue;
        const position = normalisePoint(placement.position, (p) => this.clampToBounds(p.x, p.y), convertPoint);
        parsedPlacements.push({
          ...placement,
          position,
          scale: normaliseScale(placement.scale ?? placement.spriteScale ?? placement.size),
          anchor: normaliseAnchor(placement.anchor ?? placement.spriteAnchor),
          zoomMin: this._normaliseZoomMin(placement.zoomMin),
          zoomMax: this._normaliseZoomMax(placement.zoomMax)
        });
      }
    }
    this.layers.sprite.placements = parsedPlacements;

    const effectLayer = data.layers?.effect ?? {};
    this.layers.effect.zoomMin = this._normaliseZoomMin(effectLayer.zoomMin);
    this.layers.effect.zoomMax = this._normaliseZoomMax(effectLayer.zoomMax);
    this._resetAgents();
    const agentDefs = Array.isArray(effectLayer.agents) ? effectLayer.agents : null;
    if (agentDefs) {
      for (const def of agentDefs) {
        if (def?.type === 'cart') {
          const id = def.id ?? this.nextCartId++;
          const cart = new Cart(id);
          this._applyCartData(cart, def, convertPoint, isLegacy);
          this.cartAgents.push(cart);
          this._agents.push(cart);
          this.nextCartId = Math.max(this.nextCartId, cart.id + 1);
        } else {
          this._createEffectAgent(def || {}, convertPoint);
        }
      }
    }

    if (!agentDefs) {
      const carts = Array.isArray(data.carts) ? data.carts : [];
      for (const cd of carts) {
        const id = cd.id ?? this.nextCartId++;
        const cart = new Cart(id);
        cart.speed = 5 / this.gridCols;
        this._applyCartData(cart, cd, convertPoint, isLegacy);
        this.cartAgents.push(cart);
        this._agents.push(cart);
        this.nextCartId = Math.max(this.nextCartId, cart.id + 1);
      }
    }
  }

  getTerrainLayer() {
    return this.layers.terrain;
  }

  getVectorLayer() {
    const base = this.layers.vector;
    const features = base.features.map(feature => feature);
    for (const cart of this.cartAgents) {
      if (cart.path.length < 2) continue;
      features.push({
        id: `cart-path-${cart.id}`,
        type: 'polyline',
        line: cart.path.map(clonePoint),
        zoomMin: cart.pathZoomMin ?? base.zoomMin,
        zoomMax: cart.pathZoomMax ?? base.zoomMax,
        style: {
          strokeStyle: cart.pathColor,
          lineWidth: cart.pathWidth ?? Math.max(this.cellWidth, this.cellHeight) * 0.1
        }
      });
    }
    return {
      zoomMin: base.zoomMin,
      zoomMax: base.zoomMax,
      features
    };
  }

  getSpriteLayer() {
    const base = this.layers.sprite;
    const placements = base.placements.map(placement => placement);
    for (const agent of this._agents) {
      if (!agent || !agent.spriteKey) continue;
      placements.push({
        id: agent.id != null ? `agent-${agent.id}` : undefined,
        glyph: agent.spriteKey,
        position: clonePoint(agent.position),
        scale: agent.spriteScale,
        anchor: agent.spriteAnchor,
        rotation: agent.spriteRotation,
        zoomMin: agent.zoomMin ?? base.zoomMin,
        zoomMax: agent.zoomMax ?? base.zoomMax,
        priority: agent.priority,
        agentRef: agent
      });
    }
    return {
      zoomMin: base.zoomMin,
      zoomMax: base.zoomMax,
      placements
    };
  }

  getEffectLayer() {
    return this.layers.effect;
  }
}
