// renderer.js - draws the world and carts onto the canvas

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
    if (this.scale < this.minScale) {
      this.scale = this.minScale;
    }
    if (this.scale > this.maxScale) {
      this.scale = this.maxScale;
    }
  }

  getNormalizedZoom() {
    const base = this.baseScale > 0 ? this.baseScale : 1;
    const ratio = Math.max(this.scale / base, 1e-6);
    return Math.log2(ratio);
  }
}

function zoomInRange(target, zoom) {
  if (!target) return true;
  const min = Number.isFinite(target.zoomMin) ? target.zoomMin : 0;
  const maxValue = target.zoomMax == null ? Infinity : target.zoomMax;
  return zoom >= min && zoom <= maxValue;
}

function getTimeSeconds() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

const DEFAULT_COLORS = {
  paperLight: '#f1d4a1',
  paperMid: '#e6c48a',
  paperDot: '#d9b67c',
  oceanDeep: '#1b5d8f',
  oceanMid: '#2d7ab6',
  shoreGlow: '#bff4ff',
  landBase: '#9bbf60',
  landLight: '#b9d87b',
  forestDark: '#1f6728',
  cliffTan: '#8a6e4a',
  road: '#a07a52',
  borderDark: '#4a2e23',
  cityRed: '#c24b3a',
  shadow: 'rgba(0,0,0,0.28)'
};

const LOD = {
  treesMinZoom: 1.2,
  cityMinZoom: 1.1,
  roadMinZoom: 0.9,
  riverMinZoom: 1.0,
  coastGlowMinZoom: 0.6,
  labelsMinZoom: 1.0
};

const BAYER_MATRIX_4 = [
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5
];

function createMulberry32(seed) {
  let t = seed >>> 0;
  return function mulberry32() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function parseCssColor(color) {
  if (!color) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const expand = (value) => value.length === 1 ? value + value : value;
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(expand(hex[0]), 16);
      const g = parseInt(expand(hex[1]), 16);
      const b = parseInt(expand(hex[2]), 16);
      const a = hex.length === 4 ? parseInt(expand(hex[3]), 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }
  const match = color.match(/rgba?\s*\(([^)]+)\)/i);
  if (match) {
    const parts = match[1].split(',').map(part => Number(part.trim()));
    const [r = 0, g = 0, b = 0, a = 1] = parts;
    return { r, g, b, a: parts.length >= 4 ? a : 1 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function rgbaString(color, alphaOverride) {
  const parsed = parseCssColor(color);
  const alpha = alphaOverride != null ? alphaOverride : parsed.a;
  return `rgba(${parsed.r},${parsed.g},${parsed.b},${alpha})`;
}

export class Renderer {
  constructor(canvas, world, glyphs) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.glyphs = glyphs;
    this.camera = new Camera();
    this._cameraFitted = false;
    this.spriteBudget = 200;
    this.effectShaders = {
      cloudNoise: (ctx, agent, view, time) => this.renderCloudNoise(ctx, agent, view, time),
      treeSway: (ctx, agent, view, time) => this.renderTreeSway(ctx, agent, view, time)
    };
    this.colors = { ...DEFAULT_COLORS, ...(world?.palette?.colors || {}) };
    this._colorsKey = null;
    this._lastPaletteRef = world?.palette || null;
    this._paperPattern = null;
    this._paperPatternSeed = world?.seed ?? 0;
    this._paperPatternSize = 128;
    this._treeCache = null;
    this._treeCacheKey = null;
    this._cityFontFamily = '"Trebuchet MS", "Segoe UI", sans-serif';
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
    this._paperPattern = null;
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
    const scale = Math.max(scaleX, scaleY);
    this.camera.scale = scale;
    this.camera.baseScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const minScale = Math.max(scale * 0.05, 1e-4);
    const maxScale = Math.max(scale * 40, minScale);
    this.camera.setScaleLimits(minScale, maxScale);
    const offsetX = -this.world.bounds.minX * scale;
    const offsetY = -this.world.bounds.minY * scale;
    this.camera.x = (this.canvas.width - worldWidth * scale) / 2 + offsetX;
    this.camera.y = (this.canvas.height - worldHeight * scale) / 2 + offsetY;
    this._cameraFitted = true;
  }

  draw() {
    const ctx = this.ctx;
    const view = this._computeViewBounds();
    this._refreshPaletteColors();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.paperBackground(ctx);
    ctx.save();
    ctx.setTransform(this.camera.scale, 0, 0, this.camera.scale, this.camera.x, this.camera.y);
    this.oceanGradient(ctx, view);
    this.drawTerrainPass(ctx, view);
    this.drawVectorPass(ctx, view);
    this.drawSpritePass(ctx, view);
    this.drawEffectPass(ctx, view);
    ctx.restore();
  }

  _computeViewBounds() {
    const left = -this.camera.x / this.camera.scale;
    const top = -this.camera.y / this.camera.scale;
    const width = this.canvas.width / this.camera.scale;
    const height = this.canvas.height / this.camera.scale;
    const scale = this.camera.scale;
    const zoom = typeof this.camera.getNormalizedZoom === 'function'
      ? this.camera.getNormalizedZoom()
      : Math.log2(Math.max(scale / (this.camera.baseScale > 0 ? this.camera.baseScale : 1), 1e-6));
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      zoom,
      scale,
      time: getTimeSeconds()
    };
  }

  _refreshPaletteColors() {
    const palette = this.world?.palette;
    const merged = { ...DEFAULT_COLORS, ...(palette?.colors || {}) };
    const key = Object.entries(merged).map(([k, v]) => `${k}:${v}`).join('|');
    if (key !== this._colorsKey) {
      this.colors = merged;
      this._colorsKey = key;
      this._paperPattern = null;
    }
  }

  _ensurePaperPattern() {
    if (this._paperPattern) {
      return;
    }
    const size = this._paperPatternSize;
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const tctx = tile.getContext('2d');
    const imageData = tctx.createImageData(size, size);
    const dotColor = parseCssColor(this.colors.paperDot);
    const midColor = parseCssColor(this.colors.paperMid);
    const rng = createMulberry32((this._paperPatternSeed >>> 0) + 0x9e3779b9);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4;
        const index = (BAYER_MATRIX_4[(x & 3) + ((y & 3) << 2)] + rng() * 16) / 32;
        const weight = Math.max(0, Math.min(1, index * 0.6));
        const alpha = weight * 0.45;
        imageData.data[offset] = Math.round(midColor.r * (1 - weight) + dotColor.r * weight);
        imageData.data[offset + 1] = Math.round(midColor.g * (1 - weight) + dotColor.g * weight);
        imageData.data[offset + 2] = Math.round(midColor.b * (1 - weight) + dotColor.b * weight);
        imageData.data[offset + 3] = Math.round(255 * alpha);
      }
    }
    tctx.putImageData(imageData, 0, 0);
    this._paperPattern = this.ctx.createPattern(tile, 'repeat');
  }

  paperBackground(ctx) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colors.paperLight;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this._ensurePaperPattern();
    if (this._paperPattern) {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = this._paperPattern;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.restore();
  }

  oceanGradient(ctx, view) {
    const bounds = this.world.bounds;
    const expansion = Math.max(view.width, view.height);
    const gradient = ctx.createLinearGradient(
      bounds.minX,
      bounds.minY - expansion * 0.25,
      bounds.minX,
      bounds.maxY + expansion * 0.25
    );
    gradient.addColorStop(0, this.colors.oceanDeep);
    gradient.addColorStop(1, this.colors.oceanMid);
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(
      bounds.minX - expansion,
      bounds.minY - expansion,
      this.world.width + expansion * 2,
      this.world.height + expansion * 2
    );
    ctx.restore();
  }

  drawTerrainPass(ctx, view) {
    const layer = this.world.getTerrainLayer();
    if (!zoomInRange(layer, view.zoom)) return;
    const grid = layer.grid;
    if (!grid) return;
    const cellWidth = this.world.cellWidth;
    const cellHeight = this.world.cellHeight;
    if (!isFinite(cellWidth) || !isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return;
    const left = view.left;
    const top = view.top;
    const visibleWidth = view.width;
    const visibleHeight = view.height;
    const colStart = Math.max(0, Math.floor((left - this.world.bounds.minX) / cellWidth));
    const colEnd = Math.min(
      this.world.gridCols - 1,
      Math.floor(((left + visibleWidth) - this.world.bounds.minX - 1e-9) / cellWidth)
    );
    const rowStart = Math.max(0, Math.floor((top - this.world.bounds.minY) / cellHeight));
    const rowEnd = Math.min(
      this.world.gridRows - 1,
      Math.floor(((top + visibleHeight) - this.world.bounds.minY - 1e-9) / cellHeight)
    );
    if (colEnd < colStart || rowEnd < rowStart) return;

    const visibleCols = colEnd - colStart + 1;
    const visibleRows = rowEnd - rowStart + 1;
    const waterMask = Array.from({ length: visibleRows }, () => new Array(visibleCols).fill(false));
    const landPath = new Path2D();
    const coastlineEdges = [];

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const tileId = grid[row][col];
        const tile = this.world.getTileDescriptor(tileId);
        const category = this._categoriseTile(tile);
        const x = this.world.bounds.minX + col * cellWidth;
        const y = this.world.bounds.minY + row * cellHeight;
        const maskRow = row - rowStart;
        const maskCol = col - colStart;
        if (category === 'water') {
          waterMask[maskRow][maskCol] = true;
          continue;
        }
        landPath.rect(x, y, cellWidth, cellHeight);
        this._collectCoastEdges(coastlineEdges, row, col, x, y, cellWidth, cellHeight);
      }
    }

    this._fillLand(ctx, landPath, view);

    if (view.zoom >= LOD.coastGlowMinZoom) {
      const waterDistance = this.distanceField(waterMask, cellWidth, cellHeight);
      this._drawCliffs(ctx, coastlineEdges, view);
      this._drawCoastOutline(ctx, coastlineEdges, view);
      this._drawCoastGlow(ctx, waterMask, waterDistance, colStart, rowStart, cellWidth, cellHeight, view);
    } else {
      this._drawCoastOutline(ctx, coastlineEdges, view);
    }

    if (view.zoom >= LOD.treesMinZoom) {
      this._drawTrees(ctx, view);
    }
  }

  _categoriseTile(tile) {
    if (!tile) return 'land';
    if (tile.category) return tile.category;
    const key = typeof tile.key === 'string' ? tile.key.toLowerCase() : '';
    if (key.includes('water')) return 'water';
    if (key.includes('forest')) return 'forest';
    if (key.includes('road')) return 'road';
    return 'land';
  }

  _tileCategoryAt(row, col) {
    if (row < 0 || row >= this.world.gridRows || col < 0 || col >= this.world.gridCols) {
      return 'water';
    }
    const tileId = this.world.grid[row][col];
    const tile = this.world.getTileDescriptor(tileId);
    return this._categoriseTile(tile);
  }

  _collectCoastEdges(edges, row, col, x, y, cellWidth, cellHeight) {
    const neighbors = [
      { dx: 0, dy: -1, x1: x, y1: y, x2: x + cellWidth, y2: y, nx: 0, ny: 1 },
      { dx: 0, dy: 1, x1: x, y1: y + cellHeight, x2: x + cellWidth, y2: y + cellHeight, nx: 0, ny: -1 },
      { dx: -1, dy: 0, x1: x, y1: y, x2: x, y2: y + cellHeight, nx: 1, ny: 0 },
      { dx: 1, dy: 0, x1: x + cellWidth, y1: y, x2: x + cellWidth, y2: y + cellHeight, nx: -1, ny: 0 }
    ];
    for (const neighbor of neighbors) {
      const category = this._tileCategoryAt(row + neighbor.dy, col + neighbor.dx);
      if (category === 'water') {
        edges.push({
          x1: neighbor.x1,
          y1: neighbor.y1,
          x2: neighbor.x2,
          y2: neighbor.y2,
          nx: neighbor.nx,
          ny: neighbor.ny
        });
      }
    }
  }

  _fillLand(ctx, landPath, view) {
    if (!landPath) return;
    ctx.save();
    const offset = 2 / view.scale;
    ctx.shadowColor = this.colors.shadow;
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = offset;
    ctx.shadowOffsetY = offset;
    ctx.fillStyle = this.colors.landBase;
    ctx.fill(landPath);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = this.colors.landBase;
    ctx.fill(landPath);
    ctx.restore();

    ctx.save();
    ctx.clip(landPath);
    const gradient = ctx.createLinearGradient(
      view.left,
      view.top,
      view.left + view.width * 0.6,
      view.top + view.height * 0.4
    );
    gradient.addColorStop(0, rgbaString(this.colors.landLight, 0.55));
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gradient;
    ctx.fillRect(view.left, view.top, view.width, view.height);
    ctx.restore();
  }

  _drawCliffs(ctx, edges, view) {
    if (!edges.length) return;
    const widthWorld = Math.max(2.5, 4.0) / view.scale;
    ctx.save();
    ctx.fillStyle = this.colors.cliffTan;
    for (const edge of edges) {
      const nx = edge.nx * widthWorld;
      const ny = edge.ny * widthWorld;
      ctx.beginPath();
      ctx.moveTo(edge.x1, edge.y1);
      ctx.lineTo(edge.x2, edge.y2);
      ctx.lineTo(edge.x2 - nx, edge.y2 - ny);
      ctx.lineTo(edge.x1 - nx, edge.y1 - ny);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  _drawCoastOutline(ctx, edges, view) {
    if (!edges.length) return;
    const path = new Path2D();
    for (const edge of edges) {
      path.moveTo(edge.x1, edge.y1);
      path.lineTo(edge.x2, edge.y2);
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.colors.borderDark;
    ctx.lineWidth = 2.2 / view.scale;
    ctx.stroke(path);
    ctx.restore();
  }

  _drawCoastGlow(ctx, waterMask, waterDistance, colStart, rowStart, cellWidth, cellHeight, view) {
    if (!waterMask.length || !waterDistance.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = this.colors.shoreGlow;
    for (let row = 0; row < waterMask.length; row++) {
      for (let col = 0; col < waterMask[row].length; col++) {
        if (!waterMask[row][col]) continue;
        const distWorld = waterDistance[row][col];
        if (!Number.isFinite(distWorld) || distWorld <= 0) continue;
        const distPx = distWorld * view.scale;
        if (distPx > 6) continue;
        const alpha = Math.exp(-distPx / 3);
        if (alpha < 0.02) continue;
        ctx.globalAlpha = alpha * 0.8;
        const x = this.world.bounds.minX + (col + colStart) * cellWidth;
        const y = this.world.bounds.minY + (row + rowStart) * cellHeight;
        ctx.fillRect(x, y, cellWidth, cellHeight);
      }
    }
    ctx.restore();
  }

  distanceField(mask, cellWidth, cellHeight, maxTiles = 6) {
    const rows = mask.length;
    const cols = rows ? mask[0].length : 0;
    if (!rows || !cols) return [];
    const maxDistance = Math.hypot(cellWidth * maxTiles, cellHeight * maxTiles);
    const result = Array.from({ length: rows }, () => new Array(cols).fill(maxDistance));
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!mask[y][x]) {
          result[y][x] = 0;
          continue;
        }
        let best = maxDistance;
        for (let dy = -maxTiles; dy <= maxTiles; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= rows) {
            best = 0;
            break;
          }
          for (let dx = -maxTiles; dx <= maxTiles; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= cols) {
              best = 0;
              break;
            }
            if (!mask[ny][nx]) {
              const dist = Math.hypot(dx * cellWidth, dy * cellHeight);
              if (dist < best) {
                best = dist;
              }
              if (best === 0) break;
            }
          }
          if (best === 0) break;
        }
        result[y][x] = best;
      }
    }
    return result;
  }

  _buildTreeCache() {
    const baseScale = this.camera.baseScale || this.camera.scale || 1;
    const key = `${this.world.seed}:${this.world.gridCols}:${this.world.gridRows}:${this._colorsKey}`;
    if (this._treeCache && this._treeCache.key === key) {
      return this._treeCache.points;
    }
    const rng = createMulberry32((this.world.seed >>> 0) ^ 0x51ed2705);
    const points = [];
    const spacingMin = 10 / baseScale;
    const spacingMax = 16 / baseScale;
    const cellWidth = this.world.cellWidth;
    const cellHeight = this.world.cellHeight;
    for (let row = 0; row < this.world.gridRows; row++) {
      for (let col = 0; col < this.world.gridCols; col++) {
        const tileId = this.world.grid[row][col];
        const tile = this.world.getTileDescriptor(tileId);
        if (this._categoriseTile(tile) !== 'forest') continue;
        const attempts = 3;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const pxRadius = 10 + rng() * 6;
          const spacing = spacingMin + rng() * (spacingMax - spacingMin);
          const x = this.world.bounds.minX + col * cellWidth + rng() * cellWidth;
          const y = this.world.bounds.minY + row * cellHeight + rng() * cellHeight;
          let overlaps = false;
          for (const other of points) {
            const dx = other.x - x;
            const dy = other.y - y;
            const distance = Math.hypot(dx, dy);
            if (distance < (other.spacing + spacing) * 0.5) {
              overlaps = true;
              break;
            }
          }
          if (!overlaps) {
            points.push({
              x,
              y,
              sizePx: pxRadius * 1.7,
              spacing,
              phase: rng() * Math.PI * 2
            });
            break;
          }
        }
      }
    }
    this._treeCache = { key, points };
    return points;
  }

  _drawTrees(ctx, view) {
    const glyph = this.glyphs?.byKey?.tree7x7;
    if (!glyph?.canvas) return;
    const points = this._buildTreeCache();
    if (!points.length) return;
    const padding = Math.max(this.world.cellWidth, this.world.cellHeight) * 2;
    const minX = view.left - padding;
    const maxX = view.right + padding;
    const minY = view.top - padding;
    const maxY = view.bottom + padding;
    const time = view.time;
    for (const point of points) {
      if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) continue;
      const pxSize = point.sizePx || 18;
      const widthWorld = pxSize / view.scale;
      const heightWorld = (pxSize * (glyph.height / glyph.width)) / view.scale;
      const sway = Math.sin(time * 0.35 + point.phase) * (0.6 / view.scale);
      const centerX = point.x + sway;
      const baseY = point.y;
      const drawX = centerX - widthWorld * 0.5;
      const drawY = baseY - heightWorld * 0.9;
      const shadowWidth = (pxSize * 0.8) / view.scale;
      const shadowHeight = shadowWidth * 0.45;
      const shadowOffsetX = 2.2 / view.scale;
      const shadowOffsetY = 3.2 / view.scale;
      ctx.save();
      ctx.fillStyle = this.colors.shadow;
      ctx.globalAlpha = 0.26;
      ctx.beginPath();
      ctx.ellipse(centerX + shadowOffsetX, baseY + shadowOffsetY, shadowWidth * 0.5, shadowHeight * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.drawImage(glyph.canvas, drawX, drawY, widthWorld, heightWorld);
    }
  }

  _drawCityShadow(ctx, command, view) {
    const offsetX = 2 / view.scale;
    const offsetY = 2 / view.scale;
    ctx.save();
    ctx.fillStyle = this.colors.shadow;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(command.x + offsetX, command.y + offsetY, command.width, command.height);
    ctx.restore();
  }

  _drawCartOverlay(ctx, command, view) {
    const ellipseX = command.centerX + 1.2 / view.scale;
    const ellipseY = command.y + command.height + 1.4 / view.scale;
    const radiusX = (command.width * 0.45);
    const radiusY = radiusX * 0.45;
    ctx.save();
    ctx.fillStyle = this.colors.shadow;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.ellipse(ellipseX, ellipseY, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = rgbaString('#ffffff', 0.6);
    ctx.lineWidth = Math.max(0.8 / view.scale, 0.35 / view.scale);
    ctx.strokeRect(command.x, command.y, command.width, command.height);
    ctx.restore();
  }

  _drawCityLabel(ctx, command, view) {
    const label = command.placement?.label || command.placement?.name;
    if (!label) return;
    const offsetWorld = (command.height * 0.6) + (6 / view.scale);
    const screen = this.camera.worldToScreen(command.centerX, command.y - offsetWorld);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const fontSize = 12 + Math.max(0, view.zoom - LOD.labelsMinZoom) * 3;
    ctx.font = `600 ${fontSize}px ${this._cityFontFamily}`;
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgbaString(this.colors.paperLight, 0.85);
    ctx.lineWidth = 4;
    ctx.strokeText(label, screen.x, screen.y);
    ctx.fillStyle = this.colors.borderDark;
    ctx.fillText(label, screen.x, screen.y);
    ctx.restore();
  }

  drawVectorPass(ctx, view) {
    const layer = this.world.getVectorLayer();
    if (!zoomInRange(layer, view.zoom)) return;
    for (const feature of layer.features) {
      if (!feature) continue;
      if (!zoomInRange(feature, view.zoom)) continue;
      const category = this._resolveVectorCategory(feature);
      if (category === 'road') {
        if (view.zoom >= LOD.roadMinZoom) {
          this._drawRoad(ctx, feature, view);
        }
        continue;
      }
      if (category === 'river') {
        if (view.zoom >= LOD.riverMinZoom) {
          this._drawRiver(ctx, feature, view);
        }
        continue;
      }
      const style = feature.style || {};
      const strokeStyle = style.strokeStyle || rgbaString(this.colors.borderDark, 0.4);
      const lineWidth = Number.isFinite(style.lineWidth) ? style.lineWidth : (1.5 / view.scale);
      const fillStyle = style.fillStyle;
      if (feature.poly && feature.poly.length >= 3) {
        ctx.save();
        ctx.beginPath();
        feature.poly.forEach((p, index) => {
          if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        if (fillStyle) {
          ctx.fillStyle = fillStyle;
          ctx.fill();
        }
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = strokeStyle;
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
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = strokeStyle;
      if (style.lineDash && Array.isArray(style.lineDash)) {
        ctx.setLineDash(style.lineDash);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  _resolveVectorCategory(feature) {
    const label = (feature.category || feature.kind || feature.type || '').toString().toLowerCase();
    if (label.includes('road')) return 'road';
    if (label.includes('river') || label.includes('water')) return 'river';
    if (typeof feature.id === 'string') {
      const id = feature.id.toLowerCase();
      if (id.includes('road')) return 'road';
      if (id.includes('river')) return 'river';
    }
    const stroke = feature.style?.strokeStyle;
    if (typeof stroke === 'string') {
      const normalised = stroke.toLowerCase();
      if (normalised === (this.colors.road || '').toLowerCase()) return 'road';
      if (normalised === (this.colors.shoreGlow || '').toLowerCase()) return 'river';
    }
    return null;
  }

  _buildSmoothPath(points) {
    const path = new Path2D();
    if (!points || points.length === 0) {
      return path;
    }
    if (points.length === 1) {
      path.moveTo(points[0].x, points[0].y);
      return path;
    }
    path.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    return path;
  }

  _drawRoad(ctx, feature, view) {
    const points = feature.line || feature.poly;
    if (!points || points.length < 2) return;
    const path = this._buildSmoothPath(points);
    const zoomBoost = Math.max(0, view.zoom - LOD.roadMinZoom);
    const basePx = 3.4 + zoomBoost * 1.5;
    const outlinePx = basePx + 2;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.colors.shadow;
    ctx.lineWidth = outlinePx / view.scale;
    ctx.globalAlpha = 0.6;
    ctx.stroke(path);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.colors.road;
    ctx.lineWidth = basePx / view.scale;
    ctx.stroke(path);
    ctx.restore();
  }

  _drawRiver(ctx, feature, view) {
    const points = feature.line || feature.poly;
    if (!points || points.length < 2) return;
    const path = this._buildSmoothPath(points);
    const zoomBoost = Math.max(0, view.zoom - LOD.riverMinZoom);
    const basePx = 2 + zoomBoost * 0.8;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgbaString(this.colors.shoreGlow, 0.55);
    ctx.lineWidth = (basePx + 2) / view.scale;
    ctx.stroke(path);
    ctx.strokeStyle = this.colors.oceanMid;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = basePx / view.scale;
    ctx.stroke(path);
    ctx.restore();
  }

  _resolveSpriteScale(placement, glyph) {
    const baseWidth = this.world.cellWidth;
    const baseHeight = this.world.cellHeight;
    const defaultScaleX = baseWidth / glyph.width;
    const defaultScaleY = baseHeight / glyph.height;
    const scale = placement.scale;
    if (scale == null) {
      return { x: defaultScaleX, y: defaultScaleY };
    }
    if (typeof scale === 'number') {
      return { x: scale, y: scale };
    }
    const sx = Number.isFinite(scale.x) ? scale.x : defaultScaleX;
    const sy = Number.isFinite(scale.y) ? scale.y : defaultScaleY;
    return { x: sx, y: sy };
  }

  _resolveAnchor(placement) {
    const anchor = placement.anchor;
    if (!anchor) {
      return { x: 0.5, y: 0.5 };
    }
    const ax = Number.isFinite(anchor.x) ? anchor.x : 0.5;
    const ay = Number.isFinite(anchor.y) ? anchor.y : 0.5;
    return { x: ax, y: ay };
  }

  _computeSpriteOffset(agent, time) {
    if (!agent) return { x: 0, y: 0 };
    const effect = agent.effect || agent.type;
    if (effect === 'treeSway') {
      const amplitude = Number.isFinite(agent.amplitude) ? agent.amplitude : Math.min(this.world.cellWidth, this.world.cellHeight) * 0.3;
      const speed = Number.isFinite(agent.speed) ? agent.speed : 1.2;
      const phase = (agent.phase || 0) + speed * time;
      return {
        x: Math.sin(phase) * amplitude,
        y: Math.cos(phase * 0.5) * amplitude * 0.1
      };
    }
    return { x: 0, y: 0 };
  }

  _intersectsView(bounds, view) {
    return !(bounds.right < view.left || bounds.left > view.right || bounds.bottom < view.top || bounds.top > view.bottom);
  }

  drawSpritePass(ctx, view) {
    const layer = this.world.getSpriteLayer();
    if (!zoomInRange(layer, view.zoom)) return;
    const commands = [];
    let index = 0;
    for (const placement of layer.placements) {
      if (!placement || !placement.glyph) continue;
      if (!zoomInRange(placement, view.zoom)) continue;
      const glyphKey = placement.glyph;
      const lowerKey = typeof glyphKey === 'string' ? glyphKey.toLowerCase() : '';
      if (lowerKey.includes('tree')) continue;
      if (lowerKey.includes('city') && view.zoom < LOD.cityMinZoom) continue;
      const glyph = this.glyphs?.byKey ? this.glyphs.byKey[glyphKey] : null;
      if (!glyph || !glyph.canvas) continue;
      const scale = this._resolveSpriteScale(placement, glyph);
      if (scale.x <= 0 || scale.y <= 0) continue;
      const anchor = this._resolveAnchor(placement);
      const offset = this._computeSpriteOffset(placement.agentRef, view.time);
      const width = glyph.width * scale.x;
      const height = glyph.height * scale.y;
      const x = placement.position.x + offset.x - anchor.x * width;
      const y = placement.position.y + offset.y - anchor.y * height;
      const rotation = Number.isFinite(placement.rotation) ? placement.rotation : 0;
      const centerX = x + width * 0.5;
      const centerY = y + height * 0.5;
      const radius = Math.hypot(width, height) * 0.5;
      const bounds = {
        left: centerX - radius,
        right: centerX + radius,
        top: centerY - radius,
        bottom: centerY + radius
      };
      if (!this._intersectsView(bounds, view)) continue;
      commands.push({
        glyph,
        x,
        y,
        width,
        height,
        rotation,
        centerX,
        centerY,
        placement,
        order: Number.isFinite(placement.priority) ? placement.priority : 0,
        index: index++,
        isCity: lowerKey.includes('city'),
        isCart: placement.agentRef?.type === 'cart'
      });
    }
    if (commands.length === 0) return;
    commands.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.index - b.index;
    });
    const culled = commands.slice(0, this.spriteBudget);
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    for (const cmd of culled) {
      if (cmd.rotation) {
        ctx.save();
        ctx.translate(cmd.centerX, cmd.centerY);
        ctx.rotate(cmd.rotation);
        if (cmd.isCity) {
          this._drawCityShadow(ctx, cmd, view);
        }
        ctx.drawImage(cmd.glyph.canvas, -cmd.width * 0.5, -cmd.height * 0.5, cmd.width, cmd.height);
        ctx.restore();
      } else {
        if (cmd.isCity) {
          this._drawCityShadow(ctx, cmd, view);
        }
        ctx.drawImage(cmd.glyph.canvas, cmd.x, cmd.y, cmd.width, cmd.height);
      }
      if (cmd.placement.agentRef && cmd.placement.agentRef.effect === 'treeSway') {
        this.renderTreeSwayHighlight(ctx, cmd);
      }
      if (cmd.isCart) {
        this._drawCartOverlay(ctx, cmd, view);
      }
      if (cmd.isCity && view.zoom >= LOD.labelsMinZoom) {
        this._drawCityLabel(ctx, cmd, view);
      }
    }
    ctx.imageSmoothingEnabled = smoothing;
  }

  drawEffectPass(ctx, view) {
    const layer = this.world.getEffectLayer();
    if (!zoomInRange(layer, view.zoom)) return;
    for (const agent of layer.agents) {
      if (!agent) continue;
      if (!zoomInRange(agent, view.zoom)) continue;
      const effect = agent.effect || agent.type;
      const shader = this.effectShaders[effect];
      if (!shader) continue;
      shader(ctx, agent, view, view.time);
    }
  }

  renderCloudNoise(ctx, agent, view, time) {
    const baseRadius = Number.isFinite(agent.radius) ? agent.radius : Math.min(this.world.width, this.world.height) * 0.12;
    const speed = Number.isFinite(agent.speed) ? agent.speed : 0.06;
    const phase = (agent.phase || 0) + speed * time;
    const seed = agent.seed != null ? agent.seed : (typeof agent.id === 'number' ? agent.id : 1);
    const layers = 6;
    const parallax = 1 / (1 + Math.max(0, view.zoom));
    const opacityBase = agent.opacity != null ? agent.opacity : 0.18;
    ctx.save();
    ctx.translate(agent.position.x, agent.position.y);
    ctx.globalAlpha = opacityBase * (0.85 + parallax * 0.3);
    for (let i = 0; i < layers; i++) {
      const angle = (i / layers) * Math.PI * 2;
      const hash = Math.sin((seed + i) * 12.9898) * 43758.5453;
      const noise = hash - Math.floor(hash);
      const radius = baseRadius * (0.55 + 0.45 * noise) * (0.8 + parallax * 0.4);
      const dx = Math.cos(angle + phase * 0.25) * radius * (0.9 + parallax * 0.4);
      const dy = Math.sin(angle * 0.9 + phase * 0.18) * radius * 0.6 * (0.95 + parallax * 0.2);
      const gradient = ctx.createRadialGradient(dx, dy, radius * 0.2, dx, dy, radius);
      gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  renderTreeSway(ctx, agent, _view, time) {
    const amplitude = Number.isFinite(agent.amplitude) ? agent.amplitude : Math.min(this.world.cellWidth, this.world.cellHeight) * 0.4;
    const height = amplitude * 3;
    const speed = Number.isFinite(agent.speed) ? agent.speed : 1.4;
    const phase = (agent.phase || 0) + time * speed;
    const sway = Math.sin(phase) * amplitude;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = Math.max(this.world.cellWidth, this.world.cellHeight) * 0.05;
    ctx.beginPath();
    ctx.moveTo(agent.position.x, agent.position.y);
    ctx.quadraticCurveTo(agent.position.x + sway, agent.position.y - height * 0.5, agent.position.x, agent.position.y - height);
    ctx.stroke();
    ctx.restore();
  }

  renderTreeSwayHighlight(ctx, command) {
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(command.centerX, command.centerY - command.height * 0.3, command.width * 0.6, command.height * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
