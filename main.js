// main.js - entry point tying together world, renderer, input and UI
import { World, DEFAULT_WORLD_SEED } from './world.js';
import { Renderer } from './renderer.js';
import { InteractionController } from './input.js';
import { loadAssets } from './assets.js';

const WORLD_BOUNDS = { minX: 0, minY: 0, maxX: 1024, maxY: 1024 };

function formatNodeLabel(node) {
  if (!node) return '—';
  const name = node.metadata?.name || node.id;
  const level = node.metadata?.levelLabel ? ` (${node.metadata.levelLabel})` : '';
  return `${name}${level}`;
}

function formatBuildingLabel(building) {
  if (!building) return '—';
  const level = building.level ? ` (${building.level})` : '';
  return `${building.id}${level}`;
}

function updateLayerStatus(renderer, element) {
  if (!element || !renderer) return;
  const entries = Object.entries(renderer.layerVisibility)
    .map(([key, visible]) => `${key}: ${visible ? 'on' : 'off'}`);
  element.textContent = `Layers · ${entries.join(' · ')}`;
}

async function init() {
  try {
    const { palette, glyphs, createTilesetLoader } = await loadAssets();
    const canvas = document.getElementById('canvas');
    const seedInput = document.getElementById('seedInput');
    const applySeedBtn = document.getElementById('applySeed');
    const randomSeedBtn = document.getElementById('randomSeed');

    const initialSeedValue = seedInput && seedInput.value.trim() !== ''
      ? seedInput.value.trim()
      : DEFAULT_WORLD_SEED;

    const world = new World(palette, { bounds: WORLD_BOUNDS, seed: initialSeedValue, autoSeed: false });
    const tilesetLoader = createTilesetLoader({
      quadtree: world.getTerrainLayer().quadtree,
      worldSeed: world.seed
    });
    await tilesetLoader.bootstrap();
    if (seedInput) {
      seedInput.value = world.seed.toString();
    }
    const renderer = new Renderer(canvas, world, glyphs);
    const controller = new InteractionController(canvas, renderer, world);

    const modeButtons = document.querySelectorAll('[data-mode]');
    const hoverInfo = document.getElementById('hoverInfo');
    const selectionInfo = document.getElementById('selectionInfo');
    const measurementInfo = document.getElementById('measurementInfo');
    const layerStatus = document.getElementById('layerStatus');

    modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        controller.setMode(btn.dataset.mode);
        modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === controller.mode));
      });
    });

    modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === controller.mode));

    controller.on('mode-change', ({ detail }) => {
      modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === detail.mode));
    });

    controller.on('hover', ({ detail }) => {
      if (!hoverInfo) return;
      if (detail.building) {
        hoverInfo.textContent = `Hover · Building ${formatBuildingLabel(detail.building)} in ${formatNodeLabel(detail.node)}`;
      } else if (detail.node) {
        hoverInfo.textContent = `Hover · Node ${formatNodeLabel(detail.node)}`;
      } else {
        hoverInfo.textContent = 'Hover · —';
      }
    });

    controller.on('selection', ({ detail }) => {
      if (!selectionInfo) return;
      if (detail.building) {
        selectionInfo.textContent = `Selection · Building ${formatBuildingLabel(detail.building)} in ${formatNodeLabel(detail.node)}`;
      } else if (detail.node) {
        selectionInfo.textContent = `Selection · Node ${formatNodeLabel(detail.node)}`;
      } else {
        selectionInfo.textContent = 'Selection · —';
      }
    });

    const updateMeasurementInfo = (detail) => {
      if (!measurementInfo) return;
      const distance = detail?.distance ? detail.distance.toFixed(1) : '0';
      measurementInfo.textContent = `Measurement · ${distance}`;
    };

    controller.on('measurement-update', ({ detail }) => updateMeasurementInfo(detail));
    controller.on('measurement-complete', ({ detail }) => updateMeasurementInfo(detail));

    controller.on('layer-toggle', () => updateLayerStatus(renderer, layerStatus));
    if (hoverInfo) hoverInfo.textContent = 'Hover · —';
    if (selectionInfo) selectionInfo.textContent = 'Selection · —';
    updateMeasurementInfo(null);
    updateLayerStatus(renderer, layerStatus);

    const updateSeedUI = () => {
      if (seedInput) {
        seedInput.value = world.seed.toString();
      }
      controller.update(frameTime);
      renderer.draw();
    };

    const applySeedFromInput = () => {
      if (!seedInput) return;
      const raw = seedInput.value.trim();
      if (raw === '') return;
      const numeric = Number(raw);
      const nextSeed = Number.isFinite(numeric) ? numeric : raw;
      world.setSeed(nextSeed);
      tilesetLoader.setWorldSeed(world.seed);
      tilesetLoader.attachQuadtree(world.getTerrainLayer().quadtree);
      updateSeedUI();
    };

    if (applySeedBtn) {
      applySeedBtn.onclick = () => {
        applySeedFromInput();
      };
    }

    if (seedInput) {
      seedInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          applySeedFromInput();
        }
      });
    }

    if (randomSeedBtn) {
      randomSeedBtn.onclick = () => {
        const randomSeed = Math.floor(Math.random() * 0xffffffff);
        world.setSeed(randomSeed);
        tilesetLoader.setWorldSeed(world.seed);
        tilesetLoader.attachQuadtree(world.getTerrainLayer().quadtree);
        updateSeedUI();
      };
    }

    // Play/pause button
    const playPauseBtn = document.getElementById('playPause');
    let playing = false;
    playPauseBtn.onclick = () => {
      playing = !playing;
      playPauseBtn.textContent = playing ? 'Pause' : 'Play';
    };

    // Save button
    const saveBtn = document.getElementById('saveBtn');
    saveBtn.onclick = () => {
      const ndjson = world.serialize();
      const blob = new Blob([ndjson], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'world.ndjson';
      a.click();
      URL.revokeObjectURL(url);
    };

    // Load button
    const loadBtn = document.getElementById('loadBtn');
    const loadInput = document.getElementById('loadInput');
    loadBtn.onclick = () => {
      loadInput.value = '';
      loadInput.click();
    };
    loadInput.onchange = () => {
      const file = loadInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const text = ev.target.result;
          world.deserialize(text);
          updateSeedUI();
          renderer.fitCameraToWorld();
        } catch (ex) {
          alert('Failed to load world: ' + ex.message);
        }
      };
      reader.readAsText(file);
    };

    // Main animation loop
    const FIXED_STEP = 1 / 60;
    const MAX_FRAME_TIME = 0.25; // prevent spiral of death
    let accumulator = 0;
    let lastTime = performance.now();
    function loop(time) {
      let frameTime = (time - lastTime) / 1000;
      lastTime = time;
      if (frameTime > MAX_FRAME_TIME) {
        frameTime = MAX_FRAME_TIME;
      }

      if (playing) {
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
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  } catch (err) {
    console.error('Failed to initialize engine', err);
    const selectionInfo = document.getElementById('selectionInfo');
    if (selectionInfo) {
      selectionInfo.textContent = 'Failed to load assets';
    }
  }
}

init();