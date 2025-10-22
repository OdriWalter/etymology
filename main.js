// main.js - initialise quadtree world, renderer, input, and modern UI panels
import { World, DEFAULT_WORLD_SEED } from './world.js';
import { Renderer } from './renderer.js';
import { InteractionController } from './input.js';
import { loadAssets } from './assets.js';

const WORLD_BOUNDS = { minX: 0, minY: 0, maxX: 1024, maxY: 1024 };
const MAX_SEARCH_RESULTS = 8;

function capitalise(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatNodeLabel(node) {
  if (!node) return '—';
  const name = node.metadata?.name || node.id;
  const level = node.metadata?.levelLabel ? capitalise(node.metadata.levelLabel) : `LOD ${node.lod}`;
  return `${name} (${level})`;
}

function formatBuildingLabel(building) {
  if (!building) return '—';
  const name = building.metadata?.name || building.id;
  const level = building.metadata?.type || building.level || 'building';
  return `${name} (${level})`;
}

function formatDistance(detail) {
  if (!detail || !Number.isFinite(detail.distance)) {
    return '0';
  }
  if (detail.distance >= 1000) {
    return `${(detail.distance / 1000).toFixed(2)} km`;
  }
  return `${detail.distance.toFixed(1)} m`;
}

function parseTagsInput(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formatTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return '';
  }
  return tags.join(', ');
}

function parseInteger(value) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseLineageEntry(entry) {
  if (!entry || typeof entry !== 'string') {
    return { level: null, name: null };
  }
  const [level, ...rest] = entry.split(':');
  const name = rest.length > 0 ? rest.join(':') : level;
  if (rest.length === 0) {
    return { level: null, name };
  }
  return { level: level || null, name: name || null };
}

function formatBreadcrumbs(node, building) {
  const parts = [];
  const parentPath = node?.metadata?.parentPath;
  if (Array.isArray(parentPath)) {
    for (const entry of parentPath) {
      const { level, name } = parseLineageEntry(entry);
      if (!level && !name) continue;
      const label = level ? `${capitalise(level)}: ${name || '—'}` : name;
      if (label) {
        parts.push(label);
      }
    }
  }
  if (node) {
    const level = node.metadata?.levelLabel || `lod ${node.lod}`;
    const name = node.metadata?.name || node.id;
    parts.push(`${capitalise(level)}: ${name}`);
  }
  if (building) {
    const name = building.metadata?.name || building.id;
    parts.push(`Building: ${name}`);
  }
  return parts.length ? parts.join(' → ') : 'World overview';
}

function toSearchRecord(node) {
  if (!node) return null;
  const metadata = node.metadata || {};
  const name = metadata.name || node.id;
  const level = metadata.levelLabel ? capitalise(metadata.levelLabel) : `LOD ${node.lod}`;
  const lineage = Array.isArray(metadata.parentPath) ? metadata.parentPath : [];
  const tokens = [name.toLowerCase(), level.toLowerCase(), node.id.toLowerCase()];
  for (const entry of lineage) {
    if (typeof entry === 'string' && entry.length > 0) {
      tokens.push(entry.toLowerCase());
    }
  }
  if (Array.isArray(metadata.tags)) {
    for (const tag of metadata.tags) {
      if (typeof tag === 'string' && tag.length > 0) {
        tokens.push(tag.toLowerCase());
      }
    }
  }
  return {
    id: node.id,
    lod: node.lod,
    name,
    level,
    metadata,
    bounds: node.bounds,
    tokens,
    subtitle: metadata.levelLabel ? capitalise(metadata.levelLabel) : `LOD ${node.lod}`
  };
}

function buildSearchIndex(quadtree) {
  const records = new Map();
  if (!quadtree) return records;
  for (const node of quadtree.nodes.values()) {
    const record = toSearchRecord(node);
    if (record) {
      records.set(record.id, record);
    }
  }
  return records;
}

function findSearchMatches(index, query) {
  if (!query) return [];
  const term = query.trim().toLowerCase();
  if (!term) return [];
  const matches = [];
  for (const record of index.values()) {
    if (record.tokens.some((token) => token.includes(term))) {
      matches.push(record);
      if (matches.length >= MAX_SEARCH_RESULTS) {
        break;
      }
    }
  }
  return matches;
}

function renderAttributes(container, building) {
  if (!container) return;
  container.innerHTML = '';
  container.classList.remove('empty');
  const metadata = building?.metadata;
  if (!metadata || Object.keys(metadata).length === 0) {
    container.classList.add('empty');
    return;
  }
  const entries = Object.entries(metadata);
  for (const [key, value] of entries) {
    const label = capitalise(String(key).replace(/[_-]+/g, ' '));
    let formatted;
    if (value == null) {
      formatted = '—';
    } else if (typeof value === 'object') {
      try {
        formatted = JSON.stringify(value);
      } catch (err) {
        formatted = String(value);
      }
    } else {
      formatted = String(value);
    }
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = formatted;
    container.appendChild(dt);
    container.appendChild(dd);
  }
}

async function init() {
  const canvas = document.getElementById('canvas');
  const hoverSummary = document.getElementById('hoverSummary');
  const selectionSummary = document.getElementById('selectionSummary');
  const measurementInfo = document.getElementById('measurementInfo');
  const quadtreeDepth = document.getElementById('quadtreeDepth');
  const tileStatus = document.getElementById('tileStatus');
  const breadcrumbsTrail = document.getElementById('breadcrumbsTrail');
  const attributeList = document.getElementById('selectedAttributes');
  const layerSummary = document.getElementById('layerSummary');
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  const searchResults = document.getElementById('searchResults');
  const modeButtons = document.querySelectorAll('#modeControls [data-mode]');
  const layerToggles = document.querySelectorAll('[data-layer-toggle]');
  const playPauseBtn = document.getElementById('playPause');
  const saveBtn = document.getElementById('saveBtn');
  const loadBtn = document.getElementById('loadBtn');
  const loadInput = document.getElementById('loadInput');
  const authoringPanel = document.getElementById('authoringPanel');
  const authoringStatusText = document.getElementById('authoringStatusText');
  const unsavedIndicator = document.getElementById('unsavedIndicator');
  const authoringModeButtons = document.querySelectorAll('#authoringModeControls [data-mode]');
  const authoringForm = document.getElementById('authoringForm');
  const authorNameInput = document.getElementById('authorName');
  const authorLandUseInput = document.getElementById('authorLandUse');
  const authorStoreysInput = document.getElementById('authorStoreys');
  const authorTagsInput = document.getElementById('authorTags');
  const authorApplyBtn = document.getElementById('authorApply');
  const authorDiscardBtn = document.getElementById('authorDiscard');
  const authorError = document.getElementById('authoringError');
  const authorEditsList = document.getElementById('authoringEdits');
  const subdivideBtn = document.getElementById('subdivideSelected');
  const clearNodeEditsBtn = document.getElementById('clearNodeEdits');

  if (!canvas) {
    throw new Error('Canvas element missing');
  }

  try {
    const { palette, glyphs, createTilesetLoader } = await loadAssets();
    const world = new World(palette, {
      bounds: WORLD_BOUNDS,
      seed: DEFAULT_WORLD_SEED,
      autoSeed: false
    });

    let lastLoadedTile = null;
    const tilesetLoader = createTilesetLoader({
      quadtree: world.getTerrainLayer().quadtree,
      worldSeed: world.seed,
      editor: world.editor,
      onTileHydrated: (tile) => {
        lastLoadedTile = tile;
        indexTile(tile);
      }
    });

    await tilesetLoader.bootstrap();

    const renderer = new Renderer(canvas, world, glyphs);
    const controller = new InteractionController(canvas, renderer, world);

    const quadtree = world.getTerrainLayer().quadtree;
    let searchIndex = buildSearchIndex(quadtree);
    const authoringState = { target: null, dirty: false };

    function setAuthoringError(message) {
      if (!authorError) return;
      authorError.textContent = message || '';
      authorError.hidden = !message;
    }

    function clearAuthoringError() {
      setAuthoringError('');
    }

    function updateUnsavedIndicator() {
      if (!unsavedIndicator) return;
      const hasEdits = world.hasUnsavedEdits();
      unsavedIndicator.hidden = !hasEdits;
      unsavedIndicator.setAttribute('aria-hidden', hasEdits ? 'false' : 'true');
    }

    function renderEditsSummary() {
      if (!authorEditsList) return;
      authorEditsList.innerHTML = '';
      const summary = world.getEditorSummary();
      if (!summary.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'No pending edits';
        authorEditsList.appendChild(empty);
        return;
      }
      summary.sort((a, b) => b.total - a.total);
      for (const entry of summary) {
        const parts = [];
        if (entry.counts.terrainPatches) {
          parts.push(`terrain ×${entry.counts.terrainPatches}`);
        }
        if (entry.counts.vector) {
          parts.push(`vector ×${entry.counts.vector}`);
        }
        if (entry.counts.parcels) {
          parts.push(`parcels ×${entry.counts.parcels}`);
        }
        if (entry.counts.buildings) {
          parts.push(`buildings ×${entry.counts.buildings}`);
        }
        if (entry.counts.metadata) {
          parts.push('metadata');
        }
        const item = document.createElement('li');
        item.textContent = `${entry.nodeId}: ${parts.join(', ')}`;
        authorEditsList.appendChild(item);
      }
    }

    function refreshAuthoringSummary() {
      updateUnsavedIndicator();
      renderEditsSummary();
      if (authoringState.target && clearNodeEditsBtn) {
        clearNodeEditsBtn.disabled = !world.hasUnsavedEdits(authoringState.target.nodeId);
      }
    }

    function enableAuthoringForm(enabled) {
      const disable = !enabled;
      [authorNameInput, authorLandUseInput, authorStoreysInput, authorTagsInput].forEach((input) => {
        if (input) {
          input.disabled = disable;
        }
      });
      if (authorApplyBtn) {
        authorApplyBtn.disabled = true;
      }
      if (authorDiscardBtn) {
        authorDiscardBtn.disabled = disable;
      }
    }

    function updateAuthoringButtons() {
      if (authorApplyBtn) {
        authorApplyBtn.disabled = !(authoringState.target && authoringState.dirty);
      }
      if (authorDiscardBtn) {
        authorDiscardBtn.disabled = !authoringState.target;
      }
      if (clearNodeEditsBtn) {
        if (authoringState.target?.nodeId) {
          clearNodeEditsBtn.disabled = !world.hasUnsavedEdits(authoringState.target.nodeId);
        } else {
          clearNodeEditsBtn.disabled = true;
        }
      }
    }

    function resetAuthoringForm() {
      authoringState.target = null;
      authoringState.dirty = false;
      if (authorNameInput) authorNameInput.value = '';
      if (authorLandUseInput) authorLandUseInput.value = '';
      if (authorStoreysInput) authorStoreysInput.value = '';
      if (authorTagsInput) authorTagsInput.value = '';
      if (authoringStatusText) {
        authoringStatusText.textContent = 'No selection';
      }
      if (subdivideBtn) {
        subdivideBtn.disabled = true;
      }
      clearAuthoringError();
      enableAuthoringForm(false);
      updateAuthoringButtons();
    }

    resetAuthoringForm();
    refreshAuthoringSummary();

    function gatherFormValues() {
      if (!authoringState.target) {
        return null;
      }
      const name = authorNameInput?.value.trim() || '';
      const landUse = authorLandUseInput?.value.trim() || '';
      const storeysValue = authorStoreysInput?.value.trim() || '';
      const tags = parseTagsInput(authorTagsInput?.value || '');
      let storeys = null;
      if (storeysValue) {
        const parsed = parseInteger(storeysValue);
        if (parsed === null || parsed < 0) {
          setAuthoringError('Storeys must be a non-negative integer.');
          return null;
        }
        storeys = parsed;
      }
      clearAuthoringError();
      return {
        name,
        landUse,
        storeys,
        tags
      };
    }

    function populateAuthoring(detail) {
      if (!authoringPanel) return;
      if (!detail || (!detail.building && !detail.node)) {
        resetAuthoringForm();
        return;
      }
      clearAuthoringError();
      enableAuthoringForm(true);
      let nodeId = detail.node?.id || detail.building?.nodeId || null;
      let statusLabel = '';
      if (detail.building) {
        const featureId = detail.building.metadata?.featureId || detail.building.id;
        const combined = nodeId && featureId
          ? (world.editor?.getCombined(nodeId, 'buildings') || []).find((feature) => feature && feature.id === featureId)
          : null;
        const fallbackProps = detail.building.metadata?.properties || {};
        const source = combined || detail.building.metadata || {};
        const props = { ...(combined?.properties || fallbackProps) };
        const metadata = combined?.metadata || detail.building.metadata || {};
        if (authorNameInput) {
          authorNameInput.value = metadata.name || combined?.name || detail.building.metadata?.name || detail.building.id || '';
        }
        if (authorLandUseInput) {
          authorLandUseInput.value = props.landUse || '';
        }
        if (authorStoreysInput) {
          authorStoreysInput.value = Number.isFinite(props.storeys) ? String(props.storeys) : '';
        }
        if (authorTagsInput) {
          authorTagsInput.value = formatTags(metadata.tags || []);
        }
        statusLabel = `Building · ${detail.building.id || featureId}`;
        authoringState.target = {
          kind: 'building',
          nodeId,
          featureId,
          featureType: 'buildings',
          data: combined || source
        };
      } else if (detail.node) {
        const node = quadtree.getNode(detail.node.id);
        const metadata = node?.metadata || detail.node.metadata || {};
        if (authorNameInput) {
          authorNameInput.value = metadata.name || '';
        }
        if (authorLandUseInput) {
          authorLandUseInput.value = metadata.landUse || '';
        }
        if (authorStoreysInput) {
          authorStoreysInput.value = Number.isFinite(metadata.storeys) ? String(metadata.storeys) : '';
        }
        if (authorTagsInput) {
          authorTagsInput.value = formatTags(metadata.tags || []);
        }
        statusLabel = `Node · ${detail.node.id}`;
        authoringState.target = {
          kind: 'node',
          nodeId: detail.node.id,
          data: metadata
        };
      }
      authoringState.dirty = false;
      if (authoringStatusText) {
        authoringStatusText.textContent = statusLabel || 'Authoring';
      }
      if (subdivideBtn) {
        subdivideBtn.disabled = !nodeId;
      }
      updateAuthoringButtons();
    }

    function refreshCurrentSelection() {
      if (!currentSelection) return;
      if (currentSelection.node?.id) {
        const node = quadtree.getNode(currentSelection.node.id);
        if (node) {
          currentSelection.node.metadata = node.metadata ? { ...node.metadata } : null;
        }
      }
      if (currentSelection.building?.nodeId && currentSelection.building.metadata?.featureId) {
        const features = world.editor?.getCombined(currentSelection.building.nodeId, 'buildings') || [];
        const feature = features.find((entry) => entry && entry.id === currentSelection.building.metadata.featureId);
        if (feature) {
          currentSelection.building.metadata = {
            ...(currentSelection.building.metadata || {}),
            properties: feature.properties ? { ...feature.properties } : {},
            name: feature.name || feature.metadata?.name || currentSelection.building.metadata?.name || null,
            tags: feature.metadata?.tags ? [...feature.metadata.tags] : []
          };
        }
      }
      updateSelection(currentSelection);
    }

    function handleApply() {
      if (!authoringState.target) return;
      const values = gatherFormValues();
      if (!values) return;
      if (authoringState.target.kind === 'building' && authoringState.target.nodeId && authoringState.target.featureId) {
        const features = world.editor?.getCombined(authoringState.target.nodeId, 'buildings') || [];
        const current = features.find((feature) => feature && feature.id === authoringState.target.featureId) || authoringState.target.data || {};
        const properties = { ...(current.properties || {}) };
        if (values.name) {
          properties.name = values.name;
        } else {
          delete properties.name;
        }
        if (values.landUse) {
          properties.landUse = values.landUse;
        } else {
          delete properties.landUse;
        }
        if (values.storeys !== null) {
          properties.storeys = values.storeys;
        } else {
          delete properties.storeys;
        }
        const metadata = { ...(current.metadata || {}) };
        if (values.name) {
          metadata.name = values.name;
        } else {
          delete metadata.name;
        }
        metadata.tags = values.tags;
        const updates = {
          properties,
          metadata
        };
        if (values.name || current.name) {
          updates.name = values.name || null;
        }
        world.updateBuildingFeature(authoringState.target.nodeId, authoringState.target.featureId, updates);
      } else if (authoringState.target.kind === 'node' && authoringState.target.nodeId) {
        const updates = {};
        updates.name = values.name || null;
        updates.landUse = values.landUse || null;
        updates.storeys = values.storeys !== null ? values.storeys : null;
        updates.tags = values.tags;
        world.updateNodeMetadata(authoringState.target.nodeId, updates);
      }
      authoringState.dirty = false;
      refreshCurrentSelection();
      populateAuthoring(currentSelection);
      refreshAuthoringSummary();
    }

    function handleDiscard() {
      if (!authoringState.target) return;
      populateAuthoring(currentSelection);
      authoringState.dirty = false;
      clearAuthoringError();
      updateAuthoringButtons();
    }

    if (authoringForm) {
      authoringForm.addEventListener('input', () => {
        if (!authoringState.target) return;
        authoringState.dirty = true;
        updateAuthoringButtons();
        clearAuthoringError();
      });
      authoringForm.addEventListener('submit', (event) => {
        event.preventDefault();
        handleApply();
      });
    }

    if (authorApplyBtn) {
      authorApplyBtn.addEventListener('click', (event) => {
        event.preventDefault();
        handleApply();
      });
    }

    if (authorDiscardBtn) {
      authorDiscardBtn.addEventListener('click', (event) => {
        event.preventDefault();
        handleDiscard();
      });
    }

    if (subdivideBtn) {
      subdivideBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        const nodeId = currentSelection?.node?.id || authoringState.target?.nodeId || null;
        if (!nodeId) return;
        const children = world.subdivideNode(nodeId) || [];
        if (children.length && tilesetLoader) {
          for (const child of children) {
            const position = child?.metadata?.position;
            if (position && Number.isInteger(position.lod) && Number.isInteger(position.x) && Number.isInteger(position.y)) {
              try {
                await tilesetLoader.ensureTile(position.lod, position.x, position.y);
              } catch (err) {
                console.warn('Failed to hydrate subdivided child', err);
              }
            }
          }
          searchIndex = buildSearchIndex(quadtree);
        }
        refreshAuthoringSummary();
      });
    }

    if (clearNodeEditsBtn) {
      clearNodeEditsBtn.addEventListener('click', (event) => {
        event.preventDefault();
        const nodeId = authoringState.target?.nodeId || currentSelection?.node?.id || null;
        if (!nodeId) return;
        world.clearNodeEdits(nodeId);
        refreshCurrentSelection();
        populateAuthoring(currentSelection);
        refreshAuthoringSummary();
      });
    }

    function refreshLayerSummary() {
      if (!layerSummary) return;
      const parts = Object.entries(renderer.layerVisibility).map(([layer, visible]) => `${layer}:${visible ? 'on' : 'off'}`);
      layerSummary.textContent = parts.join(' · ');
    }

    function updateDepthDisplay(node) {
      if (!quadtreeDepth) return;
      const depth = node?.lod ?? 0;
      quadtreeDepth.textContent = `Depth · ${depth} / ${quadtree.maxLod}`;
    }

    function updateHover(detail) {
      if (hoverSummary) {
        if (detail?.building) {
          hoverSummary.textContent = `Hover · ${formatBuildingLabel(detail.building)}`;
        } else if (detail?.node) {
          hoverSummary.textContent = `Hover · ${formatNodeLabel(detail.node)}`;
        } else {
          hoverSummary.textContent = 'Hover · —';
        }
      }
      updateDepthDisplay(detail?.node || currentSelection?.node || null);
    }

    function updateSelection(detail) {
      if (selectionSummary) {
        if (detail?.building) {
          selectionSummary.textContent = `Selection · ${formatBuildingLabel(detail.building)}`;
        } else if (detail?.node) {
          selectionSummary.textContent = `Selection · ${formatNodeLabel(detail.node)}`;
        } else {
          selectionSummary.textContent = 'Selection · —';
        }
      }
      renderAttributes(attributeList, detail?.building || null);
      updateDepthDisplay(detail?.node || null);
      const trail = formatBreadcrumbs(detail?.node || null, detail?.building || null);
      if (breadcrumbsTrail) {
        breadcrumbsTrail.textContent = trail;
      }
    }

    function updateMeasurement(detail) {
      if (measurementInfo) {
        const formatted = formatDistance(detail);
        measurementInfo.textContent = `Measurement · ${formatted}`;
      }
    }

    function updateTileStatus() {
      if (!tileStatus) return;
      const pending = tilesetLoader?.inFlight?.size ?? 0;
      const pieces = [`Tiles · ${pending > 0 ? `loading (${pending})` : 'idle'}`];
      if (lastLoadedTile) {
        pieces.push(`LOD ${lastLoadedTile.lod} (${lastLoadedTile.x},${lastLoadedTile.y})`);
      }
      tileStatus.textContent = pieces.join(' · ');
      tileStatus.dataset.state = pending > 0 ? 'loading' : 'idle';
    }

    function indexTile(tile) {
      if (!tile) return;
      try {
        const target = quadtree.ensureNodeForTile(tile.lod ?? 0, tile.x ?? 0, tile.y ?? 0);
        if (target) {
          const record = toSearchRecord(target);
          if (record) {
            searchIndex.set(record.id, record);
          }
          let parentId = target.parentId;
          while (parentId) {
            const parent = quadtree.getNode(parentId);
            if (!parent) break;
            const parentRecord = toSearchRecord(parent);
            if (parentRecord) {
              searchIndex.set(parentRecord.id, parentRecord);
            }
            parentId = parent.parentId;
          }
        }
      } catch (err) {
        console.warn('[search] Failed to index tile node', err);
      }
      updateTileStatus();
    }

    function renderSearch(matches) {
      if (!searchResults) return;
      searchResults.innerHTML = '';
      if (!matches.length) {
        return;
      }
      for (const match of matches) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.className = 'search-result';
        button.type = 'button';
        button.dataset.nodeId = match.id;
        button.textContent = match.name;
        if (match.subtitle) {
          const subtitle = document.createElement('span');
          subtitle.className = 'subtitle';
          subtitle.textContent = match.subtitle;
          button.appendChild(subtitle);
        }
        item.appendChild(button);
        searchResults.appendChild(item);
      }
    }

    async function focusNode(nodeId) {
      if (!nodeId) return;
      const node = quadtree.getNode(nodeId);
      if (!node) {
        return;
      }
      const position = node.metadata?.position;
      if (position && Number.isInteger(position.lod) && Number.isInteger(position.x) && Number.isInteger(position.y)) {
        await tilesetLoader.ensureTile(position.lod, position.x, position.y);
      }
      controller.focusOnBounds(node.bounds, 0.2);
      const payload = {
        id: node.id,
        lod: node.lod,
        bounds: node.bounds,
        metadata: node.metadata || null
      };
      controller.selection = { building: null, node: payload, bounds: node.bounds };
      controller.emit('selection', {
        mode: controller.mode,
        building: null,
        node: payload
      });
      controller._updateRendererState();
    }

    function clearSearchResults() {
      if (searchResults) {
        searchResults.innerHTML = '';
      }
    }

    let currentSelection = null;

    controller.on('hover', ({ detail }) => {
      updateHover(detail);
    });

    controller.on('selection', ({ detail }) => {
      currentSelection = detail;
      updateSelection(detail);
      populateAuthoring(detail);
      updateAuthoringButtons();
    });

    controller.on('feature-created', () => {
      refreshCurrentSelection();
      populateAuthoring(currentSelection);
      refreshAuthoringSummary();
    });

    controller.on('feature-updated', () => {
      refreshCurrentSelection();
      populateAuthoring(currentSelection);
      refreshAuthoringSummary();
    });

    controller.on('feature-cancelled', () => {
      refreshAuthoringSummary();
    });

    controller.on('measurement-update', ({ detail }) => {
      updateMeasurement(detail);
    });

    controller.on('measurement-complete', ({ detail }) => {
      updateMeasurement(detail);
    });

    controller.on('layer-toggle', () => refreshLayerSummary());

    modeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        controller.setMode(button.dataset.mode);
        modeButtons.forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.mode === controller.mode);
        });
      });
    });

    authoringModeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        controller.setMode(button.dataset.mode);
      });
    });
    authoringModeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === controller.mode);
    });

    controller.on('mode-change', ({ detail }) => {
      modeButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === detail.mode);
      });
      authoringModeButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === detail.mode);
      });
    });

    layerToggles.forEach((toggle) => {
      toggle.addEventListener('change', () => {
        const layer = toggle.dataset.layerToggle;
        renderer.setLayerVisibility(layer, toggle.checked);
        refreshLayerSummary();
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const matches = findSearchMatches(searchIndex, searchInput.value);
        renderSearch(matches);
      });
    }

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        if (searchInput) {
          searchInput.value = '';
        }
        clearSearchResults();
        searchInput?.focus();
      });
    }

    if (searchResults) {
      searchResults.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-node-id]');
        if (!button) return;
        event.preventDefault();
        await focusNode(button.dataset.nodeId);
        clearSearchResults();
      });
    }

    if (playPauseBtn) {
      let playing = false;
      playPauseBtn.addEventListener('click', () => {
        playing = !playing;
        playPauseBtn.textContent = playing ? 'Pause' : 'Play';
        state.playing = playing;
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        if (!world.hasUnsavedEdits()) {
          alert('No edits to export');
          return;
        }
        const ndjson = world.exportEditorPatch();
        if (!ndjson) {
          alert('No edits to export');
          return;
        }
        const blob = new Blob([ndjson], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'world-edits.ndjson';
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    if (loadBtn && loadInput) {
      loadBtn.addEventListener('click', () => {
        loadInput.value = '';
        loadInput.click();
      });
      loadInput.addEventListener('change', () => {
        const file = loadInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const text = ev.target?.result;
            if (typeof text !== 'string') {
              throw new Error('Unsupported file contents');
            }
            const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
            if (!lines.length) {
              throw new Error('File was empty');
            }
            let parsedHeader = null;
            try {
              parsedHeader = JSON.parse(lines[0]);
            } catch (err) {
              parsedHeader = null;
            }
            if (parsedHeader?.type === 'editorPatch') {
              world.applyEditorPatch(text);
              searchIndex = buildSearchIndex(world.getTerrainLayer().quadtree);
            } else {
              world.deserialize(text);
              searchIndex = buildSearchIndex(world.getTerrainLayer().quadtree);
              refreshLayerSummary();
              renderer.fitCameraToWorld();
            }
            refreshCurrentSelection();
            populateAuthoring(currentSelection);
            refreshAuthoringSummary();
          } catch (err) {
            alert('Failed to load world: ' + (err?.message || err));
          }
        };
        reader.readAsText(file);
      });
    }

    refreshLayerSummary();
    updateHover(null);
    updateSelection(null);
    updateMeasurement(null);
    updateTileStatus();

    const statusInterval = setInterval(updateTileStatus, 250);

    const state = { playing: false };
    const FIXED_STEP = 1 / 60;
    const MAX_FRAME_TIME = 0.25;
    let accumulator = 0;
    let lastTime = performance.now();

    function loop(time) {
      let frameTime = (time - lastTime) / 1000;
      lastTime = time;
      if (frameTime > MAX_FRAME_TIME) {
        frameTime = MAX_FRAME_TIME;
      }

      if (state.playing) {
        accumulator += frameTime;
        while (accumulator >= FIXED_STEP) {
          world.update(FIXED_STEP);
          accumulator -= FIXED_STEP;
        }
      } else {
        accumulator = 0;
      }

      controller.update(frameTime);
      renderer.draw();
      updateTileStatus();
      requestAnimationFrame(loop);
    }

    window.addEventListener('beforeunload', () => {
      clearInterval(statusInterval);
    });

    requestAnimationFrame(loop);
  } catch (err) {
    console.error('Failed to initialise engine', err);
    if (selectionSummary) {
      selectionSummary.textContent = 'Failed to load assets';
    }
  }
}

init();
