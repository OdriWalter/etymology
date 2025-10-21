// bundle.js - single file bundle of the engine with embedded assets
(() => {
  // world.js
  var DEFAULT_ZOOM_MIN = 0;
  var DEFAULT_ZOOM_MAX = null;
  var DEFAULT_WORLD_SEED = 1027423549;
  function normaliseSeed(seed) {
    if (seed == null) {
      return DEFAULT_WORLD_SEED;
    }
    if (typeof seed === "number" && Number.isFinite(seed)) {
      return seed >>> 0;
    }
    if (typeof seed === "bigint") {
      const masked = seed & BigInt(4294967295);
      return Number(masked);
    }
    if (typeof seed === "string") {
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
      t += 1831565813;
      let r = Math.imul(t ^ t >>> 15, 1 | t);
      r ^= r + Math.imul(r ^ r >>> 7, 61 | r);
      return ((r ^ r >>> 14) >>> 0) / 4294967296;
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
  function normalisePoint(point, clamp2, convertLegacy) {
    if (!point) {
      return clamp2(convertLegacy({ x: 0.5, y: 0.5 }));
    }
    if (Array.isArray(point) && point.length >= 2) {
      return clamp2(convertLegacy({ x: Number(point[0]), y: Number(point[1]) }));
    }
    if (typeof point === "object") {
      return clamp2(convertLegacy({ x: Number(point.x), y: Number(point.y) }));
    }
    return clamp2(convertLegacy({ x: 0.5, y: 0.5 }));
  }
  function mapPolyline(points, clamp2, convertLegacy, minPoints = 2) {
    if (!Array.isArray(points)) return null;
    const out = [];
    for (const pt of points) {
      const converted = normalisePoint(pt, clamp2, convertLegacy);
      out.push(converted);
    }
    return out.length >= minPoints ? out : null;
  }
  function cloneGrid(grid) {
    return grid.map((row) => row.slice());
  }
  var Cart = class {
    constructor(id) {
      this.id = id;
      this.type = "cart";
      this.path = [];
      this.position = { x: 0, y: 0 };
      this.speed = 0.1;
      this.progress = 0;
      this.loop = true;
      this.selected = false;
      this.segments = null;
      this.totalLength = 0;
      this.spriteKey = "cart";
      this.spriteScale = null;
      this.spriteAnchor = null;
      this.spriteRotation = 0;
      this.zoomMin = DEFAULT_ZOOM_MIN;
      this.zoomMax = DEFAULT_ZOOM_MAX;
      this.pathZoomMin = DEFAULT_ZOOM_MIN;
      this.pathZoomMax = DEFAULT_ZOOM_MAX;
      this.pathColor = "rgba(0,0,0,0.6)";
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
          this.progress = total - 1e-4;
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
  };
  function serialiseZoom(value) {
    return value == null || value === DEFAULT_ZOOM_MAX ? null : value;
  }
  function normaliseScale(scale) {
    if (scale == null) return null;
    if (typeof scale === "number" && Number.isFinite(scale)) {
      return scale;
    }
    if (typeof scale === "object") {
      const sx = Number(scale.x);
      const sy = Number(scale.y);
      return {
        x: Number.isFinite(sx) ? sx : void 0,
        y: Number.isFinite(sy) ? sy : void 0
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
  var World = class {
    constructor(cols, rows, palette, bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }, seed = DEFAULT_WORLD_SEED) {
      this.gridCols = cols;
      this.gridRows = rows;
      this.bounds = { ...bounds };
      this.grid = [];
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
          grid: []
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
      const paletteIds = this.palette?.tiles?.map((tile) => tile.id) || [];
      if (!paletteIds.includes(this.defaultTileId)) {
        paletteIds.unshift(this.defaultTileId);
      }
      if (paletteIds.length === 0) {
        this.grid = [];
        this.layers.terrain.grid = this.grid;
        this._syncTerrainParams();
        return;
      }
      const rng = createMulberry32(this.seed ^ 2654435769);
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
      this._syncTerrainParams();
    }
    setPalette(palette) {
      if (!palette) {
        throw new Error("Palette is required to create a World");
      }
      this.palette = palette;
      this.defaultTileId = palette.defaultTileId;
      this._syncTerrainParams();
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
        this.cartAgents.forEach((c) => c.selected = false);
        selected.selected = true;
        return selected;
      }
      return null;
    }
    get selectedCart() {
      return this.cartAgents.find((c) => c.selected);
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
    _resetAgents() {
      this._agents = [];
      this.layers.effect.agents = this._agents;
      this.cartAgents = [];
      this.carts = this.cartAgents;
      this.nextCartId = 1;
    }
    _applyCartData(cart, data, convertPoint, isLegacy) {
      const path = Array.isArray(data.path) ? mapPolyline(data.path, (p) => this.clampToBounds(p.x, p.y), convertPoint) : null;
      cart.path = path ? path : [];
      cart.position = normalisePoint(data.position, (p) => this.clampToBounds(p.x, p.y), convertPoint);
      cart.speed = isLegacy && typeof data.speed === "number" ? data.speed / this.gridCols : typeof data.speed === "number" ? data.speed : cart.speed;
      cart.progress = isLegacy ? 0 : typeof data.progress === "number" ? data.progress : 0;
      cart.loop = data.loop !== void 0 ? data.loop : cart.loop;
      cart.spriteKey = data.spriteKey || data.glyph || cart.spriteKey;
      cart.spriteScale = normaliseScale(data.spriteScale ?? data.spriteSize ?? data.scale);
      cart.spriteAnchor = normaliseAnchor(data.spriteAnchor);
      cart.spriteRotation = Number.isFinite(data.spriteRotation) ? data.spriteRotation : cart.spriteRotation;
      cart.zoomMin = this._normaliseZoomMin(data.zoomMin);
      cart.zoomMax = this._normaliseZoomMax(data.zoomMax);
      cart.pathZoomMin = this._normaliseZoomMin(data.pathZoomMin ?? data.zoomMin);
      cart.pathZoomMax = this._normaliseZoomMax(data.pathZoomMax ?? data.zoomMax);
      cart.pathColor = typeof data.pathColor === "string" ? data.pathColor : cart.pathColor;
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
        type: def.type || "effect",
        effect: def.effect || def.type || "cloudNoise",
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
        seed: Number.isFinite(def.seed) ? def.seed : void 0,
        opacity: Number.isFinite(def.opacity) ? def.opacity : void 0
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
        if (placement.scale && typeof placement.scale === "object") {
          payload.scale = { ...placement.scale };
        }
        if (placement.anchor) {
          payload.anchor = { ...placement.anchor };
        }
        return payload;
      });
      const serializeAgents = () => this._agents.map((agent) => {
        if (agent.type === "cart" || agent instanceof Cart) {
          return {
            type: "cart",
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
        payload.radius = Number.isFinite(agent.radius) ? agent.radius : void 0;
        payload.amplitude = Number.isFinite(agent.amplitude) ? agent.amplitude : void 0;
        if (payload.spriteScale && typeof payload.spriteScale === "object") {
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
      const isLegacy = legacyTileSize !== void 0 && !data.bounds;
      const terrainLayer = data.layers?.terrain ?? {};
      this.layers.terrain.zoomMin = this._normaliseZoomMin(terrainLayer.zoomMin);
      this.layers.terrain.zoomMax = this._normaliseZoomMax(terrainLayer.zoomMax);
      const incomingGrid = Array.isArray(terrainLayer.grid) ? terrainLayer.grid : Array.isArray(data.grid) ? data.grid : [];
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
        } else if (typeof pt === "object") {
          point = { x: Number(pt.x), y: Number(pt.y) };
        } else {
          point = { x: 0.5, y: 0.5 };
        }
        if (isLegacy) {
          return {
            x: this.bounds.minX + point.x / this.gridCols * this.width,
            y: this.bounds.minY + point.y / this.gridRows * this.height
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
          const type = feature?.type || (feature?.poly ? "polygon" : "polyline");
          const rawPoints = feature?.line || feature?.poly || feature?.points || feature?.path;
          const requiredPoints = type === "polygon" ? 3 : 2;
          const mapped = mapPolyline(rawPoints, (p) => this.clampToBounds(p.x, p.y), convertPoint, requiredPoints);
          if (!mapped) continue;
          const stored = { ...feature };
          if (type === "polygon") {
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
          if (def?.type === "cart") {
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
      const features = base.features.map((feature) => feature);
      for (const cart of this.cartAgents) {
        if (cart.path.length < 2) continue;
        features.push({
          id: `cart-path-${cart.id}`,
          type: "polyline",
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
      const placements = base.placements.map((placement) => placement);
      for (const agent of this._agents) {
        if (!agent || !agent.spriteKey) continue;
        placements.push({
          id: agent.id != null ? `agent-${agent.id}` : void 0,
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
  };

  // renderer.js
  var Camera = class {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.scale = 1;
      this.minScale = 0.01;
      this.maxScale = Infinity;
    }
    screenToWorld(px, py) {
      return {
        x: (px - this.x) / this.scale,
        y: (py - this.y) / this.scale
      };
    }
    worldToScreen(wx, wy) {
      return {
        x: wx * this.scale + this.x,
        y: wy * this.scale + this.y
      };
    }
    setScaleLimits(minScale, maxScale) {
      if (Number.isFinite(minScale) && minScale > 0) {
        this.minScale = minScale;
      }
      if (maxScale == null) {
        this.maxScale = Infinity;
      } else if (Number.isFinite(maxScale) && maxScale >= this.minScale) {
        this.maxScale = maxScale;
      }
      if (this.scale < this.minScale) {
        this.scale = this.minScale;
      }
      if (this.scale > this.maxScale) {
        this.scale = this.maxScale;
      }
    }
  };
  function zoomInRange(target, zoom) {
    if (!target) return true;
    const min = Number.isFinite(target.zoomMin) ? target.zoomMin : 0;
    const maxValue = target.zoomMax == null ? Infinity : target.zoomMax;
    return zoom >= min && zoom <= maxValue;
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function getTimeSeconds() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now() / 1e3;
    }
    return Date.now() / 1e3;
  }
  var Renderer = class {
    constructor(canvas, world, glyphs) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.world = world;
      this.glyphs = glyphs;
      this.camera = new Camera();
      this._cameraFitted = false;
      this.spriteBudget = 200;
      this.effectShaders = {
        cloudNoise: (ctx, agent, view, time) => this.renderCloudNoise(ctx, agent, view, time),
        treeSway: (ctx, agent, view, time) => this.renderTreeSway(ctx, agent, view, time)
      };
      this.resize(true);
      window.addEventListener("resize", () => this.resize());
    }
    resize(forceFit = false) {
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
      if (forceFit || !this._cameraFitted) {
        this.fitCameraToWorld();
      }
    }
    fitCameraToWorld() {
      const worldWidth = this.world.width;
      const worldHeight = this.world.height;
      if (worldWidth === 0 || worldHeight === 0) return;
      const scaleX = this.canvas.width / worldWidth;
      const scaleY = this.canvas.height / worldHeight;
      const scale = Math.min(scaleX, scaleY);
      this.camera.scale = scale;
      const minScale = Math.max(scale * 0.05, 1e-4);
      const maxScale = Math.max(scale * 40, minScale);
      this.camera.setScaleLimits(minScale, maxScale);
      const offsetX = -this.world.bounds.minX * scale;
      const offsetY = -this.world.bounds.minY * scale;
      this.camera.x = (this.canvas.width - worldWidth * scale) / 2 + offsetX;
      this.camera.y = (this.canvas.height - worldHeight * scale) / 2 + offsetY;
      this._cameraFitted = true;
    }
    draw() {
      const ctx = this.ctx;
      ctx.save();
      ctx.setTransform(this.camera.scale, 0, 0, this.camera.scale, this.camera.x, this.camera.y);
      const view = this._computeViewBounds();
      ctx.clearRect(view.left, view.top, view.width, view.height);
      this.drawTerrainPass(ctx, view);
      this.drawVectorPass(ctx, view);
      this.drawSpritePass(ctx, view);
      this.drawEffectPass(ctx, view);
      ctx.restore();
    }
    _computeViewBounds() {
      const left = -this.camera.x / this.camera.scale;
      const top = -this.camera.y / this.camera.scale;
      const width = this.canvas.width / this.camera.scale;
      const height = this.canvas.height / this.camera.scale;
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        zoom: this.camera.scale,
        time: getTimeSeconds()
      };
    }
    drawTerrainPass(ctx, view) {
      const layer = this.world.getTerrainLayer();
      if (!zoomInRange(layer, view.zoom)) return;
      const grid = layer.grid;
      if (!grid) return;
      const cellWidth = this.world.cellWidth;
      const cellHeight = this.world.cellHeight;
      if (!isFinite(cellWidth) || !isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return;
      const left = view.left;
      const top = view.top;
      const visibleWidth = view.width;
      const visibleHeight = view.height;
      const colStart = Math.max(0, Math.floor((left - this.world.bounds.minX) / cellWidth));
      const colEnd = Math.min(
        this.world.gridCols - 1,
        Math.floor((left + visibleWidth - this.world.bounds.minX - 1e-9) / cellWidth)
      );
      const rowStart = Math.max(0, Math.floor((top - this.world.bounds.minY) / cellHeight));
      const rowEnd = Math.min(
        this.world.gridRows - 1,
        Math.floor((top + visibleHeight - this.world.bounds.minY - 1e-9) / cellHeight)
      );
      if (colEnd < colStart || rowEnd < rowStart) return;
      const canAdjustSmoothing = "imageSmoothingEnabled" in ctx;
      const previousSmoothing = canAdjustSmoothing ? ctx.imageSmoothingEnabled : null;
      if (canAdjustSmoothing) {
        ctx.imageSmoothingEnabled = false;
      }
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          const tileId = grid[row][col];
          const tile = this.world.getTileDescriptor(tileId);
          if (!tile) continue;
          const x = this.world.bounds.minX + col * cellWidth;
          const y = this.world.bounds.minY + row * cellHeight;
          const textureKey = tile.texture;
          const textureGlyph = textureKey && this.glyphs && this.glyphs.byKey ? this.glyphs.byKey[textureKey] : null;
          if (textureGlyph && textureGlyph.canvas) {
            ctx.drawImage(textureGlyph.canvas, x, y, cellWidth, cellHeight);
          } else {
            ctx.fillStyle = tile.color || "#000000";
            ctx.fillRect(x, y, cellWidth, cellHeight);
          }
        }
      }
      if (canAdjustSmoothing) {
        ctx.imageSmoothingEnabled = previousSmoothing;
      }
    }
    drawVectorPass(ctx, view) {
      const layer = this.world.getVectorLayer();
      if (!zoomInRange(layer, view.zoom)) return;
      for (const feature of layer.features) {
        if (!feature) continue;
        if (!zoomInRange(feature, view.zoom)) continue;
        const style = feature.style || {};
        const strokeStyle = style.strokeStyle || "rgba(0,0,0,0.6)";
        const lineWidth = Number.isFinite(style.lineWidth) ? style.lineWidth : 1 / clamp(view.zoom, 1, Infinity);
        const fillStyle = style.fillStyle;
        if (feature.poly && feature.poly.length >= 3) {
          ctx.save();
          ctx.beginPath();
          feature.poly.forEach((p, index) => {
            if (index === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          });
          ctx.closePath();
          if (fillStyle) {
            ctx.fillStyle = fillStyle;
            ctx.fill();
          }
          ctx.lineWidth = lineWidth;
          ctx.strokeStyle = strokeStyle;
          ctx.stroke();
          ctx.restore();
          continue;
        }
        const points = feature.line;
        if (!points || points.length < 2) continue;
        ctx.save();
        ctx.beginPath();
        points.forEach((p, index) => {
          if (index === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = strokeStyle;
        if (style.lineDash && Array.isArray(style.lineDash)) {
          ctx.setLineDash(style.lineDash);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
    _resolveSpriteScale(placement, glyph) {
      const baseWidth = this.world.cellWidth;
      const baseHeight = this.world.cellHeight;
      const defaultScaleX = baseWidth / glyph.width;
      const defaultScaleY = baseHeight / glyph.height;
      const scale = placement.scale;
      if (scale == null) {
        return { x: defaultScaleX, y: defaultScaleY };
      }
      if (typeof scale === "number") {
        return { x: scale, y: scale };
      }
      const sx = Number.isFinite(scale.x) ? scale.x : defaultScaleX;
      const sy = Number.isFinite(scale.y) ? scale.y : defaultScaleY;
      return { x: sx, y: sy };
    }
    _resolveAnchor(placement) {
      const anchor = placement.anchor;
      if (!anchor) {
        return { x: 0.5, y: 0.5 };
      }
      const ax = Number.isFinite(anchor.x) ? anchor.x : 0.5;
      const ay = Number.isFinite(anchor.y) ? anchor.y : 0.5;
      return { x: ax, y: ay };
    }
    _computeSpriteOffset(agent, time) {
      if (!agent) return { x: 0, y: 0 };
      const effect = agent.effect || agent.type;
      if (effect === "treeSway") {
        const amplitude = Number.isFinite(agent.amplitude) ? agent.amplitude : Math.min(this.world.cellWidth, this.world.cellHeight) * 0.3;
        const speed = Number.isFinite(agent.speed) ? agent.speed : 1.2;
        const phase = (agent.phase || 0) + speed * time;
        return {
          x: Math.sin(phase) * amplitude,
          y: Math.cos(phase * 0.5) * amplitude * 0.1
        };
      }
      return { x: 0, y: 0 };
    }
    _intersectsView(bounds, view) {
      return !(bounds.right < view.left || bounds.left > view.right || bounds.bottom < view.top || bounds.top > view.bottom);
    }
    drawSpritePass(ctx, view) {
      const layer = this.world.getSpriteLayer();
      if (!zoomInRange(layer, view.zoom)) return;
      const commands = [];
      let index = 0;
      for (const placement of layer.placements) {
        if (!placement || !placement.glyph) continue;
        if (!zoomInRange(placement, view.zoom)) continue;
        const glyph = this.glyphs?.byKey ? this.glyphs.byKey[placement.glyph] : null;
        if (!glyph || !glyph.canvas) continue;
        const scale = this._resolveSpriteScale(placement, glyph);
        if (scale.x <= 0 || scale.y <= 0) continue;
        const anchor = this._resolveAnchor(placement);
        const offset = this._computeSpriteOffset(placement.agentRef, view.time);
        const width = glyph.width * scale.x;
        const height = glyph.height * scale.y;
        const x = placement.position.x + offset.x - anchor.x * width;
        const y = placement.position.y + offset.y - anchor.y * height;
        const rotation = Number.isFinite(placement.rotation) ? placement.rotation : 0;
        const centerX = x + width * 0.5;
        const centerY = y + height * 0.5;
        const radius = Math.hypot(width, height) * 0.5;
        const bounds = {
          left: centerX - radius,
          right: centerX + radius,
          top: centerY - radius,
          bottom: centerY + radius
        };
        if (!this._intersectsView(bounds, view)) continue;
        commands.push({
          glyph,
          x,
          y,
          width,
          height,
          rotation,
          centerX,
          centerY,
          placement,
          order: Number.isFinite(placement.priority) ? placement.priority : 0,
          index: index++
        });
      }
      if (commands.length === 0) return;
      commands.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.index - b.index;
      });
      const culled = commands.slice(0, this.spriteBudget);
      const smoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      for (const cmd of culled) {
        if (cmd.rotation) {
          ctx.save();
          ctx.translate(cmd.centerX, cmd.centerY);
          ctx.rotate(cmd.rotation);
          ctx.drawImage(cmd.glyph.canvas, -cmd.width * 0.5, -cmd.height * 0.5, cmd.width, cmd.height);
          ctx.restore();
        } else {
          ctx.drawImage(cmd.glyph.canvas, cmd.x, cmd.y, cmd.width, cmd.height);
        }
        if (cmd.placement.agentRef && cmd.placement.agentRef.effect === "treeSway") {
          this.renderTreeSwayHighlight(ctx, cmd);
        }
      }
      ctx.imageSmoothingEnabled = smoothing;
    }
    drawEffectPass(ctx, view) {
      const layer = this.world.getEffectLayer();
      if (!zoomInRange(layer, view.zoom)) return;
      for (const agent of layer.agents) {
        if (!agent) continue;
        if (!zoomInRange(agent, view.zoom)) continue;
        const effect = agent.effect || agent.type;
        const shader = this.effectShaders[effect];
        if (!shader) continue;
        shader(ctx, agent, view, view.time);
      }
    }
    renderCloudNoise(ctx, agent, _view, time) {
      const radius = Number.isFinite(agent.radius) ? agent.radius : Math.min(this.world.width, this.world.height) * 0.1;
      const opacity = agent.opacity != null ? agent.opacity : 0.35;
      const speed = Number.isFinite(agent.speed) ? agent.speed : 0.08;
      const phase = (agent.phase || 0) + speed * time;
      const seed = agent.seed != null ? agent.seed : typeof agent.id === "number" ? agent.id : 1;
      const layers = 6;
      ctx.save();
      ctx.translate(agent.position.x, agent.position.y);
      ctx.globalAlpha = opacity;
      for (let i = 0; i < layers; i++) {
        const angle = i / layers * Math.PI * 2;
        const hash = Math.sin((seed + i) * 12.9898) * 43758.5453;
        const noise = hash - Math.floor(hash);
        const r = radius * (0.6 + 0.4 * noise);
        const dx = Math.cos(angle + phase * 0.3) * r;
        const dy = Math.sin(angle * 0.9 + phase * 0.2) * r * 0.6;
        const gradient = ctx.createRadialGradient(dx, dy, r * 0.2, dx, dy, r);
        gradient.addColorStop(0, "rgba(255,255,255,0.9)");
        gradient.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    renderTreeSway(ctx, agent, _view, time) {
      const amplitude = Number.isFinite(agent.amplitude) ? agent.amplitude : Math.min(this.world.cellWidth, this.world.cellHeight) * 0.4;
      const height = amplitude * 3;
      const speed = Number.isFinite(agent.speed) ? agent.speed : 1.4;
      const phase = (agent.phase || 0) + time * speed;
      const sway = Math.sin(phase) * amplitude;
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = Math.max(this.world.cellWidth, this.world.cellHeight) * 0.05;
      ctx.beginPath();
      ctx.moveTo(agent.position.x, agent.position.y);
      ctx.quadraticCurveTo(agent.position.x + sway, agent.position.y - height * 0.5, agent.position.x, agent.position.y - height);
      ctx.stroke();
      ctx.restore();
    }
    renderTreeSwayHighlight(ctx, command) {
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(command.centerX, command.centerY - command.height * 0.3, command.width * 0.6, command.height * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  // input.js
  var Input = class {
    constructor(canvas, renderer, world) {
      this.canvas = canvas;
      this.renderer = renderer;
      this.world = world;
      this.currentTileId = 0;
      this.isPanning = false;
      this.setupEvents();
    }
    setupEvents() {
      this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
      this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
      this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
      this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    }
    onPointerDown(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (e.button === 2) {
        this.isPanning = true;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
      } else if (e.button === 0) {
        const worldPos = this.renderer.camera.screenToWorld(x, y);
        if (e.shiftKey) {
          const cart = this.world.selectedCart;
          if (cart) {
            const point = this.world.clampToBounds(worldPos.x, worldPos.y);
            cart.path.push(point);
            if (cart.path.length >= 2) {
              cart.computeSegments();
            }
          }
        } else {
          const point = this.world.clampToBounds(worldPos.x, worldPos.y);
          const selected = this.world.selectCartAt(point.x, point.y);
          if (!selected) {
            this.world.paintTile(point.x, point.y, this.currentTileId);
          }
        }
      }
    }
    onPointerMove(e) {
      if (this.isPanning && e.buttons & 2) {
        const dx = e.clientX - this.lastPanX;
        const dy = e.clientY - this.lastPanY;
        this.renderer.camera.x += dx;
        this.renderer.camera.y += dy;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
      } else if (e.buttons & 1 && !this.isPanning) {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const worldPos = this.renderer.camera.screenToWorld(px, py);
        const point = this.world.clampToBounds(worldPos.x, worldPos.y);
        this.world.paintTile(point.x, point.y, this.currentTileId);
      }
    }
    onPointerUp(e) {
      if (e.button === 2) {
        this.isPanning = false;
      }
    }
    onWheel(e) {
      e.preventDefault();
      const scaleFactor = 1.1;
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const camera = this.renderer.camera;
      const worldBefore = camera.screenToWorld(px, py);
      let newScale = camera.scale;
      if (e.deltaY < 0) {
        newScale *= scaleFactor;
      } else {
        newScale /= scaleFactor;
      }
      const minScale = Number.isFinite(camera.minScale) && camera.minScale > 0 ? camera.minScale : 0.2;
      const maxScale = Number.isFinite(camera.maxScale) && camera.maxScale > minScale ? camera.maxScale : Infinity;
      newScale = Math.max(minScale, Math.min(newScale, maxScale));
      camera.scale = newScale;
      camera.x = px - worldBefore.x * newScale;
      camera.y = py - worldBefore.y * newScale;
    }
  };

  // data/paletteData.js
  var paletteData_default = {
    "defaultTile": "grass",
    "tiles": [
      { "key": "grass", "name": "Grass", "color": "#8BC34A", "texture": "grass_tile" },
      { "key": "forest", "name": "Forest", "color": "#4CAF50", "texture": "forest_tile" },
      { "key": "water", "name": "Water", "color": "#2196F3", "texture": "water_tile" },
      { "key": "mountain", "name": "Mountain", "color": "#795548", "texture": "mountain_tile" },
      { "key": "road", "name": "Road", "color": "#FF9800", "texture": "road_tile" }
    ]
  };

  // data/glyphsData.js
  var glyphsData_default = {
    "glyphs": [
      {
        "key": "tree",
        "name": "Tree",
        "width": 3,
        "height": 3,
        "palette": [null, "#4CAF50", "#795548"],
        "rle": "1*0 1*1 1*0 1*1 1*2 1*1 1*0 1*1 1*0"
      },
      {
        "key": "cart",
        "name": "Cart",
        "width": 5,
        "height": 3,
        "palette": [null, "#5D4037", "#FFEB3B"],
        "rle": "2*0 1*1 2*0 1*0 1*1 1*2 1*1 1*0 1*0 3*1 1*0"
      },
      {
        "key": "grass_tile",
        "name": "Grass Tile",
        "width": 8,
        "height": 8,
        "palette": [null, "#6EA943", "#7CC54D", "#93D35B", "#5F8F38"],
        "rle": "1*1 1*2 1*1 1*3 1*1 1*2 1*1 1*4 1*2 1*1 1*3 1*1 1*4 1*1 1*2 2*1 1*3 1*1 1*2 1*1 1*4 1*1 1*2 1*3 1*1 1*2 1*1 1*2 1*1 1*3 2*1 1*4 1*1 1*2 1*1 1*3 1*1 2*2 1*1 1*4 1*1 1*3 1*1 1*2 2*1 1*2 1*1 1*3 1*1 1*2 1*1 1*4 1*2 1*1 1*2 1*1 1*4 1*1 1*3 1*1"
      },
      {
        "key": "forest_tile",
        "name": "Forest Tile",
        "width": 8,
        "height": 8,
        "palette": [null, "#2E7D32", "#1B5E20", "#388E3C", "#4CAF50"],
        "rle": "1*2 2*1 1*2 2*3 1*2 2*1 1*2 2*3 1*2 1*1 1*3 1*2 1*1 1*3 1*4 1*3 1*1 1*2 1*3 1*1 1*2 2*3 1*4 2*3 2*2 1*3 1*4 2*3 1*4 2*3 2*2 1*3 1*1 1*2 1*3 1*4 1*3 2*1 1*3 1*2 2*3 1*2 1*3 1*1 1*2 1*1 1*3 1*2 1*1 1*3 2*2"
      },
      {
        "key": "water_tile",
        "name": "Water Tile",
        "width": 8,
        "height": 8,
        "palette": [null, "#03A9F4", "#0288D1", "#29B6F6", "#01579B"],
        "rle": "1*1 1*2 1*1 1*3 1*1 1*2 1*1 1*4 1*2 1*1 1*4 1*1 1*2 1*1 1*3 2*1 1*4 1*2 1*1 1*4 1*1 1*2 1*1 1*3 2*1 1*2 1*1 1*3 1*1 1*2 1*1 1*2 1*1 1*4 1*1 1*2 1*1 1*3 1*2 1*1 1*3 1*1 1*2 1*1 1*4 2*1 1*3 1*1 1*2 1*1 1*4 1*1 1*2 1*4 1*1 1*2 1*1 1*3 1*1 1*2 1*1"
      },
      {
        "key": "mountain_tile",
        "name": "Mountain Tile",
        "width": 8,
        "height": 8,
        "palette": [null, "#8D6E63", "#6D4C41", "#A1887F", "#D7CCC8"],
        "rle": "2*1 4*2 3*1 2*2 2*3 2*2 1*1 2*2 1*3 1*4 2*3 3*2 1*3 3*4 2*3 2*2 2*3 1*4 2*3 2*2 1*1 2*2 2*3 2*2 3*1 4*2 5*1 2*2 3*1"
      },
      {
        "key": "road_tile",
        "name": "Road Tile",
        "width": 8,
        "height": 8,
        "palette": [null, "#A1887F", "#8D6E63", "#BCAAA4"],
        "rle": "2*1 2*2 1*3 2*2 2*1 1*2 1*3 1*2 1*1 1*2 1*3 2*2 1*3 1*1 2*2 1*3 5*2 1*3 2*2 1*3 1*1 1*3 1*1 2*2 1*3 2*2 1*3 1*2 1*3 1*2 1*1 1*2 1*3 1*1 3*2 1*3 3*2 1*3 1*2 1*1 2*2 1*3 1*1 2*2 1*1"
      }
    ]
  };

  // assets.js
  var PALETTE_PATH = "./data/palette.json";
  var GLYPHS_PATH = "./data/glyphs.json";
  function buildPaletteLUT(data) {
    const tiles = (data.tiles || []).map((tile, index) => {
      const assignedId = tile.id != null ? tile.id : index;
      return { ...tile, id: assignedId };
    });
    if (tiles.length === 0) {
      throw new Error("Palette definition contains no tiles");
    }
    const byKey = {};
    const byId = {};
    for (const tile of tiles) {
      if (!tile.key) {
        throw new Error("Palette tile missing key");
      }
      byKey[tile.key] = tile;
      byId[tile.id] = tile;
    }
    const fallbackKey = data.defaultTile && byKey[data.defaultTile] ? data.defaultTile : tiles[0].key;
    const defaultTileId = byKey[fallbackKey].id;
    return {
      tiles,
      byKey,
      byId,
      defaultTileKey: fallbackKey,
      defaultTileId
    };
  }
  function parseHexColor(hex) {
    const normalized = hex.replace(/^#/, "");
    if (![3, 4, 6, 8].includes(normalized.length)) {
      throw new Error(`Unsupported hex colour: ${hex}`);
    }
    const expand = (value) => value.length === 1 ? value + value : value;
    let r, g, b, a = 255;
    if (normalized.length === 3 || normalized.length === 4) {
      const rHex = expand(normalized[0]);
      const gHex = expand(normalized[1]);
      const bHex = expand(normalized[2]);
      const aHex = normalized.length === 4 ? expand(normalized[3]) : "ff";
      r = parseInt(rHex, 16);
      g = parseInt(gHex, 16);
      b = parseInt(bHex, 16);
      a = parseInt(aHex, 16);
    } else {
      r = parseInt(normalized.slice(0, 2), 16);
      g = parseInt(normalized.slice(2, 4), 16);
      b = parseInt(normalized.slice(4, 6), 16);
      if (normalized.length === 8) {
        a = parseInt(normalized.slice(6, 8), 16);
      }
    }
    return { r, g, b, a };
  }
  function decodeRLE(rle, expected) {
    if (!rle) return [];
    const tokens = rle.trim().split(/\s+/);
    const pixels = [];
    for (const token of tokens) {
      const parts = token.split("*");
      if (parts.length !== 2) {
        throw new Error(`Invalid RLE token: ${token}`);
      }
      const count = Number(parts[0]);
      const value = Number(parts[1]);
      if (!Number.isFinite(count) || !Number.isFinite(value)) {
        throw new Error(`Invalid RLE pair: ${token}`);
      }
      for (let i = 0; i < count; i++) {
        pixels.push(value);
      }
    }
    if (expected != null && pixels.length !== expected) {
      throw new Error(`RLE length ${pixels.length} does not match expected ${expected}`);
    }
    return pixels;
  }
  function expandGlyph(definition) {
    const { width, height, palette = [], rle } = definition;
    const pixelCount = width * height;
    const pixels = decodeRLE(rle, pixelCount);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);
    for (let i = 0; i < pixelCount; i++) {
      const paletteIndex = pixels[i];
      const color = palette[paletteIndex];
      const offset = i * 4;
      if (!color) {
        imageData.data[offset] = 0;
        imageData.data[offset + 1] = 0;
        imageData.data[offset + 2] = 0;
        imageData.data[offset + 3] = 0;
        continue;
      }
      const { r, g, b, a } = parseHexColor(color);
      imageData.data[offset] = r;
      imageData.data[offset + 1] = g;
      imageData.data[offset + 2] = b;
      imageData.data[offset + 3] = a;
    }
    ctx.putImageData(imageData, 0, 0);
    return {
      ...definition,
      pixels,
      canvas
    };
  }
  function buildGlyphRegistry(data) {
    const glyphs = {};
    const list = [];
    for (const def of data.glyphs || []) {
      if (!def.key) {
        throw new Error("Glyph definition missing key");
      }
      const expanded = expandGlyph(def);
      glyphs[def.key] = expanded;
      list.push(expanded);
    }
    return { byKey: glyphs, list };
  }
  function loadEmbeddedAssetJson() {
    if (!paletteData_default) {
      throw new Error("Embedded palette data missing");
    }
    if (!glyphsData_default) {
      throw new Error("Embedded glyph data missing");
    }
    return { paletteJson: paletteData_default, glyphJson: glyphsData_default };
  }
  async function fetchAssetJson() {
    const [paletteRes, glyphRes] = await Promise.all([
      fetch(PALETTE_PATH),
      fetch(GLYPHS_PATH)
    ]);
    if (!paletteRes.ok) {
      throw new Error(`Failed to load palette: ${paletteRes.status}`);
    }
    if (!glyphRes.ok) {
      throw new Error(`Failed to load glyphs: ${glyphRes.status}`);
    }
    const [paletteJson, glyphJson] = await Promise.all([
      paletteRes.json(),
      glyphRes.json()
    ]);
    return { paletteJson, glyphJson };
  }
  function logAssetSummary(palette, glyphs, source) {
    const tileCount = palette.tiles.length;
    const glyphCount = glyphs.list.length;
    const message = `[assets] Loaded ${tileCount} palette tiles and ${glyphCount} glyphs (${source}).`;
    if (tileCount === 0 || glyphCount === 0) {
      console.warn(message);
    } else {
      console.info(message);
    }
  }
  async function loadAssets(options = {}) {
    const preferFetch = options.preferFetch === true;
    let paletteJson;
    let glyphJson;
    const errors = [];
    if (!preferFetch) {
      try {
        ({ paletteJson, glyphJson } = loadEmbeddedAssetJson());
      } catch (err) {
        errors.push(err);
        console.warn(`[assets] Embedded asset load failed: ${err.message}`);
      }
    }
    let source = "embedded data";
    if (!paletteJson || !glyphJson) {
      try {
        ({ paletteJson, glyphJson } = await fetchAssetJson());
        source = "network fetch";
      } catch (err) {
        errors.push(err);
      }
    }
    if (!paletteJson || !glyphJson) {
      const details = errors.map((err) => err && err.message ? err.message : String(err)).join("; ");
      throw new Error(`Unable to load palette/glyph assets: ${details || "unknown error"}`);
    }
    const palette = buildPaletteLUT(paletteJson);
    const glyphs = buildGlyphRegistry(glyphJson);
    logAssetSummary(palette, glyphs, source);
    return { palette, glyphs };
  }

  // main.js
  var COLS = 50;
  var ROWS = 50;
  function populatePaletteUI(palette, input) {
    const paletteDiv = document.getElementById("palette");
    paletteDiv.innerHTML = "";
    palette.tiles.forEach((tile) => {
      const btn = document.createElement("button");
      btn.textContent = tile.name;
      btn.style.backgroundColor = tile.color;
      btn.onclick = () => {
        input.currentTileId = tile.id;
        Array.from(paletteDiv.children).forEach((child) => {
          child.style.outline = "";
        });
        btn.style.outline = "2px solid black";
      };
      paletteDiv.appendChild(btn);
    });
    if (paletteDiv.children.length > 0) {
      paletteDiv.children[0].click();
    }
  }
  async function init() {
    try {
      let loop = function(time) {
        let frameTime = (time - lastTime) / 1e3;
        lastTime = time;
        if (frameTime > MAX_FRAME_TIME) {
          frameTime = MAX_FRAME_TIME;
        }
        if (playing) {
          accumulator += frameTime;
          while (accumulator >= FIXED_STEP) {
            world.update(FIXED_STEP);
            accumulator -= FIXED_STEP;
          }
        } else {
          accumulator = 0;
        }
        renderer.draw();
        requestAnimationFrame(loop);
      };
      const { palette, glyphs } = await loadAssets();
      const canvas = document.getElementById("canvas");
      const seedInput = document.getElementById("seedInput");
      const applySeedBtn = document.getElementById("applySeed");
      const randomSeedBtn = document.getElementById("randomSeed");
      const initialSeedValue = seedInput && seedInput.value.trim() !== "" ? seedInput.value.trim() : DEFAULT_WORLD_SEED;
      const world = new World(COLS, ROWS, palette, void 0, initialSeedValue);
      if (seedInput) {
        seedInput.value = world.seed.toString();
      }
      const renderer = new Renderer(canvas, world, glyphs);
      const input = new Input(canvas, renderer, world);
      input.currentTileId = palette.defaultTileId;
      populatePaletteUI(palette, input);
      const updateSeedUI = () => {
        if (seedInput) {
          seedInput.value = world.seed.toString();
        }
        renderer.draw();
      };
      const applySeedFromInput = () => {
        if (!seedInput) return;
        const raw = seedInput.value.trim();
        if (raw === "") return;
        const numeric = Number(raw);
        const nextSeed = Number.isFinite(numeric) ? numeric : raw;
        world.setSeed(nextSeed);
        updateSeedUI();
      };
      if (applySeedBtn) {
        applySeedBtn.onclick = () => {
          applySeedFromInput();
        };
      }
      if (seedInput) {
        seedInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            applySeedFromInput();
          }
        });
      }
      if (randomSeedBtn) {
        randomSeedBtn.onclick = () => {
          const randomSeed = Math.floor(Math.random() * 4294967295);
          world.setSeed(randomSeed);
          updateSeedUI();
        };
      }
      const addCartBtn = document.getElementById("addCart");
      addCartBtn.onclick = () => {
        const cart = world.addCart();
        world.carts.forEach((c) => c.selected = false);
        cart.selected = true;
      };
      const playPauseBtn = document.getElementById("playPause");
      let playing = false;
      playPauseBtn.onclick = () => {
        playing = !playing;
        playPauseBtn.textContent = playing ? "Pause" : "Play";
      };
      const saveBtn = document.getElementById("saveBtn");
      saveBtn.onclick = () => {
        const data = world.serialize();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "world.json";
        a.click();
        URL.revokeObjectURL(url);
      };
      const loadBtn = document.getElementById("loadBtn");
      const loadInput = document.getElementById("loadInput");
      loadBtn.onclick = () => {
        loadInput.value = "";
        loadInput.click();
      };
      loadInput.onchange = () => {
        const file = loadInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const data = JSON.parse(ev.target.result);
            world.deserialize(data);
            updateSeedUI();
            renderer.fitCameraToWorld();
          } catch (ex) {
            alert("Failed to load world: " + ex.message);
          }
        };
        reader.readAsText(file);
      };
      const FIXED_STEP = 1 / 60;
      const MAX_FRAME_TIME = 0.25;
      let accumulator = 0;
      let lastTime = performance.now();
      requestAnimationFrame(loop);
    } catch (err) {
      console.error("Failed to initialise engine", err);
      const paletteDiv = document.getElementById("palette");
      paletteDiv.textContent = "Failed to load assets";
    }
  }
  init();
})();
