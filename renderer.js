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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
    this._drawTerrain(ctx, view);
    this._drawVectorFeatures(ctx, view);
    this._drawCarts(ctx, view);

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

  _drawTerrain(ctx, view) {
    const nodes = this.world.getVisibleNodes(view, view.zoom) || [];
    for (const node of nodes) {
      this._drawNode(ctx, node, view.zoom);
    }
  }

  _drawNode(ctx, node, zoom) {
    const color = this._resolveNodeColor(node);
    const { minX, minY, maxX, maxY } = node.bounds;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const halfWidth = (maxX - minX) / 2;
    const halfHeight = (maxY - minY) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(centerX, minY);
    ctx.lineTo(maxX, centerY);
    ctx.lineTo(centerX, maxY);
    ctx.lineTo(minX, centerY);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    const strokeAlpha = clamp(0.15 + zoom * 0.08, 0.15, 0.6);
    ctx.strokeStyle = `rgba(0,0,0,${strokeAlpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(0.5, Math.min(2.0, (Math.max(halfWidth, halfHeight) * 0.1)));
    ctx.stroke();
    ctx.restore();
  }

  _resolveNodeColor(node) {
    const tileId = node?.payloadRefs?.terrain;
    const descriptor = this.world.getTileDescriptor(tileId);
    if (descriptor?.color) {
      return descriptor.color;
    }
    return '#b9d87b';
  }

  _drawVectorFeatures(ctx, view) {
    const layer = this.world.getVectorLayer();
    if (!layer || !Array.isArray(layer.features)) return;
    for (const feature of layer.features) {
      if (!feature) continue;
      if (feature.zoomMin != null && view.zoom < feature.zoomMin) continue;
      if (feature.zoomMax != null && view.zoom > feature.zoomMax) continue;
      if (feature.poly && feature.poly.length >= 3) {
        ctx.save();
        ctx.beginPath();
        feature.poly.forEach((p, index) => {
          if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        if (feature.style?.fillStyle) {
          ctx.fillStyle = feature.style.fillStyle;
          ctx.fill();
        }
        ctx.strokeStyle = feature.style?.strokeStyle || this.colors.terrainStroke;
        ctx.lineWidth = feature.style?.lineWidth || 1 / this.camera.scale;
        ctx.stroke();
        ctx.restore();
        continue;
      }
      const points = feature.line;
      if (!points || points.length < 2) continue;
      ctx.save();
      ctx.beginPath();
      points.forEach((p, index) => {
        if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = feature.style?.strokeStyle || this.colors.terrainStroke;
      ctx.lineWidth = feature.style?.lineWidth || 1.5 / this.camera.scale;
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawCarts(ctx, view) {
    if (!Array.isArray(this.world.carts)) return;
    const baseRadius = Math.max(this.world.width, this.world.height) * 0.01;
    for (const cart of this.world.carts) {
      if (!cart) continue;
      const radius = cart.selected ? baseRadius * 1.2 : baseRadius;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cart.position.x, cart.position.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = cart.selected ? '#ffcc33' : '#333333';
      ctx.fill();
      if (cart.path.length >= 2 && (!cart.pathZoomMin || view.zoom >= cart.pathZoomMin)) {
        ctx.beginPath();
        cart.path.forEach((p, index) => {
          if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.strokeStyle = cart.pathColor || 'rgba(0,0,0,0.6)';
        ctx.lineWidth = (cart.pathWidth || radius * 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}
