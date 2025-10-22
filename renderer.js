import { DiamondRenderer } from './renderer/diamondRenderer.js';

function parseHexColor(hex) {
  if (typeof hex !== 'string') {
    return [128, 128, 128];
  }
  const value = hex.trim();
  if (/^#([0-9a-f]{3})$/i.test(value)) {
    const [, short] = value.match(/^#([0-9a-f]{3})$/i);
    const r = parseInt(short[0] + short[0], 16);
    const g = parseInt(short[1] + short[1], 16);
    const b = parseInt(short[2] + short[2], 16);
    return [r, g, b];
  }
  if (/^#([0-9a-f]{6})$/i.test(value)) {
    const [, full] = value.match(/^#([0-9a-f]{6})$/i);
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return [r, g, b];
  }
  return [128, 128, 128];
}

function toHexChannel(channel) {
  const clamped = Math.max(0, Math.min(255, Math.round(channel)));
  const str = clamped.toString(16);
  return str.length === 1 ? `0${str}` : str;
}

function tintColor(hex, amount) {
  const [r, g, b] = parseHexColor(hex);
  const t = Math.max(-1, Math.min(1, amount));
  const adjust = (component) => {
    if (t >= 0) {
      return component + (255 - component) * t;
    }
    return component * (1 + t);
  };
  const nr = adjust(r);
  const ng = adjust(g);
  const nb = adjust(b);
  return `#${toHexChannel(nr)}${toHexChannel(ng)}${toHexChannel(nb)}`;
}

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
    this.layerVisibility = {
      terrain: true,
      vector: true,
      sprite: true,
      effect: true
    };
    this.interactionState = {
      hoveredNode: null,
      hoveredBuilding: null,
      selection: null,
      measurement: null,
      editSession: null
    };
    this._voxelDepthBuffer = new Map();
    this._zoomConstraints = { min: -4, max: 6 };
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
    this._updateCameraLimits();
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
    this._updateCameraLimits();
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
    this._drawInteractionOverlays(ctx, view);

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
    if (!this.isLayerVisible('terrain')) return;
    if (this.world?.voxels) {
      this._drawVoxelTerrain(ctx, view);
      return;
    }
    const nodes = this.world.getVisibleNodes(view, view.zoom) || [];
    this.diamondRenderer.renderTerrain(ctx, nodes, view, this.colors);
  }

  drawVectorPass(ctx, view) {
    if (!this.isLayerVisible('vector')) return;
    const layer = this.world.getVectorLayer();
    this.diamondRenderer.renderVectors(ctx, view, layer);
  }

  drawSpritePass(ctx, view) {
    if (!this.isLayerVisible('sprite') && !this.isLayerVisible('effect')) return;
    const spriteLayer = this.world.getSpriteLayer();
    const shouldRenderSprites = this.isLayerVisible('sprite');
    const shouldRenderEffects = this.isLayerVisible('effect');
    const carts = shouldRenderEffects ? this.world.carts : [];
    if (shouldRenderSprites) {
      this.diamondRenderer.renderSprites(ctx, view, spriteLayer, carts);
    } else if (shouldRenderEffects && Array.isArray(carts) && carts.length > 0) {
      this.diamondRenderer.renderSprites(ctx, view, null, carts);
    }
  }

  pickBuildingAt(px, py) {
    const worldPos = this.camera.screenToWorld(px, py);
    return this.diamondRenderer.pickBuildingAt(worldPos.x, worldPos.y);
  }

  pickProxyAt(px, py, filter) {
    const worldPos = this.camera.screenToWorld(px, py);
    return this.diamondRenderer.pickProxyAt(worldPos.x, worldPos.y, filter);
  }

  pickVoxelAt(px, py, options = {}) {
    if (!this.world?.voxels) {
      return null;
    }
    const worldPos = this.camera.screenToWorld(px, py);
    const x = Math.floor(worldPos.x);
    const y = Math.floor(worldPos.y);
    const key = `${x},${y}`;
    const depthEntry = this._voxelDepthBuffer.get(key);
    const column = this.world.getVoxelColumnAt(worldPos.x, worldPos.y);
    if (!column) {
      return null;
    }
    const height = depthEntry?.height ?? column.height ?? 0;
    const layer = options.layer || 'terrain';
    return {
      x,
      y,
      z: height,
      layer,
      column,
      world: worldPos
    };
  }

  setLayerVisibility(layer, visible) {
    if (!(layer in this.layerVisibility)) {
      return;
    }
    this.layerVisibility[layer] = Boolean(visible);
  }

  toggleLayer(layer) {
    if (!(layer in this.layerVisibility)) {
      return false;
    }
    this.layerVisibility[layer] = !this.layerVisibility[layer];
    return this.layerVisibility[layer];
  }

  isLayerVisible(layer) {
    if (!(layer in this.layerVisibility)) return true;
    return this.layerVisibility[layer] !== false;
  }

  setInteractionState(state) {
    const nextState = {
      ...this.interactionState,
      ...state
    };

    if (state && Object.prototype.hasOwnProperty.call(state, 'hoveredBuilding')) {
      const hover = state.hoveredBuilding;
      if (hover && hover.id) {
        const proxy = this.diamondRenderer.hitProxies.get(hover.id);
        if (proxy) {
          nextState.hoveredBuilding = {
            ...proxy,
            ...hover,
            metadata: {
              ...(proxy.metadata || null),
              ...(hover.metadata || null)
            }
          };
        } else {
          nextState.hoveredBuilding = hover;
        }
      } else {
        nextState.hoveredBuilding = hover || null;
      }
    }

    if (state && Object.prototype.hasOwnProperty.call(state, 'selection') && state.selection?.building?.id) {
      const selection = state.selection;
      const building = selection.building;
      const proxy = this.diamondRenderer.hitProxies.get(building.id);
      if (proxy) {
        nextState.selection = {
          ...selection,
          building: {
            ...proxy,
            ...building,
            metadata: {
              ...(proxy.metadata || null),
              ...(building.metadata || null)
            }
          }
        };
      } else {
        nextState.selection = selection;
      }
    }

    this.interactionState = nextState;
  }

  getZoomConstraints() {
    return { ...this._zoomConstraints };
  }

  _drawInteractionOverlays(ctx) {
    const state = this.interactionState || {};
    if (!state) return;
    ctx.save();
    ctx.lineWidth = 1 / this.camera.scale;
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.9)';
    ctx.fillStyle = 'rgba(255, 220, 80, 0.2)';

    if (state.voxelBrush?.center && state.voxelBrush?.brush?.radius) {
      ctx.save();
      ctx.strokeStyle = 'rgba(82, 141, 255, 0.75)';
      ctx.lineWidth = 2 / this.camera.scale;
      ctx.setLineDash(state.voxelBrush.stroke ? [1 / this.camera.scale, 4 / this.camera.scale] : []);
      ctx.beginPath();
      ctx.arc(state.voxelBrush.center.x, state.voxelBrush.center.y, state.voxelBrush.brush.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (state.voxelHover) {
      const size = 1;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 226, 138, 0.9)';
      ctx.lineWidth = 1 / this.camera.scale;
      ctx.strokeRect(state.voxelHover.x, state.voxelHover.y, size, size);
      ctx.restore();
    }

    if (state.hoveredNode?.bounds) {
      const { minX, minY, maxX, maxY } = state.hoveredNode.bounds;
      const width = maxX - minX;
      const height = maxY - minY;
      ctx.strokeRect(minX, minY, width, height);
    }

    if (state.hoveredBuilding?.path instanceof Path2D) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fill(state.hoveredBuilding.path);
      ctx.restore();
      ctx.stroke(state.hoveredBuilding.path);
    }

    if (state.selection?.bounds) {
      const { minX, minY, maxX, maxY } = state.selection.bounds;
      const width = maxX - minX;
      const height = maxY - minY;
      ctx.save();
      ctx.strokeStyle = 'rgba(82, 141, 255, 0.9)';
      ctx.lineWidth = 2 / this.camera.scale;
      ctx.strokeRect(minX, minY, width, height);
      ctx.restore();
    }

    if (state.measurement?.start && state.measurement?.end) {
      ctx.save();
      ctx.strokeStyle = 'rgba(82, 141, 255, 0.85)';
      ctx.lineWidth = 2 / this.camera.scale;
      ctx.beginPath();
      ctx.moveTo(state.measurement.start.x, state.measurement.start.y);
      ctx.lineTo(state.measurement.end.x, state.measurement.end.y);
      ctx.stroke();
      ctx.restore();
    }

    if (state.editSession?.vertices?.length) {
      const edit = state.editSession;
      const vertices = edit.vertices || [];
      ctx.save();
      ctx.lineWidth = 2 / this.camera.scale;
      ctx.strokeStyle = 'rgba(82, 255, 141, 0.9)';
      ctx.fillStyle = 'rgba(82, 255, 141, 0.18)';
      ctx.beginPath();
      ctx.moveTo(vertices[0].x, vertices[0].y);
      for (let i = 1; i < vertices.length; i++) {
        ctx.lineTo(vertices[i].x, vertices[i].y);
      }
      if (edit.preview) {
        ctx.lineTo(edit.preview.x, edit.preview.y);
      }
      if (edit.geometry === 'polygon' && vertices.length >= 3) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();
      ctx.restore();

      ctx.save();
      const handleRadius = 5 / this.camera.scale;
      for (let i = 0; i < vertices.length; i++) {
        const vertex = vertices[i];
        ctx.beginPath();
        ctx.arc(vertex.x, vertex.y, handleRadius, 0, Math.PI * 2);
        const isActive = i === edit.activeIndex;
        const isHover = !isActive && edit.hoverIndex != null && edit.activeIndex == null && i === edit.hoverIndex;
        const isClosable = edit.closable && i === 0 && edit.geometry === 'polygon';
        ctx.fillStyle = isActive
          ? '#ffcc33'
          : isHover
            ? 'rgba(255, 226, 138, 0.9)'
            : isClosable
              ? 'rgba(255, 255, 255, 0.9)'
              : 'rgba(255, 255, 255, 0.85)';
        ctx.strokeStyle = isActive || isHover ? 'rgba(82, 141, 255, 0.95)' : 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 1 / this.camera.scale;
        ctx.fill();
        ctx.stroke();
      }
      if (edit.preview) {
        ctx.beginPath();
        ctx.arc(edit.preview.x, edit.preview.y, handleRadius * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(82, 255, 141, 0.6)';
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  _drawVoxelTerrain(ctx, view) {
    const bounds = {
      minX: Math.floor(view.left) - 1,
      maxX: Math.ceil(view.right) + 1,
      minY: Math.floor(view.top) - 1,
      maxY: Math.ceil(view.bottom) + 1
    };
    this._voxelDepthBuffer.clear();
    const palette = this.world?.palette;
    const materialColor = (material) => {
      if (!material) {
        return '#808080';
      }
      if (palette?.materials?.[material]?.color) {
        return palette.materials[material].color;
      }
      if (palette?.colors?.[material]) {
        return palette.colors[material];
      }
      return material;
    };
    this.world.forEachVoxelColumn(bounds, (column) => {
      if (!column) return;
      const baseColor = materialColor(column.material);
      const shade = column.height / (this.world.voxels?.maxHeight || 1);
      const color = tintColor(baseColor, shade * 0.35 - 0.15);
      ctx.fillStyle = color;
      ctx.fillRect(column.x, column.y, 1, 1);
      this._voxelDepthBuffer.set(`${column.x},${column.y}`, { height: column.height });
      if (column.prop && column.prop.id) {
        ctx.fillStyle = tintColor(baseColor, 0.5);
        ctx.fillRect(column.x + 0.2, column.y + 0.2, 0.6, 0.6);
      }
    });
  }

  _computeMaxZoomNormalized() {
    const thresholds = this.world?.terrain?.zoomThresholds;
    if (!Array.isArray(thresholds) || thresholds.length === 0) {
      return 6;
    }
    const finite = thresholds.filter((value) => Number.isFinite(value));
    if (finite.length === 0) {
      return 6;
    }
    const maxThreshold = finite[finite.length - 1];
    return maxThreshold + 0.75;
  }

  _updateCameraLimits() {
    const base = this.camera.baseScale > 0 ? this.camera.baseScale : 1;
    const minScale = base * 0.05;
    const maxNormalized = this._computeMaxZoomNormalized();
    const maxScale = base * Math.pow(2, maxNormalized);
    this.camera.setScaleLimits(minScale, maxScale);
    const minNormalized = Math.log2(this.camera.minScale / base);
    this._zoomConstraints = {
      min: Number.isFinite(minNormalized) ? minNormalized : -4,
      max: maxNormalized
    };
  }
}
