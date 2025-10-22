const DEFAULT_OPTIONS = {
  mode: 'orthographic',
  chunkColumns: 32,
  chunkRows: 32,
  pixelsPerUnit: 1.25,
  layerShadeStrength: 0.35,
  highlightStrength: 0.18,
  isoDiamondHeight: 0.95,
  maxChunks: 256
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createOffscreenCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = typeof document !== 'undefined'
    ? document.createElement('canvas')
    : null;
  if (!canvas) {
    return null;
  }
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function pointInPolygon(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPatch(point, patch) {
  if (!patch) return false;
  if (Array.isArray(patch.polygons) && patch.polygons.length > 0) {
    let inside = false;
    patch.polygons.forEach((ring, index) => {
      if (!Array.isArray(ring) || ring.length < 3) return;
      const contained = pointInPolygon(point, ring);
      if (index === 0) {
        inside = contained;
      } else if (contained) {
        inside = !inside;
      }
    });
    if (inside) return true;
  }
  if (Array.isArray(patch.polygon) && patch.polygon.length >= 3) {
    return pointInPolygon(point, patch.polygon);
  }
  return false;
}

function normalizeBounds(bounds) {
  if (!bounds) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  const { minX, minY, maxX, maxY } = bounds;
  return {
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    maxX: Number.isFinite(maxX) ? maxX : minX || 0,
    maxY: Number.isFinite(maxY) ? maxY : minY || 0
  };
}

function stablePatchSignature(patch) {
  if (!patch) return 'null';
  const tileRef = patch.tileId ?? patch.tileKey ?? patch.tile ?? 'default';
  const rings = [];
  if (Array.isArray(patch.polygon)) {
    rings.push(patch.polygon);
  }
  if (Array.isArray(patch.polygons)) {
    for (const ring of patch.polygons) {
      if (!Array.isArray(ring)) continue;
      rings.push(ring);
    }
  }
  const coords = rings
    .map((ring) => ring
      .filter((pt) => pt && Number.isFinite(pt.x) && Number.isFinite(pt.y))
      .map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`)
      .join('|'))
    .join(';');
  const revision = patch.updatedAt ?? patch.revision ?? patch.version ?? 0;
  return `${tileRef}|${coords}|${revision}`;
}

function spriteKeyForPlacement(placement) {
  if (!placement) return null;
  return placement.id || placement.key || placement.spriteKey || placement.glyph || null;
}

export class VoxelRenderer {
  constructor(world, camera, glyphs, options = {}) {
    this.world = world;
    this.camera = camera;
    this.glyphs = glyphs;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    this.devicePixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.chunkCache = new Map();
    this.vectorCache = new Map();
    this.spriteCache = new Map();
    this.hitProxies = new Map();
    this.visibleChunkIds = new Set();

    if (typeof document !== 'undefined') {
      this._hitTestCanvas = document.createElement('canvas');
      this._hitTestCanvas.width = 1;
      this._hitTestCanvas.height = 1;
      this._hitTestContext = this._hitTestCanvas.getContext('2d');
    } else {
      this._hitTestCanvas = null;
      this._hitTestContext = null;
    }
  }

  setDevicePixelRatio(dpr) {
    if (Number.isFinite(dpr) && dpr > 0) {
      if (Math.abs(dpr - this.devicePixelRatio) > 1e-3) {
        this.devicePixelRatio = dpr;
        this.chunkCache.clear();
      }
    }
  }

  beginFrame(view) {
    if (this.world && typeof this.world.consumeEditedNodes === 'function') {
      const editedNodes = this.world.consumeEditedNodes();
      if (Array.isArray(editedNodes) && editedNodes.length > 0) {
        for (const nodeId of editedNodes) {
          this.chunkCache.delete(nodeId);
        }
      }
    }
    this.visibleChunkIds.clear();
    this.currentView = view || null;
  }

  endFrame() {
    this._pruneChunkCache();
    this.currentView = null;
  }

  getChunkSlice(node, colors) {
    if (!node) return null;
    const entry = this._ensureChunkEntry(node, colors);
    if (!entry) return null;
    entry.lastUsed = (typeof performance !== 'undefined' && performance.now()) || Date.now();
    this.visibleChunkIds.add(node.id);
    return { node, entry };
  }

  drawTerrainSlices(ctx, slices, view) {
    if (!Array.isArray(slices) || slices.length === 0) {
      return;
    }
    this.hitProxies.clear();
    const sorted = [...slices].sort((a, b) => {
      const aBounds = a.entry.bounds;
      const bBounds = b.entry.bounds;
      if (aBounds.maxY !== bBounds.maxY) {
        return aBounds.maxY - bBounds.maxY;
      }
      if (aBounds.minX !== bBounds.minX) {
        return aBounds.minX - bBounds.minX;
      }
      return a.node.lod - b.node.lod;
    });

    for (const slice of sorted) {
      const { node, entry } = slice;
      const { bounds, canvas } = entry;
      const width = bounds.maxX - bounds.minX;
      const height = bounds.maxY - bounds.minY;
      if (!canvas || width <= 0 || height <= 0) continue;
      ctx.drawImage(canvas, bounds.minX, bounds.minY, width, height);
      this._registerTerrainProxies(node, view);
      this._registerVectorProxies(node, view);
    }
  }

  renderVectors(ctx, view, layer) {
    if (!layer || !Array.isArray(layer.features)) return;
    for (const feature of layer.features) {
      if (!feature) continue;
      if (feature.zoomMin != null && view.zoom < feature.zoomMin) continue;
      if (feature.zoomMax != null && view.zoom > feature.zoomMax) continue;
      let cached = this.vectorCache.get(feature);
      if (!cached) {
        cached = this._buildVectorCache(feature);
        this.vectorCache.set(feature, cached);
      }
      if (cached.type === 'poly') {
        ctx.save();
        if (cached.fillStyle) {
          ctx.fillStyle = cached.fillStyle;
          ctx.fill(cached.path);
        }
        ctx.strokeStyle = cached.strokeStyle;
        ctx.lineWidth = cached.lineWidth / this.camera.scale;
        ctx.stroke(cached.path);
        ctx.restore();
      } else if (cached.type === 'line') {
        ctx.save();
        ctx.strokeStyle = cached.strokeStyle;
        ctx.lineWidth = cached.lineWidth / this.camera.scale;
        ctx.stroke(cached.path);
        ctx.restore();
      }
    }
  }

  prepareSpriteAtlas(placements) {
    const atlases = [];
    if (!Array.isArray(placements)) {
      return atlases;
    }
    for (const placement of placements) {
      const cached = this._ensureSpriteCache(placement);
      if (cached) {
        atlases.push({ placement, cached });
      }
    }
    return atlases;
  }

  renderSprites(ctx, view, spriteLayer, carts, { renderSprites = true, renderEffects = true, preparedAtlas = null } = {}) {
    const commands = [];
    let commandIndex = 0;
    const placementEntries = preparedAtlas && Array.isArray(preparedAtlas)
      ? preparedAtlas
      : (renderSprites && spriteLayer && Array.isArray(spriteLayer.placements)
        ? spriteLayer.placements.map((placement) => ({ placement, cached: null }))
        : []);

    if (renderSprites) {
      for (const entry of placementEntries) {
        const placement = entry.placement || entry;
        if (!placement) continue;
        if (placement.zoomMin != null && view.zoom < placement.zoomMin) continue;
        if (placement.zoomMax != null && view.zoom > placement.zoomMax) continue;
        const cached = entry.cached || this._ensureSpriteCache(placement);
        if (!cached?.glyph?.canvas) continue;
        const glyph = cached.glyph;
        const scale = this._resolveSpriteScale(placement, glyph);
        if (scale.x <= 0 || scale.y <= 0) continue;
        const anchor = this._resolveAnchor(placement);
        const offset = this._computeSpriteOffset(placement.agentRef, view?.time ?? 0);
        const width = glyph.width * scale.x;
        const height = glyph.height * scale.y;
        const x = placement.position.x + offset.x - anchor.x * width;
        const y = placement.position.y + offset.y - anchor.y * height;
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
          rotation: Number.isFinite(placement.rotation) ? placement.rotation : 0,
          centerX,
          centerY,
          order: Number.isFinite(placement.priority) ? placement.priority : 0,
          depth: centerY,
          index: commandIndex++,
          tint: placement.tint ?? null
        });
      }
    }

    if (commands.length > 0) {
      commands.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.index - b.index;
      });
      const smoothing = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      for (const cmd of commands) {
        ctx.save();
        ctx.translate(cmd.centerX, cmd.centerY);
        if (cmd.rotation) {
          ctx.rotate(cmd.rotation);
        }
        if (cmd.tint) {
          ctx.fillStyle = cmd.tint;
          ctx.globalCompositeOperation = 'multiply';
        }
        ctx.drawImage(cmd.glyph.canvas, -cmd.width * 0.5, -cmd.height * 0.5, cmd.width, cmd.height);
        ctx.restore();
      }
      ctx.imageSmoothingEnabled = smoothing;
    }

    if (renderEffects && Array.isArray(carts)) {
      for (const cart of carts) {
        if (!cart) continue;
        const radius = cart.selected ? 6 : 5;
        ctx.save();
        ctx.fillStyle = cart.selected ? '#ffcc33' : '#333333';
        ctx.beginPath();
        ctx.arc(cart.position.x, cart.position.y, radius / this.camera.scale, 0, Math.PI * 2);
        ctx.fill();
        if (cart.path.length >= 2 && (!cart.pathZoomMin || view.zoom >= cart.pathZoomMin)) {
          ctx.beginPath();
          cart.path.forEach((p, index) => {
            if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
          });
          ctx.strokeStyle = cart.pathColor || 'rgba(0,0,0,0.6)';
          ctx.lineWidth = (cart.pathWidth || 2) / this.camera.scale;
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  pickBuildingAt(worldX, worldY) {
    return this.pickProxyAt(worldX, worldY, (proxy) => proxy.type === 'building');
  }

  pickProxyAt(worldX, worldY, filter) {
    if (!this._hitTestContext) return null;
    const ctx = this._hitTestContext;
    for (const proxy of this.hitProxies.values()) {
      if (!proxy || !proxy.path || !(proxy.path instanceof Path2D)) continue;
      if (typeof filter === 'function' && !filter(proxy)) continue;
      if (proxy.kind === 'polyline') {
        if (proxy.strokeWidth && Number.isFinite(proxy.strokeWidth)) {
          ctx.lineWidth = proxy.strokeWidth;
        }
        if (ctx.isPointInStroke && ctx.isPointInStroke(proxy.path, worldX, worldY)) {
          return proxy;
        }
      } else if (ctx.isPointInPath(proxy.path, worldX, worldY)) {
        return proxy;
      }
    }
    return null;
  }

  _ensureChunkEntry(node, colors) {
    const signature = this._chunkSignature(node, colors);
    let entry = this.chunkCache.get(node.id);
    if (entry && entry.signature === signature) {
      return entry;
    }
    entry = this._buildChunkEntry(node, colors);
    if (entry) {
      entry.signature = signature;
      this.chunkCache.set(node.id, entry);
    }
    return entry;
  }

  _chunkSignature(node, colors) {
    const bounds = normalizeBounds(node.bounds);
    const terrainId = node?.payloadRefs?.terrain ?? 'default';
    const patches = Array.isArray(node?.payloadRefs?.terrainPatches)
      ? node.payloadRefs.terrainPatches.map(stablePatchSignature).join('#')
      : 'none';
    const paletteKey = colors?.terrainStroke || '';
    return [
      bounds.minX.toFixed(2),
      bounds.minY.toFixed(2),
      bounds.maxX.toFixed(2),
      bounds.maxY.toFixed(2),
      terrainId,
      patches,
      paletteKey,
      this.options.mode,
      this.options.chunkColumns,
      this.options.chunkRows,
      this.devicePixelRatio.toFixed(2)
    ].join('|');
  }

  _buildChunkEntry(node, colors) {
    const bounds = normalizeBounds(node.bounds);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width <= 0 || height <= 0) {
      return null;
    }
    const columns = Math.max(1, Math.floor(this.options.chunkColumns));
    const rows = Math.max(1, Math.floor(this.options.chunkRows));
    const pixelWidth = Math.max(8, Math.round(width * this.options.pixelsPerUnit * this.devicePixelRatio));
    const pixelHeight = Math.max(8, Math.round(height * this.options.pixelsPerUnit * this.devicePixelRatio));
    const canvas = createOffscreenCanvas(pixelWidth, pixelHeight);
    if (!canvas) return null;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingEnabled = false;
    context.scale(pixelWidth / width, pixelHeight / height);
    context.translate(-bounds.minX, -bounds.minY);

    const baseTile = this._resolveTileDescriptor(node?.payloadRefs?.terrain);
    const patches = Array.isArray(node?.payloadRefs?.terrainPatches)
      ? node.payloadRefs.terrainPatches
      : [];

    const columnWidth = width / columns;
    const rowHeight = height / rows;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const minX = bounds.minX + columnWidth * col;
        const minY = bounds.minY + rowHeight * row;
        const maxX = minX + columnWidth;
        const maxY = minY + rowHeight;
        const center = { x: minX + columnWidth * 0.5, y: minY + rowHeight * 0.5 };
        const descriptor = this._resolveDescriptorAtPosition(baseTile, patches, center);
        const glyph = this._resolveGlyphForDescriptor(descriptor);
        const shading = this._computeShading(row, rows, col, columns);
        const cellBounds = { minX, minY, maxX, maxY };
        if (this.options.mode === 'isometric') {
          this._drawDiamondColumn(context, cellBounds, glyph, descriptor, shading);
        } else {
          this._drawOrthographicColumn(context, cellBounds, glyph, descriptor, shading);
        }
      }
    }

    this._strokeChunkOutline(context, bounds, colors);

    return {
      id: node.id,
      canvas,
      bounds,
      width,
      height,
      lastUsed: (typeof performance !== 'undefined' && performance.now()) || Date.now()
    };
  }

  _strokeChunkOutline(ctx, bounds, colors) {
    if (!ctx) return;
    ctx.save();
    ctx.lineWidth = 1 / this.devicePixelRatio;
    ctx.strokeStyle = colors?.terrainStroke || 'rgba(0,0,0,0.25)';
    ctx.strokeRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    ctx.restore();
  }

  _drawOrthographicColumn(ctx, cellBounds, glyph, descriptor, shading) {
    const width = cellBounds.maxX - cellBounds.minX;
    const height = cellBounds.maxY - cellBounds.minY;
    this._blitGlyph(ctx, glyph, descriptor, cellBounds.minX, cellBounds.minY, width, height);
    this._applyRectShading(ctx, cellBounds, shading);
  }

  _drawDiamondColumn(ctx, cellBounds, glyph, descriptor, shading) {
    const width = cellBounds.maxX - cellBounds.minX;
    const height = cellBounds.maxY - cellBounds.minY;
    const diamondHeight = height * this.options.isoDiamondHeight;
    const offsetY = cellBounds.minY + (height - diamondHeight);
    const centerX = cellBounds.minX + width * 0.5;
    const top = { x: centerX, y: offsetY };
    const right = { x: cellBounds.maxX, y: offsetY + diamondHeight * 0.5 };
    const bottom = { x: centerX, y: offsetY + diamondHeight };
    const left = { x: cellBounds.minX, y: offsetY + diamondHeight * 0.5 };

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.clip();
    this._blitGlyph(ctx, glyph, descriptor, left.x, offsetY, width, diamondHeight);
    this._applyPathShading(ctx, shading);
    ctx.restore();
  }

  _applyRectShading(ctx, bounds, shading) {
    if (!shading) return;
    if (shading.shade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${shading.shade})`;
      ctx.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    }
    if (shading.highlight > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = `rgba(255,255,255,${shading.highlight})`;
      ctx.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      ctx.restore();
    }
  }

  _applyPathShading(ctx, shading) {
    if (!shading) return;
    if (shading.shade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${shading.shade})`;
      ctx.fill();
    }
    if (shading.highlight > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = `rgba(255,255,255,${shading.highlight})`;
      ctx.fill();
      ctx.restore();
    }
  }

  _blitGlyph(ctx, glyph, descriptor, x, y, width, height) {
    if (glyph?.canvas) {
      ctx.drawImage(glyph.canvas, x, y, width, height);
      return;
    }
    const color = descriptor?.color || '#888888';
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  }

  _computeShading(row, rows, col, columns) {
    const rowFactor = rows > 1 ? row / (rows - 1) : 0;
    const colFactor = columns > 1 ? col / (columns - 1) : 0;
    const shade = clamp(
      rowFactor * this.options.layerShadeStrength +
      colFactor * (this.options.layerShadeStrength * 0.5),
      0,
      0.85
    );
    const highlight = clamp(
      (1 - colFactor) * this.options.highlightStrength,
      0,
      0.5
    );
    return { shade, highlight };
  }

  _resolveDescriptorAtPosition(baseTile, patches, point) {
    if (Array.isArray(patches) && patches.length > 0) {
      for (let i = patches.length - 1; i >= 0; i--) {
        const patch = patches[i];
        if (!patch) continue;
        if (pointInPatch(point, patch)) {
          const descriptor = this._resolvePatchDescriptor(patch);
          if (descriptor) {
            return descriptor;
          }
        }
      }
    }
    return baseTile || this._resolveTileDescriptor(null);
  }

  _resolveTileDescriptor(tileIdOrKey) {
    if (tileIdOrKey == null) {
      return this.world?.getTileDescriptor(null) || null;
    }
    if (typeof tileIdOrKey === 'string' && this.world?.palette?.byKey?.[tileIdOrKey]) {
      return this.world.palette.byKey[tileIdOrKey];
    }
    if (this.world && typeof this.world.getTileDescriptor === 'function') {
      return this.world.getTileDescriptor(tileIdOrKey);
    }
    return null;
  }

  _resolvePatchDescriptor(patch) {
    if (!patch) return null;
    if (patch.tile) {
      if (typeof patch.tile === 'string' && this.world?.palette?.byKey?.[patch.tile]) {
        return this.world.palette.byKey[patch.tile];
      }
      if (typeof patch.tile === 'number') {
        return this._resolveTileDescriptor(patch.tile);
      }
      if (patch.tile && typeof patch.tile === 'object' && patch.tile.texture) {
        return patch.tile;
      }
    }
    if (patch.tileKey) {
      return this._resolveTileDescriptor(patch.tileKey);
    }
    if (patch.tileId != null) {
      return this._resolveTileDescriptor(patch.tileId);
    }
    return null;
  }

  _resolveGlyphForDescriptor(descriptor) {
    if (!descriptor) return null;
    const textureKey = descriptor.texture || descriptor.spriteKey;
    if (!textureKey) return null;
    return this.glyphs?.byKey?.[textureKey] || null;
  }

  _buildVectorCache(feature) {
    if (feature.poly && feature.poly.length >= 3) {
      const path = new Path2D();
      feature.poly.forEach((p, index) => {
        if (index === 0) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y);
      });
      path.closePath();
      return {
        type: 'poly',
        path,
        fillStyle: feature.style?.fillStyle || null,
        strokeStyle: feature.style?.strokeStyle || '#333333',
        lineWidth: feature.style?.lineWidth || 1
      };
    }
    const points = feature.line || feature.path || feature.points || [];
    if (!Array.isArray(points) || points.length < 2) {
      return {
        type: 'line',
        path: new Path2D(),
        strokeStyle: feature.style?.strokeStyle || '#333333',
        lineWidth: feature.style?.lineWidth || 1.5
      };
    }
    const path = new Path2D();
    points.forEach((p, index) => {
      if (index === 0) path.moveTo(p.x, p.y); else path.lineTo(p.x, p.y);
    });
    return {
      type: 'line',
      path,
      strokeStyle: feature.style?.strokeStyle || '#333333',
      lineWidth: feature.style?.lineWidth || 1.5
    };
  }

  _ensureSpriteCache(placement) {
    if (!placement) return null;
    const key = spriteKeyForPlacement(placement);
    if (!key) return null;
    const signature = this._spriteSignature(placement);
    let cached = this.spriteCache.get(key);
    if (cached && cached.signature === signature) {
      return cached;
    }
    const glyphKey = placement.spriteKey || placement.key || placement.glyph || key;
    const glyph = this.glyphs?.byKey?.[glyphKey] || null;
    if (!glyph) {
      return null;
    }
    cached = { glyph, key, signature };
    this.spriteCache.set(key, cached);
    return cached;
  }

  _spriteSignature(placement) {
    return [
      placement.spriteKey || placement.key || placement.glyph || '',
      placement.tint || '',
      placement.scale ? JSON.stringify(placement.scale) : '',
      placement.anchor ? JSON.stringify(placement.anchor) : '',
      placement.rotation ?? 0
    ].join('|');
  }

  _resolveSpriteScale(placement, glyph) {
    const scale = placement.scale;
    if (scale == null) {
      return { x: 1, y: 1 };
    }
    if (typeof scale === 'number') {
      return { x: scale, y: scale };
    }
    const sx = Number.isFinite(scale.x) ? scale.x : 1;
    const sy = Number.isFinite(scale.y) ? scale.y : 1;
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
      const amplitude = Number.isFinite(agent.amplitude) ? agent.amplitude : 6;
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
    if (!bounds || !view) return true;
    return !(bounds.right < view.left || bounds.left > view.right || bounds.bottom < view.top || bounds.top > view.bottom);
  }

  _registerTerrainProxies(node, view) {
    const patches = node?.payloadRefs?.terrainPatches;
    if (!Array.isArray(patches) || patches.length === 0) {
      return;
    }
    patches.forEach((patch, index) => {
      if (!patch) return;
      const rings = [];
      if (Array.isArray(patch.polygon) && patch.polygon.length >= 3) {
        rings.push(patch.polygon);
      }
      if (Array.isArray(patch.polygons)) {
        for (const ring of patch.polygons) {
          if (Array.isArray(ring) && ring.length >= 3) {
            rings.push(ring);
          }
        }
      }
      if (rings.length === 0) return;
      const path = new Path2D();
      for (const ring of rings) {
        ring.forEach((pt, idx) => {
          if (idx === 0) path.moveTo(pt.x, pt.y); else path.lineTo(pt.x, pt.y);
        });
        path.closePath();
      }
      const patchId = patch.id || `${node.id}:terrain:${index}`;
      const key = `terrain:${patchId}`;
      const metadata = patch.metadata ? { ...patch.metadata } : {};
      if (patch.properties && typeof patch.properties === 'object') {
        metadata.properties = { ...patch.properties };
      }
      metadata.featureId = patch.id ?? patchId;
      metadata.nodeId = node.id;
      metadata.featureIndex = index;
      const proxy = {
        id: key,
        featureId: patch.id ?? patchId,
        type: 'terrain',
        featureType: 'terrain',
        nodeId: node.id,
        path,
        bounds: node.bounds,
        kind: 'polygon',
        metadata,
        zoom: view?.zoom ?? null
      };
      this.hitProxies.set(key, proxy);
    });
  }

  _registerVectorProxies(node, view) {
    const features = node?.payloadRefs?.vector;
    if (!Array.isArray(features) || features.length === 0) {
      return;
    }
    features.forEach((feature, index) => {
      if (!feature) return;
      let rings = [];
      let kind = 'polyline';
      if (Array.isArray(feature.polygons) && feature.polygons.length > 0) {
        rings = feature.polygons.filter((ring) => Array.isArray(ring) && ring.length >= 3);
        kind = 'polygon';
      } else if (Array.isArray(feature.polygon) && feature.polygon.length >= 3) {
        rings = [feature.polygon];
        kind = 'polygon';
      } else if (Array.isArray(feature.poly) && feature.poly.length >= 3) {
        rings = [feature.poly];
        kind = 'polygon';
      }

      let path;
      let bounds = null;
      if (kind === 'polygon' && rings.length > 0) {
        path = new Path2D();
        for (const ring of rings) {
          ring.forEach((pt, idx) => {
            if (idx === 0) path.moveTo(pt.x, pt.y); else path.lineTo(pt.x, pt.y);
          });
          path.closePath();
        }
        bounds = normalizeBounds(node.bounds);
      } else {
        const points = Array.isArray(feature.line)
          ? feature.line
          : Array.isArray(feature.path)
            ? feature.path
            : Array.isArray(feature.points)
              ? feature.points
              : [];
        if (!Array.isArray(points) || points.length < 2) {
          return;
        }
        const vectorPath = new Path2D();
        vectorPath.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          vectorPath.lineTo(points[i].x, points[i].y);
        }
        path = vectorPath;
        bounds = this._computeBoundsFromPoints(points);
        kind = 'polyline';
      }

      const featureId = feature.id || `${node.id}:vector:${index}`;
      const key = `vector:${featureId}`;
      const metadata = feature.properties ? { ...feature.properties } : {};
      metadata.featureId = featureId;
      metadata.nodeId = node.id;
      metadata.featureIndex = index;
      const proxy = {
        id: key,
        featureId,
        type: feature.type || 'vector',
        featureType: feature.type || 'vector',
        nodeId: node.id,
        path,
        bounds,
        kind,
        metadata,
        zoom: view?.zoom ?? null,
        strokeWidth: feature.style?.lineWidth || 1.5
      };
      this.hitProxies.set(key, proxy);
    });
  }

  _computeBoundsFromPoints(points) {
    if (!Array.isArray(points) || points.length === 0) {
      return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      if (!point) continue;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }
    return { minX, minY, maxX, maxY };
  }

  _pruneChunkCache() {
    const max = Math.max(0, this.options.maxChunks || DEFAULT_OPTIONS.maxChunks);
    if (this.chunkCache.size <= max) {
      for (const id of Array.from(this.chunkCache.keys())) {
        if (!this.visibleChunkIds.has(id)) {
          // Opportunistically trim stale entries when under budget
          const entry = this.chunkCache.get(id);
          if (entry && (Date.now() - entry.lastUsed) > 60_000) {
            this.chunkCache.delete(id);
          }
        }
      }
      return;
    }
    const entries = Array.from(this.chunkCache.values());
    entries.sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.chunkCache.size > max && entries.length > 0) {
      const entry = entries.shift();
      if (entry) {
        this.chunkCache.delete(entry.id);
      }
    }
  }
}

