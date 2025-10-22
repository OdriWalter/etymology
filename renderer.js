import { DiamondRenderer } from './renderer/diamondRenderer.js';

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.scale = 1;
    this.baseScale = 1;
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
    this.scale = Math.max(this.minScale, Math.min(this.scale, this.maxScale));
  }

  getNormalizedZoom() {
    const base = this.baseScale > 0 ? this.baseScale : 1;
    const ratio = Math.max(this.scale / base, 1e-6);
    return Math.log2(ratio);
  }
}

function defaultPaletteColors(palette) {
  return {
    ocean: palette?.colors?.oceanMid || '#2d7ab6',
    terrainStroke: palette?.colors?.borderDark || '#4a2e23',
    background: palette?.colors?.paperLight || '#f1d4a1',
    text: palette?.colors?.borderDark || '#2d2d2d'
  };
}

export class Renderer {
  constructor(canvas, world, glyphs) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.glyphs = glyphs;
    this.camera = new Camera();
    this._cameraFitted = false;
    this.colors = defaultPaletteColors(world?.palette);
    this.diamondRenderer = new DiamondRenderer(world, this.camera, glyphs);
    this.resize(true);
    window.addEventListener('resize', () => this.resize());
  }

  resize(forceFit = false) {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.diamondRenderer.setDevicePixelRatio(dpr);
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
    this.camera.baseScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const minScale = this.camera.baseScale * 0.05;
    const maxScale = this.camera.baseScale * 64;
    this.camera.setScaleLimits(minScale, maxScale);
    const offsetX = (this.canvas.width - worldWidth * this.camera.scale) / 2;
    const offsetY = (this.canvas.height - worldHeight * this.camera.scale) / 2;
    this.camera.x = offsetX - this.world.bounds.minX * this.camera.scale;
    this.camera.y = offsetY - this.world.bounds.minY * this.camera.scale;
    this._cameraFitted = true;
  }

  draw() {
    const ctx = this.ctx;
    const view = this._computeViewBounds();
    this.colors = defaultPaletteColors(this.world?.palette);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colors.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.setTransform(this.camera.scale, 0, 0, this.camera.scale, this.camera.x, this.camera.y);

    this._drawOcean(ctx);
    this.drawTerrainPass(ctx, view);
    this.drawVectorPass(ctx, view);
    this.drawSpritePass(ctx, view);

    ctx.restore();
  }

  _computeViewBounds() {
    const left = -this.camera.x / this.camera.scale;
    const top = -this.camera.y / this.camera.scale;
    const width = this.canvas.width / this.camera.scale;
    const height = this.canvas.height / this.camera.scale;
    const zoom = this.camera.getNormalizedZoom();
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      zoom
    };
  }

  _drawOcean(ctx) {
    const bounds = this.world.bounds;
    ctx.fillStyle = this.colors.ocean;
    ctx.fillRect(bounds.minX, bounds.minY, this.world.width, this.world.height);
  }

  drawTerrainPass(ctx, view) {
    const nodes = this.world.getVisibleNodes(view, view.zoom) || [];
    this.diamondRenderer.renderTerrain(ctx, nodes, view, this.colors);
  }

  drawVectorPass(ctx, view) {
    const layer = this.world.getVectorLayer();
    this.diamondRenderer.renderVectors(ctx, view, layer);
  }

  drawSpritePass(ctx, view) {
    const spriteLayer = this.world.getSpriteLayer();
    this.diamondRenderer.renderSprites(ctx, view, spriteLayer, this.world.carts);
  }

  pickBuildingAt(px, py) {
    const worldPos = this.camera.screenToWorld(px, py);
    return this.diamondRenderer.pickBuildingAt(worldPos.x, worldPos.y);
  }
}
