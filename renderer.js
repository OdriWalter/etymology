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