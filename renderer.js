// renderer.js - draws the world and carts onto the canvas

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.scale = 1;
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
}

function zoomInRange(target, zoom) {
  if (!target) return true;
  const min = Number.isFinite(target.zoomMin) ? target.zoomMin : 0;
  const maxValue = target.zoomMax == null ? Infinity : target.zoomMax;
  return zoom >= min && zoom <= maxValue;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getTimeSeconds() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
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
    ctx.save();
    ctx.setTransform(this.camera.scale, 0, 0, this.camera.scale, this.camera.x, this.camera.y);
    const view = this._computeViewBounds();
    ctx.clearRect(view.left, view.top, view.width, view.height);
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
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      zoom: this.camera.scale,
      time: getTimeSeconds()
    };
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
    const canAdjustSmoothing = 'imageSmoothingEnabled' in ctx;
    const previousSmoothing = canAdjustSmoothing ? ctx.imageSmoothingEnabled : null;
    if (canAdjustSmoothing) {
      ctx.imageSmoothingEnabled = false;
    }
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const tileId = grid[row][col];
        const tile = this.world.getTileDescriptor(tileId);
        if (!tile) continue;
        const x = this.world.bounds.minX + col * cellWidth;
        const y = this.world.bounds.minY + row * cellHeight;
        const textureKey = tile.texture;
        const textureGlyph = textureKey && this.glyphs && this.glyphs.byKey
          ? this.glyphs.byKey[textureKey]
          : null;
        if (textureGlyph && textureGlyph.canvas) {
          ctx.drawImage(textureGlyph.canvas, x, y, cellWidth, cellHeight);
        } else {
          ctx.fillStyle = tile.color || '#000000';
          ctx.fillRect(x, y, cellWidth, cellHeight);
        }
      }
    }
    if (canAdjustSmoothing) {
      ctx.imageSmoothingEnabled = previousSmoothing;
    }
  }

  drawVectorPass(ctx, view) {
    const layer = this.world.getVectorLayer();
    if (!zoomInRange(layer, view.zoom)) return;
    for (const feature of layer.features) {
      if (!feature) continue;
      if (!zoomInRange(feature, view.zoom)) continue;
      const style = feature.style || {};
      const strokeStyle = style.strokeStyle || 'rgba(0,0,0,0.6)';
      const lineWidth = Number.isFinite(style.lineWidth) ? style.lineWidth : (1 / clamp(view.zoom, 1, Infinity));
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
      const glyph = this.glyphs?.byKey ? this.glyphs.byKey[placement.glyph] : null;
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
        index: index++
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
        ctx.drawImage(cmd.glyph.canvas, -cmd.width * 0.5, -cmd.height * 0.5, cmd.width, cmd.height);
        ctx.restore();
      } else {
        ctx.drawImage(cmd.glyph.canvas, cmd.x, cmd.y, cmd.width, cmd.height);
      }
      if (cmd.placement.agentRef && cmd.placement.agentRef.effect === 'treeSway') {
        this.renderTreeSwayHighlight(ctx, cmd);
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

  renderCloudNoise(ctx, agent, _view, time) {
    const radius = Number.isFinite(agent.radius) ? agent.radius : Math.min(this.world.width, this.world.height) * 0.1;
    const opacity = agent.opacity != null ? agent.opacity : 0.35;
    const speed = Number.isFinite(agent.speed) ? agent.speed : 0.08;
    const phase = (agent.phase || 0) + speed * time;
    const seed = agent.seed != null ? agent.seed : (typeof agent.id === 'number' ? agent.id : 1);
    const layers = 6;
    ctx.save();
    ctx.translate(agent.position.x, agent.position.y);
    ctx.globalAlpha = opacity;
    for (let i = 0; i < layers; i++) {
      const angle = (i / layers) * Math.PI * 2;
      const hash = Math.sin((seed + i) * 12.9898) * 43758.5453;
      const noise = hash - Math.floor(hash);
      const r = radius * (0.6 + 0.4 * noise);
      const dx = Math.cos(angle + phase * 0.3) * r;
      const dy = Math.sin(angle * 0.9 + phase * 0.2) * r * 0.6;
      const gradient = ctx.createRadialGradient(dx, dy, r * 0.2, dx, dy, r);
      gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
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
