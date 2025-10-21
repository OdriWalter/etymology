// bundle.js - single file bundle of the worldbox‑like engine
// Defines world, renderer, input and initialises the engine without using ES modules.

(function() {
  // Tile definitions
  const TILE_TYPES = {
    grass: { id: 0, name: 'Grass', color: '#8BC34A' },
    forest: { id: 1, name: 'Forest', color: '#4CAF50' },
    water: { id: 2, name: 'Water', color: '#2196F3' },
    mountain: { id: 3, name: 'Mountain', color: '#795548' },
    road: { id: 4, name: 'Road', color: '#FF9800' }
  };

  function getTileById(id) {
    for (const key in TILE_TYPES) {
      if (TILE_TYPES[key].id === id) return TILE_TYPES[key];
    }
    return TILE_TYPES.grass;
  }

  // Cart with polyline path and simple motion
  class Cart {
    constructor(id) {
      this.id = id;
      this.path = [];
      this.position = { x: 0, y: 0 };
      this.speed = 5; // tiles per second
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

  // World grid holding tiles and carts
  class World {
    constructor(cols, rows, tileSize) {
      this.cols = cols;
      this.rows = rows;
      this.tileSize = tileSize;
      this.grid = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) {
          row.push(TILE_TYPES.grass.id);
        }
        this.grid.push(row);
      }
      this.carts = [];
      this.nextCartId = 1;
    }
    paintTile(col, row, tileId) {
      if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return;
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
      this.grid = data.grid.map(row => row.slice());
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

  // Simple camera with pan and zoom
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

  // Renderer draws tiles, paths and carts onto a canvas
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
          const tile = getTileById(tileId);
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

  // Input handler for panning, zooming, painting and adding waypoints
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

  // Bootstrapping function: called after DOM is ready
  function init() {
    const TILE_SIZE = 32;
    const COLS = 50;
    const ROWS = 50;
    const canvas = document.getElementById('canvas');
    const world = new World(COLS, ROWS, TILE_SIZE);
    const renderer = new Renderer(canvas, world);
    const input = new InputHandler(canvas, renderer, world);
    // Build palette UI
    const paletteDiv = document.getElementById('palette');
    for (const key in TILE_TYPES) {
      const tile = TILE_TYPES[key];
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
    }
    // Select first tile by default
    if (paletteDiv.children.length > 0) {
      paletteDiv.children[0].click();
    }
    // Add cart button
    const addCartBtn = document.getElementById('addCart');
    addCartBtn.onclick = () => {
      const cart = world.addCart();
      world.carts.forEach(c => c.selected = false);
      cart.selected = true;
    };
    // Play/pause button
    const playPauseBtn = document.getElementById('playPause');
    let playing = false;
    playPauseBtn.onclick = () => {
      playing = !playing;
      playPauseBtn.textContent = playing ? 'Pause' : 'Play';
    };
    // Save button
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
    // Load button
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
    // Animation loop
    let lastTime = performance.now();
    function frame(time) {
      const dt = (time - lastTime) / 1000;
      lastTime = time;
      if (playing) {
        world.update(dt);
      }
      renderer.draw();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  // Run init when DOM content is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();