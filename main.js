// main.js - initialise voxel world, renderer, and authoring UI
import { World, DEFAULT_WORLD_SEED } from './world.js';
import { Renderer } from './renderer.js';
import { InteractionController } from './input.js';
import { loadAssets } from './assets.js';

const WORLD_BOUNDS = { minX: 0, minY: 0, maxX: 256, maxY: 256 };

function formatLayerSummary(renderer) {
  const entries = [];
  for (const [layer, visible] of Object.entries(renderer.layerVisibility)) {
    entries.push(`${layer}:${visible ? 'on' : 'off'}`);
  }
  return entries.join(' · ');
}

function formatVoxelSummary(voxel) {
  if (!voxel) {
    return 'Hover a voxel to inspect.';
  }
  const material = voxel.column?.material ?? '—';
  const height = voxel.column?.height ?? 0;
  const prop = voxel.column?.prop?.id || 'none';
  return `(${voxel.x}, ${voxel.y}) · z ${height} · material ${material} · prop ${prop}`;
}

async function init() {
  const canvas = document.getElementById('canvas');
  if (!canvas) {
    throw new Error('Canvas element missing');
  }

  const modeButtons = document.querySelectorAll('#modeControls [data-mode]');
  const undoBtn = document.getElementById('undoVoxel');
  const redoBtn = document.getElementById('redoVoxel');
  const radiusSlider = document.getElementById('brushRadius');
  const radiusValue = document.getElementById('brushRadiusValue');
  const materialSelect = document.getElementById('brushMaterial');
  const layerSelect = document.getElementById('brushLayer');
  const heightInput = document.getElementById('brushHeightDelta');
  const propInput = document.getElementById('brushPropId');
  const columnToggle = document.getElementById('brushColumn');
  const brushSummary = document.getElementById('brushSummary');
  const layerToggles = document.querySelectorAll('[data-layer-toggle]');
  const layerSummary = document.getElementById('layerSummary');
  const hoverInfo = document.getElementById('voxelHoverInfo');

  const { palette, glyphs } = await loadAssets();
  const world = new World(palette, {
    bounds: WORLD_BOUNDS,
    seed: DEFAULT_WORLD_SEED,
    autoSeed: false
  });
  const renderer = new Renderer(canvas, world, glyphs);
  const controller = new InteractionController(canvas, renderer, world);

  const brush = controller.getBrush();

  function updateUndoRedoButtons() {
    if (undoBtn) {
      undoBtn.disabled = !world.canUndoVoxelEdit();
    }
    if (redoBtn) {
      redoBtn.disabled = !world.canRedoVoxelEdit();
    }
  }

  function updateModeButtons(activeMode) {
    modeButtons.forEach((button) => {
      const mode = button.dataset.mode;
      if (mode === activeMode) {
        button.classList.add('active');
      } else {
        button.classList.remove('active');
      }
    });
    const currentBrush = controller.getBrush();
    const label = activeMode.replace('voxel-', '').replace(/-/g, ' ');
    const layerLabel = currentBrush.layer || 'terrain';
    if (brushSummary) {
      brushSummary.textContent = `${label} · radius ${Number(currentBrush.radius).toFixed(1)} · layer ${layerLabel}`;
    }
  }

  function updateBrushControls(currentBrush) {
    if (!currentBrush) return;
    if (radiusSlider) {
      radiusSlider.value = String(currentBrush.radius);
      if (radiusValue) {
        radiusValue.textContent = Number(currentBrush.radius).toFixed(1);
      }
    }
    if (materialSelect) {
      materialSelect.value = currentBrush.material;
      materialSelect.disabled = currentBrush.layer === 'prop';
    }
    if (layerSelect) {
      layerSelect.value = currentBrush.layer;
    }
    if (heightInput) {
      heightInput.value = String(currentBrush.heightDelta);
    }
    if (propInput) {
      propInput.value = currentBrush.propId || '';
    }
    if (columnToggle) {
      columnToggle.checked = Boolean(currentBrush.column);
    }
    const label = controller.mode.replace('voxel-', '').replace(/-/g, ' ');
    const layerLabel = currentBrush.layer || 'terrain';
    if (brushSummary) {
      brushSummary.textContent = `${label} · radius ${Number(currentBrush.radius).toFixed(1)} · layer ${layerLabel}`;
    }
  }

  if (materialSelect) {
    const materials = world.getVoxelMaterials();
    materialSelect.innerHTML = '';
    for (const material of materials) {
      const option = document.createElement('option');
      option.value = material;
      option.textContent = material;
      materialSelect.appendChild(option);
    }
  }

  if (layerSelect) {
    layerSelect.addEventListener('change', (event) => {
      controller.setBrush({ layer: event.target.value });
    });
  }

  updateBrushControls(brush);
  updateUndoRedoButtons();
  if (layerSummary) {
    layerSummary.textContent = formatLayerSummary(renderer);
  }

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode;
      controller.setMode(mode);
    });
  });

  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      controller.undoEdit();
      updateUndoRedoButtons();
    });
  }

  if (redoBtn) {
    redoBtn.addEventListener('click', () => {
      controller.redoEdit();
      updateUndoRedoButtons();
    });
  }

  if (radiusSlider) {
    radiusSlider.addEventListener('input', (event) => {
      const value = Number(event.target.value);
      controller.setBrush({ radius: value });
      if (radiusValue) {
        radiusValue.textContent = value.toFixed(1);
      }
    });
  }

  if (materialSelect) {
    materialSelect.addEventListener('change', (event) => {
      controller.setBrush({ material: event.target.value });
    });
  }

  if (heightInput) {
    heightInput.addEventListener('change', (event) => {
      const value = Math.max(1, Math.round(Number(event.target.value) || 1));
      controller.setBrush({ heightDelta: value });
      event.target.value = String(value);
    });
  }

  if (propInput) {
    propInput.addEventListener('input', (event) => {
      const value = event.target.value.trim();
      controller.setBrush({ propId: value || null });
    });
  }

  if (columnToggle) {
    columnToggle.addEventListener('change', (event) => {
      controller.setBrush({ column: event.target.checked });
    });
  }

  layerToggles.forEach((toggle) => {
    toggle.addEventListener('change', (event) => {
      const layer = event.target.dataset.layerToggle;
      renderer.setLayerVisibility(layer, event.target.checked);
      if (layerSummary) {
        layerSummary.textContent = formatLayerSummary(renderer);
      }
    });
  });

  controller.on('mode-change', ({ detail }) => {
    updateModeButtons(detail.mode);
  });

  controller.on('brush-change', ({ detail }) => {
    updateBrushControls(detail.brush);
  });

  controller.on('voxel-hover', ({ detail }) => {
    if (hoverInfo) {
      hoverInfo.textContent = formatVoxelSummary(detail.voxel);
    }
  });

  controller.on('voxel-edit', () => {
    updateUndoRedoButtons();
  });

  controller.on('voxel-undo', () => {
    updateUndoRedoButtons();
  });

  controller.on('voxel-redo', () => {
    updateUndoRedoButtons();
  });

  updateModeButtons(controller.mode);

  let running = true;
  let lastTime = (typeof performance !== 'undefined' && performance.now()) || Date.now();

  function frame(now) {
    if (!running) return;
    const current = now || ((typeof performance !== 'undefined' && performance.now()) || Date.now());
    const dt = (current - lastTime) / 1000;
    lastTime = current;
    world.update(dt);
    controller.update();
    renderer.draw();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
