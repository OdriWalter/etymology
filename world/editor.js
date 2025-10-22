const FEATURE_TYPES = {
  terrain: 'terrainPatches',
  terrainpatch: 'terrainPatches',
  terrainpatches: 'terrainPatches',
  patch: 'terrainPatches',
  patches: 'terrainPatches',
  vector: 'vector',
  vectors: 'vector',
  parcel: 'parcels',
  parcels: 'parcels',
  building: 'buildings',
  buildings: 'buildings'
};

function normaliseType(type) {
  if (!type) {
    throw new Error('Feature type is required');
  }
  const key = String(type).toLowerCase();
  const resolved = FEATURE_TYPES[key];
  if (!resolved) {
    throw new Error(`Unsupported feature type: ${type}`);
  }
  return resolved;
}

function clonePoint(point) {
  if (!point) return null;
  return { x: Number(point.x), y: Number(point.y) };
}

function clonePointArray(points) {
  if (!Array.isArray(points)) {
    return null;
  }
  return points.map(clonePoint).filter(Boolean);
}

function cloneNestedPointArray(polygons) {
  if (!Array.isArray(polygons)) {
    return null;
  }
  return polygons.map((ring) => clonePointArray(Array.isArray(ring) ? ring : [])).filter((ring) => Array.isArray(ring) && ring.length > 0);
}

function cloneProperties(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneProperties);
  }
  const result = {};
  for (const key of Object.keys(value)) {
    result[key] = cloneProperties(value[key]);
  }
  return result;
}

function cloneFeature(feature) {
  if (!feature) return null;
  const cloned = { ...feature };
  if (feature.properties && typeof feature.properties === 'object') {
    cloned.properties = cloneProperties(feature.properties);
  }
  if (Array.isArray(feature.line)) {
    cloned.line = clonePointArray(feature.line);
  }
  if (Array.isArray(feature.poly)) {
    cloned.poly = clonePointArray(feature.poly);
  }
  if (Array.isArray(feature.polygon)) {
    cloned.polygon = clonePointArray(feature.polygon);
  }
  if (Array.isArray(feature.polygons)) {
    cloned.polygons = cloneNestedPointArray(feature.polygons);
  }
  if (Array.isArray(feature.geometry)) {
    cloned.geometry = cloneNestedPointArray(feature.geometry);
  }
  return cloned;
}

function cloneTerrainPatch(patch) {
  if (!patch) return null;
  const cloned = { ...patch };
  if (Array.isArray(patch.polygon)) {
    cloned.polygon = clonePointArray(patch.polygon);
  }
  if (Array.isArray(patch.polygons)) {
    cloned.polygons = cloneNestedPointArray(patch.polygons);
  }
  return cloned;
}

function cloneForType(feature, typeKey) {
  if (!feature) return null;
  if (typeKey === 'terrainPatches') {
    return cloneTerrainPatch(feature);
  }
  return cloneFeature(feature);
}

function cloneMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value)) {
      result[key] = value.map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          return { ...entry };
        }
        return entry;
      });
    } else if (value && typeof value === 'object') {
      result[key] = { ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function emptySource() {
  return {
    terrainPatches: [],
    vector: [],
    parcels: [],
    buildings: []
  };
}

function emptyEdits() {
  return {
    terrainPatches: new Map(),
    vector: new Map(),
    parcels: new Map(),
    buildings: new Map()
  };
}

function normaliseTagList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function mapFromArray(features, typeKey, generateId) {
  const map = new Map();
  if (!Array.isArray(features)) {
    return map;
  }
  for (const feature of features) {
    const cloned = cloneForType(feature, typeKey);
    if (!cloned) {
      continue;
    }
    if (!cloned.id) {
      cloned.id = generateId(typeKey);
    }
    map.set(cloned.id, cloned);
  }
  return map;
}

function cloneMapValues(map, typeKey) {
  if (!(map instanceof Map)) {
    return [];
  }
  return Array.from(map.values()).map((feature) => cloneForType(feature, typeKey)).filter(Boolean);
}

export class WorldEditor {
  constructor() {
    this.nodes = new Map();
    this._featureSeq = 1;
  }

  _ensureNode(nodeId) {
    if (!nodeId) {
      throw new Error('Node id is required');
    }
    let entry = this.nodes.get(nodeId);
    if (!entry) {
      entry = {
        source: emptySource(),
        edits: emptyEdits(),
        metadataSource: null,
        metadataEdit: null
      };
      this.nodes.set(nodeId, entry);
    }
    return entry;
  }

  _generateFeatureId(typeKey) {
    const sequence = (this._featureSeq++).toString(36);
    const timestamp = Date.now().toString(36);
    return `edit-${typeKey}-${timestamp}-${sequence}`;
  }

  setSource(nodeId, payload = {}) {
    const entry = this._ensureNode(nodeId);
    entry.source.terrainPatches = Array.isArray(payload.terrainPatches)
      ? payload.terrainPatches.map((patch) => cloneTerrainPatch(patch)).filter(Boolean)
      : [];
    entry.source.vector = Array.isArray(payload.vector)
      ? payload.vector.map((feature) => cloneFeature(feature)).filter(Boolean)
      : [];
    entry.source.parcels = Array.isArray(payload.parcels)
      ? payload.parcels.map((feature) => cloneFeature(feature)).filter(Boolean)
      : [];
    entry.source.buildings = Array.isArray(payload.buildings)
      ? payload.buildings.map((feature) => cloneFeature(feature)).filter(Boolean)
      : [];
    return this.getCombinedPayload(nodeId);
  }

  setMetadataSource(nodeId, metadata = null) {
    const entry = this._ensureNode(nodeId);
    entry.metadataSource = cloneMetadata(metadata);
    if (!entry.metadataSource) {
      entry.metadataSource = null;
    }
    if (!entry.metadataEdit && !this.hasEdits(nodeId) && !this._isSourceEmpty(entry.source)) {
      return cloneMetadata(entry.metadataSource);
    }
    return cloneMetadata(entry.metadataSource);
  }

  getMetadataSource(nodeId) {
    const entry = this.nodes.get(nodeId);
    if (!entry || !entry.metadataSource) {
      return null;
    }
    return cloneMetadata(entry.metadataSource);
  }

  getSource(nodeId) {
    const entry = this.nodes.get(nodeId);
    if (!entry) {
      return emptySource();
    }
    return {
      terrainPatches: entry.source.terrainPatches.map((patch) => cloneTerrainPatch(patch)),
      vector: entry.source.vector.map((feature) => cloneFeature(feature)),
      parcels: entry.source.parcels.map((feature) => cloneFeature(feature)),
      buildings: entry.source.buildings.map((feature) => cloneFeature(feature))
    };
  }

  getNodeMetadataEdit(nodeId) {
    const entry = this.nodes.get(nodeId);
    if (!entry || !entry.metadataEdit) {
      return null;
    }
    return cloneMetadata(entry.metadataEdit);
  }

  updateNodeMetadata(nodeId, updates = {}) {
    if (!nodeId || !updates || typeof updates !== 'object') {
      return null;
    }
    const entry = this._ensureNode(nodeId);
    const merged = { ...(entry.metadataEdit || {}) };
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        continue;
      }
      if (key === 'tags') {
        const tags = normaliseTagList(value);
        if (tags.length > 0 || Array.isArray(value)) {
          merged.tags = tags;
        } else if (merged.tags) {
          merged.tags = [];
        }
        continue;
      }
      if (value === null || value === '') {
        merged[key] = null;
      } else if (Array.isArray(value)) {
        merged[key] = value.slice();
      } else if (value && typeof value === 'object') {
        merged[key] = { ...value };
      } else {
        merged[key] = value;
      }
    }
    if (Object.keys(merged).length === 0) {
      entry.metadataEdit = null;
    } else {
      entry.metadataEdit = merged;
    }
    return this.getNodeMetadataEdit(nodeId);
  }

  addFeature(nodeId, type, feature) {
    const typeKey = normaliseType(type);
    const entry = this._ensureNode(nodeId);
    const collection = entry.edits[typeKey];
    const cloned = cloneForType(feature, typeKey) || {};
    if (!cloned.id) {
      cloned.id = this._generateFeatureId(typeKey);
    }
    collection.set(cloned.id, cloned);
    return cloneForType(cloned, typeKey);
  }

  updateFeature(nodeId, type, featureId, updates) {
    const typeKey = normaliseType(type);
    const entry = this.nodes.get(nodeId);
    if (!entry || !featureId) {
      return null;
    }
    const collection = entry.edits[typeKey];
    const existing = collection.get(featureId);
    if (!existing) {
      return null;
    }
    const merged = this._mergeFeature(existing, updates, typeKey);
    collection.set(featureId, merged);
    return cloneForType(merged, typeKey);
  }

  removeFeature(nodeId, type, featureId) {
    const typeKey = normaliseType(type);
    const entry = this.nodes.get(nodeId);
    if (!entry || !featureId) {
      return false;
    }
    const collection = entry.edits[typeKey];
    if (!collection.delete(featureId)) {
      return false;
    }
    if (this._isEntryEmpty(entry)) {
      this.nodes.delete(nodeId);
    }
    return true;
  }

  getEdits(nodeId, type) {
    const typeKey = normaliseType(type);
    const entry = this.nodes.get(nodeId);
    if (!entry) {
      return [];
    }
    return cloneMapValues(entry.edits[typeKey], typeKey);
  }

  hasEdits(nodeId) {
    const entry = this.nodes.get(nodeId);
    if (!entry) {
      return false;
    }
    const featureEdits = Object.values(entry.edits).some((collection) => collection instanceof Map && collection.size > 0);
    return featureEdits || (entry.metadataEdit && Object.keys(entry.metadataEdit).length > 0);
  }

  clearEdits(nodeId) {
    const entry = this.nodes.get(nodeId);
    if (!entry) {
      return false;
    }
    entry.edits = emptyEdits();
    entry.metadataEdit = null;
    if (!this.hasEdits(nodeId) && this._isSourceEmpty(entry.source)) {
      this.nodes.delete(nodeId);
    }
    return true;
  }

  clearAll() {
    this.nodes.clear();
    this._featureSeq = 1;
  }

  listEditedNodes() {
    const summary = [];
    for (const [nodeId, entry] of this.nodes.entries()) {
      const terrainCount = entry.edits.terrainPatches?.size || 0;
      const vectorCount = entry.edits.vector?.size || 0;
      const parcelCount = entry.edits.parcels?.size || 0;
      const buildingCount = entry.edits.buildings?.size || 0;
      const metadataEdited = entry.metadataEdit ? Object.keys(entry.metadataEdit).length : 0;
      const total = terrainCount + vectorCount + parcelCount + buildingCount + (metadataEdited ? 1 : 0);
      if (total === 0) {
        continue;
      }
      summary.push({
        nodeId,
        counts: {
          terrainPatches: terrainCount,
          vector: vectorCount,
          parcels: parcelCount,
          buildings: buildingCount,
          metadata: metadataEdited ? 1 : 0
        },
        total
      });
    }
    return summary;
  }

  getCombined(nodeId, type) {
    const typeKey = normaliseType(type);
    const entry = this.nodes.get(nodeId);
    if (!entry) {
      if (typeKey === 'terrainPatches') {
        return [];
      }
      return [];
    }
    const source = entry.source[typeKey] || [];
    const edits = cloneMapValues(entry.edits[typeKey], typeKey);
    const combinedSource = source.map((feature) => cloneForType(feature, typeKey));
    return combinedSource.concat(edits);
  }

  getCombinedPayload(nodeId) {
    const entry = this.nodes.get(nodeId);
    if (!entry) {
      return {
        terrainPatches: [],
        vector: [],
        parcels: [],
        buildings: []
      };
    }
    return {
      terrainPatches: this.getCombined(nodeId, 'terrain'),
      vector: this.getCombined(nodeId, 'vector'),
      parcels: this.getCombined(nodeId, 'parcels'),
      buildings: this.getCombined(nodeId, 'buildings')
    };
  }

  serializePatches() {
    const lines = [JSON.stringify({ type: 'editorPatch', version: 1 })];
    for (const [nodeId, entry] of this.nodes.entries()) {
      const terrain = cloneMapValues(entry.edits.terrainPatches, 'terrainPatches');
      const vector = cloneMapValues(entry.edits.vector, 'vector');
      const parcels = cloneMapValues(entry.edits.parcels, 'parcels');
      const buildings = cloneMapValues(entry.edits.buildings, 'buildings');
      const metadata = entry.metadataEdit ? cloneMetadata(entry.metadataEdit) : null;
      const hasContent = terrain.length || vector.length || parcels.length || buildings.length || (metadata && Object.keys(metadata).length);
      if (!hasContent) {
        continue;
      }
      const record = {
        type: 'node',
        nodeId,
        terrainPatches: terrain,
        vector,
        parcels,
        buildings,
        metadata
      };
      lines.push(JSON.stringify(record));
    }
    return lines.join('\n');
  }

  importPatches(serialized) {
    const records = typeof serialized === 'string'
      ? serialized.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
      : Array.isArray(serialized)
        ? serialized
        : [];
    if (!records.length) {
      return [];
    }
    const [header, ...rest] = records;
    if (header.type !== 'editorPatch') {
      throw new Error('Invalid patch header');
    }
    const touched = new Set();
    for (const record of rest) {
      if (!record || record.type !== 'node' || !record.nodeId) {
        continue;
      }
      const entry = this._ensureNode(record.nodeId);
      entry.edits.terrainPatches = mapFromArray(record.terrainPatches, 'terrainPatches', (typeKey) => this._generateFeatureId(typeKey));
      entry.edits.vector = mapFromArray(record.vector, 'vector', (typeKey) => this._generateFeatureId(typeKey));
      entry.edits.parcels = mapFromArray(record.parcels, 'parcels', (typeKey) => this._generateFeatureId(typeKey));
      entry.edits.buildings = mapFromArray(record.buildings, 'buildings', (typeKey) => this._generateFeatureId(typeKey));
      entry.metadataEdit = record.metadata ? cloneMetadata(record.metadata) : null;
      touched.add(record.nodeId);
    }
    return Array.from(touched);
  }

  _mergeFeature(existing, updates, typeKey) {
    const base = cloneForType(existing, typeKey) || {};
    if (!updates || typeof updates !== 'object') {
      return base;
    }
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'line' && Array.isArray(value)) {
        base.line = clonePointArray(value);
      } else if ((key === 'poly' || key === 'polygon') && Array.isArray(value)) {
        base[key] = clonePointArray(value);
      } else if ((key === 'polygons' || key === 'geometry') && Array.isArray(value)) {
        base[key] = cloneNestedPointArray(value);
      } else if (key === 'properties' && value && typeof value === 'object') {
        base.properties = cloneProperties(value);
      } else {
        base[key] = value;
      }
    }
    return base;
  }

  _isEntryEmpty(entry) {
    const noEdits = Object.values(entry.edits).every((collection) => collection instanceof Map && collection.size === 0);
    const noMetadata = !entry.metadataEdit || Object.keys(entry.metadataEdit).length === 0;
    return noEdits && noMetadata && this._isSourceEmpty(entry.source);
  }

  _isSourceEmpty(source) {
    return ['terrainPatches', 'vector', 'parcels', 'buildings'].every((key) => {
      const items = source[key];
      return !Array.isArray(items) || items.length === 0;
    });
  }
}
