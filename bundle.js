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
      this.speed = 5;
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
    constructor(cols, rows, tileSize, palette) {
      this.cols = cols;
      this.rows = rows;
      this.tileSize = tileSize;
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
    paintTile(col, row, tileId) {
      if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return;
      if (!this.palette.byId[tileId]) return;
      this.grid[row][col] = tileId;
    }
    addCart() {
      const cart = new Cart(this.nextCartId++);
      cart.position = { x: this.cols / 2, y: this.rows / 2 };
      this.carts.push(cart);
      return cart;
    }
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
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }
    resize() {
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
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
      const ts = world.tileSize;
      const colStart = Math.max(0, Math.floor(-this.camera.x / (this.camera.scale * ts)));
      const colEnd = Math.min(world.cols - 1, Math.ceil((this.canvas.width - this.camera.x) / (this.camera.scale * ts)));
      const rowStart = Math.max(0, Math.floor(-this.camera.y / (this.camera.scale * ts)));
      const rowEnd = Math.min(world.rows - 1, Math.ceil((this.canvas.height - this.camera.y) / (this.camera.scale * ts)));
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          const tileId = world.grid[row][col];
          const tile = world.getTileDescriptor(tileId);
          if (!tile) continue;
          ctx.fillStyle = tile.color;
          ctx.fillRect(col * ts, row * ts, ts, ts);
        }
      }
    }
    drawPaths(ctx) {
      const world = this.world;
      const ts = world.tileSize;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1 / this.camera.scale;
      for (const cart of world.carts) {
        if (cart.path.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < cart.path.length; i++) {
          const p = cart.path[i];
          const px = p.x * ts;
          const py = p.y * ts;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    drawCarts(ctx) {
      const world = this.world;
      const ts = world.tileSize;
      for (const cart of world.carts) {
        ctx.fillStyle = cart.selected ? 'yellow' : 'red';
        const px = cart.position.x * ts;
        const py = cart.position.y * ts;
        const radius = ts * 0.3;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
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
        const ts = this.world.tileSize;
        const worldTileX = worldPos.x / ts;
        const worldTileY = worldPos.y / ts;
        if (e.shiftKey) {
          const cart = this.world.selectedCart;
          if (cart) {
            cart.path.push({ x: worldTileX, y: worldTileY });
            if (cart.path.length >= 2) cart.computeSegments();
          }
        } else {
          const selected = this.world.selectCartAt(worldTileX, worldTileY);
          if (!selected) {
            const col = Math.floor(worldPos.x / ts);
            const row = Math.floor(worldPos.y / ts);
            this.world.paintTile(col, row, this.currentTileId);
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
        const ts = this.world.tileSize;
        const col = Math.floor(worldPos.x / ts);
        const row = Math.floor(worldPos.y / ts);
        this.world.paintTile(col, row, this.currentTileId);
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
      const TILE_SIZE = 32;
      const COLS = 50;
      const ROWS = 50;
      const canvas = document.getElementById('canvas');
      const world = new World(COLS, ROWS, TILE_SIZE, palette);
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
