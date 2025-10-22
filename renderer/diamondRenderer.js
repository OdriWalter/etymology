const DEFAULT_OPTIONS = {
  cacheResolution: 0.6,
  morphRange: 0.75,
  screenSpaceErrorThreshold: 8,
  strokeErrorThreshold: 3,
  buildingZoomHysteresis: 0.35,
  buildingLod: 4,
  maxCacheEntries: 512
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function computeScreenSpaceError(bounds, scale) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return Math.hypot(width, height) * scale;
}

export function computeMorphFactor(zoom, minZoom, maxZoom, range) {
  if (!Number.isFinite(zoom)) return 0;
  const center = Number.isFinite(minZoom) ? minZoom : zoom;
  const blendStart = center - range;
  const blendEnd = Number.isFinite(maxZoom) ? maxZoom : center + range;
  return smoothstep(blendStart, blendEnd, zoom);
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pseudoRandom(str, salt) {
  const h = hashString(str + ':' + salt);
  return (h % 10000) / 10000;
}

function createOffscreenCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function buildPathFromVertices(vertices) {
  const path = new Path2D();
  if (!vertices || vertices.length === 0) {
    return path;
  }
  path.moveTo(vertices[0].x, vertices[0].y);
  for (let i = 1; i < vertices.length; i++) {
    path.lineTo(vertices[i].x, vertices[i].y);
  }
  path.closePath();
  return path;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export class DiamondRenderer {
  constructor(world, camera, glyphs, options = {}) {
    this.world = world;
    this.camera = camera;
    this.glyphs = glyphs;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.cache = new Map();
    this.vectorCache = new Map();
    this.spriteCache = new Map();
    this.hitProxies = new Map();
    this.visibleIds = new Set();
    this.devicePixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
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
      this.devicePixelRatio = dpr;
    }
  }

  purgeInvisibleEntries() {
    if (this.cache.size <= this.options.maxCacheEntries) {
      for (const id of Array.from(this.cache.keys())) {
        if (!this.visibleIds.has(id)) {
          this.cache.delete(id);
        }
      }
      return;
    }
    // prune LRU-ish by timestamp
    const entries = Array.from(this.cache.values()).sort((a, b) => a.lastUsed - b.lastUsed);
    const target = Math.floor(this.options.maxCacheEntries * 0.75);
    for (let i = 0; i < entries.length && this.cache.size > target; i++) {
      const entry = entries[i];
      this.cache.delete(entry.id);
    }
  }

  renderTerrain(ctx, nodes, view, colors) {
    this.visibleIds.clear();
    this.hitProxies.clear();
    const sorted = [...nodes].sort((a, b) => a.lod - b.lod);
    for (const node of sorted) {
      if (!node) continue;
      this.visibleIds.add(node.id);
      const entry = this._ensureCacheEntry(node, colors);
      if (!entry) continue;
      entry.lastUsed = (typeof performance !== 'undefined' && performance.now()) || Date.now();
      const morph = computeMorphFactor(
        view.zoom,
        node.minZoom ?? node.lod,
        node.maxZoom ?? node.minZoom ?? node.lod,
        this.options.morphRange
      );
      const morphPath = this._buildMorphPath(entry, morph);
      const bounds = entry.bounds;
      const width = bounds.maxX - bounds.minX;
      const height = bounds.maxY - bounds.minY;
      const screenError = computeScreenSpaceError(bounds, this.camera.scale);
      const errorThreshold = this.options.screenSpaceErrorThreshold;
      const fade = errorThreshold > 0
        ? clamp(screenError / Math.max(errorThreshold, 1e-6), 0.25, 1)
        : 1;
      ctx.save();
      if (morphPath) {
        ctx.clip(morphPath);
      }
      ctx.globalAlpha = fade;
      ctx.drawImage(entry.canvas, bounds.minX, bounds.minY, width, height);
      ctx.restore();

      if (screenError > this.options.strokeErrorThreshold) {
        ctx.save();
        ctx.strokeStyle = entry.strokeStyle;
        const alpha = clamp(screenError / (screenError + 80), 0.25, 0.9);
        ctx.globalAlpha = alpha;
        const strokeScale = Math.max(0.75, Math.min(width, height) * 0.08);
        ctx.lineWidth = strokeScale / this.camera.scale;
        ctx.stroke(morphPath);
        ctx.restore();
      }

      if (entry.buildingFootprints && this._shouldRenderBuildings(node, view.zoom)) {
        this._renderBuildings(ctx, entry, view);
      }
    }
    this.purgeInvisibleEntries();
  }

  renderVectors(ctx, view, layer) {
    if (!layer || !Array.isArray(layer.features)) return;
    const cache = this.vectorCache;
    for (const feature of layer.features) {
      if (!feature) continue;
      if (feature.zoomMin != null && view.zoom < feature.zoomMin) continue;
      if (feature.zoomMax != null && view.zoom > feature.zoomMax) continue;
      let cached = cache.get(feature);
      if (!cached) {
        cached = this._buildVectorCache(feature);
        cache.set(feature, cached);
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

  renderSprites(ctx, view, spriteLayer, carts) {
    if (spriteLayer && Array.isArray(spriteLayer.placements)) {
      for (const placement of spriteLayer.placements) {
        if (!placement) continue;
        if (placement.zoomMin != null && view.zoom < placement.zoomMin) continue;
        if (placement.zoomMax != null && view.zoom > placement.zoomMax) continue;
        const key = placement.id || placement.key || placement;
        let cached = this.spriteCache.get(key);
        if (!cached) {
          cached = this._buildSpriteCache(placement);
          this.spriteCache.set(key, cached);
        }
        this._drawSprite(ctx, cached, placement);
      }
    }
    if (Array.isArray(carts)) {
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
    if (!this._hitTestContext) return null;
    for (const proxy of this.hitProxies.values()) {
      if (!proxy.path || !(proxy.path instanceof Path2D)) continue;
      if (this._hitTestContext.isPointInPath(proxy.path, worldX, worldY)) {
        return proxy;
      }
    }
    return null;
  }

  _ensureCacheEntry(node, colors) {
    const signature = this._signatureForNode(node);
    let entry = this.cache.get(node.id);
    if (entry && entry.signature === signature) {
      return entry;
    }
    entry = this._buildCacheEntry(node, colors);
    if (entry) {
      this.cache.set(node.id, entry);
    }
    return entry;
  }

  _buildCacheEntry(node, colors) {
    const bounds = { ...node.bounds };
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const resolution = clamp(Math.max(width, height) * this.options.cacheResolution, 16, 512);
    const aspect = height > 0 ? width / height : 1;
    const pixelWidth = Math.max(8, Math.round(resolution));
    const pixelHeight = Math.max(8, Math.round(resolution / (aspect || 1)));
    const canvas = createOffscreenCanvas(pixelWidth, pixelHeight);
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.save();
    context.scale(pixelWidth / width, pixelHeight / height);
    context.translate(-bounds.minX, -bounds.minY);
    const diamondVertices = this._computeDiamondVertices(bounds);
    const diamondPath = buildPathFromVertices(diamondVertices);
    const fillStyle = this._resolveNodeColor(node, colors);
    context.fillStyle = fillStyle;
    context.fill(diamondPath);
    const strokeStyle = this._deriveStrokeStyle(fillStyle);
    context.strokeStyle = strokeStyle;
    context.lineWidth = Math.max(width, height) * 0.03;
    context.stroke(diamondPath);
    context.restore();

    const rectVertices = this._computeRectVertices(bounds);
    const now = (typeof performance !== 'undefined' && performance.now()) || Date.now();
    const entry = {
      id: node.id,
      signature: this._signatureForNode(node),
      bounds,
      canvas,
      fillStyle,
      strokeStyle,
      diamondVertices,
      rectVertices,
      buildingFootprints: this._generateBuildingFootprints(node),
      lastUsed: now,
      metadata: node.metadata
    };
    return entry;
  }

  _generateBuildingFootprints(node) {
    const features = node?.payloadRefs?.buildings;
    if (!Array.isArray(features) || features.length === 0) {
      return null;
    }

    const level = node.metadata?.levelLabel || 'building';
    const footprints = [];

    features.forEach((feature, index) => {
      if (!feature) return;
      const rings = this._normaliseBuildingRings(feature);
      if (rings.length === 0) return;

      const path = new Path2D();
      for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        path.moveTo(ring[0].x, ring[0].y);
        for (let i = 1; i < ring.length; i++) {
          path.lineTo(ring[i].x, ring[i].y);
        }
        path.closePath();
      }

      const bounds = this._computeBoundsFromRings(rings);
      if (!bounds) return;

      const buildingId = feature.id || `${node.id}:building:${index}`;
      const properties = feature.properties && typeof feature.properties === 'object'
        ? { ...feature.properties }
        : null;
      const metadata = {
        id: buildingId,
        featureId: feature.id ?? null,
        level,
        properties,
        node: null
      };
      const proxy = {
        id: buildingId,
        nodeId: node.id,
        path,
        bounds,
        level,
        zoom: null,
        metadata
      };

      footprints.push({
        id: buildingId,
        nodeId: node.id,
        level,
        path,
        bounds,
        featureId: feature.id ?? null,
        properties,
        metadata,
        proxy
      });
    });

    return footprints.length > 0 ? footprints : null;
  }

  _normaliseBuildingRings(feature) {
    if (!feature) return [];
    if (Array.isArray(feature.polygons)) {
      return feature.polygons
        .filter((ring) => Array.isArray(ring) && ring.length >= 3);
    }
    const primary = Array.isArray(feature.poly) ? feature.poly : Array.isArray(feature.polygon) ? feature.polygon : null;
    if (Array.isArray(primary) && primary.length >= 3) {
      return [primary];
    }
    return [];
  }

  _computeBoundsFromRings(rings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      if (!Array.isArray(ring)) continue;
      for (const point of ring) {
        if (!point) continue;
        const x = Number(point.x);
        const y = Number(point.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }
    return { minX, minY, maxX, maxY };
  }

  _renderBuildings(ctx, entry, view) {
    if (!entry.buildingFootprints) return;
    const baseFill = entry.fillStyle || '#999999';
    for (const footprint of entry.buildingFootprints) {
      const shadeFactor = pseudoRandom(footprint.id, 'shade');
      const fill = this._shadeColor(baseFill, 0.15 + shadeFactor * 0.35);
      ctx.save();
      ctx.fillStyle = fill;
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.5 / this.camera.scale;
      ctx.fill(footprint.path);
      ctx.stroke(footprint.path);
      ctx.restore();
      const proxy = footprint.proxy || {
        id: footprint.id,
        nodeId: entry.id,
        path: footprint.path,
        bounds: footprint.bounds,
        level: footprint.level,
        metadata: footprint.metadata || null,
        zoom: null
      };
      proxy.nodeId = entry.id;
      proxy.path = footprint.path;
      proxy.bounds = footprint.bounds;
      proxy.level = footprint.level;
      proxy.zoom = view.zoom;
      if (proxy.metadata) {
        proxy.metadata.properties = footprint.properties ?? proxy.metadata.properties ?? null;
        proxy.metadata.featureId = footprint.featureId ?? proxy.metadata.featureId ?? null;
        proxy.metadata.level = footprint.level ?? proxy.metadata.level ?? null;
        proxy.metadata.node = entry.metadata || null;
      }
      this.hitProxies.set(footprint.id, proxy);
    }
  }

  _shouldRenderBuildings(node, zoom) {
    const buildingLod = this.options.buildingLod ?? 4;
    const thresholdIndex = Math.min(buildingLod, this.world?.terrain?.zoomThresholds?.length - 1 || buildingLod);
    const zoomThresholds = this.world?.terrain?.zoomThresholds || [];
    const threshold = zoomThresholds[thresholdIndex] ?? node.minZoom ?? 2;
    const hysteresis = this.options.buildingZoomHysteresis;
    return zoom >= (threshold - hysteresis);
  }

  _signatureForNode(node) {
    const payload = node.payloadRefs || {};
    const terrain = payload.terrain ?? 'null';
    const vector = Array.isArray(payload.vector) ? payload.vector.join(',') : '[]';
    const sprites = Array.isArray(payload.sprites) ? payload.sprites.join(',') : '[]';
    const effects = Array.isArray(payload.effects) ? payload.effects.join(',') : '[]';
    const stamp = node.metadata?.updatedAt ?? 0;
    const buildingHash = this._hashBuildingPayload(payload.buildings);
    return `${terrain}|${vector}|${sprites}|${effects}|${stamp}|${buildingHash}`;
  }

  _hashBuildingPayload(buildings) {
    if (!Array.isArray(buildings) || buildings.length === 0) {
      return '0';
    }
    const parts = [];
    for (const feature of buildings) {
      if (!feature) continue;
      const rings = this._normaliseBuildingRings(feature);
      const coordsKey = rings
        .map((ring) => Array.isArray(ring)
          ? ring.map((point) => `${Number(point.x)},${Number(point.y)}`).join(';')
          : '')
        .filter(Boolean)
        .join('|');
      const propsKey = feature.properties ? stableStringify(feature.properties) : '';
      const idKey = feature.id || '';
      parts.push(`${idKey}|${coordsKey}|${propsKey}`);
    }
    if (parts.length === 0) {
      return '0';
    }
    return hashString(parts.join('||')).toString(16);
  }

  _computeDiamondVertices(bounds) {
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    return [
      { x: centerX, y: bounds.maxY },
      { x: bounds.maxX, y: centerY },
      { x: centerX, y: bounds.minY },
      { x: bounds.minX, y: centerY }
    ];
  }

  _computeRectVertices(bounds) {
    return [
      { x: bounds.minX, y: bounds.maxY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.minX, y: bounds.minY }
    ];
  }

  _buildMorphPath(entry, morph) {
    const vertices = [];
    for (let i = 0; i < entry.diamondVertices.length; i++) {
      const d = entry.diamondVertices[i];
      const r = entry.rectVertices[i];
      vertices.push({
        x: lerp(d.x, r.x, morph),
        y: lerp(d.y, r.y, morph)
      });
    }
    return buildPathFromVertices(vertices);
  }

  _resolveNodeColor(node, colors) {
    const tileId = node?.payloadRefs?.terrain;
    const descriptor = this.world.getTileDescriptor(tileId);
    if (descriptor?.color) {
      return descriptor.color;
    }
    return colors?.terrainStroke || '#b9d87b';
  }

  _deriveStrokeStyle(fill) {
    const { r, g, b } = this._colorToRgb(fill);
    return `rgba(${r},${g},${b},0.65)`;
  }

  _shadeColor(color, amount) {
    const { r, g, b } = this._colorToRgb(color);
    const scale = 1 - amount;
    const nr = clamp(Math.round(r * scale), 0, 255);
    const ng = clamp(Math.round(g * scale), 0, 255);
    const nb = clamp(Math.round(b * scale), 0, 255);
    return `rgb(${nr}, ${ng}, ${nb})`;
  }

  _colorToRgb(color) {
    if (typeof color === 'string' && color.startsWith('#')) {
      const hex = color.slice(1);
      const bigint = parseInt(hex.length === 3
        ? hex.split('').map(ch => ch + ch).join('')
        : hex, 16);
      return {
        r: (bigint >> 16) & 255,
        g: (bigint >> 8) & 255,
        b: bigint & 255
      };
    }
    const match = /rgb\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)/.exec(color);
    if (match) {
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    }
    return { r: 128, g: 128, b: 128 };
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
    const path = new Path2D();
    const points = feature.line || [];
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

  _buildSpriteCache(placement) {
    const glyph = this.glyphs?.byKey?.[placement.spriteKey || placement.key];
    return {
      sprite: glyph,
      key: placement.spriteKey || placement.key
    };
  }

  _drawSprite(ctx, cached, placement) {
    if (!cached?.sprite?.commands) return;
    const commands = cached.sprite.commands;
    ctx.save();
    const scale = (placement.scale || 1) / this.camera.scale;
    const anchorX = placement.anchor?.x || 0;
    const anchorY = placement.anchor?.y || 0;
    ctx.translate(placement.position.x, placement.position.y);
    if (placement.rotation) {
      ctx.rotate(placement.rotation);
    }
    ctx.scale(scale, scale);
    ctx.translate(-anchorX, -anchorY);
    for (const command of commands) {
      if (command.type === 'path') {
        ctx.fillStyle = command.fill || '#ffffff';
        ctx.beginPath();
        command.points.forEach((pt, idx) => {
          if (idx === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
        });
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
