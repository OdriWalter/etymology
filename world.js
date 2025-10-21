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
    this.position = { x: 0, y: 0 }; // in tile units (i.e. centre of tiles)
    this.speed = 5; // tiles per second
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
  constructor(cols, rows, tileSize, palette) {
    this.cols = cols;
    this.rows = rows;
    this.tileSize = tileSize;
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

  paintTile(col, row, tileId) {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return;
    if (!this.palette.byId[tileId]) return;
    this.grid[row][col] = tileId;
  }

  addCart() {
    const cart = new Cart(this.nextCartId++);
    // set initial position to centre
    cart.position = { x: this.cols / 2, y: this.rows / 2 };
    this.carts.push(cart);
    return cart;
  }

  // Select a cart near the world coordinates (tile units)
  selectCartAt(wx, wy) {
    let selected = null;
    let minDistSq = 0.5 * 0.5;
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
      cols: this.cols,
      rows: this.rows,
      tileSize: this.tileSize,
      grid: this.grid,
      carts: this.carts.map(c => ({
        id: c.id,
        path: c.path,
        position: c.position,
        speed: c.speed,
        progress: c.progress,
        loop: c.loop
      }))
    };
  }

  // Load world from plain object
  deserialize(data) {
    this.cols = data.cols;
    this.rows = data.rows;
    this.tileSize = data.tileSize;
    this.grid = data.grid.map(row => row.map(id => this.palette.byId[id] ? id : this.defaultTileId));
    this.carts = [];
    this.nextCartId = 1;
    for (const cd of data.carts) {
      const cart = new Cart(cd.id);
      cart.path = cd.path;
      cart.position = cd.position;
      cart.speed = cd.speed;
      cart.progress = cd.progress;
      cart.loop = cd.loop;
      if (cart.path.length >= 2) {
        cart.computeSegments();
        cart.update(0);
      }
      this.nextCartId = Math.max(this.nextCartId, cd.id + 1);
      this.carts.push(cart);
    }
  }
}