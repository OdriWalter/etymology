// input.js - interaction controller for navigation, selection, measurement and layer toggles

const DEFAULT_MODES = ['navigate', 'measure', 'metadata', 'layers'];

const EDIT_MODE_CONFIGS = {
  'edit-terrain': {
    featureType: 'terrain',
    geometry: 'polygon',
    minVertices: 3,
    proxyTypes: ['terrain']
  },
  'edit-vector': {
    featureType: 'vector',
    geometry: 'polyline',
    minVertices: 2,
    proxyTypes: ['vector']
  },
  'edit-building': {
    featureType: 'buildings',
    geometry: 'polygon',
    minVertices: 3,
    proxyTypes: ['building']
  }
};

const HANDLE_HIT_RADIUS = 12;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

function cloneVertex(point) {
  if (!point) return { x: 0, y: 0 };
  const px = Number(point.x);
  const py = Number(point.y);
  const x = Number.isFinite(px) ? px : 0;
  const y = Number.isFinite(py) ? py : 0;
  return { x, y };
}

function cloneVertices(vertices) {
  if (!Array.isArray(vertices)) {
    return [];
  }
  return vertices.map((vertex) => cloneVertex(vertex));
}

function areVerticesEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    if (!va || !vb) return false;
    if (Math.abs(va.x - vb.x) > 1e-9 || Math.abs(va.y - vb.y) > 1e-9) {
      return false;
    }
  }
  return true;
}

export class InteractionController {
  constructor(canvas, renderer, world) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.world = world;
    this.mode = 'navigate';
    this._modes = new Set(DEFAULT_MODES);
    this.editModes = new Map();
    Object.entries(EDIT_MODE_CONFIGS).forEach(([modeKey, config]) => {
      this.registerEditMode(modeKey, config);
    });
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
    this.editSession = null;
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

  registerEditMode(mode, config = {}) {
    if (!mode) {
      return;
    }
    const descriptor = {
      featureType: config.featureType || null,
      geometry: config.geometry === 'polyline' ? 'polyline' : 'polygon',
      minVertices: Math.max(2, Number.isFinite(config.minVertices) ? config.minVertices : 2),
      proxyTypes: Array.isArray(config.proxyTypes) ? [...config.proxyTypes] : [],
      allowNew: config.allowNew !== false
    };
    this.editModes.set(mode, descriptor);
    this._modes.add(mode);
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
    this.cancelEditSession('reset');
  }

  update() {
    this._updateCameraTransition();
  }

  onPointerDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    this.pointer = { id: e.pointerId, x: px, y: py };

    if (this.isEditMode() || this.editSession) {
      if (e.button === 0) {
        this._handleEditPointerDown(e, px, py);
      } else if (e.button === 2) {
        this.cancelEditSession('pointer-cancel');
      }
      return;
    }

    if ((e.button === 1 || e.button === 2) && !this.isEditingGestureActive()) {
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
    if (this.isEditMode() || this.editSession) {
      this._handleEditPointerMove(e, px, py);
      if (!this.isEditingGestureActive()) {
        this._updateHover(px, py);
      }
      return;
    }
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
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (this.isEditMode() || this.editSession) {
      this._handleEditPointerUp(e, px, py);
      this.canvas.releasePointerCapture?.(e.pointerId);
      return;
    }
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
    if (this.isEditingGestureActive()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const delta = e.deltaY;
    this.zoomCamera(delta, px, py);
  }

  isEditMode(mode = this.mode) {
    return this.editModes.has(mode);
  }

  _getEditConfig(mode = this.mode) {
    return this.editModes.get(mode) || null;
  }

  isEditingGestureActive() {
    return Boolean(this.editSession && this.editSession.pointerId !== null);
  }

  onKeyDown(event) {
    if (!this.isEditMode(this.mode) && !this.editSession) {
      return;
    }
    if (!event) {
      return;
    }
    const key = event.key ? event.key.toLowerCase() : '';
    const ctrlOrMeta = event.ctrlKey || event.metaKey;
    if (key === 'escape') {
      this.cancelEditSession('keyboard');
      event.preventDefault();
      return;
    }
    if (key === 'enter') {
      this.confirmEditSession();
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

  startPanning(e) {
    if (this.isEditingGestureActive()) {
      return;
    }
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
    let changed = false;
    if (this.hoveredBuilding || this.hoveredNode) {
      this.hoveredBuilding = null;
      this.hoveredNode = null;
      changed = true;
      this.emit('hover', { building: null, node: null });
    }
    if (this.editSession && this.editSession.pointerId == null) {
      this.editSession.hoverIndex = null;
      this.editSession.preview = null;
      this.editSession.previewClosable = false;
      changed = true;
    }
    if (changed) {
      this._updateRendererState();
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

  _handleEditPointerDown(e, px, py) {
    const config = this._getEditConfig(this.mode);
    if (!config) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    const worldPos = this.screenToWorld(px, py);
    let session = this.editSession;
    if (!session || session.mode !== this.mode) {
      const proxy = this._pickFeatureProxy(px, py, config);
      if (proxy && this._beginEditFromProxy(proxy, config)) {
        session = this.editSession;
      }
    }
    if (!session) {
      const nodeId = this._resolveNodeIdAt(px, py);
      if (!nodeId) {
        return;
      }
      session = this._createEditSession(config, nodeId, null);
    } else if (!session.nodeId) {
      session.nodeId = this._resolveNodeIdAt(px, py) ?? session.nodeId;
    }
    if (!session) {
      return;
    }

    if (config.geometry === 'polygon' && session.vertices.length >= (config.minVertices || 2)) {
      if (this._isPointerNearHandle(px, py, session, 0)) {
        this.confirmEditSession();
        return;
      }
    }
    if (e.detail >= 2 && session.vertices.length >= (config.minVertices || 2)) {
      this.confirmEditSession();
      return;
    }

    const handleIndex = this._findHandleIndex(px, py, session);
    if (handleIndex !== -1) {
      this._beginHandleDrag(session, handleIndex, e, true);
      this._updateRendererState();
      return;
    }

    if (config.allowNew === false) {
      return;
    }

    this._pushUndoState(session);
    session.vertices.push(cloneVertex(worldPos));
    this._beginHandleDrag(session, session.vertices.length - 1, e, false);
    this._updateRendererState();
  }

  _handleEditPointerMove(e, px, py) {
    const session = this.editSession;
    if (!session) {
      return;
    }
    const config = this._getEditConfig(session.mode);
    const worldPos = this.screenToWorld(px, py);
    if (session.pointerId === e.pointerId && session.activeIndex != null) {
      session.vertices[session.activeIndex] = cloneVertex(worldPos);
      session.preview = null;
      session.hoverIndex = session.activeIndex;
      session.previewClosable = false;
      this._updateRendererState();
      return;
    }
    session.preview = cloneVertex(worldPos);
    const hoverIndex = this._findHandleIndex(px, py, session);
    session.hoverIndex = hoverIndex;
    session.previewClosable = Boolean(
      config &&
      config.geometry === 'polygon' &&
      hoverIndex === 0 &&
      session.vertices.length >= (config.minVertices || 2)
    );
    this._updateRendererState();
  }

  _handleEditPointerUp(e, px, py) {
    const session = this.editSession;
    if (!session) {
      return;
    }
    const config = this._getEditConfig(session.mode);
    if (session.pointerId === e.pointerId) {
      session.pointerId = null;
      session.activeIndex = null;
      const shouldClose = Boolean(
        config &&
        config.geometry === 'polygon' &&
        session.vertices.length >= (config.minVertices || 2) &&
        this._isPointerNearHandle(px, py, session, 0)
      );
      session.hoverIndex = this._findHandleIndex(px, py, session);
      session.preview = null;
      session.previewClosable = false;
      if (shouldClose) {
        this.confirmEditSession();
        return;
      }
      this._updateRendererState();
      return;
    }
    session.preview = null;
    session.previewClosable = false;
    this._updateRendererState();
  }

  _resolveNodeIdAt(px, py) {
    const hit = this._hitTest(px, py);
    if (hit?.node?.id) {
      return hit.node.id;
    }
    if (this.selection?.node?.id) {
      return this.selection.node.id;
    }
    return null;
  }

  _pickFeatureProxy(px, py, config) {
    if (!this.renderer || typeof this.renderer.pickProxyAt !== 'function') {
      return null;
    }
    const types = Array.isArray(config?.proxyTypes) && config.proxyTypes.length > 0
      ? config.proxyTypes
      : null;
    return this.renderer.pickProxyAt(px, py, (proxy) => {
      if (!proxy) return false;
      if (!types) return true;
      return types.includes(proxy.type);
    });
  }

  _resolveNodeIdFromProxy(proxy) {
    if (!proxy) {
      return this.selection?.node?.id || null;
    }
    return proxy.nodeId
      || proxy.metadata?.nodeId
      || proxy.metadata?.node?.id
      || this.selection?.node?.id
      || null;
  }

  _getFeatureFromWorld(nodeId, featureType, featureId, fallbackIndex = null) {
    const editor = this.world?.editor;
    if (!editor || !nodeId || !featureType) {
      return null;
    }
    const features = editor.getCombined(nodeId, featureType);
    if (!Array.isArray(features)) {
      return null;
    }
    let feature = null;
    if (featureId) {
      feature = features.find((entry) => entry && entry.id === featureId) || null;
    }
    if (!feature && Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < features.length) {
      feature = features[fallbackIndex];
    }
    return feature || null;
  }

  _extractVerticesFromFeature(feature, config) {
    if (!feature || !config) {
      return [];
    }
    if (config.geometry === 'polyline') {
      const points = Array.isArray(feature.line)
        ? feature.line
        : Array.isArray(feature.path)
          ? feature.path
          : Array.isArray(feature.points)
            ? feature.points
            : [];
      return cloneVertices(points);
    }
    if (Array.isArray(feature.polygon) && feature.polygon.length >= 2) {
      return cloneVertices(feature.polygon);
    }
    if (Array.isArray(feature.poly) && feature.poly.length >= 2) {
      return cloneVertices(feature.poly);
    }
    if (Array.isArray(feature.polygons) && feature.polygons.length > 0) {
      return cloneVertices(feature.polygons[0]);
    }
    if (Array.isArray(feature.geometry) && feature.geometry.length > 0 && Array.isArray(feature.geometry[0])) {
      return cloneVertices(feature.geometry[0]);
    }
    return [];
  }

  _createEditSession(config, nodeId, feature = null) {
    if (!config) {
      return null;
    }
    const vertices = feature ? this._extractVerticesFromFeature(feature, config) : [];
    const session = {
      mode: this.mode,
      featureType: config.featureType,
      geometry: config.geometry,
      minVertices: config.minVertices || 2,
      proxyTypes: Array.isArray(config.proxyTypes) ? [...config.proxyTypes] : [],
      nodeId: nodeId || null,
      featureId: feature?.id || null,
      vertices,
      history: { undo: [], redo: [] },
      pointerId: null,
      activeIndex: null,
      hoverIndex: null,
      preview: null,
      previewClosable: false,
      properties: feature?.properties ? { ...feature.properties } : null,
      metadata: feature?.metadata ? { ...feature.metadata } : null,
      isNew: !feature
    };
    this.editSession = session;
    this._pushUndoState(session, true);
    this._updateRendererState();
    return session;
  }

  _beginEditFromProxy(proxy, config) {
    const nodeId = this._resolveNodeIdFromProxy(proxy);
    const featureId = proxy?.featureId || proxy?.metadata?.featureId || proxy?.id || null;
    if (!nodeId || !featureId) {
      return false;
    }
    const fallbackIndex = Number.isInteger(proxy?.metadata?.featureIndex)
      ? proxy.metadata.featureIndex
      : null;
    const feature = this._getFeatureFromWorld(nodeId, config.featureType, featureId, fallbackIndex);
    if (!feature) {
      return false;
    }
    const session = this._createEditSession(config, nodeId, feature);
    if (!session) {
      return false;
    }
    session.featureId = feature.id || featureId;
    session.isNew = false;
    this._updateRendererState();
    return true;
  }

  _pushUndoState(session, preserveRedo = false) {
    if (!session) {
      return;
    }
    if (!session.history) {
      session.history = { undo: [], redo: [] };
    }
    const snapshot = cloneVertices(session.vertices);
    const undoStack = session.history.undo;
    const last = undoStack[undoStack.length - 1];
    if (last && areVerticesEqual(last, snapshot)) {
      return;
    }
    undoStack.push(snapshot);
    if (!preserveRedo) {
      session.history.redo = [];
    }
    if (undoStack.length > 100) {
      undoStack.shift();
    }
  }

  _beginHandleDrag(session, index, event, recordHistory = true) {
    if (!session) {
      return;
    }
    if (recordHistory) {
      this._pushUndoState(session);
    }
    session.pointerId = event.pointerId;
    session.activeIndex = index;
    session.hoverIndex = index;
    session.preview = null;
    session.previewClosable = false;
    this.canvas.setPointerCapture?.(event.pointerId);
  }

  _findHandleIndex(px, py, session) {
    if (!session?.vertices?.length) {
      return -1;
    }
    const threshold = HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS;
    for (let i = 0; i < session.vertices.length; i++) {
      const vertex = session.vertices[i];
      const screenPos = this.renderer.camera.worldToScreen(vertex.x, vertex.y);
      const dx = screenPos.x - px;
      const dy = screenPos.y - py;
      if (dx * dx + dy * dy <= threshold) {
        return i;
      }
    }
    return -1;
  }

  _isPointerNearHandle(px, py, session, index) {
    if (!session || index == null || index < 0 || index >= session.vertices.length) {
      return false;
    }
    const vertex = session.vertices[index];
    const screenPos = this.renderer.camera.worldToScreen(vertex.x, vertex.y);
    const dx = screenPos.x - px;
    const dy = screenPos.y - py;
    return dx * dx + dy * dy <= HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS;
  }

  _applyEditSession(session) {
    if (!session || !this.world) {
      return null;
    }
    if (!session.nodeId) {
      return null;
    }
    const vertices = cloneVertices(session.vertices);
    if (!Array.isArray(vertices) || vertices.length === 0) {
      return null;
    }
    let result = null;
    if (session.featureType === 'terrain') {
      const payload = { polygon: vertices };
      result = session.featureId
        ? this.world.updateTerrainPatch(session.nodeId, session.featureId, payload)
        : this.world.addTerrainPatch(session.nodeId, payload);
    } else if (session.featureType === 'vector') {
      const payload = { line: vertices };
      result = session.featureId
        ? this.world.updateVectorFeature(session.nodeId, session.featureId, payload)
        : this.world.addVectorFeature(session.nodeId, payload, {});
    } else if (session.featureType === 'buildings') {
      const payload = { polygon: vertices };
      result = session.featureId
        ? this.world.updateBuildingFeature(session.nodeId, session.featureId, payload)
        : this.world.addBuildingFeature(session.nodeId, payload, {});
    }
    if (!result && !session.featureId) {
      return null;
    }
    return { result, vertices };
  }

  confirmEditSession() {
    const session = this.editSession;
    if (!session) {
      return;
    }
    const config = this._getEditConfig(session.mode);
    const minimum = config?.minVertices || 2;
    if (session.vertices.length < minimum) {
      return;
    }
    const applied = this._applyEditSession(session);
    if (!applied) {
      return;
    }
    const { result, vertices } = applied;
    const featureId = result?.id || session.featureId;
    if (!featureId) {
      return;
    }
    const detail = {
      mode: session.mode,
      nodeId: session.nodeId,
      featureId,
      type: session.featureType,
      feature: result || { id: featureId, vertices }
    };
    const eventName = session.featureId ? 'feature-updated' : 'feature-created';
    this.editSession = null;
    this.emit(eventName, detail);
    this._updateRendererState();
  }

  cancelEditSession(reason = 'cancel', emitEvent = true) {
    if (!this.editSession) {
      return;
    }
    const session = this.editSession;
    if (session.pointerId != null) {
      this.canvas.releasePointerCapture?.(session.pointerId);
    }
    this.editSession = null;
    if (emitEvent) {
      this.emit('feature-cancelled', {
        mode: session.mode,
        nodeId: session.nodeId,
        featureId: session.featureId || null,
        type: session.featureType,
        reason
      });
    }
    this._updateRendererState();
  }

  undoEdit() {
    const session = this.editSession;
    if (!session?.history?.undo?.length) {
      return false;
    }
    const previous = session.history.undo.pop();
    if (!previous) {
      return false;
    }
    session.history.redo.push(cloneVertices(session.vertices));
    session.vertices = cloneVertices(previous);
    session.pointerId = null;
    session.activeIndex = null;
    session.hoverIndex = null;
    session.preview = null;
    session.previewClosable = false;
    this._updateRendererState();
    return true;
  }

  redoEdit() {
    const session = this.editSession;
    if (!session?.history?.redo?.length) {
      return false;
    }
    const next = session.history.redo.pop();
    if (!next) {
      return false;
    }
    session.history.undo.push(cloneVertices(session.vertices));
    session.vertices = cloneVertices(next);
    session.pointerId = null;
    session.activeIndex = null;
    session.hoverIndex = null;
    session.preview = null;
    session.previewClosable = false;
    this._updateRendererState();
    return true;
  }

  _updateRendererState() {
    const editState = this.editSession ? {
      mode: this.editSession.mode,
      geometry: this.editSession.geometry,
      vertices: cloneVertices(this.editSession.vertices),
      activeIndex: this.editSession.activeIndex,
      preview: this.editSession.preview ? cloneVertex(this.editSession.preview) : null,
      closable: Boolean(
        this.editSession.geometry === 'polygon' &&
        this.editSession.vertices.length >= (this.editSession.minVertices || 2) &&
        (this.editSession.previewClosable || this.editSession.hoverIndex === 0)
      ),
      hoverIndex: this.editSession.hoverIndex
    } : null;
    this.renderer.setInteractionState({
      hoveredBuilding: this.hoveredBuilding,
      hoveredNode: this.hoveredNode,
      selection: this.selection ? {
        bounds: this.selection.bounds
      } : null,
      measurement: this.measurement ? {
        start: this.measurement.start,
        end: this.measurement.end
      } : null,
      editSession: editState
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
