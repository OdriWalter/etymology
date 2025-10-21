// renderer.js - draws the world and carts onto the canvas

export class Camera {
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

export class Renderer {
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
    // Clear the visible world region
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