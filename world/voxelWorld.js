const DEFAULT_CHUNK_SIZE = 16;
const DEFAULT_MAX_HEIGHT = 64;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function chunkKey(cx, cy) {
  return `${cx},${cy}`;
}

function normaliseMaterial(material, palette) {
  if (!material) {
    return null;
  }
  const key = String(material);
  if (!palette) {
    return key;
  }
  if (palette.materials && palette.materials[key]) {
    return key;
  }
  if (palette.colors && palette.colors[key]) {
    return key;
  }
  return key;
}

function defaultPaletteMaterial(palette) {
  if (!palette) return 'grass';
  if (palette.materials) {
    const keys = Object.keys(palette.materials);
    if (keys.length > 0) {
      return keys[0];
    }
  }
  if (palette.colors) {
    const keys = Object.keys(palette.colors);
    if (keys.length > 0) {
      return keys[0];
    }
  }
  return 'grass';
}

function cloneOperation(op) {
  return op ? { ...op } : null;
}

export class VoxelWorld {
  constructor({ chunkSize = DEFAULT_CHUNK_SIZE, maxHeight = DEFAULT_MAX_HEIGHT, palette = null } = {}) {
    this.chunkSize = Math.max(1, Math.floor(chunkSize));
    this.maxHeight = Math.max(1, Math.floor(maxHeight));
    this.palette = palette;
    this.defaultMaterial = defaultPaletteMaterial(palette);
    this.chunks = new Map();
    this.props = new Map();
    this._history = { undo: [], redo: [] };
    this._activeStroke = null;
  }

  getChunkCoords(x, y) {
    const cx = Math.floor(x / this.chunkSize);
    const cy = Math.floor(y / this.chunkSize);
    return { cx, cy };
  }

  _ensureChunk(cx, cy) {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      const size = this.chunkSize;
      chunk = {
        cx,
        cy,
        width: size,
        height: size,
        materials: new Array(size * size).fill(this.defaultMaterial),
        heights: new Array(size * size).fill(0)
      };
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  _indexInChunk(chunk, x, y) {
    const localX = x - chunk.cx * this.chunkSize;
    const localY = y - chunk.cy * this.chunkSize;
    if (localX < 0 || localY < 0 || localX >= this.chunkSize || localY >= this.chunkSize) {
      return -1;
    }
    return localY * this.chunkSize + localX;
  }

  getMaterial(x, y) {
    const { cx, cy } = this.getChunkCoords(x, y);
    const key = chunkKey(cx, cy);
    const chunk = this.chunks.get(key);
    if (!chunk) {
      return this.defaultMaterial;
    }
    const index = this._indexInChunk(chunk, x, y);
    if (index < 0) {
      return this.defaultMaterial;
    }
    return chunk.materials[index];
  }

  getHeight(x, y) {
    const { cx, cy } = this.getChunkCoords(x, y);
    const key = chunkKey(cx, cy);
    const chunk = this.chunks.get(key);
    if (!chunk) {
      return 0;
    }
    const index = this._indexInChunk(chunk, x, y);
    if (index < 0) {
      return 0;
    }
    return chunk.heights[index] || 0;
  }

  getProp(x, y) {
    const key = `${x},${y}`;
    return this.props.get(key) || null;
  }

  getColumn(x, y) {
    return {
      x,
      y,
      material: this.getMaterial(x, y),
      height: this.getHeight(x, y),
      prop: this.getProp(x, y)
    };
  }

  setMaterial(x, y, material, record = true) {
    const resolved = material ? normaliseMaterial(material, this.palette) : null;
    const { cx, cy } = this.getChunkCoords(x, y);
    const chunk = this._ensureChunk(cx, cy);
    const index = this._indexInChunk(chunk, x, y);
    if (index < 0) return null;
    const previous = chunk.materials[index];
    if (previous === resolved) {
      return null;
    }
    chunk.materials[index] = resolved ?? this.defaultMaterial;
    if (record && this._activeStroke) {
      this._activeStroke.ops.push({ type: 'material', x, y, from: previous, to: chunk.materials[index] });
    }
    return previous;
  }

  setHeight(x, y, height, record = true) {
    const { cx, cy } = this.getChunkCoords(x, y);
    const chunk = this._ensureChunk(cx, cy);
    const index = this._indexInChunk(chunk, x, y);
    if (index < 0) return null;
    const clamped = clamp(Math.floor(height), 0, this.maxHeight);
    const previous = chunk.heights[index] || 0;
    if (previous === clamped) {
      return null;
    }
    chunk.heights[index] = clamped;
    if (record && this._activeStroke) {
      this._activeStroke.ops.push({ type: 'height', x, y, from: previous, to: clamped });
    }
    return previous;
  }

  modifyHeight(x, y, delta, record = true) {
    const current = this.getHeight(x, y);
    return this.setHeight(x, y, current + delta, record);
  }

  setProp(x, y, propId, record = true) {
    const key = `${x},${y}`;
    const previous = this.props.get(key) || null;
    if (propId) {
      this.props.set(key, { id: propId });
    } else {
      this.props.delete(key);
    }
    if (record && this._activeStroke) {
      this._activeStroke.ops.push({ type: 'prop', x, y, from: previous, to: propId ? { id: propId } : null });
    }
    return previous;
  }

  beginStroke(metadata = null) {
    if (this._activeStroke) {
      return this._activeStroke;
    }
    this._activeStroke = { ops: [], metadata };
    return this._activeStroke;
  }

  commitStroke() {
    const stroke = this._activeStroke;
    if (!stroke) {
      return false;
    }
    this._activeStroke = null;
    if (!stroke.ops.length) {
      return false;
    }
    this._history.undo.push(stroke.ops.map(cloneOperation));
    this._history.redo = [];
    return true;
  }

  cancelStroke() {
    const stroke = this._activeStroke;
    if (!stroke) {
      return;
    }
    for (let i = stroke.ops.length - 1; i >= 0; i--) {
      const op = stroke.ops[i];
      this._applyOperation(op, true);
    }
    this._activeStroke = null;
  }

  _applyOperation(op, inverse = false) {
    if (!op) return;
    const from = inverse ? op.to : op.from;
    const to = inverse ? op.from : op.to;
    if (op.type === 'material') {
      this.setMaterial(op.x, op.y, to, false);
    } else if (op.type === 'height') {
      this.setHeight(op.x, op.y, to, false);
    } else if (op.type === 'prop') {
      this.setProp(op.x, op.y, to ? to.id : null, false);
    }
  }

  undo() {
    if (!this._history.undo.length) {
      return false;
    }
    const ops = this._history.undo.pop();
    if (!ops) return false;
    for (let i = ops.length - 1; i >= 0; i--) {
      this._applyOperation(ops[i], true);
    }
    this._history.redo.push(ops.map(cloneOperation));
    return true;
  }

  redo() {
    if (!this._history.redo.length) {
      return false;
    }
    const ops = this._history.redo.pop();
    if (!ops) return false;
    for (const op of ops) {
      this._applyOperation(op, false);
    }
    this._history.undo.push(ops.map(cloneOperation));
    return true;
  }

  clearHistory() {
    this._history.undo = [];
    this._history.redo = [];
  }

  canUndo() {
    return this._history.undo.length > 0;
  }

  canRedo() {
    return this._history.redo.length > 0;
  }

  forEachColumnInBounds(bounds, callback) {
    if (!callback) return;
    const minX = Math.floor(bounds.minX);
    const maxX = Math.ceil(bounds.maxX);
    const minY = Math.floor(bounds.minY);
    const maxY = Math.ceil(bounds.maxY);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        callback(this.getColumn(x, y));
      }
    }
  }

  pickColumn(worldX, worldY) {
    const x = Math.floor(worldX);
    const y = Math.floor(worldY);
    return this.getColumn(x, y);
  }

  applyPaintBrush(centerX, centerY, radius, material) {
    const stroke = this.beginStroke({ type: 'paint' });
    const r = Math.max(0, radius);
    const minX = Math.floor(centerX - r);
    const maxX = Math.floor(centerX + r);
    const minY = Math.floor(centerY - r);
    const maxY = Math.floor(centerY + r);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - centerX;
        const dy = y + 0.5 - centerY;
        if (dx * dx + dy * dy > r * r) continue;
        this.setMaterial(x, y, material, true);
      }
    }
    return stroke;
  }

  applyEraseBrush(centerX, centerY, radius) {
    return this.applyPaintBrush(centerX, centerY, radius, this.defaultMaterial);
  }

  applyHeightBrush(centerX, centerY, radius, delta) {
    const stroke = this.beginStroke({ type: 'height', delta });
    const r = Math.max(0, radius);
    const minX = Math.floor(centerX - r);
    const maxX = Math.floor(centerX + r);
    const minY = Math.floor(centerY - r);
    const maxY = Math.floor(centerY + r);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - centerX;
        const dy = y + 0.5 - centerY;
        if (dx * dx + dy * dy > r * r) continue;
        this.modifyHeight(x, y, delta, true);
      }
    }
    return stroke;
  }

  applyPropBrush(centerX, centerY, radius, propId) {
    const stroke = this.beginStroke({ type: 'prop', id: propId });
    const r = Math.max(0, radius);
    const minX = Math.floor(centerX - r);
    const maxX = Math.floor(centerX + r);
    const minY = Math.floor(centerY - r);
    const maxY = Math.floor(centerY + r);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - centerX;
        const dy = y + 0.5 - centerY;
        if (dx * dx + dy * dy > r * r) continue;
        if (propId) {
          this.setProp(x, y, propId, true);
        } else {
          this.setProp(x, y, null, true);
        }
      }
    }
    return stroke;
  }
}
