// input.js - interaction controller for navigation, selection, measurement and layer toggles

const DEFAULT_MODES = ['navigate', 'measure', 'metadata', 'layers'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

export class InteractionController {
  constructor(canvas, renderer, world) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.world = world;
    this.mode = 'navigate';
    this._modes = new Set(DEFAULT_MODES);
    this._eventTarget = typeof window !== 'undefined' && typeof window.EventTarget === 'function'
      ? new EventTarget()
      : null;
    this.isPanning = false;
    this.hoveredNode = null;
    this.hoveredBuilding = null;
    this.selection = null;
    this.measurement = null;
    this.layerCycle = ['terrain', 'vector', 'sprite', 'effect'];
    this.layerCycleIndex = 0;
    this.cameraTransition = null;
    this.pointer = { id: null, x: 0, y: 0 };
    this.setupEvents();
    this._updateRendererState();
  }

  setupEvents() {
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointerleave', () => this.clearHover());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  on(type, listener) {
    if (!this._eventTarget) return () => {};
    this._eventTarget.addEventListener(type, listener);
    return () => this._eventTarget.removeEventListener(type, listener);
  }

  emit(type, detail) {
    if (!this._eventTarget || typeof CustomEvent !== 'function') return;
    const event = new CustomEvent(type, { detail });
    this._eventTarget.dispatchEvent(event);
    this.canvas.dispatchEvent(new CustomEvent(`interaction-${type}`, { detail }));
  }

  setMode(mode) {
    if (!this._modes.has(mode)) return;
    if (this.mode === mode) return;
    this.mode = mode;
    this.resetTransientState();
    this.emit('mode-change', { mode });
    this._updateRendererState();
  }

  resetTransientState() {
    this.isPanning = false;
    this.measurement = null;
    this.cameraTransition = null;
    this.selection = null;
  }

  update() {
    this._updateCameraTransition();
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    this.pointer = { id: e.pointerId, x: px, y: py };

    if (e.button === 1 || e.button === 2) {
      this.startPanning(e);
      return;
    }

    if (e.button !== 0) {
      return;
    }

    this.canvas.setPointerCapture?.(e.pointerId);

    if (this.mode === 'measure') {
      const worldPos = this.screenToWorld(px, py);
      this.measurement = {
        start: worldPos,
        end: { ...worldPos },
        distance: 0,
        active: true
      };
      this.emit('measurement-update', { ...this.measurement });
      this._updateRendererState();
      return;
    }

    const { building, node, worldPos } = this._hitTest(px, py);

    if (this.mode === 'metadata') {
      if (building || node) {
        this.selection = this._selectionFromHit(building, node);
        this.emit('selection', {
          mode: this.mode,
          building: building ? this._buildingPayload(building) : null,
          node: node ? this._nodePayload(node) : null
        });
        this._updateRendererState();
      }
      return;
    }

    if (this.mode === 'layers') {
      this.toggleNextLayer();
      return;
    }

    if (this.mode === 'navigate') {
      if (e.shiftKey && node) {
        this.expandNode(node);
        return;
      }
      if (e.altKey && node) {
        this.collapseNode(node);
        return;
      }
      if (building || node) {
        this.selection = this._selectionFromHit(building, node);
        this.focusOnSelection(this.selection);
        this.emit('selection', {
          mode: this.mode,
          building: building ? this._buildingPayload(building) : null,
          node: node ? this._nodePayload(node) : null
        });
      } else if (worldPos) {
        this.focusOnWorldPosition(worldPos);
      }
      this._updateRendererState();
    }
  }

  onPointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (this.isPanning) {
      const dx = e.clientX - this.lastPanX;
      const dy = e.clientY - this.lastPanY;
      this.panCamera(dx, dy);
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
      return;
    }

    if (this.mode === 'measure' && this.measurement?.active) {
      this.measurement.end = this.screenToWorld(px, py);
      this.measurement.distance = this._distance(this.measurement.start, this.measurement.end);
      this.emit('measurement-update', { ...this.measurement });
      this._updateRendererState();
      return;
    }

    this._updateHover(px, py);
  }

  onPointerUp(e) {
    if (this.isPanning && (e.button === 1 || e.button === 2)) {
      this.endPanning();
    }
    if (this.measurement?.active && e.button === 0) {
      this.measurement.active = false;
      this.emit('measurement-complete', { ...this.measurement });
    }
    this.canvas.releasePointerCapture?.(e.pointerId);
  }

  onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const delta = e.deltaY;
    this.zoomCamera(delta, px, py);
  }

  startPanning(e) {
    this.isPanning = true;
    this.lastPanX = e.clientX;
    this.lastPanY = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  }

  endPanning() {
    this.isPanning = false;
  }

  panCamera(dx, dy) {
    const camera = this.renderer.camera;
    camera.x += dx;
    camera.y += dy;
  }

  zoomCamera(deltaY, px, py) {
    const camera = this.renderer.camera;
    const constraints = this.renderer.getZoomConstraints();
    const worldBefore = camera.screenToWorld(px, py);
    const zoomDelta = -deltaY * 0.0015;
    const base = camera.baseScale > 0 ? camera.baseScale : 1;
    const currentNormalized = Math.log2(camera.scale / base);
    let targetNormalized = currentNormalized + zoomDelta;
    const maxZoom = constraints.max ?? 6;
    if (targetNormalized > maxZoom) {
      const overshoot = targetNormalized - maxZoom;
      targetNormalized = maxZoom + Math.tanh(overshoot) * 0.25;
    }
    const minZoom = constraints.min ?? -4;
    targetNormalized = clamp(targetNormalized, minZoom, maxZoom + 0.25);
    const targetScale = base * Math.pow(2, targetNormalized);
    camera.scale = clamp(targetScale, camera.minScale, camera.maxScale);
    camera.x = px - worldBefore.x * camera.scale;
    camera.y = py - worldBefore.y * camera.scale;
  }

  focusOnSelection(selection) {
    if (!selection) return;
    if (selection.building && selection.building.bounds) {
      this.focusOnBounds(selection.building.bounds, 0.35);
    } else if (selection.node && selection.node.bounds) {
      this.focusOnBounds(selection.node.bounds, 0.2);
    }
    this._updateRendererState();
  }

  focusOnWorldPosition(worldPos) {
    const padding = 30 / (this.renderer.camera.scale || 1);
    const bounds = {
      minX: worldPos.x - padding,
      minY: worldPos.y - padding,
      maxX: worldPos.x + padding,
      maxY: worldPos.y + padding
    };
    this.focusOnBounds(bounds, 0.5);
  }

  focusOnBounds(bounds, paddingRatio = 0.15) {
    if (!bounds) return;
    const camera = this.renderer.camera;
    const canvasWidth = this.renderer.canvas.width;
    const canvasHeight = this.renderer.canvas.height;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const paddedWidth = Math.max(width * (1 + paddingRatio * 2), 1e-6);
    const paddedHeight = Math.max(height * (1 + paddingRatio * 2), 1e-6);
    const targetScaleX = canvasWidth / paddedWidth;
    const targetScaleY = canvasHeight / paddedHeight;
    const targetScale = Math.max(Math.min(targetScaleX, targetScaleY), 1e-6);
    const base = camera.baseScale > 0 ? camera.baseScale : 1;
    const targetNormalized = Math.log2(targetScale / base);
    const constraints = this.renderer.getZoomConstraints();
    const clampedNormalized = clamp(targetNormalized, constraints.min, constraints.max);
    const finalScale = clamp(base * Math.pow(2, clampedNormalized), camera.minScale, camera.maxScale);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const targetX = canvasWidth / 2 - centerX * finalScale;
    const targetY = canvasHeight / 2 - centerY * finalScale;
    const now = (typeof performance !== 'undefined' && performance.now()) || Date.now();
    this.cameraTransition = {
      startX: camera.x,
      startY: camera.y,
      startScale: camera.scale,
      endX: targetX,
      endY: targetY,
      endScale: finalScale,
      startTime: now,
      duration: 500
    };
  }

  expandNode(node) {
    if (!node) return;
    const children = this.world.terrain.subdivideNode(node.id);
    if (children && children.length > 0) {
      this.emit('quadtree-expand', { node: this._nodePayload(node), children: children.map((child) => this._nodePayload(child)) });
    }
  }

  collapseNode(node) {
    if (!node || node.id === this.world.terrain.rootId) return;
    this.world.terrain.pruneSubtree(node.id);
    this.emit('quadtree-collapse', { node: this._nodePayload(node) });
    this.selection = null;
    this._updateRendererState();
  }

  toggleNextLayer() {
    const layer = this.layerCycle[this.layerCycleIndex % this.layerCycle.length];
    const visible = this.renderer.toggleLayer(layer);
    this.layerCycleIndex = (this.layerCycleIndex + 1) % this.layerCycle.length;
    this.emit('layer-toggle', { layer, visible });
  }

  clearHover() {
    if (this.hoveredBuilding || this.hoveredNode) {
      this.hoveredBuilding = null;
      this.hoveredNode = null;
      this._updateRendererState();
      this.emit('hover', { building: null, node: null });
    }
  }

  screenToWorld(px, py) {
    return this.renderer.camera.screenToWorld(px, py);
  }

  _hitTest(px, py) {
    const building = this.renderer.pickBuildingAt(px, py);
    const worldPos = this.screenToWorld(px, py);
    const zoom = this.renderer.camera.getNormalizedZoom();
    const node = this.world.terrain.sampleFeatureAt(worldPos, zoom);
    return { building, node, worldPos };
  }

  _updateHover(px, py) {
    const result = this._hitTest(px, py);
    const sameBuilding = result.building?.id === this.hoveredBuilding?.id;
    const sameNode = result.node?.id === this.hoveredNode?.id;
    if (sameBuilding && sameNode) {
      return;
    }
    this.hoveredBuilding = result.building || null;
    this.hoveredNode = result.node || null;
    const payload = {
      building: this.hoveredBuilding ? this._buildingPayload(this.hoveredBuilding) : null,
      node: this.hoveredNode ? this._nodePayload(this.hoveredNode) : null,
      worldPosition: result.worldPos
    };
    this.emit('hover', payload);
    this._updateRendererState();
  }

  _updateRendererState() {
    this.renderer.setInteractionState({
      hoveredBuilding: this.hoveredBuilding,
      hoveredNode: this.hoveredNode,
      selection: this.selection ? {
        bounds: this.selection.bounds
      } : null,
      measurement: this.measurement ? {
        start: this.measurement.start,
        end: this.measurement.end
      } : null
    });
  }

  _selectionFromHit(building, node) {
    if (building) {
      return {
        building: this._buildingPayload(building),
        node: node ? this._nodePayload(node) : null,
        bounds: building.bounds || (node && node.bounds) || null
      };
    }
    if (node) {
      return {
        building: null,
        node: this._nodePayload(node),
        bounds: node.bounds || null
      };
    }
    return null;
  }

  _buildingPayload(building) {
    if (!building) return null;
    return {
      id: building.id,
      nodeId: building.nodeId,
      level: building.level,
      bounds: building.bounds,
      metadata: building.metadata || null
    };
  }

  _nodePayload(node) {
    if (!node) return null;
    return {
      id: node.id,
      lod: node.lod,
      bounds: node.bounds,
      metadata: node.metadata || null
    };
  }

  _distance(a, b) {
    if (!a || !b) return 0;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.hypot(dx, dy);
  }

  _updateCameraTransition() {
    if (!this.cameraTransition) return;
    const camera = this.renderer.camera;
    const now = (typeof performance !== 'undefined' && performance.now()) || Date.now();
    const elapsed = now - this.cameraTransition.startTime;
    const t = clamp(elapsed / this.cameraTransition.duration, 0, 1);
    const eased = easeOutQuad(t);
    camera.x = lerp(this.cameraTransition.startX, this.cameraTransition.endX, eased);
    camera.y = lerp(this.cameraTransition.startY, this.cameraTransition.endY, eased);
    camera.scale = lerp(this.cameraTransition.startScale, this.cameraTransition.endScale, eased);
    if (t >= 1) {
      this.cameraTransition = null;
    }
  }
}

export const Input = InteractionController;
