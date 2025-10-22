// input.js - interaction controller for navigation and voxel authoring

const DEFAULT_MODES = ['navigate'];

const VOXEL_MODE_CONFIGS = {
  'voxel-paint': { action: 'paint' },
  'voxel-erase': { action: 'erase' },
  'voxel-sculpt': { action: 'sculpt' },
  'voxel-prop': { action: 'prop' }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

function cloneBrush(brush) {
  if (!brush) {
    return null;
  }
  return {
    radius: brush.radius,
    layer: brush.layer,
    material: brush.material,
    heightDelta: brush.heightDelta,
    propId: brush.propId,
    column: brush.column
  };
}

export class InteractionController {
  constructor(canvas, renderer, world) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.world = world;
    this.mode = 'navigate';
    this._modes = new Set(DEFAULT_MODES);
    this.voxelModes = new Map(Object.entries(VOXEL_MODE_CONFIGS));
    Object.keys(VOXEL_MODE_CONFIGS).forEach((mode) => this._modes.add(mode));
    this._eventTarget = typeof window !== 'undefined' && typeof window.EventTarget === 'function'
      ? new EventTarget()
      : null;

    const materials = Array.isArray(world?.getVoxelMaterials?.()) ? world.getVoxelMaterials() : ['grass'];
    this.voxelBrush = {
      radius: 2,
      layer: 'terrain',
      material: materials[0] || 'grass',
      heightDelta: 1,
      propId: 'marker',
      column: false
    };

    this.pointer = { id: null, x: 0, y: 0 };
    this.isPanning = false;
    this.lastPanX = 0;
    this.lastPanY = 0;
    this.hoveredVoxel = null;
    this._voxelStrokeActive = false;
    this._voxelStrokeMode = null;
    this.cameraTransition = null;

    this._onKeyDown = (event) => this.onKeyDown(event);
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
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown, { passive: false });
    }
  }

  destroy() {
    if (typeof window !== 'undefined' && this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
    }
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

  getBrush() {
    return cloneBrush(this.voxelBrush);
  }

  setBrush(settings = {}) {
    if (!settings || typeof settings !== 'object') {
      return;
    }
    const updates = { ...this.voxelBrush };
    if (settings.radius != null && Number.isFinite(settings.radius)) {
      updates.radius = clamp(Number(settings.radius), 0.5, 64);
    }
    if (typeof settings.layer === 'string') {
      updates.layer = settings.layer;
    }
    if (typeof settings.material === 'string') {
      updates.material = settings.material;
    }
    if (settings.heightDelta != null && Number.isFinite(settings.heightDelta)) {
      updates.heightDelta = Math.max(1, Math.round(settings.heightDelta));
    }
    if (typeof settings.propId === 'string' || settings.propId === null) {
      updates.propId = settings.propId;
    }
    if (settings.column != null) {
      updates.column = Boolean(settings.column);
    }
    const changed = JSON.stringify(this.voxelBrush) !== JSON.stringify(updates);
    this.voxelBrush = updates;
    if (changed) {
      this.emit('brush-change', { brush: this.getBrush() });
      this._updateRendererState();
    }
  }

  isEditMode(mode = this.mode) {
    return this.voxelModes.has(mode);
  }

  setMode(mode) {
    if (!this._modes.has(mode)) {
      return;
    }
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.resetTransientState();
    this.emit('mode-change', { mode });
    this._updateRendererState();
  }

  resetTransientState() {
    if (this._voxelStrokeActive) {
      this.world?.cancelVoxelStroke?.();
    }
    this._voxelStrokeActive = false;
    this._voxelStrokeMode = null;
    this.isPanning = false;
    const pointerId = this.pointer.id;
    this.pointer.id = null;
    if (pointerId != null) {
      this.canvas.releasePointerCapture?.(pointerId);
    }
    this._updateRendererState();
  }

  update() {
    this._updateCameraTransition();
  }

  onPointerDown(event) {
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    this.pointer = { id: event.pointerId, x: px, y: py };

    if (this.isEditMode()) {
      if (event.button === 0 || (this.mode === 'voxel-sculpt' && event.button === 2)) {
        this._beginVoxelStroke(event, px, py);
      }
      return;
    }

    if (event.button === 1 || event.button === 2 || (event.button === 0 && event.altKey)) {
      this.startPanning(event);
      return;
    }

    this.canvas.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    if (this._voxelStrokeActive) {
      this._continueVoxelStroke(event, px, py);
      return;
    }

    if (this.isPanning) {
      const dx = event.clientX - this.lastPanX;
      const dy = event.clientY - this.lastPanY;
      this.panCamera(dx, dy);
      this.lastPanX = event.clientX;
      this.lastPanY = event.clientY;
      return;
    }

    this._updateVoxelHover(px, py);
  }

  onPointerUp(event) {
    if (this._voxelStrokeActive && event.pointerId === this.pointer.id) {
      const changed = this.world?.commitVoxelStroke?.() || false;
      if (!changed) {
        this.world?.cancelVoxelStroke?.();
      } else {
        this.emit('voxel-edit', {
          mode: this._voxelStrokeMode,
          brush: this.getBrush(),
          pointer: { x: this.pointer.x, y: this.pointer.y }
        });
      }
      this._voxelStrokeActive = false;
      this._voxelStrokeMode = null;
      this.canvas.releasePointerCapture?.(event.pointerId);
      this._updateRendererState();
      return;
    }

    if (this.isPanning && (event.button === 1 || event.button === 2 || event.button === 0)) {
      this.endPanning();
    }

    this.canvas.releasePointerCapture?.(event.pointerId);
  }

  onWheel(event) {
    if (this._voxelStrokeActive) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    this.zoomCamera(event.deltaY, px, py);
  }

  onKeyDown(event) {
    if (!event) {
      return;
    }
    const key = event.key ? event.key.toLowerCase() : '';
    const ctrlOrMeta = event.ctrlKey || event.metaKey;
    if (key === 'escape' && this._voxelStrokeActive) {
      this.world?.cancelVoxelStroke?.();
      this._voxelStrokeActive = false;
      this._voxelStrokeMode = null;
      this._updateRendererState();
      event.preventDefault();
      return;
    }
    if (ctrlOrMeta && key === 'z') {
      if (event.shiftKey) {
        this.redoEdit();
      } else {
        this.undoEdit();
      }
      event.preventDefault();
      return;
    }
    if (ctrlOrMeta && key === 'y') {
      this.redoEdit();
      event.preventDefault();
    }
  }

  startPanning(event) {
    this.isPanning = true;
    this.lastPanX = event.clientX;
    this.lastPanY = event.clientY;
    this.canvas.setPointerCapture?.(event.pointerId);
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

  clearHover() {
    if (this.hoveredVoxel) {
      this.hoveredVoxel = null;
      this.emit('voxel-hover', { voxel: null });
      this._updateRendererState();
    }
  }

  screenToWorld(px, py) {
    return this.renderer.camera.screenToWorld(px, py);
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

  focusOnWorldPosition(worldPos) {
    if (!worldPos) return;
    const padding = 30 / (this.renderer.camera.scale || 1);
    const bounds = {
      minX: worldPos.x - padding,
      minY: worldPos.y - padding,
      maxX: worldPos.x + padding,
      maxY: worldPos.y + padding
    };
    this.focusOnBounds(bounds, 0.5);
  }

  toggleNextLayer() {
    const layers = ['terrain', 'vector', 'sprite', 'effect'];
    if (!this._layerCycle) {
      this._layerCycle = { list: layers, index: 0 };
    }
    const layer = this._layerCycle.list[this._layerCycle.index % this._layerCycle.list.length];
    const visible = this.renderer.toggleLayer(layer);
    this._layerCycle.index = (this._layerCycle.index + 1) % this._layerCycle.list.length;
    this.emit('layer-toggle', { layer, visible });
  }

  undoEdit() {
    const result = this.world?.undoVoxelEdit?.() || false;
    if (result) {
      this.emit('voxel-undo', {});
      this._updateRendererState();
    }
    return result;
  }

  redoEdit() {
    const result = this.world?.redoVoxelEdit?.() || false;
    if (result) {
      this.emit('voxel-redo', {});
      this._updateRendererState();
    }
    return result;
  }

  _beginVoxelStroke(event, px, py) {
    const layer = this.voxelBrush.layer;
    const hit = this.renderer.pickVoxelAt(px, py, { layer, column: this.voxelBrush.column });
    if (!hit) {
      return;
    }
    this.pointer = { id: event.pointerId, x: px, y: py };
    this.canvas.setPointerCapture?.(event.pointerId);
    this.world?.beginVoxelStroke?.({ mode: this.mode, layer });
    this._voxelStrokeActive = true;
    this._voxelStrokeMode = this.mode;
    this._applyVoxelBrush(hit, event);
    this.emit('voxel-stroke', { state: 'begin', mode: this.mode, hit });
    this._updateRendererState();
  }

  _continueVoxelStroke(event, px, py) {
    if (!this._voxelStrokeActive) {
      return;
    }
    const hit = this.renderer.pickVoxelAt(px, py, { layer: this.voxelBrush.layer, column: this.voxelBrush.column });
    if (!hit) {
      return;
    }
    this.pointer.x = px;
    this.pointer.y = py;
    this._applyVoxelBrush(hit, event);
    this.emit('voxel-stroke', { state: 'update', mode: this.mode, hit });
    this._updateRendererState();
  }

  _applyVoxelBrush(hit, event) {
    if (!hit || !this.world?.voxels) {
      return;
    }
    const centerX = hit.x + 0.5;
    const centerY = hit.y + 0.5;
    const brush = this.voxelBrush;
    const mode = this.mode;
    if (mode === 'voxel-paint') {
      if (brush.layer === 'prop') {
        if (brush.propId) {
          this.world.voxels.applyPropBrush(centerX, centerY, brush.radius, brush.propId);
        }
      } else {
        this.world.voxels.applyPaintBrush(centerX, centerY, brush.radius, brush.material);
        if (brush.column) {
          this.world.voxels.applyHeightBrush(centerX, centerY, brush.radius, brush.heightDelta);
        }
      }
    } else if (mode === 'voxel-erase') {
      if (brush.layer === 'prop') {
        this.world.voxels.applyPropBrush(centerX, centerY, brush.radius, null);
      } else {
        this.world.voxels.applyEraseBrush(centerX, centerY, brush.radius);
        if (brush.column) {
          const drop = -(this.world.voxels?.maxHeight || brush.heightDelta || 1);
          this.world.voxels.applyHeightBrush(centerX, centerY, brush.radius, drop);
        }
      }
    } else if (mode === 'voxel-sculpt') {
      const invert = event && (event.button === 2 || event.altKey);
      const delta = invert ? -brush.heightDelta : brush.heightDelta;
      this.world.voxels.applyHeightBrush(centerX, centerY, brush.radius, delta);
    } else if (mode === 'voxel-prop') {
      const propId = event && event.altKey ? null : brush.propId;
      this.world.voxels.applyPropBrush(centerX, centerY, brush.radius, propId);
    }
  }

  _updateVoxelHover(px, py) {
    const hit = this.renderer.pickVoxelAt(px, py, { layer: this.voxelBrush.layer, column: this.voxelBrush.column });
    if (!hit && !this.hoveredVoxel) {
      return;
    }
    if (hit && this.hoveredVoxel && hit.x === this.hoveredVoxel.x && hit.y === this.hoveredVoxel.y && hit.layer === this.hoveredVoxel.layer) {
      return;
    }
    this.hoveredVoxel = hit || null;
    this.emit('voxel-hover', { voxel: hit });
    this._updateRendererState();
  }

  _updateRendererState() {
    const brush = this.getBrush();
    const hover = this.hoveredVoxel ? {
      x: this.hoveredVoxel.x,
      y: this.hoveredVoxel.y,
      z: this.hoveredVoxel.z,
      layer: this.hoveredVoxel.layer
    } : null;
    const center = this.hoveredVoxel ? { x: this.hoveredVoxel.x + 0.5, y: this.hoveredVoxel.y + 0.5 } : null;
    this.renderer.setInteractionState({
      hoveredNode: null,
      hoveredBuilding: null,
      selection: null,
      measurement: null,
      editSession: null,
      voxelHover: hover,
      voxelBrush: {
        mode: this.mode,
        brush,
        center,
        active: this.isEditMode(),
        stroke: this._voxelStrokeActive
      }
    });
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
