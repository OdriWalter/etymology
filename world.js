// world.js - defines the world grid, tile descriptors from the palette and carts

function resolveTile(palette, defaultTileId, tileId) {
  if (!palette) return null;
  const resolved = palette.byId[tileId];
  if (resolved) return resolved;
  return palette.byId[defaultTileId];
}

// Cart class with a polyline path and simple linear motion
export class Cart {
  constructor(id) {
    this.id = id;
    this.path = [];
    this.position = { x: 0, y: 0 }; // normalised world coordinates (0-1)
    this.speed = 0.1; // normalised units per second; world adjusts when adding
    this.progress = 0; // distance travelled along the polyline
    this.loop = true;
    this.selected = false;
    this.segments = null;
    this.totalLength = 0;
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
    // advance along the path
    this.progress += this.speed * dt;
    const total = this.totalLength;
    if (total <= 0) return;
    // wrap progress if looping
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
    // find segment
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

// World class to hold tiles and carts
export class World {
  constructor(cols, rows, palette, bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }) {
    this.gridCols = cols;
    this.gridRows = rows;
    this.bounds = { ...bounds };
    this.setPalette(palette);
    // 2D grid initialised to default tile
    this.grid = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push(this.defaultTileId);
      }
      this.grid.push(row);
    }
    this.carts = [];
    this.nextCartId = 1;
  }

  setPalette(palette) {
    if (!palette) {
      throw new Error('Palette is required to create a World');
    }
    this.palette = palette;
    this.defaultTileId = palette.defaultTileId;
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
    const clampedX = Math.min(this.bounds.maxX, Math.max(this.bounds.minX, x));
    const clampedY = Math.min(this.bounds.maxY, Math.max(this.bounds.minY, y));
    return { x: clampedX, y: clampedY };
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
    // set initial position to centre of bounds
    cart.position = {
      x: this.bounds.minX + this.width / 2,
      y: this.bounds.minY + this.height / 2
    };
    cart.speed = 5 / this.gridCols; // preserve legacy tiles-per-second default
    this.carts.push(cart);
    return cart;
  }

  // Select a cart near the world coordinates (normalised units)
  selectCartAt(wx, wy) {
    let selected = null;
    const selectionRadius = Math.min(this.cellWidth, this.cellHeight) * 0.75;
    let minDistSq = selectionRadius * selectionRadius;
    for (const cart of this.carts) {
      const dx = cart.position.x - wx;
      const dy = cart.position.y - wy;
      const d = dx * dx + dy * dy;
      if (d < minDistSq) {
        selected = cart;
        minDistSq = d;
      }
    }
    if (selected) {
      this.carts.forEach(c => c.selected = false);
      selected.selected = true;
      return selected;
    }
    return null;
  }

  get selectedCart() {
    return this.carts.find(c => c.selected);
  }

  update(dt) {
    for (const cart of this.carts) {
      cart.update(dt);
    }
  }

  getTileDescriptor(tileId) {
    return resolveTile(this.palette, this.defaultTileId, tileId);
  }

  // Serialize world to plain object
  serialize() {
    return {
      bounds: { ...this.bounds },
      gridCols: this.gridCols,
      gridRows: this.gridRows,
      // include legacy keys for backwards compatibility
      cols: this.gridCols,
      rows: this.gridRows,
      grid: this.grid,
      carts: this.carts.map(c => ({
        id: c.id,
        path: c.path.map(p => ({ x: p.x, y: p.y })),
        position: { x: c.position.x, y: c.position.y },
        speed: c.speed,
        progress: c.progress,
        loop: c.loop
      }))
    };
  }

  // Load world from plain object
  deserialize(data) {
    const cols = data.gridCols ?? data.cols ?? this.gridCols;
    const rows = data.gridRows ?? data.rows ?? this.gridRows;
    this.gridCols = cols;
    this.gridRows = rows;
    this.bounds = data.bounds ? { ...data.bounds } : { minX: 0, minY: 0, maxX: 1, maxY: 1 };

    const legacyTileSize = data.tileSize;
    const isLegacy = legacyTileSize !== undefined && !data.bounds;

    const incomingGrid = Array.isArray(data.grid) ? data.grid : [];
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

    this.carts = [];
    this.nextCartId = 1;
    const carts = Array.isArray(data.carts) ? data.carts : [];
    for (const cd of carts) {
      const id = cd.id ?? this.nextCartId++;
      const cart = new Cart(id);
      cart.speed = 5 / this.gridCols;
      const convertPoint = (pt) => {
        if (!pt) return { x: this.bounds.minX + this.width / 2, y: this.bounds.minY + this.height / 2 };
        if (isLegacy) {
          return {
            x: this.bounds.minX + (pt.x / this.gridCols) * this.width,
            y: this.bounds.minY + (pt.y / this.gridRows) * this.height
          };
        }
        return { x: pt.x, y: pt.y };
      };

      cart.path = Array.isArray(cd.path) ? cd.path.map(convertPoint) : [];
      cart.position = convertPoint(cd.position);
      cart.speed = isLegacy && typeof cd.speed === 'number'
        ? cd.speed / this.gridCols
        : (typeof cd.speed === 'number' ? cd.speed : cart.speed);
      cart.progress = isLegacy ? 0 : (typeof cd.progress === 'number' ? cd.progress : 0);
      cart.loop = cd.loop !== undefined ? cd.loop : cart.loop;
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
      this.nextCartId = Math.max(this.nextCartId, cart.id + 1);
      this.carts.push(cart);
    }
  }
}