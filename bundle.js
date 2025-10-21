// bundle.js - single file bundle of the engine with palette/glyph asset loading
(function() {
  const PALETTE_PATH = './data/palette.json';
  const GLYPHS_PATH = './data/glyphs.json';

  function buildPaletteLUT(data) {
    const tiles = (data.tiles || []).map((tile, index) => {
      const assignedId = tile.id != null ? tile.id : index;
      return { ...tile, id: assignedId };
    });
    if (tiles.length === 0) {
      throw new Error('Palette definition contains no tiles');
    }
    const byKey = {};
    const byId = {};
    for (const tile of tiles) {
      if (!tile.key) {
        throw new Error('Palette tile missing key');
      }
      byKey[tile.key] = tile;
      byId[tile.id] = tile;
    }
    const fallbackKey = data.defaultTile && byKey[data.defaultTile]
      ? data.defaultTile
      : tiles[0].key;
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
    const normalized = hex.replace(/^#/, '');
    if (![3, 4, 6, 8].includes(normalized.length)) {
      throw new Error(`Unsupported hex colour: ${hex}`);
    }
    const expand = (value) => value.length === 1 ? value + value : value;
    let r, g, b, a = 255;
    if (normalized.length === 3 || normalized.length === 4) {
      const rHex = expand(normalized[0]);
      const gHex = expand(normalized[1]);
      const bHex = expand(normalized[2]);
      const aHex = normalized.length === 4 ? expand(normalized[3]) : 'ff';
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
      const parts = token.split('*');
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
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
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
        throw new Error('Glyph definition missing key');
      }
      const expanded = expandGlyph(def);
      glyphs[def.key] = expanded;
      list.push(expanded);
    }
    return { byKey: glyphs, list };
  }

  async function loadAssets() {
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
    const palette = buildPaletteLUT(paletteJson);
    const glyphs = buildGlyphRegistry(glyphJson);
    return { palette, glyphs };
  }

  class Cart {
    constructor(id) {
      this.id = id;
      this.path = [];
      this.position = { x: 0, y: 0 };
      this.speed = 0.1;
      this.progress = 0;
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

  function resolveTile(palette, defaultTileId, tileId) {
    if (!palette) return null;
    const resolved = palette.byId[tileId];
    if (resolved) return resolved;
    return palette.byId[defaultTileId];
  }

  class World {
    constructor(cols, rows, palette, bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }) {
      this.gridCols = cols;
      this.gridRows = rows;
      this.bounds = { ...bounds };
      this.setPalette(palette);
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
      cart.position = {
        x: this.bounds.minX + this.width / 2,
        y: this.bounds.minY + this.height / 2
      };
      cart.speed = 5 / this.gridCols;
      this.carts.push(cart);
      return cart;
    }
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
    serialize() {
      return {
        bounds: { ...this.bounds },
        gridCols: this.gridCols,
        gridRows: this.gridRows,
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

  class Camera {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.scale = 1;
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
  }

  class Renderer {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.camera = new Camera();
      this._cameraFitted = false;
      this.resize(true);
      window.addEventListener('resize', () => this.resize());
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
      const worldLeft = -this.camera.x / this.camera.scale;
      const worldTop = -this.camera.y / this.camera.scale;
      const worldWidth = this.canvas.width / this.camera.scale;
      const worldHeight = this.canvas.height / this.camera.scale;
      ctx.clearRect(worldLeft, worldTop, worldWidth, worldHeight);
      this.drawTiles(ctx);
      this.drawPaths(ctx);
      this.drawCarts(ctx);
      ctx.restore();
    }
    drawTiles(ctx) {
      const world = this.world;
      const cellWidth = world.cellWidth;
      const cellHeight = world.cellHeight;
      if (!isFinite(cellWidth) || !isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return;
      const left = -this.camera.x / this.camera.scale;
      const top = -this.camera.y / this.camera.scale;
      const visibleWidth = this.canvas.width / this.camera.scale;
      const visibleHeight = this.canvas.height / this.camera.scale;
      const colStart = Math.max(0, Math.floor((left - world.bounds.minX) / cellWidth));
      const colEnd = Math.min(
        world.gridCols - 1,
        Math.floor(((left + visibleWidth) - world.bounds.minX - 1e-9) / cellWidth)
      );
      const rowStart = Math.max(0, Math.floor((top - world.bounds.minY) / cellHeight));
      const rowEnd = Math.min(
        world.gridRows - 1,
        Math.floor(((top + visibleHeight) - world.bounds.minY - 1e-9) / cellHeight)
      );
      if (colEnd < colStart || rowEnd < rowStart) return;
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          const tileId = world.grid[row][col];
          const tile = world.getTileDescriptor(tileId);
          if (!tile) continue;
          ctx.fillStyle = tile.color;
          const x = world.bounds.minX + col * cellWidth;
          const y = world.bounds.minY + row * cellHeight;
          ctx.fillRect(x, y, cellWidth, cellHeight);
        }
      }
    }
    drawPaths(ctx) {
      const world = this.world;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1 / this.camera.scale;
      for (const cart of world.carts) {
        if (cart.path.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < cart.path.length; i++) {
          const p = cart.path[i];
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
    drawCarts(ctx) {
      const world = this.world;
      const baseRadius = Math.min(world.cellWidth, world.cellHeight);
      if (!isFinite(baseRadius) || baseRadius <= 0) return;
      const radius = baseRadius * 0.3;
      for (const cart of world.carts) {
        ctx.fillStyle = cart.selected ? 'yellow' : 'red';
        ctx.beginPath();
        ctx.arc(cart.position.x, cart.position.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  class InputHandler {
    constructor(canvas, renderer, world) {
      this.canvas = canvas;
      this.renderer = renderer;
      this.world = world;
      this.currentTileId = 0;
      this.isPanning = false;
      this.initEvents();
    }
    initEvents() {
      this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
      this.canvas.addEventListener('pointerup', e => this.onPointerUp(e));
      this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
      this.canvas.addEventListener('contextmenu', e => e.preventDefault());
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
            if (cart.path.length >= 2) cart.computeSegments();
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
      if (this.isPanning && (e.buttons & 2)) {
        const dx = e.clientX - this.lastPanX;
        const dy = e.clientY - this.lastPanY;
        this.renderer.camera.x += dx;
        this.renderer.camera.y += dy;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
      } else if ((e.buttons & 1) && !this.isPanning) {
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
      if (e.deltaY < 0) newScale *= scaleFactor; else newScale /= scaleFactor;
      newScale = Math.min(Math.max(newScale, 0.2), 5);
      camera.scale = newScale;
      camera.x = px - worldBefore.x * newScale;
      camera.y = py - worldBefore.y * newScale;
    }
  }

  function populatePaletteUI(palette, input) {
    const paletteDiv = document.getElementById('palette');
    paletteDiv.innerHTML = '';
    palette.tiles.forEach((tile) => {
      const btn = document.createElement('button');
      btn.textContent = tile.name;
      btn.style.backgroundColor = tile.color;
      btn.onclick = () => {
        input.currentTileId = tile.id;
        Array.from(paletteDiv.children).forEach(child => {
          child.style.outline = '';
        });
        btn.style.outline = '2px solid black';
      };
      paletteDiv.appendChild(btn);
    });
    if (paletteDiv.children.length > 0) {
      paletteDiv.children[0].click();
    }
  }

  async function init() {
    try {
      const { palette } = await loadAssets();
      const COLS = 50;
      const ROWS = 50;
      const canvas = document.getElementById('canvas');
      const world = new World(COLS, ROWS, palette);
      const renderer = new Renderer(canvas, world);
      const input = new InputHandler(canvas, renderer, world);
      input.currentTileId = palette.defaultTileId;

      populatePaletteUI(palette, input);

      const addCartBtn = document.getElementById('addCart');
      addCartBtn.onclick = () => {
        const cart = world.addCart();
        world.carts.forEach(c => c.selected = false);
        cart.selected = true;
      };

      const playPauseBtn = document.getElementById('playPause');
      let playing = false;
      playPauseBtn.onclick = () => {
        playing = !playing;
        playPauseBtn.textContent = playing ? 'Pause' : 'Play';
      };

      const saveBtn = document.getElementById('saveBtn');
      saveBtn.onclick = () => {
        const data = world.serialize();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'world.json';
        a.click();
        URL.revokeObjectURL(url);
      };

      const loadBtn = document.getElementById('loadBtn');
      const loadInput = document.getElementById('loadInput');
      loadBtn.onclick = () => {
        loadInput.value = '';
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
            renderer.fitCameraToWorld();
          } catch (ex) {
            alert('Failed to load world: ' + ex.message);
          }
        };
        reader.readAsText(file);
      };

      const FIXED_STEP = 1 / 60;
      const MAX_FRAME_TIME = 0.25;
      let accumulator = 0;
      let lastTime = performance.now();
      function loop(time) {
        let frameTime = (time - lastTime) / 1000;
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
      }
      requestAnimationFrame(loop);
    } catch (err) {
      console.error('Failed to initialise engine', err);
      const paletteDiv = document.getElementById('palette');
      paletteDiv.textContent = 'Failed to load assets';
    }
  }

  init();
})();
